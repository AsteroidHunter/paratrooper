"""Deployment configuration + secret access.

Three kinds of value, deliberately separated:

* **Deployment configuration** — the profile, the model, the notification texts,
  the upload expiry and, on ``pinboard``, everything that describes one person's
  site: owner, address, remote, branch names, commit identity, stage folders,
  changelog and the optional screenshot shape. All of it lives in one TOML
  source which reaches a running service through exactly one environment
  variable, ``PARATROOPER_CONFIG_B64``, holding that text base64-encoded. There
  is no path variable, no mounted file, no search order and no second source: a
  service either has that one value or does not start. ``config/paratrooper.toml``
  is the thing a human edits and ``config/paratrooper.example.toml`` documents
  every field; neither is ever read by a running service.
* **Machine paths** stay environment values, because they are the two things
  that genuinely differ between two containers reading one source:
  ``PARATROOPER_INBOX`` on both services and ``PARATROOPER_SITE_ROOT`` on the
  pinboard worker. They name a place on a disk rather than anything personal.
* **Secrets** are **environment variables, never the config source** — the app
  bearer token, the GitHub App's ids and private key, ``CLAUDE_CODE_OAUTH_TOKEN`` /
  ``ANTHROPIC_API_KEY``, Spotify id/secret, VAPID keys. Read via
  :func:`require_env` / the typed accessors, which **hard-error loudly** when a
  required secret is missing (matching the no-silent-fallback posture for auth).
  The App's private key is one of these: a variable like the rest since
  2026-09-07, read once by :func:`take_github_app` and taken out of the
  environment with the two ids. It was a mounted file until then; no path is
  read any more and none is consulted as a fallback.

**Pure validation vs runtime loading.** :func:`parse_config` and
:func:`validate_config` are pure: text (or a parsed table) in, a :class:`Config`
out, with no environment, no filesystem and no credential involved. That is what
lets ``python -m paratrooper.deploy check`` validate a source on a laptop that
has no inbox, no checkout and no secrets, using the very same code the service
boots with rather than a second implementation that can drift from it.
:func:`load_config` is that function plus the two machine paths.
"""

from __future__ import annotations

import base64
import binascii
import contextlib
import logging
import os
import tomllib
from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath
from typing import Any

logger = logging.getLogger(__name__)

# The one route. Its value is standard base64 (RFC 4648, padding kept) of the
# UTF-8 bytes of the TOML source.
CONFIG_VAR = "PARATROOPER_CONFIG_B64"
# The path variable this replaced. The loader refuses to start while it is still
# set: a half-finished migration has to be loud rather than look like a working
# deployment that quietly read something else.
LEGACY_CONFIG_VAR = "PARATROOPER_CONFIG"
INBOX_VAR = "PARATROOPER_INBOX"
SITE_ROOT_VAR = "PARATROOPER_SITE_ROOT"

SCHEMA_VERSION = 1
PINBOARD, PLAIN = "pinboard", "plain"
PROFILES = (PINBOARD, PLAIN)
# Phase 1 ships the pinboard refactor only. The plain profile is a described
# shape with no session behind it yet, and a source that asks for one would boot
# a worker with no tools rather than fail, so it is refused by name until the
# code that runs it exists.
IMPLEMENTED_PROFILES = (PINBOARD,)
# A photo only has to survive until the worker picks it up; never infinite.
TTL_HOURS_MIN, TTL_HOURS_MAX = 1, 168

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
            f"[pinboard].branch_prefix must be a non-empty string (got {prefix!r}): "
            'name the branch namespace, e.g. "paratrooper"'
        )
    if "/" in prefix:
        raise ConfigError(
            f"[pinboard].branch_prefix {prefix!r} must not contain '/': write the bare "
            'word (e.g. "paratrooper"), the separator before the branch name is added'
        )
    if any(ch.isspace() for ch in prefix):
        raise ConfigError(
            f"[pinboard].branch_prefix {prefix!r} must not contain whitespace: "
            "a branch namespace is one word"
        )
    return prefix


# --- the loaded shape --------------------------------------------------------


