"""Deliver one deployment's configuration to its two services.

``config/paratrooper.toml`` is the thing a human edits. A running service never
reads it: it reads ``PARATROOPER_CONFIG_B64``, holding that file's bytes base64
encoded. This module is the bridge, and it is deliberately the *only* one, so
there is one command to run and one place for it to go wrong.

    python -m paratrooper.deploy check config/paratrooper.toml
    python -m paratrooper.deploy push  config/paratrooper.toml

``check`` is pure. It runs the same validator the services boot with — imported,
not reimplemented, because a second copy is a copy that drifts — and needs no
API key, no inbox, no checkout and no network. ``push`` validates first, so a
source that could not boot never reaches a service.

**Idempotence is the point.** ``push`` reads the one key it owns, writes only
where the value is absent or different, and asks for a deploy only where it
wrote. Running it twice with nothing changed performs no writes and no requests
for a deploy.

**Uncertainty is an outcome, not a rounding error.** Render's API says what a
deploy is, not what caused it, so "a deploy appeared while I was writing" is not
"my write started it": a commit, the dashboard or another person in the same
seconds looks identical from here. A request that never came back is not a
failed write either — a PUT that timed out may well have been applied. Both are
reported as uncertain, neither is retried or deployed over, and an uncertain run
exits non-zero, because the one thing worse than a failure is a success that
nobody checked.

**What is never logged.** The configuration names a person's site, repository
and commit identity, and the credential is a credential. Neither the TOML, nor
the encoded value, nor the API key, nor the CLI token is printed. What is
printed is the encoded length and one outcome line per service.

**Not implemented, on purpose.** This does not refresh an expired CLI token, does
not copy the CLI's credentials anywhere, does not wake a suspended service, does
not repeat a write whose answer was lost, and does not touch any environment
variable other than its own key.

Dependencies (``httpx``, ``PyYAML``) live in the ``deploy`` extra. They are a
laptop's dependencies, not a service's, and neither image installs them.
"""

from __future__ import annotations

import argparse
import base64
import math
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .agent.config import CONFIG_VAR, Config, ConfigError, parse_config

# The one key this command owns. It reads, compares and writes this and nothing
# else: a bulk environment replacement would silently drop every variable it did
# not know about, which on these services is every secret they have.
CONFIG_KEY = CONFIG_VAR

WEB_SERVICE = "paratrooper-web"
WORKER_SERVICE = "paratrooper-worker"
SERVICE_NAMES = (WEB_SERVICE, WORKER_SERVICE)

# The only API this command speaks to. The CLI's own default host is
# ``https://api.render.com/v1/`` (pkg/cfg: GetHost), which normalizes to this.
API_HOSTNAME = "api.render.com"
API_BASE_PATH = "/v1"
DEFAULT_API_HOST = f"https://{API_HOSTNAME}{API_BASE_PATH}"
PAGE_LIMIT = 100
# A listing this command will not walk past. Two named services in one
# workspace do not need 5000 rows, and a cursor that stops advancing should end
# as an error rather than as a loop holding a bearer token.
MAX_PAGES = 50
# Render's CLI resolution, read from its public configuration source rather than
# guessed: the file is <dir>/cli.yaml with the directory defaulting to ~/.render,
# RENDER_CLI_CONFIG_PATH overrides the whole path, RENDER_CLI_CONFIG_DIR
# overrides the directory, and the workspace may come from RENDER_WORKSPACE.
CLI_CONFIG_PATH_VAR = "RENDER_CLI_CONFIG_PATH"
CLI_CONFIG_DIR_VAR = "RENDER_CLI_CONFIG_DIR"
WORKSPACE_VAR = "RENDER_WORKSPACE"
API_KEY_VAR = "RENDER_API_KEY"


class DeployError(RuntimeError):
    """Anything that stops the delivery: a bad source, no credential, no
    workspace, an ambiguous service name, or an API refusal.

    Its message is written to be printed. It never carries a token, a request
    body, a response body or any part of the configuration."""


class ApiNotFound(DeployError):
    """The API answered 404. For the single-variable endpoint that is the
    documented answer for "this service has no such variable", which is an
    answer rather than a failure."""


