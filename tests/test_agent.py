"""Tests for the agent layer — SDK-independent internals + the security pieces.

Heaviest coverage on the two boundaries: ``git_violation`` (the main/merge
hook, 3.2b) and ``configure_auth`` (no-fallback auth, 3.2).
"""

from __future__ import annotations

import asyncio
import json

import numpy as np
import pytest
from PIL import Image

from paratrooper.agent import images, memory, pins, spotify
from paratrooper.agent.auth import configure_auth
from paratrooper.agent.config import ConfigError, load_config, require_env
from paratrooper.agent.hooks import git_violation, make_main_guard_hook
from paratrooper.agent.siterepo import GitError, SiteRepo
from paratrooper.agent.tools import ToolContext, build_tool_server

# --- hooks (3.2b): the main/merge boundary -----------------------------------

@pytest.mark.parametrize(
    "command",
    [
        "git push origin main",
        "git push -u origin main",
        "git push origin HEAD:main",
        "git merge feature",
        "git merge origin/main",
        "gh pr merge 5",
        "git push --force origin paratrooper/x",
        "git push -f origin paratrooper/x",
        "git checkout main && git push origin main",  # compound
        "cd src/content && git push origin main",  # compound
        'bash -c "git push origin main"',  # nested -> regex backstop
        "git branch -D main",
    ],
)
def test_git_violation_denies(command):
    assert git_violation(command, "main") is not None


@pytest.mark.parametrize(
    "command",
    [
        "git push origin paratrooper/twen-new-band",
        "git push --set-upstream origin paratrooper/foo",
        "git add -A && git commit -m 'add pin'",
        "git checkout -b paratrooper/foo",
        "npm run build",
        "ls -la && cat index.json",
        "git status",
        "git log --oneline -5",
    ],
)
def test_git_violation_allows(command):
    assert git_violation(command, "main") is None


def test_git_violation_respects_default_branch_name():
    # if the default branch were "trunk", pushing to main is fine but trunk isn't
    assert git_violation("git push origin trunk", "trunk") is not None
    assert git_violation("git push origin main", "trunk") is None


def test_hook_returns_deny_shape():
    hook = make_main_guard_hook("main")

    def call(tool_name, command=""):
        payload = {"tool_name": tool_name, "tool_input": {"command": command}}
        return asyncio.run(hook(payload, None, None))

    deny = call("Bash", "git push origin main")
    assert deny["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert deny["hookSpecificOutput"]["hookEventName"] == "PreToolUse"
    assert call("Bash", "git status") == {}
    assert call("Write") == {}  # non-Bash tools pass through untouched


# --- auth (3.2): manual mode, no fallback ------------------------------------

def test_auth_subscription_requires_token_and_clears_api_key(monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "oat-123")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-be-cleared")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "tok-should-be-cleared")
    assert configure_auth("subscription") == "subscription"
    import os

    assert os.environ.get("ANTHROPIC_API_KEY") is None  # cleared so it can't win precedence
    assert os.environ.get("ANTHROPIC_AUTH_TOKEN") is None
    assert os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") == "oat-123"


def test_auth_subscription_missing_token_hard_errors(monkeypatch):
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)
    with pytest.raises(ConfigError, match="subscription"):
        configure_auth("subscription")