@dataclass(frozen=True)
class Notifications:
    """Push bodies both profiles have. ``reply`` is the body for a reply with no
    text of its own; ``error`` is the body for a failed job."""

    reply: str
    error: str


@dataclass(frozen=True)
class Uploads:
    ttl_hours: int  # 1..168; how long a staged photo lives in the shared store

    @property
    def ttl_seconds(self) -> int:
        """What both readers actually want. The web writes it onto every staged
        blob and the worker quotes the hours back to the person when a photo is
        gone, so the two must come from this one number rather than a module
        default either of them could keep after the other moved."""
        return self.ttl_hours * 3600


@dataclass(frozen=True)
class PinboardNotifications:
    screenshot: str
    pr: str


@dataclass(frozen=True)
class ScreenshotConfig:
    """The shape of one site, for the board capture.

    Only what describes a *site* lives here. ``screenshot.NPM_HARDENING`` and
    ``INSTALL_CMD`` deliberately stay in code: the ignore-scripts flag, the
    emptied node options and the fixed script shell are what keep a build the
    agent can edit from becoming code execution, and a value in a configuration
    file is a value an edit can drop. ``build_script`` therefore carries the npm
    script name and nothing else.
    """

    build_script: str
    dist: str
    viewport: tuple[int, int]
    selector: str
    pin_selector: str
    card_selector: str
    title_selector: str


@dataclass(frozen=True)
class PinboardConfig:
    """Everything that describes one person's pinboard deployment.

    The four site paths are held exactly as the source wrote them, relative to
    the site root, and resolved through the properties below. That split is what
    lets the web service carry this object without a checkout: it needs the
    branch names and the remote, never a folder on the worker's disk. The
    pinboard worker binds ``site_root`` at boot and the same attribute names
    then answer with absolute paths.
    """

    owner: str  # the person the prompt, two tool descriptions and two denials name
    site: str  # the address the prompt names
    remote: str  # the site repository, always explicit: never read back off the checkout
    default_branch: str  # never pushed to; the Publish merge target
    branch_prefix: str  # guard, prompt, Publish lookup — one bare word
    git_name: str  # commit identity on the checkout
    git_email: str  # must resolve to a GitHub identity to render linked
    # relative to the site root; the three stages share one parent
    pins_rel: str
    archive_rel: str
    later_rel: str
    changelog_rel: str
    notifications: PinboardNotifications
    screenshot: ScreenshotConfig | None = None
    site_root: Path | None = None  # env PARATROOPER_SITE_ROOT; the worker requires it

    def _under_root(self, relative: str, name: str) -> Path:
        if self.site_root is None:
            raise ConfigError(
                f"{name} is relative to the site root and this process has no "
                f"site root: set ${SITE_ROOT_VAR}. (The web service is not meant "
                "to reach for one — read the relative value instead.)"
            )
        return self.site_root / relative

    @property
    def pins_dir(self) -> Path:
        """pins-on-display: the rendered board, the only stage the site loads."""
        return self._under_root(self.pins_rel, "pins_dir")

    @property
    def archive_dir(self) -> Path:
        """pins-off-display: archived pins move here."""
        return self._under_root(self.archive_rel, "archive_dir")

    @property
    def later_dir(self) -> Path:
        """pins-for-later: staged for future publishing."""
        return self._under_root(self.later_rel, "later_dir")

    @property
    def changelog(self) -> Path:
        return self._under_root(self.changelog_rel, "changelog")

    @property
    def stages_parent(self) -> str:
        """The one folder the three stages sit in, as the prompt says it.

        Validation has already refused a source whose stages have different
        parents, so reading it off the first one is reading it off all three.
        """
        return str(PurePosixPath(self.pins_rel).parent)

    @property
    def pins_name(self) -> str:
        return PurePosixPath(self.pins_rel).name

    @property
    def archive_name(self) -> str:
        return PurePosixPath(self.archive_rel).name

    @property
    def later_name(self) -> str:
        return PurePosixPath(self.later_rel).name


