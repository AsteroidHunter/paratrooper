"""Tests for ``screenshot_board`` — real headless captures over a fixture board.

The fixture fakes the *built* site: a handwritten ``dist/index.html`` (served
with ``build=False``, so no npm) that mirrors the markup of the real board
(``src/pages/index.astro`` in the site repo): a square ``.cloth`` holding
clickable ``.board-pin`` divs keyed by ``data-pin-id``, and the
``.polaroid-overlay`` lightbox (a flex column: the ``.polaroid-title``
floating on the backdrop, collapsed while empty, above the ``.polaroid-card``
that zooms in on open and gets its artwork injected at that moment). Solid
marker colors make each layer pixel-checkable: grey cloth, blue pins, red
overlay backdrop, yellow floating title, green card, purple injected artwork.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from PIL import Image

from paratrooper.agent import memory, screenshot
from paratrooper.agent.config import Config
from paratrooper.agent.screenshot import ScreenshotError
from paratrooper.agent.tools import ToolContext

FIXTURE_HTML = """<!DOCTYPE html>
<html>
<head>
<style>
  body { margin: 0; }
  .cloth { position: relative; width: 600px; height: 600px; background: rgb(200,200,200); }
  .board-pin {
    position: absolute; width: 60px; height: 60px; background: rgb(0,0,255);
    transform: translate(-50%, -50%);
  }
  .polaroid-overlay {
    position: fixed; inset: 0; display: none; flex-direction: column;
    align-items: center; justify-content: center; background: rgb(255,0,0);
  }
  .polaroid-overlay.open { display: flex; }
  .polaroid-title {
    display: none; width: 200px; height: 40px; margin-bottom: 20px;
    background: rgb(255,255,0);
  }
  .polaroid-title:not(:empty) { display: block; }
  .polaroid-card { position: relative; width: 400px; height: 400px; background: rgb(0,255,0); }
  .polaroid-card.zooming-in { animation: polaroid-zoom-in 0.35s ease-out forwards; }
  @keyframes polaroid-zoom-in {
    from { transform: scale(0.5); opacity: 0; }
    to { transform: scale(1); opacity: 1; }
  }
  .polaroid-content img { position: absolute; top: 20px; left: 20px; width: 40px; height: 40px; }
</style>
</head>
<body>
<div class="cloth">
  <div class="board-pin" data-pin-id="twen" style="left: 25%; top: 25%;"></div>
  <div class="board-pin" data-pin-id="desert-not-barren" data-pin-title="Desert, Not Barren"
    style="left: 75%; top: 75%;"></div>
</div>
<div class="polaroid-overlay" id="polaroid-overlay">
  <div class="polaroid-title" id="polaroid-title"></div>
  <div class="polaroid-card" id="polaroid-card">
    <div class="polaroid-content" id="polaroid-content"></div>
  </div>
</div>
<script>
  // mirrors the real openPolaroid: artwork injected on open, overlay shown,
  // card zoomed in, pin id mirrored onto the card, title filled only for
  // pins that carry one (empty keeps it display:none, like multi-song-less
  // pins on the real board)
  document.querySelectorAll('.board-pin').forEach(pin => {
    pin.addEventListener('click', () => {
      const card = document.getElementById('polaroid-card');
      card.setAttribute('data-pin-id', pin.dataset.pinId);
      document.getElementById('polaroid-title').textContent = pin.dataset.pinTitle || '';
      document.getElementById('polaroid-content').innerHTML =
        '<img src="opened.png" alt="" />';
      document.getElementById('polaroid-overlay').classList.add('open');
      card.classList.add('zooming-in');
    });
  });
</script>
</body>
</html>
"""


def _fixture_site(tmp_path: Path) -> Path:
    site = tmp_path / "site"
    dist = site / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text(FIXTURE_HTML)
    Image.new("RGB", (40, 40), (128, 0, 128)).save(dist / "opened.png")
    return site


def _shot(site: Path, out: Path, **kw) -> Image.Image:
    path = asyncio.run(screenshot.screenshot_board(site, out, build=False, **kw))
    return Image.open(path).convert("RGB")


def test_screenshot_without_pin_id_captures_cloth(tmp_path):
    """No pin_id -> today's behavior: the .cloth element shot, not the viewport."""
    img = _shot(_fixture_site(tmp_path), tmp_path / "board.png")
    assert img.size == (600, 600)
    assert img.getpixel((300, 300)) == (200, 200, 200)  # cloth, no overlay
    assert img.getpixel((150, 150)) == (0, 0, 255)  # the twen pin at 25%/25%