def test_auth_api_requires_key_and_clears_oauth(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-real")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "oat-should-be-cleared")
    assert configure_auth("api") == "api"
    import os

    assert os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") is None


def test_auth_invalid_mode_hard_errors(monkeypatch):
    monkeypatch.delenv("AGENT_AUTH", raising=False)
    with pytest.raises(ConfigError):
        configure_auth("")
    with pytest.raises(ConfigError):
        configure_auth("both")


def test_require_env_loud(monkeypatch):
    monkeypatch.delenv("SOME_SECRET", raising=False)
    with pytest.raises(ConfigError):
        require_env("SOME_SECRET")


# --- config (3.4) -------------------------------------------------------------

def test_load_config_resolves_paths(tmp_path):
    cfg_file = tmp_path / "paths.toml"
    cfg_file.write_text(
        '[paths]\nsite_root = "site"\ninbox = "inbox"\n[site]\ndefault_branch = "main"\n'
    )
    cfg = load_config(cfg_file)
    assert cfg.site_root == (tmp_path / "site").resolve()
    content = cfg.site_root / "src" / "content"
    assert cfg.pins_dir == content / "pins-on-display"
    # the other stages must be OUTSIDE pins_dir (Astro's glob would render them)
    assert cfg.archive_dir == content / "pins-off-display"
    assert cfg.later_dir == content / "pins-for-later"
    assert cfg.pins_dir not in cfg.archive_dir.parents
    assert cfg.pins_dir not in cfg.later_dir.parents
    assert cfg.inbox == (tmp_path / "inbox").resolve()
    assert cfg.default_branch == "main"
    assert cfg.branch_prefix == "paratrooper"


def test_load_config_missing_file():
    with pytest.raises(ConfigError):
        load_config("/no/such/config.toml")


def test_load_config_env_overrides(tmp_path, monkeypatch):
    # render.yaml sets absolute paths via env; TOML need not carry them
    cfg_file = tmp_path / "paths.toml"
    cfg_file.write_text('[site]\ndefault_branch = "main"\n')
    monkeypatch.setenv("PARATROOPER_SITE_ROOT", str(tmp_path / "checkout"))
    monkeypatch.setenv("PARATROOPER_INBOX", str(tmp_path / "inbox"))
    cfg = load_config(cfg_file)
    assert cfg.site_root == tmp_path / "checkout"
    assert cfg.inbox == tmp_path / "inbox"
    # default pins_dir follows the env-provided site_root
    assert cfg.pins_dir == cfg.site_root / "src" / "content" / "pins-on-display"


def test_ensure_checkout_noop_and_no_remote(tmp_path):
    from paratrooper.agent.siterepo import GitError, SiteRepo

    (tmp_path / ".git").mkdir()  # already a checkout
    existing = SiteRepo(tmp_path, remote="https://github.com/o/r.git")
    existing.ensure_checkout()  # no-op, no raise (already a checkout)
    fresh = tmp_path / "fresh"
    with pytest.raises(GitError, match="no remote"):
        SiteRepo(fresh).ensure_checkout()


# --- pins ---------------------------------------------------------------------

def _make_pin(pins_dir, pin_id, data, *, image=None):
    folder = pins_dir / pin_id
    folder.mkdir(parents=True)
    (folder / "index.json").write_text(json.dumps(data))
    if image is not None:
        image.save(folder / "preview.webp", format="WEBP")
    return folder


def test_load_board_reads_size_and_cutout(tmp_path):
    pins_dir = tmp_path / "pins"
    pins_dir.mkdir()
    _make_pin(pins_dir, "earthrise", {
        "type": "image", "position": {"x": 49, "y": 64}, "size": {"w": 16, "h": 10.67},
    })
    # a cutout: RGBA with a transparent corner
    arr = np.zeros((64, 64, 4), dtype=np.uint8)
    arr[16:48, 16:48] = [255, 0, 0, 255]  # opaque square center
    cutout_img = Image.fromarray(arr, mode="RGBA")
    _make_pin(pins_dir, "ram", {
        "type": "image", "position": {"x": 50, "y": 45}, "size": {"w": 18, "h": 18},
        "frameless": True,
    }, image=cutout_img)

    board = pins.load_board(pins_dir)
    by_id = {p.id: p for p in board}
    assert by_id["earthrise"].w == 16 and by_id["earthrise"].h == pytest.approx(10.67)
    assert by_id["ram"].is_cutout and by_id["ram"].silhouette is not None
    # exclude works
    assert "ram" not in {p.id for p in pins.load_board(pins_dir, exclude="ram")}


def test_to_engine_pin_missing_size_raises(tmp_path):
    pins_dir = tmp_path / "pins"
    pins_dir.mkdir()
    _make_pin(pins_dir, "bad", {"type": "text", "position": {"x": 50, "y": 50}})
    with pytest.raises(pins.PinError):
        pins.load_board(pins_dir)


def test_write_and_archive_pin(tmp_path):
    pins_dir = tmp_path / "pins"
    archive = tmp_path / "archive"
    pins.write_pin(
        pins_dir, "twen",
        {"type": "image", "position": {"x": 20, "y": 80}, "size": {"w": 12, "h": 12}},
    )
    assert (pins_dir / "twen" / "index.json").is_file()
    dst = pins.archive_pin(pins_dir, archive, "twen")
    assert dst.is_dir() and not (pins_dir / "twen").exists()
    # archiving a non-existent pin is loud
    with pytest.raises(pins.PinError):
        pins.archive_pin(pins_dir, archive, "ghost")


def test_slugify():
    assert pins.slugify("New Favorite Band!") == "new-favorite-band"
    assert pins.slugify("   ") == "pin"


# --- images -------------------------------------------------------------------

def test_process_image_aspect_and_webp(tmp_path):
    src = tmp_path / "in.png"
    Image.new("RGB", (400, 200), "navy").save(src)
    res = images.process_image(src, tmp_path / "pin" / "preview.webp", max_dim=100)
    assert res.path.is_file()
    assert res.aspect == pytest.approx(2.0)
    assert max(res.width, res.height) <= 100  # downscaled
    assert not res.has_alpha


def test_process_image_preserves_alpha(tmp_path):
    src = tmp_path / "in.png"
    Image.new("RGBA", (120, 120), (255, 0, 0, 0)).save(src)
    res = images.process_image(src, tmp_path / "out.webp")
    assert res.has_alpha


# --- spotify (pure URL logic; no network) ------------------------------------

def test_spotify_url_helpers():
    tid = "48kjJJiIOGBhCX3Bnz8qJe"
    assert spotify.track_id_from_url(f"https://open.spotify.com/track/{tid}") == tid
    embed = "https://open.spotify.com/embed/track/ABC?utm_source=generator"
    assert spotify.track_id_from_url(embed) == "ABC"
    assert spotify.track_id_from_url("https://example.com/foo") is None
    assert spotify.embed_url("XYZ") == "https://open.spotify.com/embed/track/XYZ?utm_source=generator"


def test_resolve_link_rejects_non_track():
    with pytest.raises(ValueError):
        spotify.resolve_link("https://open.spotify.com/album/123")


# --- memory (3.3) -------------------------------------------------------------

def test_changelog_digest_and_fetch(tmp_path):
    cl = memory.Changelog(tmp_path / "changelog.jsonl")
    for i in range(12):
        cl.append(memory.ChangelogEntry(
            ts=f"2026-06-{i+1:02d}T00:00:00Z", pin_id=f"p{i}", action="add", summary=f"s{i}"
        ))
    digest = cl.hot_digest(10)
    assert len(digest) == 10
    assert digest[0]["pin_id"] == "p11"  # most recent first
    assert len(cl.fetch_history(n=3)) == 3
    assert cl.fetch_history(start=0, end=2) == cl.read_all()[:2]
    assert "p11" in memory.format_digest(digest)
    assert memory.format_digest([]) == "No prior pinboard updates recorded."


# --- tools: server construction ----------------------------------------------

def test_build_tool_server(tmp_path):
    from paratrooper.agent.config import Config

    cfg = Config(
        inbox=tmp_path / "inbox",
        site_root=tmp_path / "site",
        pins_dir=tmp_path / "pins",
        archive_dir=tmp_path / "arch",
        later_dir=tmp_path / "later",
        changelog=tmp_path / "cl.jsonl",
        remote=None,
        default_branch="main",
        branch_prefix="paratrooper",
    )
    ctx = ToolContext(
        config=cfg,
        repo=SiteRepo(cfg.site_root),
        changelog=memory.Changelog(cfg.changelog),
        branch="paratrooper/x",
    )
    server, names = build_tool_server(ctx)
    assert server["name"] == "paratrooper"
    assert "mcp__paratrooper__place_pin" in names
    assert "mcp__paratrooper__open_pr" in names
    assert "mcp__paratrooper__move_pin" in names
    assert "mcp__paratrooper__start_branch" in names
    assert len(names) == 12


# --- siterepo (pure parts) ---------------------------------------------------

def test_branch_name_and_owner_repo(tmp_path):
    repo = SiteRepo(tmp_path, remote="https://github.com/AsteroidHunter/webpage.git")
    assert repo.branch_name("twen", "new-band") == "paratrooper/twen-new-band"
    assert repo.branch_name("", "add-photo") == "paratrooper/add-photo"
    assert repo.branch_name() == "paratrooper/update"
    assert repo._owner_repo() == ("AsteroidHunter", "webpage")


def test_push_refuses_default_branch(tmp_path):
    repo = SiteRepo(tmp_path, default_branch="main")
    with pytest.raises(GitError, match="default branch"):
        repo.push_branch("main")


def test_move_pin_between_stages(tmp_path):
    on, off, later = tmp_path / "on", tmp_path / "off", tmp_path / "later"
    pins.write_pin(later, "future", {
        "type": "image", "notes": "goes up next month",
        "position": {"x": 50, "y": 50}, "size": {"w": 10, "h": 10},
    })
    # for-later -> on-display (publish)
    dst = pins.move_pin(later, on, "future")
    assert dst == on / "future" and not (later / "future").exists()
    # on-display -> off-display (archive)
    pins.move_pin(on, off, "future")
    assert (off / "future" / "index.json").is_file()
    # collision guard: put a fresh one on display, try to archive onto the old
    pins.write_pin(on, "future", {"type": "text", "text": "v2",
                                  "position": {"x": 50, "y": 50}, "size": {"w": 10, "h": 10}})
    with pytest.raises(pins.PinError, match="refusing to overwrite"):
        pins.move_pin(on, off, "future")


def test_mutating_tools_require_branch(tmp_path):
    """Before start_branch, every checkout-mutating tool must refuse — an edit
    landing on the local default branch would be wiped by the next branch prep."""
    from paratrooper.agent.config import Config
    from paratrooper.agent.tools import build_tool_server

    cfg = Config(
        inbox=tmp_path / "inbox",
        site_root=tmp_path / "site",
        pins_dir=tmp_path / "pins",
        archive_dir=tmp_path / "arch",
        later_dir=tmp_path / "later",
        changelog=tmp_path / "cl.jsonl",
        remote=None,
        default_branch="main",
        branch_prefix="paratrooper",
    )
    ctx = ToolContext(
        config=cfg,
        repo=SiteRepo(cfg.site_root),
        changelog=memory.Changelog(cfg.changelog),
    )
    assert ctx.branch is None
    # rebuild to capture handlers; call the mutating ones directly
    import paratrooper.agent.tools as tools_mod

    handlers = {}
    orig = tools_mod.create_sdk_mcp_server

    def capture(name, version, tools):
        for t in tools:
            handlers[t.name] = t.handler
        return orig(name=name, version=version, tools=tools)

    tools_mod.create_sdk_mcp_server = lambda name, version, tools: capture(name, version, tools)
    try:
        build_tool_server(ctx)
    finally:
        tools_mod.create_sdk_mcp_server = orig

    for name, args in [
        ("git_commit", {"message": "x"}),
        ("git_push", {}),
        ("open_pr", {"title": "x"}),
        ("move_pin", {"pin_id": "p", "to": "off-display"}),
        ("process_image", {"inbox_key": "k", "pin_id": "p"}),
    ]:
        out = asyncio.run(handlers[name](args))
        assert out.get("is_error"), f"{name} ran without a branch"
        assert "start_branch" in out["content"][0]["text"]


def test_is_text_delta_classifier():
    """Typing dots must fire only on message-text streaming, not tool/thinking
    deltas."""
    from paratrooper.agent.worker import _is_text_delta

    text = {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "h"}}
    tool = {"type": "content_block_delta", "delta": {"type": "input_json_delta"}}
    assert _is_text_delta(text)
    assert not _is_text_delta(tool)
    assert not _is_text_delta({"type": "content_block_delta", "delta": {"type": "thinking_delta"}})
    assert not _is_text_delta({"type": "content_block_start"})
    assert not _is_text_delta({})