@dataclass(frozen=True)
class Config:
    """One deployment's configuration, as the services hold it.

    ``inbox`` is ``None`` on a config that was only *validated* (the local
    ``check`` command, and every schema test): it is a machine path, bound by
    :func:`load_config` from the environment. Anything returned by
    :func:`load_config` has it.
    """

    schema: int
    profile: str
    model: str
    notifications: Notifications
    uploads: Uploads
    # Shared, optional, off unless a deployer says otherwise — on both profiles.
    # Not a product control and not reachable from inside a turn: see the switch
    # written in agent/worker.py for what it does and what it costs.
    shell_isolation: bool = False
    inbox: Path | None = None  # env PARATROOPER_INBOX, required by both services
    pinboard: PinboardConfig | None = None  # None on plain

    @property
    def is_pinboard(self) -> bool:
        return self.profile == PINBOARD

    def require_pinboard(self) -> PinboardConfig:
        """The pinboard block, or a loud error naming the profile that has none.

        Used by the code paths that only exist on pinboard, so that a dispatch
        bug reads as one sentence about the profile instead of an
        ``AttributeError`` on ``None`` three frames further in."""
        if self.pinboard is None:
            raise ConfigError(
                f"this deployment's profile is {self.profile!r}, which has no "
                "pinboard configuration: the site, its repository and its pin "
                "stages exist only under profile = \"pinboard\""
            )
        return self.pinboard

    def require_inbox(self) -> Path:
        if self.inbox is None:
            raise ConfigError(
                f"no inbox path is bound: set ${INBOX_VAR}. (A config that was "
                "only validated locally has no machine paths by design.)"
            )
        return self.inbox


# --- the pure validator (no environment, no filesystem, no secrets) ----------
#
# Shared verbatim by `deploy check`, `deploy push` and the runtime loader, so a
# source that passes on a laptop is a source the service accepts. Every
# rejection names the offending key and the source it came from, because the
# thing a deployer needs at 2am is which key in which place, not that something
# somewhere was invalid.

_TOP_LEVEL_KEYS = frozenset(
    {"schema", "model", "notifications", "uploads", "shell_isolation", "profile"}
)
_PINBOARD_KEYS = frozenset({
    "owner", "site", "remote", "default_branch", "branch_prefix", "git_name",
    "git_email", "pins_dir", "archive_dir", "later_dir", "changelog",
    "notifications", "screenshot",
})
_SCREENSHOT_KEYS = frozenset({
    "build_script", "dist", "viewport", "selector", "pin_selector",
    "card_selector", "title_selector",
})


def _where(table_name: str, key: str) -> str:
    return f"{table_name}.{key}" if table_name else key


def _reject_unknown(table: dict, allowed: frozenset[str], *, source: str, name: str) -> None:
    """An unknown key is an error, never something quietly ignored.

    A typo in a key that is silently dropped is a deployment running on a
    default nobody chose, which is exactly the class of surprise this whole
    change exists to remove."""
    unknown = sorted(set(table) - allowed)
    if unknown:
        raise ConfigError(
            f"{source}: unknown key {_where(name, unknown[0])!r}"
            + (f" (and {len(unknown) - 1} more)" if len(unknown) > 1 else "")
            + f". Known keys here: {', '.join(sorted(allowed))}"
        )


def _required(table: dict, key: str, *, source: str, name: str) -> Any:
    if key not in table:
        raise ConfigError(f"{source}: missing required key {_where(name, key)!r}")
    return table[key]


def _string(table: dict, key: str, *, source: str, name: str) -> str:
    value = _required(table, key, source=source, name=name)
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(
            f"{source}: {_where(name, key)!r} must be a non-empty string (got {value!r})"
        )
    return value


def _sub_table(table: dict, key: str, *, source: str, name: str) -> dict:
    value = _required(table, key, source=source, name=name)
    if not isinstance(value, dict):
        raise ConfigError(f"{source}: {_where(name, key)!r} must be a table (got {value!r})")
    return value