class ApiUnreachable(DeployError):
    """The request produced no answer at all: a connection that failed, a read
    that timed out, a socket that closed.

    The distinction matters for one call. A GET that never answered told this
    command nothing, but a PUT that never answered may already have been
    applied, so it is neither a failed write nor a completed one, and it is
    never repeated on a guess."""


# --- the source ---------------------------------------------------------------


def encode_source(text: str) -> str:
    """The TOML text as the variable carries it: standard base64 of its UTF-8
    bytes, padding kept, no newlines. Base64 is encoding and not encryption; it
    is here because it removes every newline, quoting and whitespace question a
    multi-line value raises across a dashboard field, a YAML blueprint, a shell
    and a Docker build."""
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def read_source(path: str | os.PathLike[str]) -> tuple[Config, str, str]:
    """Validate a local source file. Returns ``(config, text, encoded)``.

    The validation is the service's own, so "it passed check" means "it would
    boot", not "it looked like TOML"."""
    source = Path(path)
    try:
        text = source.read_text(encoding="utf-8")
    except OSError as exc:
        raise DeployError(f"cannot read {source}: {exc}") from exc
    except UnicodeDecodeError as exc:
        raise DeployError(f"{source} is not UTF-8 text: {exc}") from exc
    try:
        config = parse_config(text, source=str(source))
    except ConfigError as exc:
        raise DeployError(str(exc)) from exc
    return config, text, encode_source(text)


# --- credentials and workspace ------------------------------------------------


@dataclass(frozen=True)
class Credential:
    """An API token and where it came from. ``token`` is never logged."""

    token: str
    source: str
    host: str = DEFAULT_API_HOST

    def __repr__(self) -> str:  # keeps it out of tracebacks and reprs
        return f"Credential(source={self.source!r}, host={self.host!r}, token=<hidden>)"


def cli_config_path(env: dict[str, str] | None = None) -> Path:
    """Where the Render CLI keeps its config, by the CLI's own rules."""
    env = os.environ if env is None else env
    override = env.get(CLI_CONFIG_PATH_VAR, "").strip()
    if override:
        return Path(override).expanduser()
    directory = env.get(CLI_CONFIG_DIR_VAR, "").strip()
    base = Path(directory).expanduser() if directory else Path.home() / ".render"
    return base / "cli.yaml"


def _read_cli_config(path: Path) -> dict[str, Any]:
    """The CLI's saved YAML as a mapping, or an empty one when there is no file.

    A broken file is reported by path and failure kind and by nothing else. That
    is not fastidiousness: this file holds a token, and a YAML parse error
    quotes the line it choked on, which on a half-written credential file is the
    credential. ``from None`` is deliberate too — a chained traceback would
    print the original error, quoted line included, from anywhere this escapes.
    """
    if not path.is_file():
        return {}
    import yaml  # deploy extra; never imported by a service

    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raise DeployError(f"the Render CLI config at {path} is not UTF-8 text") from None
    except OSError as exc:
        # strerror, not str(exc): the message, not the file
        raise DeployError(
            f"cannot read the Render CLI config at {path}: {exc.strerror or 'unreadable'}"
        ) from None
    try:
        data = yaml.safe_load(text)
    except Exception as exc:
        raise DeployError(
            f"the Render CLI config at {path} could not be parsed as YAML "
            f"({type(exc).__name__}). Its contents are deliberately not quoted "
            f"here, because the file holds a token. Set ${API_KEY_VAR}, or run "
            "`render login` to write the file again."
        ) from None
    return data if isinstance(data, dict) else {}


