"""Paths config loader + secret access.

Two kinds of configuration, deliberately separated:

* **Paths & site settings** live in a TOML file (folders + repo settings — no
  secrets). Loaded by :func:`load_config`. Folders: ``inbox`` (raw staged
  photos), ``pins_dir``, ``archive_dir``; plus the changelog path and the
  site-repo remote/default-branch/branch-prefix.
* **Secrets** are **environment variables, never a config file** — the app
  bearer token, GitHub PAT, ``CLAUDE_CODE_OAUTH_TOKEN`` / ``ANTHROPIC_API_KEY``,
  Spotify id/secret, VAPID keys. Read via :func:`require_env` / the typed
  accessors, which **hard-error loudly** when a required secret is missing
  (matching the no-silent-fallback posture for auth).
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

DEFAULT_CONFIG_PATH = "config/paths.toml"
DEFAULT_BRANCH = "main"
DEFAULT_BRANCH_PREFIX = "paratrooper"
# Commit identity: the paratrooper-98cc GitHub App's bot user. GitHub links a
# contributor (avatar + hyperlink) only when the commit email resolves to a
# real identity, and this <bot-user-id>+<slug>@users.noreply address is that
# bot's. Self-hosters swap in their own app via [site] git_name/git_email or
# the PARATROOPER_GIT_* env vars.
DEFAULT_GIT_NAME = "paratrooper-98cc[bot]"
DEFAULT_GIT_EMAIL = "301089772+paratrooper-98cc[bot]@users.noreply.github.com"
# Standardized asset filenames inside a pin folder (post-refactor contract).
PREVIEW_ASSET = "preview.webp"  # the pinned/board preview image
OPENED_ASSET = "opened.webp"  # the larger "opened" artwork (dual-asset pins, e.g. substack)


class ConfigError(RuntimeError):
    """Raised on a missing/invalid config or a missing required secret. Loud by design."""


def validate_branch_prefix(prefix: str) -> str:
    """Return ``prefix`` unchanged once it can actually name a branch namespace.

    That one word is the single source of truth for the agent's branches: it
    fences the PreToolUse guard, names the branches the system prompt tells the
    agent to create, and filters the Publish fallback's PR lookup. A word that
    cannot do all three (empty/not a string, carrying its own slash, or split by
    whitespace) is a misconfiguration, so it raises rather than quietly falling
    back to the default and leaving the three in disagreement.
    """
    if not isinstance(prefix, str) or not prefix:
        raise ConfigError(
            f"[site].branch_prefix must be a non-empty string (got {prefix!r}): "
            'name the branch namespace, e.g. "paratrooper"'
        )
    if "/" in prefix:
        raise ConfigError(
            f"[site].branch_prefix {prefix!r} must not contain '/': write the bare "
            'word (e.g. "paratrooper"), the separator before the branch name is added'
        )
    if any(ch.isspace() for ch in prefix):
        raise ConfigError(
            f"[site].branch_prefix {prefix!r} must not contain whitespace: "
            "a branch namespace is one word"
        )
    return prefix


@dataclass
class Config:
    """Resolved worker configuration. Folders are absolute paths.

    Pin stages (user-defined layout, all under ``src/content/``): the rendered
    board lives in ``pins-on-display`` (the only dir Astro's glob loads),
    archived pins move to ``pins-off-display``, and pins staged for future
    publishing wait in ``pins-for-later``.
    """

    inbox: Path  # staging dir for uploaded photos (persistent disk on Render)
    site_root: Path  # the website repo checkout root
    pins_dir: Path  # pins-on-display: the rendered board
    archive_dir: Path  # pins-off-display: archived pins move here
    later_dir: Path  # pins-for-later: staged for future publishing
    changelog: Path  # the paratrooper changelog, committed in the website repo
    remote: str | None  # site repo git remote URL (None => use the checkout's origin)
    default_branch: str  # the branch the agent must never push to (merge target)
    branch_prefix: str  # feature-branch prefix, e.g. "paratrooper" -> paratrooper/<pin>-<slug>
    git_name: str = DEFAULT_GIT_NAME  # commit author/committer name
    git_email: str = DEFAULT_GIT_EMAIL  # commit email — must resolve to a GitHub identity to render linked


def _resolve(base: Path, value: str) -> Path:
    p = Path(value).expanduser()
    return p if p.is_absolute() else (base / p).resolve()


def load_config(path: str | os.PathLike[str] | None = None) -> Config:
    """Load the TOML paths/site config. ``path`` defaults to ``$PARATROOPER_CONFIG``
    or ``config/paths.toml``. Relative paths in the file resolve against the
    config file's directory. Raises :class:`ConfigError` if the file is missing
    or malformed."""
    cfg_path = Path(path or os.environ.get("PARATROOPER_CONFIG", DEFAULT_CONFIG_PATH))
    if not cfg_path.is_file():
        raise ConfigError(f"config file not found: {cfg_path} (set PARATROOPER_CONFIG)")
    try:
        with cfg_path.open("rb") as fh:
            raw = tomllib.load(fh)
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"invalid TOML in {cfg_path}: {exc}") from exc

    base = cfg_path.parent
    paths = raw.get("paths", {})
    site = raw.get("site", {})

    def _root(env_name: str, toml_key: str) -> Path:
        # env wins over TOML so render.yaml can set per-service absolute paths
        # without editing the committed (local-dev) config.
        val = os.environ.get(env_name) or paths.get(toml_key)
        if not val:
            raise ConfigError(f"{toml_key}: set [paths].{toml_key} in {cfg_path} or ${env_name}")
        return _resolve(base, val)

    site_root = _root("PARATROOPER_SITE_ROOT", "site_root")
    inbox = _root("PARATROOPER_INBOX", "inbox")
    content = site_root / "src" / "content"
    # Only pins-on-display is inside the Astro glob base; the other two stages
    # are siblings so they never render.
    pins_dir = (
        _resolve(base, paths["pins_dir"])
        if "pins_dir" in paths
        else content / "pins-on-display"
    )
    archive_dir = (
        _resolve(base, paths["archive_dir"])
        if "archive_dir" in paths
        else content / "pins-off-display"
    )
    later_dir = (
        _resolve(base, paths["later_dir"])
        if "later_dir" in paths
        else content / "pins-for-later"
    )
    changelog = (
        _resolve(base, paths["changelog"])
        if "changelog" in paths
        else site_root / "paratrooper-changelog.jsonl"
    )

    return Config(
        inbox=inbox,
        site_root=site_root,
        pins_dir=pins_dir,
        archive_dir=archive_dir,
        later_dir=later_dir,
        changelog=changelog,
        remote=site.get("remote") or os.environ.get("PARATROOPER_REMOTE"),
        default_branch=site.get("default_branch", DEFAULT_BRANCH),
        branch_prefix=validate_branch_prefix(site.get("branch_prefix", DEFAULT_BRANCH_PREFIX)),
        git_name=os.environ.get("PARATROOPER_GIT_NAME") or site.get("git_name", DEFAULT_GIT_NAME),
        git_email=os.environ.get("PARATROOPER_GIT_EMAIL") or site.get("git_email", DEFAULT_GIT_EMAIL),
    )


# --- Secrets (environment only) ---------------------------------------------

def require_env(name: str) -> str:
    """Return env var ``name`` or raise :class:`ConfigError` loudly. Use for any
    secret whose absence must crash the job visibly rather than degrade."""
    val = os.environ.get(name)
    if not val:
        raise ConfigError(f"required environment variable {name} is unset or empty")
    return val


def app_token() -> str:
    """Shared bearer token the PWA presents on every request/socket handshake."""
    return require_env("PARATROOPER_APP_TOKEN")


def github_token() -> str:
    """Fine-grained PAT (Contents + Pull requests write) for branch push + PR open."""
    return require_env("PARATROOPER_GITHUB_TOKEN")


def spotify_credentials() -> tuple[str, str]:
    """``(client_id, client_secret)`` for the Spotify client-credentials flow."""
    return require_env("SPOTIFY_CLIENT_ID"), require_env("SPOTIFY_CLIENT_SECRET")