def _relative_path(table: dict, key: str, *, source: str, name: str) -> str:
    """A site path, as written, checked for the two ways it could point out of
    the checkout.

    Site paths are relative to the site root and to nothing else — never to the
    TOML source, the current directory or the image's own source tree. An
    absolute value would silently make the configuration name a place on one
    particular machine, and ``..`` would let it climb out of the checkout the
    agent is fenced inside."""
    raw = _string(table, key, source=source, name=name)
    if "\\" in raw:
        raise ConfigError(
            f"{source}: {_where(name, key)!r} must use '/' separators (got {raw!r})"
        )
    candidate = PurePosixPath(raw)
    if candidate.is_absolute():
        raise ConfigError(
            f"{source}: {_where(name, key)!r} must be relative to the site root, "
            f"not absolute (got {raw!r})"
        )
    if ".." in candidate.parts:
        raise ConfigError(
            f"{source}: {_where(name, key)!r} must stay inside the site root: "
            f"'..' is not allowed (got {raw!r})"
        )
    return str(candidate)


def _viewport(table: dict, *, source: str, name: str) -> tuple[int, int]:
    value = _required(table, "viewport", source=source, name=name)
    key = _where(name, "viewport")
    if not isinstance(value, list) or len(value) != 2:
        raise ConfigError(
            f"{source}: {key!r} must be two whole numbers, [width, height] (got {value!r})"
        )
    for part in value:
        # a TOML boolean is an int in Python; it is not a pixel count
        if isinstance(part, bool) or not isinstance(part, int) or part <= 0:
            raise ConfigError(
                f"{source}: {key!r} must be two positive whole numbers (got {value!r})"
            )
    return (value[0], value[1])


def _ttl_hours(table: dict, *, source: str) -> int:
    uploads = _sub_table(table, "uploads", source=source, name="")
    _reject_unknown(uploads, frozenset({"ttl_hours"}), source=source, name="uploads")
    value = _required(uploads, "ttl_hours", source=source, name="uploads")
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(
            f"{source}: 'uploads.ttl_hours' must be a whole number of hours (got {value!r})"
        )
    if not TTL_HOURS_MIN <= value <= TTL_HOURS_MAX:
        raise ConfigError(
            f"{source}: 'uploads.ttl_hours' must be between {TTL_HOURS_MIN} and "
            f"{TTL_HOURS_MAX} (got {value}). A staged photo only has to outlive the "
            "queue wait, and it is never kept for ever."
        )
    return value


def _screenshot_config(raw: dict, *, source: str) -> ScreenshotConfig:
    name = "pinboard.screenshot"
    _reject_unknown(raw, _SCREENSHOT_KEYS, source=source, name=name)
    build_script = _string(raw, "build_script", source=source, name=name)
    if build_script.startswith("-"):
        raise ConfigError(
            f"{source}: 'pinboard.screenshot.build_script' must name an npm script, "
            "not an option starting with '-'"
        )
    return ScreenshotConfig(
        build_script=build_script,
        dist=_relative_path(raw, "dist", source=source, name=name),
        viewport=_viewport(raw, source=source, name=name),
        selector=_string(raw, "selector", source=source, name=name),
        pin_selector=_string(raw, "pin_selector", source=source, name=name),
        card_selector=_string(raw, "card_selector", source=source, name=name),
        title_selector=_string(raw, "title_selector", source=source, name=name),
    )