def official_api_host(host: str, *, where: str) -> str:
    """The saved host, normalized to the official API, or an error.

    This helper speaks the public Render API and nothing else. The CLI's
    ``api.host`` is whatever was written into the file — its own default is
    ``https://api.render.com/v1/``, but ``RENDER_HOST`` can put anything there,
    and the value ends up in a URL with a bearer token attached to it. So it is
    checked before a request is ever built: another origin, plain HTTP, a host
    with credentials or an odd port in it, a query, or a different base path is
    refused rather than followed.

    The refusal does not echo the value. A URL is a place a secret can hide
    (``https://user:token@host``), and this one came out of a credential file.
    """
    raw = (host or "").strip()
    if not raw:
        return DEFAULT_API_HOST
    refusal = DeployError(
        f"{where} names an API host this command will not use. It talks to "
        f"{DEFAULT_API_HOST} and nowhere else. Set ${API_KEY_VAR} to use an API "
        "key directly, or run `render login` against the official host. (The "
        "host is not repeated here: it came from a credential file.)"
    )
    try:
        parts = urlsplit(raw)
        port = parts.port
        hostname = (parts.hostname or "").lower()
    except ValueError:
        raise refusal from None
    if (
        parts.scheme != "https"
        or hostname != API_HOSTNAME
        or parts.username
        or parts.password
        or port not in (None, 443)
        or parts.query
        or parts.fragment
        or parts.path.rstrip("/") not in ("", API_BASE_PATH)
    ):
        raise refusal
    return DEFAULT_API_HOST


def _expiry_seconds(value: Any) -> float | None:
    """``api.expires_at`` as a Unix timestamp, or None when it is not one.

    The CLI writes it as ``time.Now().Add(...).Unix()`` into an ``int64`` field,
    so a real one is a positive number of seconds. Absent, zero, a string, a
    ``true``, a NaN: none of those is an expiry, and an expiry nobody could read
    is not the same thing as a token that does not expire. ``bool`` is excluded
    by hand because in Python it would otherwise pass for an int."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    try:
        seconds = float(value)
    except OverflowError:
        return None
    if not math.isfinite(seconds) or seconds <= 0:
        return None
    return seconds


def resolve_credential(
    env: dict[str, str] | None = None, *, now: float | None = None
) -> Credential:
    """An API key, else an *unexpired* saved CLI token, else a clear error.

    That order is the CLI's own precedence: ``RENDER_API_KEY`` first, the saved
    OAuth token second. The second route is the narrow one. The CLI stores that
    token with the moment it stops working (``api.expires_at``, Unix seconds),
    and this command's fallback is a token that has not reached it — not "a key
    was present in a file". A missing, zero, non-numeric or otherwise unreadable
    expiry is therefore refused rather than assumed to mean "never expires":
    there is no such thing documented, and guessing turns into a 401 from some
    endpoint later, which reads like a permissions problem instead of "log in
    again". This command does not refresh the token; the CLI does that.
    """
    env = os.environ if env is None else env
    key = env.get(API_KEY_VAR, "").strip()
    if key:
        return Credential(token=key, source=f"${API_KEY_VAR}")

    path = cli_config_path(env)
    data = _read_cli_config(path)
    api = data.get("api") if isinstance(data.get("api"), dict) else {}
    token = str(api.get("key") or "").strip()
    if not token:
        raise DeployError(
            f"no Render credential. Set ${API_KEY_VAR}, or run `render login` so "
            f"{path} holds an unexpired token."
        )
    expires_at = _expiry_seconds(api.get("expires_at"))
    if expires_at is None:
        raise DeployError(
            f"the saved Render CLI token in {path} does not carry a readable "
            f"expiry, so this command will not treat it as a live credential. "
            f"Set ${API_KEY_VAR} to an API key, or run `render login` to save a "
            "fresh token."
        )
    if (now if now is not None else time.time()) >= expires_at:
        raise DeployError(
            f"the saved Render CLI token in {path} has expired. Run "
            f"`render login` again, or set ${API_KEY_VAR}. (This command "
            "deliberately does not refresh it.)"
        )
    host = official_api_host(
        str(api.get("host") or ""), where=f"the Render CLI config at {path}"
    )
    return Credential(token=token, source=f"the Render CLI config at {path}", host=host)


def resolve_workspace(
    explicit: str | None = None, env: dict[str, str] | None = None
) -> tuple[str, str]:
    """``(workspace_id, where_it_came_from)``.

    Explicit and required. Without one this command would have to search every
    workspace the credential can see, and "exactly one service called
    paratrooper-worker" is only a meaningful question inside one workspace."""
    env = os.environ if env is None else env
    if explicit and explicit.strip():
        return explicit.strip(), "--workspace"
    from_env = env.get(WORKSPACE_VAR, "").strip()
    if from_env:
        return from_env, f"${WORKSPACE_VAR}"
    saved = str(_read_cli_config(cli_config_path(env)).get("workspace") or "").strip()
    if saved:
        return saved, f"the Render CLI config at {cli_config_path(env)}"
    raise DeployError(
        "no Render workspace. Pass --workspace <owner-id>, set "
        f"${WORKSPACE_VAR}, or run `render workspace set`."
    )


