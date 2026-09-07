"""Paths config loader + secret access.

Two kinds of configuration, deliberately separated:

* **Paths & site settings** live in a TOML file (folders + repo settings — no
  secrets). Loaded by :func:`load_config`. Folders: ``inbox`` (raw staged
  photos), ``pins_dir``, ``archive_dir``; plus the changelog path and the
  site-repo remote/default-branch/branch-prefix.
* **Secrets** are **environment variables, never a config file** — the app
  bearer token, the GitHub App's ids and private key, ``CLAUDE_CODE_OAUTH_TOKEN`` /
  ``ANTHROPIC_API_KEY``, Spotify id/secret, VAPID keys. Read via
  :func:`require_env` / the typed accessors, which **hard-error loudly** when a
  required secret is missing (matching the no-silent-fallback posture for auth).
  The App's private key is one of these: a variable like the rest since
  2026-09-07, read once by :func:`take_github_app` and taken out of the
  environment with the two ids. It was a mounted file until then; no path is
  read any more and none is consulted as a fallback.
"""

from __future__ import annotations

import base64
import contextlib
import logging
import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

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


# --- the GitHub App the worker authenticates as (checklist 2.2) --------------
#
# The personal access token this replaced never expired, so a leak was
# permanent. These three describe an App instead: the worker signs a JWT with
# the private key and trades it for an installation token that lives an hour.
# The names are the ones already set on the deploy and are read verbatim.

GITHUB_APP_VARS = ("PARATROOPER_GITHUB_APP_ID", "PARATROOPER_GITHUB_APP_INSTALLATION_ID")
# The private key. It was a mounted secret file until 2026-09-07; the file was
# deleted from the deploy and the key set as an environment variable, so it now
# travels the same road as the two ids: the start-up wrapper hands it over in
# its file and nothing here ever reads a path. A PEM does not fit the handoff
# file's one NAME=value per line, so the wrapper base64-encodes it under the
# second name below; unwrapped, which is local development, the first name holds
# the PEM itself. Which of the two is read is decided by which one is set, and
# there is no third road: the old file path is not consulted as a backup.
GITHUB_APP_KEY_VAR = "PARATROOPER_GITHUB_APP_KEY_PEM"
GITHUB_APP_KEY_HANDOFF_VAR = f"{GITHUB_APP_KEY_VAR}_B64"
# everything about the App that must be out of os.environ before a session exists
GITHUB_APP_SECRET_VARS = (*GITHUB_APP_VARS, GITHUB_APP_KEY_VAR, GITHUB_APP_KEY_HANDOFF_VAR)


@dataclass(frozen=True)
class GitHubApp:
    """Everything needed to mint an installation token, held in memory only."""

    app_id: str
    installation_id: str
    private_key: str


_github_app: GitHubApp | None = None


def normalise_private_key(raw: str) -> str:
    """A PEM, whichever way the value was pasted.

    Render's editor takes a real multi-line value, and that is the intended
    form. But a key copied out of a terminal, a JSON blob or a shell variable
    arrives with its line breaks written out as the two characters backslash and
    n, and that paste is silently unusable: it looks right in the dashboard and
    signs nothing. Both forms are accepted here and both end up as the same
    text. Nothing else about the value is touched."""
    text = raw.strip()
    if "\\n" in text:
        text = text.replace("\\r\\n", "\n").replace("\\n", "\n")
    return text.replace("\r\n", "\n").strip() + "\n"


def _github_app_key() -> str:
    """The App's private key as a PEM, from whichever name carries it, checked
    against the parser that will have to sign with it.

    The check is here rather than at the first signature because a key that does
    not parse is a worker that fails every message with a JWT error, hours after
    the deploy that broke it. Failing at the door names the variable instead."""
    encoded = os.environ.get(GITHUB_APP_KEY_HANDOFF_VAR, "").strip()
    if encoded:
        try:
            raw = base64.b64decode(encoded, validate=True).decode()
        except (ValueError, UnicodeDecodeError) as exc:
            logger.error(
                "%s did not decode: the start-up wrapper writes the value of %s "
                "base64-encoded and this is not that (%s)",
                GITHUB_APP_KEY_HANDOFF_VAR, GITHUB_APP_KEY_VAR, exc,
            )
            raise ConfigError(
                f"{GITHUB_APP_KEY_HANDOFF_VAR} is not base64: {exc}"
            ) from exc
    else:
        raw = os.environ.get(GITHUB_APP_KEY_VAR, "")
    if not raw.strip():
        logger.error(
            "%s is unset or empty: it carries the GitHub App's private key, which "
            "is the only credential the worker has for GitHub",
            GITHUB_APP_KEY_VAR,
        )
        raise ConfigError(
            f"required environment variable {GITHUB_APP_KEY_VAR} is unset or empty: "
            "it carries the GitHub App's private key, which the worker signs its "
            "token requests with"
        )
    pem = normalise_private_key(raw)
    # imported here, not at the top: `cryptography` arrives with the agent
    # extra's pyjwt[crypto] and the web service installs neither.
    from cryptography.hazmat.primitives.serialization import load_pem_private_key

    try:
        load_pem_private_key(pem.encode(), password=None)
    except Exception as exc:
        logger.error(
            "%s does not parse as a private key (%s). Paste the App's .pem in "
            "full, BEGIN and END lines included, either across several lines or "
            "with the line breaks written as backslash-n",
            GITHUB_APP_KEY_VAR, exc,
        )
        raise ConfigError(
            f"{GITHUB_APP_KEY_VAR} does not parse as a private key: {exc}"
        ) from exc
    return pem