def _pinboard_config(raw: dict, *, source: str) -> PinboardConfig:
    name = PINBOARD
    _reject_unknown(raw, _PINBOARD_KEYS, source=source, name=name)
    notifications = _sub_table(raw, "notifications", source=source, name=name)
    _reject_unknown(
        notifications, frozenset({"screenshot", "pr"}),
        source=source, name=f"{name}.notifications",
    )
    stages = {
        key: _relative_path(raw, key, source=source, name=name)
        for key in ("pins_dir", "archive_dir", "later_dir")
    }
    # The prompt tells the agent the three stages are sibling folders, and the
    # site renders exactly one of them, so a source that scatters them would
    # make the prompt untrue and could put the archive inside the glob base.
    parents = {str(PurePosixPath(value).parent) for value in stages.values()}
    if len(parents) != 1:
        raise ConfigError(
            f"{source}: 'pinboard.pins_dir', 'pinboard.archive_dir' and "
            f"'pinboard.later_dir' must be sibling folders sharing one parent "
            f"(got parents {sorted(parents)})"
        )
    if len(set(stages.values())) != 3:
        raise ConfigError(
            f"{source}: 'pinboard.pins_dir', 'pinboard.archive_dir' and "
            f"'pinboard.later_dir' must be three different folders (got "
            f"{sorted(stages.values())})"
        )
    screenshot = raw.get("screenshot")
    if screenshot is not None and not isinstance(screenshot, dict):
        raise ConfigError(
            f"{source}: 'pinboard.screenshot' must be a table (got {screenshot!r})"
        )
    prefix = _string(raw, "branch_prefix", source=source, name=name)
    try:
        prefix = validate_branch_prefix(prefix)
    except ConfigError as exc:
        raise ConfigError(f"{source}: {exc}") from exc
    return PinboardConfig(
        owner=_string(raw, "owner", source=source, name=name),
        site=_string(raw, "site", source=source, name=name),
        remote=_string(raw, "remote", source=source, name=name),
        default_branch=_string(raw, "default_branch", source=source, name=name),
        branch_prefix=prefix,
        git_name=_string(raw, "git_name", source=source, name=name),
        git_email=_string(raw, "git_email", source=source, name=name),
        pins_rel=stages["pins_dir"],
        archive_rel=stages["archive_dir"],
        later_rel=stages["later_dir"],
        changelog_rel=_relative_path(raw, "changelog", source=source, name=name),
        notifications=PinboardNotifications(
            screenshot=_string(
                notifications, "screenshot", source=source, name=f"{name}.notifications"
            ),
            pr=_string(notifications, "pr", source=source, name=f"{name}.notifications"),
        ),
        screenshot=(
            _screenshot_config(screenshot, source=source) if screenshot is not None else None
        ),
    )


def validate_config(raw: dict, *, source: str = CONFIG_VAR) -> Config:
    """Validate one parsed TOML source into a :class:`Config`. Pure.

    No environment is read, no path is touched and no credential is needed, so
    this is the same call a deployer makes on a laptop and the service makes at
    boot. ``source`` only names the thing being validated in error messages.
    """
    if not isinstance(raw, dict):
        raise ConfigError(f"{source}: the configuration must be a TOML table")
    # refused by name rather than as "unknown", because a [plain] table is the
    # mistake someone makes by symmetry with [pinboard] and deserves the reason
    if "plain" in raw:
        raise ConfigError(
            f"{source}: there is no '[plain]' table. The plain profile is the "
            "shared settings and nothing else; write profile = \"plain\" and stop."
        )
    _reject_unknown(raw, _TOP_LEVEL_KEYS | {PINBOARD}, source=source, name="")

    schema = _required(raw, "schema", source=source, name="")
    if isinstance(schema, bool) or not isinstance(schema, int):
        raise ConfigError(f"{source}: 'schema' must be a whole number (got {schema!r})")
    if schema != SCHEMA_VERSION:
        raise ConfigError(
            f"{source}: 'schema' is {schema}, and this build reads schema "
            f"{SCHEMA_VERSION} only"
        )

    profile = _string(raw, "profile", source=source, name="")
    if profile not in PROFILES:
        raise ConfigError(
            f"{source}: 'profile' must be one of {' or '.join(repr(p) for p in PROFILES)} "
            f"(got {profile!r})"
        )
    if profile not in IMPLEMENTED_PROFILES:
        raise ConfigError(
            f"{source}: 'profile' is {profile!r}, which this build cannot run yet. "
            f"Only {', '.join(repr(p) for p in IMPLEMENTED_PROFILES)} is implemented."
        )

    isolation = raw.get("shell_isolation", False)
    if not isinstance(isolation, bool):
        raise ConfigError(
            f"{source}: 'shell_isolation' must be true or false (got {isolation!r})"
        )

    notifications = _sub_table(raw, "notifications", source=source, name="")
    _reject_unknown(
        notifications, frozenset({"reply", "error"}), source=source, name="notifications"
    )

    pinboard_table = raw.get(PINBOARD)
    if profile == PINBOARD:
        if pinboard_table is None:
            raise ConfigError(
                f"{source}: profile = \"pinboard\" needs a '[pinboard]' table "
                "describing the site, its repository and its pin stages"
            )
        if not isinstance(pinboard_table, dict):
            raise ConfigError(
                f"{source}: '[pinboard]' must be a table (got {pinboard_table!r})"
            )
    elif pinboard_table is not None:
        raise ConfigError(
            f"{source}: '[pinboard]' belongs to profile = \"pinboard\"; this source "
            f"says profile = {profile!r}"
        )

    return Config(
        schema=schema,
        profile=profile,
        model=_string(raw, "model", source=source, name=""),
        notifications=Notifications(
            reply=_string(notifications, "reply", source=source, name="notifications"),
            error=_string(notifications, "error", source=source, name="notifications"),
        ),
        uploads=Uploads(ttl_hours=_ttl_hours(raw, source=source)),
        shell_isolation=isolation,
        pinboard=(
            _pinboard_config(pinboard_table, source=source) if profile == PINBOARD else None
        ),
    )