# --- the API ------------------------------------------------------------------


class RenderClient:
    """The handful of calls this command makes, and no others.

    Takes an ``httpx.Client`` so the tests can drive the whole sequence through
    a mock transport: idempotence is something to demonstrate, not to claim.
    """

    def __init__(self, credential: Credential, *, http: Any = None) -> None:
        import httpx  # deploy extra; never imported by a service

        self.credential = credential
        # httpx names every transport failure — connect, read, write, timeout,
        # protocol — under one base class. Answers that never arrived are the
        # ones this command has to handle rather than let escape.
        self._no_answer: tuple[type[BaseException], ...] = (httpx.RequestError,)
        if http is None:
            # The last check before a real socket: a token is about to be
            # attached to this host on every call.
            official_api_host(credential.host, where=f"the credential from {credential.source}")
            http = httpx.Client(timeout=30.0)
        self._http = http

    def _request(self, method: str, path: str, *, parse: bool = True, **kwargs: Any) -> Any:
        """One call, with every way it can go wrong turned into a DeployError.

        Three of them are distinct answers rather than one failure: 404 is the
        documented "no such thing" and is its own type, no answer at all is its
        own type because a write that got none may still have been applied, and
        a body that is not JSON is a refusal to guess at what it said. None of
        the three quotes a header, a body or a URL: the request carried a bearer
        token and the answer can echo what was sent.
        """
        url = f"{self.credential.host.rstrip('/')}{path}"
        headers = {
            "Authorization": f"Bearer {self.credential.token}",
            "Accept": "application/json",
        }
        try:
            response = self._http.request(method, url, headers=headers, **kwargs)
        except self._no_answer as exc:
            raise ApiUnreachable(
                f"Render API {method} {path} got no answer ({type(exc).__name__})"
            ) from None
        if response.status_code == 404:
            raise ApiNotFound(f"Render API {method} {path} answered 404")
        if response.status_code >= 400:
            # the body can echo a request; never include it verbatim
            raise DeployError(
                f"Render API {method} {path} answered {response.status_code}"
            )
        if not parse or response.status_code == 204 or not response.content:
            return None
        try:
            return response.json()
        except ValueError:
            raise DeployError(
                f"Render API {method} {path} answered {response.status_code} with a "
                "body this command could not read as JSON"
            ) from None

    def find_service(self, name: str, *, workspace: str) -> dict[str, Any]:
        """Exactly one service with this exact name in this workspace.

        The listing is asked for by ``name`` and ``ownerId``, and both are then
        checked again on every row that comes back. The documentation does not
        say whether the name filter is exact, a prefix or a fuzzy match, so the
        equality this command needs is the one it performs itself; the workspace
        is re-checked for the same reason, since everything after this point
        writes to whatever id comes out of here.

        Every page is read: a filter that answers on page one is still a filter,
        and "no second one exists" cannot be read off a truncated list. Zero
        matches and two matches are both errors, because either answer means
        this command does not know which service it would be writing to.
        """
        matches: list[dict[str, Any]] = []
        cursor: str | None = None
        for _page in range(MAX_PAGES):
            params: dict[str, Any] = {
                "name": name, "ownerId": workspace, "limit": PAGE_LIMIT,
            }
            if cursor:
                params["cursor"] = cursor
            page = self._request("GET", "/services", params=params) or []
            if not isinstance(page, list):
                raise DeployError(
                    "Render API GET /services answered with something other than "
                    "a list of services"
                )
            if not page:
                break
            for entry in page:
                service = entry.get("service") if isinstance(entry, dict) else None
                if not isinstance(service, dict) or service.get("name") != name:
                    continue
                owner = service.get("ownerId")
                if owner != workspace:
                    continue  # another workspace's service of the same name
                matches.append(service)
            following = page[-1].get("cursor") if isinstance(page[-1], dict) else None
            following = str(following) if following else None
            if not following:
                break
            if following == cursor:
                raise DeployError(
                    f"the service listing for {name!r} in workspace {workspace} "
                    "answered with the same page cursor twice; this command "
                    "stopped rather than page forever"
                )
            cursor = following
        else:
            raise DeployError(
                f"the service listing for {name!r} in workspace {workspace} did "
                f"not end within {MAX_PAGES} pages; this command stopped rather "
                "than keep paging"
            )
        if not matches:
            raise DeployError(
                f"no service named {name!r} in workspace {workspace}"
            )
        if len(matches) > 1:
            raise DeployError(
                f"{len(matches)} services are named {name!r} in workspace "
                f"{workspace}: this command will not choose between them"
            )
        return matches[0]

    def get_config_value(self, service_id: str) -> str | None:
        """The current value of this command's one key, or None when it is unset.

        The single-variable endpoint, never the list. Listing would hand this
        command every other secret on the service in order to look at one key it
        already knows the name of, and a key that happened to sit past the first
        page of that list would read as absent — which here means "write it",
        and a write means a deploy. ``GET /services/{id}/env-vars/{key}`` answers
        with that one variable, or 404 when the service has no such variable.
        """
        path = f"/services/{service_id}/env-vars/{CONFIG_KEY}"
        try:
            body = self._request("GET", path)
        except ApiNotFound:
            return None
        if not isinstance(body, dict) or body.get("key") != CONFIG_KEY:
            raise DeployError(
                f"Render API GET {path} answered with something other than that "
                "variable"
            )
        value = body.get("value")
        return None if value is None else str(value)

    def set_config_value(self, service_id: str, value: str) -> None:
        """The single-key update. Never a bulk replacement: the other variables
        on these services are the secrets, and this command does not know them.

        The answer is not read back. A 2xx is the whole answer worth having, and
        the body of this one is the key and its value."""
        self._request(
            "PUT",
            f"/services/{service_id}/env-vars/{CONFIG_KEY}",
            json={"value": value},
            parse=False,
        )

    def latest_deploy_id(self, service_id: str) -> str | None:
        """The id of the most recent deploy, or None when there is none."""
        path = f"/services/{service_id}/deploys"
        page = self._request("GET", path, params={"limit": 1}) or []
        if not isinstance(page, list):
            raise DeployError(
                f"Render API GET {path} answered with something other than a list "
                "of deploys"
            )
        for entry in page:
            deploy = entry.get("deploy") if isinstance(entry, dict) else None
            if isinstance(deploy, dict) and deploy.get("id"):
                return str(deploy["id"])
        return None

    def request_deploy(self, service_id: str) -> str | None:
        """Ask for a deploy and return the id the API gives back for it.

        This is the one deployment this command can honestly connect to itself:
        it asked, and the answer names the deploy the request created. None
        means the call succeeded without naming one, which is reported as
        uncertainty rather than as a deployment."""
        created = self._request("POST", f"/services/{service_id}/deploys", json={})
        if isinstance(created, dict) and created.get("id"):
            return str(created["id"])
        return None