def test_screenshot_with_pin_id_captures_opened_view(tmp_path):
    """pin_id -> click the matching .board-pin and, once the lightbox card has
    finished zooming and its injected artwork has loaded, shoot a close-up
    clip of the card plus CLIP_PAD of backdrop — not the tiny-card viewport."""
    img = _shot(_fixture_site(tmp_path), tmp_path / "open.png", pin_id="twen")
    pad = screenshot.CLIP_PAD
    assert img.size == (400 + 2 * pad, 400 + 2 * pad)  # the card union, padded
    assert img.getpixel((10, 10)) == (255, 0, 0)  # backdrop ring inside the pad
    # pure green only at animation end (opacity ramps 0 -> 1): an early shot
    # would blend the card into the red backdrop
    assert img.getpixel((pad + 200, pad + 200)) == (0, 255, 0)  # card center
    assert img.getpixel((pad + 40, pad + 40)) == (128, 0, 128)  # injected artwork


def test_screenshot_opened_clip_includes_floating_title(tmp_path):
    """A pin with a floating title clips to the card+title UNION: the title
    band (40px + its 20px gap) rides above the card instead of being cropped."""
    img = _shot(_fixture_site(tmp_path), tmp_path / "open.png", pin_id="desert-not-barren")
    pad = screenshot.CLIP_PAD
    assert img.size == (400 + 2 * pad, 460 + 2 * pad)  # union is 60px taller
    assert img.getpixel((10, 10)) == (255, 0, 0)  # backdrop ring survives
    assert img.getpixel((pad + 200, pad + 20)) == (255, 255, 0)  # the title band
    assert img.getpixel((pad + 200, pad + 260)) == (0, 255, 0)  # card center below it
    assert img.getpixel((pad + 40, pad + 100)) == (128, 0, 128)  # artwork still inside


def test_screenshot_pin_id_match_is_normalized(tmp_path):
    """A humanized name resolves to its slug when the match is unambiguous."""
    img = _shot(_fixture_site(tmp_path), tmp_path / "open.png", pin_id="Desert Not Barren")
    pad = screenshot.CLIP_PAD
    assert img.getpixel((pad + 200, pad + 260)) == (0, 255, 0)


def test_screenshot_unknown_pin_id_lists_available(tmp_path):
    """A miss must name the polaroids that do exist so the agent can retry."""
    with pytest.raises(ScreenshotError) as err:
        _shot(_fixture_site(tmp_path), tmp_path / "open.png", pin_id="nope")
    msg = str(err.value)
    assert "'nope'" in msg
    assert "twen" in msg and "desert-not-barren" in msg


# --- what the build is launched with ------------------------------------------
# The build runs the site's own config and package scripts, which the agent
# edits, so the exact argv and the exact environment are part of the contract:
# nothing the worker holds may ride along, and no .npmrc may talk npm into
# preloading code or swapping the shell.

# a sample of what the worker actually carries (render.yaml) plus the two npm
# settings that would be code execution if they reached the child
SECRET_NAMES = (
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "PARATROOPER_GITHUB_TOKEN",
    "PARATROOPER_APP_TOKEN",
    "PARATROOPER_REMOTE",
    "SPOTIFY_CLIENT_ID",
    "SPOTIFY_CLIENT_SECRET",
    "REDIS_URL",
    "NODE_OPTIONS",
    "npm_config_script_shell",
)


class _FakeProc:
    """Stands in for npm: succeeds, says nothing."""

    returncode = 0

    async def communicate(self):
        return b"", b""


def _record_launches(monkeypatch) -> list[dict]:
    """Swap the subprocess launcher for a recorder, so the npm calls can be
    read back without npm (or the registry) coming near the test. Only npm is
    faked — Playwright spawns its driver the same way and still needs to."""
    calls = []
    real_exec = asyncio.create_subprocess_exec

    async def fake_exec(*cmd, **kwargs):
        if cmd[:1] != ("npm",):
            return await real_exec(*cmd, **kwargs)
        calls.append({"cmd": cmd, **kwargs})
        return _FakeProc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    return calls


def test_npm_argv_is_pinned(tmp_path, monkeypatch):
    """Both npm calls, argv for argv: install scripts off on the install, and
    on the build the two injectable settings nailed shut on the command line
    — ahead of the script name, where npm reads them as its own flags."""
    calls = _record_launches(monkeypatch)
    site = _fixture_site(tmp_path)  # no node_modules -> the install runs too
    asyncio.run(screenshot.screenshot_board(site, tmp_path / "board.png", build=True))

    assert [c["cmd"] for c in calls] == [
        (
            "npm", "ci", "--no-audit", "--no-fund",
            "--ignore-scripts", "--node-options=", "--script-shell=/bin/sh",
        ),
        (
            "npm", "run",
            "--ignore-scripts", "--node-options=", "--script-shell=/bin/sh", "build",
        ),
    ]
    build = calls[1]["cmd"]
    for flag in ("--ignore-scripts", "--node-options=", "--script-shell=/bin/sh"):
        assert build.index(flag) < build.index("build"), flag
    assert all(c["cwd"] == site for c in calls)