def take_github_app() -> GitHubApp:
    """The App's identity and private key, read once and held here.

    All three arrive in the environment, put there by the start-up wrapper out
    of its own file, so they are in no launch record; all three are taken back
    out of the environment here, before any session exists, because the SDK
    builds the CLI's environment from ``os.environ`` and can only add to it.
    Every missing piece raises :class:`ConfigError` naming it, with a log line
    saying the same thing in one sentence; nothing falls back to a personal
    token, because from item 6 on there is not one, and nothing falls back to
    the secret file the key used to arrive in, because it is gone.

    Nothing is consumed until all three are in hand, so a boot that fails on a
    missing value leaves the environment exactly as it found it.
    """
    global _github_app
    if _github_app is not None:
        return _github_app
    app_id, installation_id = (os.environ.get(name, "") for name in GITHUB_APP_VARS)
    for name, value in zip(GITHUB_APP_VARS, (app_id, installation_id), strict=True):
        if not value:
            logger.error(
                "%s is unset or empty: it names the GitHub App the worker pushes "
                "and opens pull requests as", name,
            )
            raise ConfigError(
                f"required environment variable {name} is unset or empty: it names "
                "the GitHub App the worker pushes and opens pull requests as"
            )
    private_key = _github_app_key()
    _github_app = GitHubApp(app_id, installation_id, private_key)
    for name in GITHUB_APP_SECRET_VARS:
        os.environ.pop(name, None)
    return _github_app


# --- worker-only secrets, held here instead of in the environment ------------
#
# The Agent SDK builds the CLI's environment from os.environ and can only merge
# on top of it, never subtract, so absence from os.environ is the only lever
# that keeps a value out of the agent's session and out of every shell it opens.
# These are read once at boot, removed from the environment, and kept here.

SPOTIFY_VARS = ("SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET")

# names the path the start-up wrapper wrote, and by being set at all says the
# wrapper ran. There is no third state and nothing is guessed from the file's
# presence: set means the file must be there, unset means read the environment.
SECRETS_FILE_VAR = "PARATROOPER_SECRETS_FILE"


def load_worker_secrets() -> dict[str, str]:
    """Read the values the start-up wrapper handed over, put them back into
    ``os.environ`` for the boot readers that follow, and delete the file.
    Returns what was read.

    The wrapper exists because ``/proc/<pid>/environ`` is fixed at exec time:
    the worker can only avoid holding a value in its launch record by never
    being started with it. Values arriving this way land in ``os.environ``
    after the process started, so they are in no launch record, and the readers
    that follow take them straight back out again.

    Which path runs is decided by one explicit variable and never by guessing.
    With ``PARATROOPER_SECRETS_FILE`` set the file must exist; a missing one is
    a boot error naming the path. With it unset — local development, where
    nothing wraps the process — the values are read from the environment
    directly, exactly as before."""
    path = os.environ.get(SECRETS_FILE_VAR)
    if not path:
        return {}  # no wrapper: the environment already holds them
    handoff = Path(path)
    if not handoff.is_file():
        raise ConfigError(
            f"{SECRETS_FILE_VAR} names {path} but there is no file there. The "
            "start-up wrapper writes it and the worker reads it once at boot; "
            f"if this process is meant to read the environment directly, unset "
            f"{SECRETS_FILE_VAR}."
        )
    values: dict[str, str] = {}
    for number, line in enumerate(handoff.read_text().splitlines(), start=1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, separator, value = line.partition("=")
        if not separator or not name:
            raise ConfigError(f"{path} line {number} is not NAME=value: {line!r}")
        values[name] = value
    os.environ.update(values)
    # emptied before it is removed: if the unlink is refused for any reason the
    # values are gone regardless, which is the half that matters
    with contextlib.suppress(OSError):
        handoff.write_text("")
    try:
        handoff.unlink()
    except OSError as exc:
        logger.warning("could not delete the secrets handoff %s: %s", path, exc)
    return values

_spotify: tuple[str, str] | None = None
_spotify_taken = False


def take_spotify_credentials() -> tuple[str, str] | None:
    """Read Spotify's id and secret out of the environment **once**, remove both
    names from it, and hold the pair in module state. Returns the pair, or
    ``None`` when Spotify is not configured.

    Absence is not a fallback: name search is an optional feature and links
    resolve without it, exactly as before. Called from the worker's boot, before
    any session exists; a second call returns what the first one took, since the
    environment no longer has it."""
    global _spotify, _spotify_taken
    if _spotify_taken:
        return _spotify
    client_id = os.environ.pop("SPOTIFY_CLIENT_ID", "")
    client_secret = os.environ.pop("SPOTIFY_CLIENT_SECRET", "")
    _spotify = (client_id, client_secret) if client_id and client_secret else None
    _spotify_taken = True
    return _spotify


def spotify_credentials() -> tuple[str, str]:
    """``(client_id, client_secret)`` for the Spotify client-credentials flow.
    Raises :class:`ConfigError` when Spotify is not configured, which the caller
    treats as "no name search" rather than an error."""
    creds = take_spotify_credentials()
    if creds is None:
        raise ConfigError(
            "Spotify is not configured: set " + " and ".join(SPOTIFY_VARS)
        )
    return creds