# --- the push -----------------------------------------------------------------


@dataclass
class ServiceOutcome:
    """What happened to one service. Reported per service, so a run that got one
    right and one wrong says exactly that rather than one summary word."""

    name: str
    service_id: str | None = None
    # unchanged | updated | uncertain | failed. "uncertain" is the write whose
    # request never came back: not a failure, not a completed write.
    status: str = "failed"
    suspended: bool = False
    deploy_id: str | None = None
    # how the deployment stands: "requested" (this command asked and the API
    # named the deploy), "suspended" (nothing runs until it wakes), "unknown"
    # (something is unproven and a person has to look), or "" when there was
    # nothing to deploy
    deploy_source: str = ""
    detail: str = ""

    @property
    def settled(self) -> bool:
        """Did this service end in a state this command can stand behind?

        "unchanged" and "updated with a deploy this command asked for" are the
        two. Everything else — a failure, a write that may or may not have
        landed, a deployment nobody can attribute — is not, and a command whose
        exit code said otherwise would be the wrong kind of quiet."""
        return self.status in ("unchanged", "updated") and self.deploy_source != "unknown"

    def line(self) -> str:
        head = f"{self.name}: {self.status}"
        if self.status == "unchanged":
            return f"{head} (no write, no deploy)"
        if self.status in ("failed", "uncertain"):
            return f"{head} — {self.detail}"
        if self.suspended:
            return (
                f"{head}, service suspended — the new configuration takes effect "
                "when it next wakes; nothing was woken here"
            )
        if self.deploy_source == "unknown":
            return f"{head} — {self.detail}"
        where = {
            "requested": "no deploy followed the write, so one was requested",
        }.get(self.deploy_source, self.deploy_source)
        return f"{head}, {where}: {self.deploy_id}"