def test_npm_env_is_the_allowlist_and_nothing_else(tmp_path, monkeypatch):
    """Every npm child gets the allowlist, and the worker's secrets stay home."""
    for name in SECRET_NAMES:
        monkeypatch.setenv(name, "sekret-value")
    monkeypatch.setenv("HOME", "/home/app")
    monkeypatch.setenv("LANG", "en_US.UTF-8")
    monkeypatch.setenv("TMPDIR", "/tmp")
    calls = _record_launches(monkeypatch)
    site = tmp_path / "site"
    site.mkdir()
    # faked npm builds nothing, so the capture stops at the missing dist: this
    # test is about what npm was handed, not about the picture
    with pytest.raises(ScreenshotError):
        asyncio.run(screenshot.screenshot_board(site, tmp_path / "b.png"))

    assert len(calls) == 2
    for call in calls:
        env = call["env"]
        assert set(env) == {"PATH", "HOME", "LANG", "TMPDIR", "CI"}
        assert env["CI"] == "1"
        assert env["HOME"] == "/home/app"
        for name in SECRET_NAMES:
            assert name not in env
        assert "sekret-value" not in "".join(env.values())


def test_clean_env_drops_what_the_host_has_not_set(monkeypatch):
    """LANG and TMPDIR ride along only when they exist; PATH is never empty,
    since Python would then search the checkout the agent writes into."""
    monkeypatch.setenv("HOME", "/home/app")
    monkeypatch.delenv("LANG", raising=False)
    monkeypatch.delenv("TMPDIR", raising=False)
    assert set(screenshot._clean_env()) == {"PATH", "HOME", "CI"}

    monkeypatch.delenv("PATH", raising=False)
    assert screenshot._clean_env()["PATH"] == screenshot.FALLBACK_PATH


def test_browser_is_launched_with_the_same_scrubbed_env(tmp_path, monkeypatch):
    """Chromium is a child of this step as well, so it is handed the allowlist
    too — once, at launch — and still renders the board."""
    seen = []
    real = screenshot._clean_env

    def spy():
        seen.append(real())
        return seen[-1]

    monkeypatch.setattr(screenshot, "_clean_env", spy)
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "sekret-value")
    img = _shot(_fixture_site(tmp_path), tmp_path / "board.png")

    assert len(seen) == 1  # build=False: the browser is the only child
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in seen[0]
    assert img.getpixel((300, 300)) == (200, 200, 200)  # and the capture worked


# --- the tool wrapper (tools.py) ---------------------------------------------

def _tool_handlers(ctx) -> dict:
    """Build the tool server while capturing each handler by bare name (same
    trick as test_agent.py) so the wrapper can be called directly."""
    import paratrooper.agent.tools as tools_mod

    handlers = {}
    orig = tools_mod.create_sdk_mcp_server

    def capture(name, version, tools):
        for t in tools:
            handlers[t.name] = t.handler
        return orig(name=name, version=version, tools=tools)

    tools_mod.create_sdk_mcp_server = lambda name, version, tools: capture(name, version, tools)
    try:
        tools_mod.build_tool_server(ctx)
    finally:
        tools_mod.create_sdk_mcp_server = orig
    return handlers


def test_screenshot_tool_forwards_pin_id(tmp_path, monkeypatch):
    """The tool hands pin_id through to the capture; an absent or blank arg
    degrades to the plain board call (pin_id=None), keeping today's path."""
    calls = []

    async def fake_shot(site_root, out_path, *, pin_id=None):
        calls.append(pin_id)
        return Path(out_path)

    monkeypatch.setattr("paratrooper.agent.screenshot.screenshot_board", fake_shot)
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
    ctx = ToolContext(config=cfg, changelog=memory.Changelog(cfg.changelog))
    handlers = _tool_handlers(ctx)

    out = asyncio.run(handlers["screenshot_board"]({"pin_id": "twen"}))
    assert not out.get("is_error"), out
    asyncio.run(handlers["screenshot_board"]({}))
    asyncio.run(handlers["screenshot_board"]({"pin_id": "   "}))
    assert calls == ["twen", None, None]
    assert ctx.last_screenshot == str(cfg.site_root / "_paratrooper_board.png")