def parse_config(text: str, *, source: str = CONFIG_VAR) -> Config:
    """TOML text in, a validated :class:`Config` out. Pure; the parse error and
    the schema error are told apart so the reader knows whether the file is
    malformed or merely wrong."""
    try:
        raw = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"{source}: not valid TOML: {exc}") from exc
    return validate_config(raw, source=source)


def decode_config_value(encoded: str, *, source: str = CONFIG_VAR) -> Config:
    """The base64 value in the environment, decoded and validated.

    Each step has its own message naming the variable, because the five ways
    this can fail want five different fixes: re-encode, re-encode as UTF-8, fix
    the TOML, fix the key, or set the variable at all."""
    stripped = encoded.translate(str.maketrans("", "", " \t\n\r\v\f"))
    try:
        data = base64.b64decode(stripped, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ConfigError(
            f"${source} is not valid base64 ({exc}). It holds the configuration "
            "TOML base64-encoded: `base64 < config/paratrooper.toml | tr -d '\\n'`"
        ) from exc
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ConfigError(
            f"${source} decoded to bytes that are not UTF-8 ({exc}): encode the "
            "TOML text itself, not a compressed or re-encoded form of it"
        ) from exc
    return parse_config(text, source=f"${source}")


def load_config(*, require_site_root: bool = False) -> Config:
    """The running service's configuration, from the one environment route.

    Reads exactly ``PARATROOPER_CONFIG_B64``. There is no path argument, no
    default location, no search order and no second source: this function either
    returns a fully validated configuration or raises :class:`ConfigError` with
    one sentence saying which step failed and what to do about it.

    ``require_site_root`` is the pinboard worker's boot, which cannot work
    without a checkout to stand in. The web service leaves it false: it holds
    the same configuration and never touches the site's folders.
    """
    if LEGACY_CONFIG_VAR in os.environ:
        raise ConfigError(
            f"${LEGACY_CONFIG_VAR} is still set, and this build does not read it. "
            f"The configuration now arrives base64-encoded in ${CONFIG_VAR}, and a "
            f"deployment carrying both is half-migrated: remove ${LEGACY_CONFIG_VAR} "
            "from this service before starting this image."
        )
    encoded = os.environ.get(CONFIG_VAR, "")
    if not encoded.strip():
        raise ConfigError(
            f"required environment variable ${CONFIG_VAR} is unset or empty: it "
            "carries this deployment's whole configuration, base64-encoded. See "
            "config/paratrooper.example.toml, or run "
            "`python -m paratrooper.deploy push config/paratrooper.toml`."
        )
    config = decode_config_value(encoded)

    inbox = os.environ.get(INBOX_VAR, "").strip()
    if not inbox:
        raise ConfigError(
            f"required environment variable ${INBOX_VAR} is unset or empty: it "
            "names this container's own staging folder for photos"
        )
    config = replace(config, inbox=Path(inbox).expanduser().resolve())

    if config.pinboard is not None:
        site_root = os.environ.get(SITE_ROOT_VAR, "").strip()
        if not site_root and require_site_root:
            raise ConfigError(
                f"required environment variable ${SITE_ROOT_VAR} is unset or empty: "
                "the pinboard worker edits a checkout of the site repository and "
                "has nowhere to put one"
            )
        if site_root:
            config = replace(
                config,
                pinboard=replace(
                    config.pinboard, site_root=Path(site_root).expanduser().resolve()
                ),
            )
    return config


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