@dataclass
class PushReport:
    encoded_length: int
    workspace: str
    workspace_source: str
    credential_source: str
    outcomes: list[ServiceOutcome] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        """Every service settled. Delivery without a deployment this command can
        account for is not success: the configuration only reaches the running
        service through a deploy, so "written, deployment unknown" exits
        non-zero and says which service and why."""
        return all(o.settled for o in self.outcomes)

    def lines(self) -> list[str]:
        return [
            f"configuration validated; encoded length {self.encoded_length} bytes",
            f"workspace {self.workspace} (from {self.workspace_source})",
            f"credential from {self.credential_source}",
            *(o.line() for o in self.outcomes),
        ]


def _is_suspended(service: dict[str, Any]) -> bool:
    return str(service.get("suspended") or "").lower() == "suspended"


def _push_one(client: RenderClient, name: str, *, workspace: str, encoded: str) -> ServiceOutcome:
    outcome = ServiceOutcome(name=name)
    try:
        service = client.find_service(name, workspace=workspace)
        outcome.service_id = str(service.get("id") or "")
        outcome.suspended = _is_suspended(service)
        if client.get_config_value(outcome.service_id) == encoded:
            outcome.status = "unchanged"
            return outcome
        # Read the deployment evidence BEFORE the write. Without a before, a
        # deploy already running for an unrelated reason reads exactly like one
        # that appeared during the write, and this command would not even know
        # it was looking at something older than itself.
        #
        # A before that cannot be read does not stop the write. Delivering the
        # configuration is the job; the deployment evidence is the reporting,
        # and losing the reporting is answered by saying so rather than by
        # refusing to deliver or by guessing.
        before: str | None = None
        before_known = outcome.suspended  # nothing to compare on a suspended one
        if not outcome.suspended:
            try:
                before = client.latest_deploy_id(outcome.service_id)
                before_known = True
            except DeployError:
                before_known = False

        try:
            client.set_config_value(outcome.service_id, encoded)
        except ApiUnreachable as exc:
            # The write got no answer. It may have been applied and it may not,
            # and the difference is not visible from here. It is not repeated:
            # a blind second PUT is a second write, and if the first one landed
            # it is also a second deploy on a service that may be mid-deploy.
            outcome.status = "uncertain"
            outcome.deploy_source = "unknown"
            outcome.detail = (
                f"the write got no answer ({exc}), so whether the value reached "
                "this service is unknown. It was not sent again, and no deploy "
                "was requested. Check the service's configuration before running "
                "this again."
            )
            return outcome
        outcome.status = "updated"
        if outcome.suspended:
            outcome.deploy_source = "suspended"
            return outcome
        try:
            after = client.latest_deploy_id(outcome.service_id)
        except DeployError as exc:
            outcome.deploy_source = "unknown"
            outcome.detail = (
                f"the value was written, but whether a deploy followed could not "
                f"be established ({exc}). Check the service before assuming either."
            )
            return outcome
        if not before_known:
            outcome.deploy_source = "unknown"
            outcome.deploy_id = after
            outcome.detail = (
                "the value was written, but this service's deployment history "
                "could not be read beforehand, so whether the deploy now showing "
                f"({after}) belongs to this change could not be established. "
                "Check the service before assuming either."
            )
            return outcome
        if after is not None and after != before:
            # A deploy that was not there before the write is there now. That is
            # a coincidence in time, not a cause: the API says what a deploy is,
            # never that this write started it, and a commit, the dashboard or
            # another person in the same seconds produces exactly this picture.
            # So it is reported as unproven — and nothing is started on top of
            # it, because a second deploy would be this command's answer to not
            # knowing what the first one was.
            outcome.deploy_source, outcome.deploy_id = "unknown", after
            outcome.detail = (
                f"the value was written, and a deploy ({after}) appeared while it "
                "was being written. Render does not say what started that deploy, "
                "so whether it carries this configuration is unproven. No second "
                "deploy was requested. Check that deploy before assuming either."
            )
            return outcome
        try:
            outcome.deploy_id = client.request_deploy(outcome.service_id)
        except DeployError as exc:
            outcome.deploy_source = "unknown"
            outcome.detail = (
                f"the value was written, but the deploy request did not complete "
                f"({exc}), so this service may still be running the old "
                "configuration. Check the service before assuming either."
            )
            return outcome
        outcome.deploy_source = "requested"
        if outcome.deploy_id is None:
            outcome.deploy_source = "unknown"
            outcome.detail = (
                "the value was written and a deploy was requested, but the API "
                "did not name one. Check the service before assuming either."
            )
        return outcome
    except DeployError as exc:
        if outcome.status == "updated":
            # The write happened; something after it did not. Saying "failed"
            # here would report a service as untouched when its configuration
            # has already changed.
            outcome.deploy_source = "unknown"
            outcome.detail = (
                f"the value was written, but the run did not finish cleanly "
                f"({exc}). Check the service before assuming either."
            )
            return outcome
        outcome.status = "failed"
        outcome.detail = str(exc)
        return outcome


def push(
    path: str | os.PathLike[str],
    *,
    client: RenderClient,
    workspace: str,
    workspace_source: str = "caller",
) -> PushReport:
    """Validate, encode, then set the one key on each service that needs it.

    Each service is handled independently and reported independently: one that
    fails does not stop the other, and neither is described as done when it is
    not. That includes the network — a call that never came back on one service
    is that service's outcome, not an exception that ends the run and takes the
    other service's result with it."""
    _config, _text, encoded = read_source(path)
    report = PushReport(
        encoded_length=len(encoded),
        workspace=workspace,
        workspace_source=workspace_source,
        credential_source=client.credential.source,
    )
    for name in SERVICE_NAMES:
        report.outcomes.append(_push_one(client, name, workspace=workspace, encoded=encoded))
    return report


# --- the command line ---------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m paratrooper.deploy",
        description="Validate a Paratrooper configuration source and deliver it.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    checker = sub.add_parser("check", help="validate a source locally; no network, no secrets")
    checker.add_argument("source", help="path to the TOML source, e.g. config/paratrooper.toml")

    pusher = sub.add_parser("push", help="set the configuration variable on both services")
    pusher.add_argument("source", help="path to the TOML source, e.g. config/paratrooper.toml")
    pusher.add_argument("--workspace", default=None, help="Render workspace (owner) id")

    args = parser.parse_args(argv)
    try:
        if args.command == "check":
            config, _text, encoded = read_source(args.source)
            print(f"{args.source}: valid, profile {config.profile}, schema {config.schema}")
            print(f"encoded length {len(encoded)} bytes")
            return 0

        workspace, workspace_source = resolve_workspace(args.workspace)
        client = RenderClient(resolve_credential())
        report = push(
            args.source, client=client, workspace=workspace, workspace_source=workspace_source
        )
        for line in report.lines():
            print(line)
        return 0 if report.ok else 1
    except DeployError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
