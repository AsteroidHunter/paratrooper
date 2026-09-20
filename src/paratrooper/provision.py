"""Create a fresh Paratrooper deployment on Render, from render.yaml.

``deploy.py`` delivers configuration to services that already exist. It never
makes them, on purpose. This module is the other half: the first install, when
nothing is there yet. It reads ``render.yaml`` as the single source of truth for
what to build, then creates the Key Value store, the worker and the web service
through Render's documented REST API and hands back their ids and the web
address.

    python -m paratrooper.provision --blueprint render.yaml \
        --config config/paratrooper.toml --repo <git-url> --branch <branch> \
        --report <path>

**Why per resource and not a blueprint.** Render has no API that applies a
render.yaml: the Blueprint endpoints only list, validate, retrieve, update and
disconnect one, never create or sync it. So the supported automated path is to
create each resource and wire the links a Blueprint would have wired. There are
exactly two: ``REDIS_URL`` is the Key Value's internal connection string, read
back after the store is made; ``RENDER_WORKER_SERVICE_ID`` is the worker's id,
known once the worker is made. That fixes the order: Key Value, then worker,
then web.

**Idempotence is the point, again.** Every resource is found-or-created by its
exact name in the workspace. One that already exists is reused and never
touched, so a first run that stopped halfway (the store made, the web service
not) is finished by running again, and a run against a finished deployment
creates nothing. A resource is created with its whole environment set at once,
including the configuration, because a service cannot boot without it and this
is the only moment before its first deploy; ``deploy push`` remains the way to
change the configuration afterward.

**What is never logged.** The tokens, the app password and the idle key arrive
on stdin, never in argv and never in this process's own environment. They are
written to the new services and to nothing else. The report this writes carries
ids, the web address and whether each resource was created, and no secret. The
API errors this raises name a method and a path and never a header, a body or a
credential, because they are inherited from the client ``deploy push`` uses.

**Distinct credentials.** Provisioning authenticates with the Render login token
(or a ``RENDER_API_KEY`` already in the environment), resolved exactly as
``deploy push`` resolves it. The optional idle-sleeping key is a different thing:
it arrives on stdin and is written only into the web service's ``RENDER_API_KEY``
so the running web service can suspend and resume the worker. The two never mix.

Dependencies (``httpx``, ``PyYAML``) are the ``deploy`` extra's, shared with
``deploy.py``. Neither service image installs them.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import textwrap
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, TextIO

from .deploy import (
    CONFIG_KEY,
    MAX_PAGES,
    PAGE_LIMIT,
    ApiNotFound,
    Credential,
    DeployError,
    RenderClient,
    read_source,
    resolve_credential,
    resolve_workspace,
)

# render.yaml's own type words, and how each maps onto the API. The Key Value
# store is created through a different endpoint, so it is handled on its own.
KEYVALUE_TYPE = "keyvalue"
API_SERVICE_TYPE = {"web": "web_service", "worker": "background_worker"}

# Existing passwords are only checked for presence, never returned to the
# installer. Browser-push keys are preserved when an interrupted install resumes.
APP_TOKEN_VAR = "PARATROOPER_APP_TOKEN"
VAPID_PUBLIC_VAR = "VAPID_PUBLIC_KEY"
VAPID_PRIVATE_VAR = "VAPID_PRIVATE_KEY"
VAPID_SUBJECT_VAR = "VAPID_SUBJECT"

# Render deploy statuses (from the API's deployStatus enum). "live" is the only
# one this command accepts as ready; the failed set is terminal and stops the
# run; everything else is still in progress and is waited on.
DEPLOY_LIVE = frozenset({"live"})
DEPLOY_FAILED = frozenset({"build_failed", "update_failed", "canceled", "pre_deploy_failed"})


class ProvisionError(DeployError):
    """A provisioning step that could not be completed. Like every DeployError
    its message is safe to print: no token, no request body, no response body."""


def wrap_installer_message(
    message: str, *, first_prefix: str = "", later_prefix: str = "  ", width: int = 72
) -> str:
    """Wrap variable status and error text without splitting a path or URL."""
    lines = textwrap.wrap(
        message, width=width, initial_indent=first_prefix,
        subsequent_indent=later_prefix, break_long_words=False, break_on_hyphens=False,
    )
    if len(lines) > 1:
        previous_prefix = first_prefix if len(lines) == 2 else later_prefix
        previous = lines[-2][len(previous_prefix):].split()
        last = lines[-1][len(later_prefix):].split()
        while len(previous) > 1:
            candidate = [previous[-1], *last]
            new_previous = previous_prefix + " ".join(previous[:-1])
            new_last = later_prefix + " ".join(candidate)
            if len(new_last) > width or abs(len(new_previous) - len(new_last)) >= abs(len(lines[-2]) - len(lines[-1])):
                break
            previous.pop()
            last = candidate
            lines[-2], lines[-1] = new_previous, new_last
    return "\n".join(lines)


# --- the client ----------------------------------------------------------------


def _object_of(entry: Any, wrapper: str) -> dict[str, Any] | None:
    """One row of a listing as a plain object, whether it arrives wrapped as
    ``{wrapper: {...}}`` (services do this) or bare (some listings do). Anything
    else is not a row this command understands."""
    if not isinstance(entry, dict):
        return None
    inner = entry.get(wrapper)
    if isinstance(inner, dict):
        return inner
    if "name" in entry or "id" in entry:
        return entry
    return None


def _owner_matches(obj: dict[str, Any], workspace: str) -> bool:
    """Whether this object belongs to the workspace being provisioned.

    The listing was already asked for by ``ownerId``; this re-checks it, because
    everything after a match writes to whatever id came out of here. Services
    carry ``ownerId``; a Key Value carries an ``owner`` object. When neither is
    present the server-side filter is trusted rather than guessed against."""
    owner_id = obj.get("ownerId")
    if owner_id is not None:
        return owner_id == workspace
    owner = obj.get("owner")
    if isinstance(owner, dict) and owner.get("id") is not None:
        return owner["id"] == workspace
    return True


class ProvisionClient(RenderClient):
    """The create and find calls provisioning makes, on top of RenderClient's
    request handling (bearer auth, the official-host allowlist, 404 as its own
    type, no secret in any error). Sharing that class means this shares its
    safety rather than keeping a second, driftable copy of it."""

    def _find_one(self, path: str, wrapper: str, name: str, *, workspace: str) -> dict[str, Any] | None:
        """The single resource named ``name`` in ``workspace`` from the listing
        at ``path``, or None when there is none. Two matches is an error: this
        command would not know which one it was about to skip or write to.

        Every page is read, and the name and owner are re-checked on each row,
        for the same reasons ``deploy push`` re-checks them: a server-side filter
        is a filter and not a promise of exact equality, and a second match
        cannot be ruled out from a truncated list.
        """
        matches: list[dict[str, Any]] = []
        cursor: str | None = None
        for _page in range(MAX_PAGES):
            params: dict[str, Any] = {"name": name, "ownerId": workspace, "limit": PAGE_LIMIT}
            if cursor:
                params["cursor"] = cursor
            page = self._request("GET", path, params=params) or []
            if not isinstance(page, list):
                raise ProvisionError(f"Render API GET {path} did not answer with a list")
            if not page:
                break
            for entry in page:
                obj = _object_of(entry, wrapper)
                if obj is None or obj.get("name") != name or not _owner_matches(obj, workspace):
                    continue
                matches.append(obj)
            following = page[-1].get("cursor") if isinstance(page[-1], dict) else None
            following = str(following) if following else None
            if not following:
                break
            if following == cursor:
                raise ProvisionError(
                    f"the listing at {path} for {name!r} answered with the same page "
                    "cursor twice; this command stopped rather than page for ever"
                )
            cursor = following
        else:
            raise ProvisionError(
                f"the listing at {path} for {name!r} did not end within {MAX_PAGES} "
                "pages; this command stopped rather than keep paging"
            )
        if len(matches) > 1:
            raise ProvisionError(
                f"{len(matches)} resources are named {name!r} in workspace {workspace}: "
                "this command will not choose between them"
            )
        return matches[0] if matches else None

    def find_service(self, name: str, *, workspace: str) -> dict[str, Any] | None:
        """The one service with this exact name, or None. Overrides the parent's
        find_service, whose contract is 'exactly one or raise'; provisioning
        needs 'reuse it or create it', so absence is an answer here."""
        return self._find_one("/services", "service", name, workspace=workspace)

    def find_key_value(self, name: str, *, workspace: str) -> dict[str, Any] | None:
        """The one Key Value instance with this exact name, or None."""
        return self._find_one("/key-value", "keyValue", name, workspace=workspace)

    def create_key_value(self, body: dict[str, Any]) -> dict[str, Any]:
        """Create the Key Value store. Returns the created object (its id)."""
        created = self._request("POST", "/key-value", json=body)
        if not isinstance(created, dict):
            raise ProvisionError("Render API POST /key-value did not answer with an object")
        return created

    def key_value_connection(self, kv_id: str) -> str:
        """The Key Value's internal connection string, for REDIS_URL.

        Retried a few times because the store is 'creating' the instant it is
        made and the connection endpoint can answer 404 for that first moment.
        The external string and CLI command the endpoint also returns are not
        read: the internal one is what a same-region service uses, and reading
        only it keeps the rest out of this process entirely."""
        tries, interval = self._conn_tries, self._conn_interval
        last = "no answer yet"
        for attempt in range(tries):
            try:
                body = self._request("GET", f"/key-value/{kv_id}/connection-info")
            except ApiNotFound:
                last = "the connection endpoint answered 404"
                body = None
            if isinstance(body, dict):
                value = body.get("internalConnectionString")
                if value:
                    return str(value)
                last = "the answer carried no internal connection string"
            if attempt + 1 < tries and interval > 0:
                self._sleep(interval)
        raise ProvisionError(
            f"could not read the Key Value's internal connection string ({last}). "
            "The store may still be starting; run this again in a moment."
        )

    def create_service(self, body: dict[str, Any]) -> dict[str, Any]:
        """Create a web service or a background worker. Creation with a repo,
        a branch and the default autoDeploy starts the first deploy on its own,
        so nothing here asks for one. Returns the created service object."""
        created = self._request("POST", "/services", json=body)
        service = created.get("service") if isinstance(created, dict) else None
        if isinstance(service, dict):
            return service
        if isinstance(created, dict) and "id" in created:
            return created
        raise ProvisionError("Render API POST /services did not answer with a service")

    def read_env_var(self, service_id: str, key: str) -> str | None:
        """One environment variable's current value on a service, or None when it
        is unset. The single-variable endpoint, never the list: this asks for the
        one key by name and reads back only it, and a 404 is the documented answer
        for 'this service has no such variable', not a failure. Used to check
        that an existing app has a password, and to preserve its push keys.
        The password is never returned to the installer or written locally."""
        try:
            body = self._request("GET", f"/services/{service_id}/env-vars/{key}")
        except ApiNotFound:
            return None
        if not isinstance(body, dict) or body.get("key") != key:
            return None
        value = body.get("value")
        if value is not None and not isinstance(value, str):
            raise ProvisionError("Render returned an invalid environment variable value.")
        return value

    def set_env_var(self, service_id: str, key: str, value: str) -> None:
        """Set one environment variable, and only it. The single-key PUT, never a
        bulk replacement, because the other variables on the service are the
        secrets and this command does not carry them. Used to complete a value an
        interrupted run left unset. Render does not deploy an env-var change on its
        own (the API applies it to the next deploy only), so callers that need it
        live must ask for a deploy afterward."""
        self._request(
            "PUT", f"/services/{service_id}/env-vars/{key}", json={"value": value}, parse=False
        )

    def latest_deploy_status(self, service_id: str) -> str | None:
        """The status of the service's most recent deploy, or None when there is
        none yet. Used to judge readiness for a service whose ONLY deploy is the
        one this run cares about (a freshly created service, or a reused one with
        no new deploy). It is NOT used to confirm an activation deploy requested on
        an already-live service: the listing can still be answering with the older
        live deploy, so that case queries the specific deploy id instead."""
        page = self._request("GET", f"/services/{service_id}/deploys", params={"limit": 1}) or []
        if not isinstance(page, list):
            raise ProvisionError(
                f"Render API GET /services/{service_id}/deploys did not answer with a list"
            )
        for entry in page:
            deploy = entry.get("deploy") if isinstance(entry, dict) else None
            if isinstance(deploy, dict) and deploy.get("status"):
                return str(deploy["status"])
        return None

    def deploy_status(self, service_id: str, deploy_id: str) -> str | None:
        """The status of ONE specific deploy, or None when it cannot be read. This
        is how an activation deploy is confirmed: the id request_deploy returned is
        verified directly, so an older live deploy still showing at the top of the
        listing can never stand in for the new one that carries the change."""
        try:
            body = self._request("GET", f"/services/{service_id}/deploys/{deploy_id}")
        except ApiNotFound:
            return None
        deploy = body.get("deploy") if isinstance(body, dict) else None
        if isinstance(deploy, dict) and deploy.get("status"):
            return str(deploy["status"])
        if isinstance(body, dict) and body.get("status"):
            return str(body["status"])
        return None

    # Poll shape and sleep, overridable so a test drives them without waiting.
    _conn_tries: int = 20
    _conn_interval: float = 3.0

    @staticmethod
    def _sleep(seconds: float) -> None:
        import time

        time.sleep(seconds)


# --- render.yaml -> API bodies -------------------------------------------------


def load_specs(blueprint_path: str | Path) -> dict[str, dict[str, Any]]:
    """The web, worker and keyvalue service tables out of render.yaml.

    render.yaml is parsed rather than duplicated so it stays the one place these
    values live. A missing service, or a services list that is not one, is an
    error naming the file: this command builds exactly what the blueprint
    declares, and cannot build what it cannot read."""
    import yaml  # deploy extra; never imported by a service

    path = Path(blueprint_path)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ProvisionError(f"cannot read {path}: {exc}") from exc
    try:
        data = yaml.safe_load(text)
    except Exception as exc:  # a malformed blueprint is not something to guess at
        raise ProvisionError(f"{path} is not valid YAML ({type(exc).__name__})") from None
    services = data.get("services") if isinstance(data, dict) else None
    if not isinstance(services, list):
        raise ProvisionError(f"{path}: no 'services' list to build from")
    wanted = ("web", "worker", KEYVALUE_TYPE)
    specs: dict[str, dict[str, Any]] = {}
    for raw in services:
        if not isinstance(raw, dict):
            continue
        kind = raw.get("type")
        if kind in wanted and kind not in specs:
            specs[kind] = raw
    missing = [kind for kind in wanted if kind not in specs]
    if missing:
        raise ProvisionError(
            f"{path}: expected a service of each type {', '.join(wanted)}; "
            f"missing {', '.join(missing)}"
        )
    return specs


def key_value_body(spec: dict[str, Any], workspace: str) -> dict[str, Any]:
    """The POST /v1/key-value body, from the keyvalue table. ipAllowList is
    passed through as written: render.yaml leaves it empty, which is Render's way
    of saying internal-network only, and that is exactly the intent."""
    body: dict[str, Any] = {
        "name": _need(spec, "name", "keyvalue"),
        "ownerId": workspace,
        "plan": _need(spec, "plan", "keyvalue"),
    }
    for key in ("region", "maxmemoryPolicy"):
        if key in spec:
            body[key] = spec[key]
    if "ipAllowList" in spec:
        body["ipAllowList"] = spec["ipAllowList"]
    return body


def service_body(
    spec: dict[str, Any], workspace: str, *, repo: str, branch: str, env_vars: list[dict[str, str]]
) -> dict[str, Any]:
    """The POST /v1/services body for a web service or a background worker.

    Only the fields render.yaml sets are sent. The runtime is 'docker' there, so
    the Dockerfile path and build context travel as the API's docker build
    details; a web service's disk and health-check path travel too, and the
    worker has neither."""
    kind = spec.get("type")
    api_type = API_SERVICE_TYPE.get(kind)
    if api_type is None:
        raise ProvisionError(f"render.yaml service type {kind!r} is not one this command builds")
    details: dict[str, Any] = {
        "runtime": _need(spec, "runtime", kind),
        "plan": _need(spec, "plan", kind),
    }
    if "region" in spec:
        details["region"] = spec["region"]
    docker: dict[str, Any] = {}
    if spec.get("dockerfilePath"):
        docker["dockerfilePath"] = spec["dockerfilePath"]
    if spec.get("dockerContext"):
        docker["dockerContext"] = spec["dockerContext"]
    if docker:
        details["envSpecificDetails"] = docker
    if spec.get("healthCheckPath"):
        details["healthCheckPath"] = spec["healthCheckPath"]
    disk = spec.get("disk")
    if isinstance(disk, dict):
        details["disk"] = {
            "name": _need(disk, "name", f"{kind}.disk"),
            "mountPath": _need(disk, "mountPath", f"{kind}.disk"),
            "sizeGB": _need(disk, "sizeGB", f"{kind}.disk"),
        }
    return {
        "type": api_type,
        "name": _need(spec, "name", kind),
        "ownerId": workspace,
        "repo": repo,
        "branch": branch,
        "autoDeploy": "yes",
        "serviceDetails": details,
        "envVars": env_vars,
    }


def resolve_env_vars(
    raw_env_vars: Any, values: dict[str, str], redis_url: str
) -> list[dict[str, str]]:
    """render.yaml's envVars turned into concrete {key, value} pairs.

    A literal value is passed through. The one cross-service link (REDIS_URL from
    the Key Value's connectionString) becomes the connection string read back
    after the store was made. A ``sync: false`` key is a secret the blueprint
    declares without a value: it is filled from ``values`` when this deployment
    has one, and OMITTED when it does not. That omission is the plain profile
    working as intended, since the GitHub App, Spotify and VAPID keys are the
    pinboard's and a plain deployment sets none of them.
    """
    out: list[dict[str, str]] = []
    for entry in raw_env_vars or []:
        if not isinstance(entry, dict):
            continue
        key = entry.get("key")
        if not key:
            continue
        if "value" in entry:
            out.append({"key": key, "value": str(entry["value"])})
            continue
        link = entry.get("fromService")
        if isinstance(link, dict):
            if link.get("type") == KEYVALUE_TYPE and link.get("property") == "connectionString":
                out.append({"key": key, "value": redis_url})
                continue
            raise ProvisionError(
                f"render.yaml env var {key!r} links to a service property this "
                "command does not know how to resolve"
            )
        if entry.get("sync") is False and key in values:
            out.append({"key": key, "value": values[key]})
        # a sync:false key with no value we hold is left unset, deliberately
    return out


def _need(table: dict[str, Any], key: str, where: str) -> Any:
    if key not in table:
        raise ProvisionError(f"render.yaml {where!r} is missing required key {key!r}")
    return table[key]


def _service_url(service: dict[str, Any]) -> str:
    details = service.get("serviceDetails") if isinstance(service, dict) else None
    value = details.get("url") if isinstance(details, dict) else None
    if value is None:
        value = service.get("url", "")
    if value is not None and not isinstance(value, str):
        raise ProvisionError("Render returned an invalid web address.")
    return value or ""


def _resource_id(resource: dict[str, Any]) -> str:
    """Only an actual identifier may enter a report, a URL path or an error.

    Coercing an unexpected object to text could copy an echoed request body,
    including its password, into subsequent progress or failure output.
    """
    value = resource.get("id")
    if not isinstance(value, str) or not value or any(ch.isspace() for ch in value):
        raise ProvisionError("Render returned an invalid resource id.")
    return value


def _service_region(service: dict[str, Any]) -> str:
    details = service.get("serviceDetails") if isinstance(service, dict) else None
    if isinstance(details, dict) and details.get("region"):
        return str(details["region"])
    return str(service.get("region") or "") if isinstance(service, dict) else ""


def _norm_repo(url: Any) -> str:
    """A repository URL reduced to what identifies it: lower case, no scheme, no
    credentials, no trailing '.git' or '/'. So https://Host/Owner/Repo.git and
    https://host/owner/repo compare equal, while a different owner or host does
    not."""
    text = str(url or "").strip().lower()
    for scheme in ("https://", "http://", "ssh://", "git://"):
        if text.startswith(scheme):
            text = text[len(scheme):]
            break
    if text.startswith("git@"):
        text = text[len("git@"):].replace(":", "/", 1)
    if "@" in text.split("/", 1)[0]:  # strip user:pass@host
        text = text.split("@", 1)[1]
    if text.endswith(".git"):
        text = text[: -len(".git")]
    return text.rstrip("/")


def _ensure_service_compatible(
    existing: dict[str, Any], *, expected_type: str, repo: str, region: str, name: str
) -> None:
    """Stop unless this existing service is, demonstrably, this Paratrooper
    deployment's own service of the expected kind.

    A name collision is not identity. Adopting a same-named service of the wrong
    type, or one built from another repository or run in another region, would
    reconfigure a stranger's resource and, for the worker, hand its id to the web
    service's suspend/resume controls. So the type must match, and the repository
    and region must be present and match; anything unproven stops the run before
    a single value is read from or written to the resource. Nothing is renamed,
    overwritten or deleted here: this only refuses to adopt.
    """
    actual_type = str(existing.get("type") or "")
    if actual_type != expected_type:
        raise ProvisionError(
            f"a resource named {name!r} already exists but is a {actual_type or 'unknown'!r}, "
            f"not the {expected_type!r} this deployment expects. Stopping rather than adopt or "
            "control an unrelated resource; rename or remove it, or use a different workspace."
        )
    actual_repo = _norm_repo(existing.get("repo"))
    if not actual_repo or actual_repo != _norm_repo(repo):
        raise ProvisionError(
            f"a service named {name!r} already exists but does not build from this repository. "
            "Stopping rather than adopt an unrelated resource; use a different workspace or "
            "remove it if it is stale."
        )
    actual_region = _service_region(existing)
    if region and actual_region and actual_region != region:
        raise ProvisionError(
            f"a service named {name!r} already exists in region {actual_region!r}, not "
            f"{region!r}. Stopping rather than adopt an unrelated resource."
        )


def _ensure_key_value_compatible(existing: dict[str, Any], *, region: str, name: str) -> None:
    """Stop unless this existing Key Value store is in this deployment's region.
    The listing endpoint only returns Key Value instances, so the type is not in
    doubt; the region is the identity check that is available."""
    actual_region = str((existing.get("region") or "")) or _service_region(existing)
    if region and actual_region and actual_region != region:
        raise ProvisionError(
            f"a Key Value store named {name!r} already exists in region {actual_region!r}, not "
            f"{region!r}. Stopping rather than adopt an unrelated resource."
        )


def generate_vapid_keypair() -> tuple[str, str]:
    """A fresh VAPID key pair, in the web-push format the app already reads.

    Returns ``(public_key, private_key)``, both base64url without padding. The
    public key is the uncompressed P-256 point, which is exactly the
    ``applicationServerKey`` the browser subscribes with and what
    ``web/push.py`` serves at ``/api/push/key``. The private key is the raw 32
    byte scalar, which is what ``pywebpush`` (via ``py_vapid.Vapid.from_string``)
    loads from ``VAPID_PRIVATE_KEY`` when it signs. Generated here so the operator
    is not sent to do it by hand; the private key goes straight onto the service
    and is never written to this laptop's disk.
    """
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    private = ec.generate_private_key(ec.SECP256R1())
    scalar = private.private_numbers().private_value.to_bytes(32, "big")
    private_key = base64.urlsafe_b64encode(scalar).rstrip(b"=").decode("ascii")
    point = private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    public_key = base64.urlsafe_b64encode(point).rstrip(b"=").decode("ascii")
    return public_key, private_key


def _predicted_url(name: str) -> str:
    """A web service's default Render address, from its name. Used as the VAPID
    subject at creation, when the actual URL is not yet known: setting the subject
    in the create body means the very first deploy already carries a working push
    configuration, rather than a later env-var change that would need its own
    deploy to take effect."""
    return f"https://{name}.onrender.com"


def _vapid_subject(web_url: str) -> str:
    """The VAPID contact, obtained automatically and carrying no personal
    identity: this deployment's own https address. RFC 8292 lets the subject be an
    ``https:`` URL identifying the sender. Used rather than an account email so
    nothing is hard-coded and no extra question is asked."""
    return web_url


def _ensure_web_push(client: ProvisionClient, web_id: str, web_url: str, report: ProvisionReport) -> None:
    """Make browser-push (VAPID) keys certain and ACTIVE on a reused web service.

    Keys are recovered, not regenerated when present, since a new pair would
    silently invalidate every phone already subscribed; only what an earlier
    interrupted run left unset is completed. A saved env var is not an active one:
    Render applies an env-var change to the next deploy only (the API does not
    deploy it automatically), so if anything is written here a deploy is
    requested, and readiness then waits for THAT deploy to go live. A web process
    still serving the previous environment is not accepted as proof the new push
    configuration is active. Nothing is kept on this laptop's disk.
    """
    public = client.read_env_var(web_id, VAPID_PUBLIC_VAR)
    private = client.read_env_var(web_id, VAPID_PRIVATE_VAR)
    subject = client.read_env_var(web_id, VAPID_SUBJECT_VAR)
    changed = False
    if not public or not private:
        public, private = generate_vapid_keypair()
        client.set_env_var(web_id, VAPID_PUBLIC_VAR, public)
        client.set_env_var(web_id, VAPID_PRIVATE_VAR, private)
        changed = True
    if not subject and web_url:
        client.set_env_var(web_id, VAPID_SUBJECT_VAR, _vapid_subject(web_url))
        changed = True
    if changed:
        # Activate the update: request a deploy and REMEMBER its id, so readiness
        # confirms THIS deploy goes live rather than an older live one the listing
        # may still be returning.
        report.web_activation_requested = True
        report.web_activation_deploy_id = client.request_deploy(web_id)
    report.vapid_configured = bool(public and private and (subject or web_url))


# --- the run -------------------------------------------------------------------


@dataclass
class Resource:
    """One resource's outcome. ``action`` is 'created' or 'reused', so a run says
    which resources it made and which were already there."""

    kind: str
    name: str
    id: str = ""
    url: str = ""
    action: str = ""


@dataclass
class ProvisionReport:
    workspace: str
    workspace_source: str
    credential_source: str
    resources: list[Resource] = field(default_factory=list)
    # Only the fact that a password is configured. No secret in this report,
    # including its repr, and no password file is written on the laptop.
    app_token_known: bool = False
    # Whether browser-push (VAPID) keys are configured on the web service after
    # this run. No key material is kept; this is only the fact.
    vapid_configured: bool = False
    # Deploy readiness, filled by the readiness wait. deploys_ready is true only
    # when BOTH the web and worker deploys are live. deploy_detail names a failed
    # or pending service when they are not, for the installer's message.
    deploys_ready: bool = False
    web_ready: bool = False
    worker_ready: bool = False
    deploy_detail: str = ""
    deploy_statuses: dict[str, str] = field(default_factory=dict)
    # When notification config was completed on an already-live web service, a
    # deploy is requested to activate it. Readiness must confirm THIS deploy, not
    # whatever the listing returns. The id is what request_deploy named (or None
    # if it named nothing, which readiness treats as unconfirmed).
    web_activation_requested: bool = False
    web_activation_deploy_id: str | None = None

    @property
    def web(self) -> Resource | None:
        return next((r for r in self.resources if r.kind == "web"), None)

    @property
    def web_url(self) -> str:
        web = self.web
        return web.url if web else ""

    @property
    def web_created(self) -> bool:
        web = self.web
        return bool(web and web.action == "created")

    def as_dict(self) -> dict[str, Any]:
        """The JSON the installer reads: ids, the web address and what was made.
        No secret is in here, by construction."""
        return {
            "ok": True,
            "workspace": self.workspace,
            "web_url": self.web_url,
            "web_created": self.web_created,
            "app_token_known": self.app_token_known,
            "vapid_configured": self.vapid_configured,
            "deploys_ready": self.deploys_ready,
            "web_ready": self.web_ready,
            "worker_ready": self.worker_ready,
            "deploy_detail": self.deploy_detail,
            "deploy_statuses": self.deploy_statuses,
            "resources": [
                {"kind": r.kind, "name": r.name, "id": r.id, "url": r.url, "action": r.action}
                for r in self.resources
            ],
        }


def validate_app_password(value: str) -> None:
    """A memorable passphrase compatible with the existing bearer-token gate.

    The phone trims surrounding whitespace and sends the value in an HTTP
    header. Keep internal spaces and punctuation verbatim, but reject edge
    spaces, controls and non-ASCII characters rather than changing the secret.
    This remains a shared bearer credential, not a hashed-password login.
    """
    if not value:
        raise ProvisionError("That was empty. Choose a strong passphrase.")
    if len(value) < 20:
        raise ProvisionError("Use at least 20 characters, such as several unrelated words.")
    if not all(" " <= ch <= "~" for ch in value):
        raise ProvisionError("Use printable ASCII letters, spaces or punctuation only.")
    if value != value.strip():
        raise ProvisionError("Leave out spaces at the beginning and end.")


def inspect_app(
    client: ProvisionClient, specs: dict[str, dict[str, Any]], *, workspace: str, repo: str
) -> dict[str, str]:
    """Read-only password decision before collecting inputs or making resources.

    Identity checks are the same as reuse, including reuse across branches of
    the same repository. Never return a password or silently repair a missing
    one. An existing installation keeps its authentication unchanged.
    """
    spec = specs["web"]
    name = str(_need(spec, "name", "web"))
    existing = client.find_service(name, workspace=workspace)
    if existing is None:
        return {"password_mode": "new", "existing_web_id": "", "web_url": ""}
    _ensure_service_compatible(
        existing, expected_type=API_SERVICE_TYPE["web"], repo=repo,
        region=str(spec.get("region") or ""), name=name,
    )
    web_id = _resource_id(existing)
    if not client.read_env_var(web_id, APP_TOKEN_VAR):
        raise ProvisionError(
            "The existing app has no configured password. Nothing was changed. "
            "Restore PARATROOPER_APP_TOKEN on that web service and deploy it before retrying."
        )
    return {
        "password_mode": "existing", "existing_web_id": web_id,
        "web_url": _service_url(existing),
    }


def _check_password_mode(
    state: dict[str, str], *, password_mode: str, existing_web_id: str
) -> None:
    if state["password_mode"] != password_mode or (
        password_mode == "existing" and state["existing_web_id"] != existing_web_id
    ):
        raise ProvisionError(
            "The app changed since the password step. No password was set or replaced. "
            "Run ./install.sh again to check the installation before continuing."
        )


def provision(
    *,
    client: ProvisionClient,
    specs: dict[str, dict[str, Any]],
    workspace: str,
    repo: str,
    branch: str,
    values: dict[str, str],
    password_mode: str = "new",
    existing_web_id: str = "",
    workspace_source: str = "caller",
    announce: Callable[[Resource], None] | None = None,
) -> ProvisionReport:
    """Find-or-create the Key Value store, the worker and the web service.

    Ordered by the two links: the store first, since both services carry its
    connection string; the worker before the web, since the web carries the
    worker's id when idle sleeping is on. Each resource is created with its whole
    environment, or reused untouched if it already exists. A failure stops the
    run at the resource that failed, having created the earlier ones, so running
    again reuses those and finishes.
    """
    report = ProvisionReport(
        workspace=workspace,
        workspace_source=workspace_source,
        credential_source=client.credential.source,
    )

    # Fail before ANY write if the selected password would be ignored, if the
    # reused app changed, or if a resume would create an app without a password.
    if password_mode == "new":
        validate_app_password(values.get(APP_TOKEN_VAR, ""))
    elif password_mode == "existing":
        if APP_TOKEN_VAR in values:
            raise ProvisionError("An existing app keeps its password; do not supply a new one.")
    else:
        raise ProvisionError("Choose new or existing for the password mode.")
    _check_password_mode(
        inspect_app(client, specs, workspace=workspace, repo=repo),
        password_mode=password_mode, existing_web_id=existing_web_id,
    )

    def record(resource: Resource) -> None:
        report.resources.append(resource)
        if announce is not None:
            announce(resource)

    # 1. Key Value. Both services read REDIS_URL off its internal address.
    kv_spec = specs[KEYVALUE_TYPE]
    kv_name = str(_need(kv_spec, "name", "keyvalue"))
    kv_region = str(kv_spec.get("region") or "")
    existing_kv = client.find_key_value(kv_name, workspace=workspace)
    if existing_kv is not None:
        _ensure_key_value_compatible(existing_kv, region=kv_region, name=kv_name)
        kv_id = _resource_id(existing_kv)
        record(Resource("keyvalue", kv_name, kv_id, "", "reused"))
    else:
        created = client.create_key_value(key_value_body(kv_spec, workspace))
        kv_id = _resource_id(created)
        record(Resource("keyvalue", kv_name, kv_id, "", "created"))
    redis_url = client.key_value_connection(kv_id)

    # 2. Worker. Its id becomes the web service's RENDER_WORKER_SERVICE_ID, so a
    # reused one is adopted only once it is established to be this deployment's
    # worker: wiring a stranger's id into suspend/resume would be controlling it.
    worker_spec = specs["worker"]
    worker_name = str(_need(worker_spec, "name", "worker"))
    worker_region = str(worker_spec.get("region") or "")
    existing_worker = client.find_service(worker_name, workspace=workspace)
    if existing_worker is not None:
        _ensure_service_compatible(
            existing_worker, expected_type=API_SERVICE_TYPE["worker"],
            repo=repo, region=worker_region, name=worker_name,
        )
        worker_id = _resource_id(existing_worker)
        record(Resource("worker", worker_name, worker_id, "", "reused"))
    else:
        env = resolve_env_vars(worker_spec.get("envVars"), values, redis_url)
        created = client.create_service(
            service_body(worker_spec, workspace, repo=repo, branch=branch, env_vars=env)
        )
        worker_id = _resource_id(created)
        record(Resource("worker", worker_name, worker_id, "", "created"))

    # 3. Web. Idle sleeping needs the pair; when it is off, neither is set and the
    # web service leaves the worker always on, which is render_control's own rule.
    web_values = dict(values)
    if "RENDER_API_KEY" in web_values:
        web_values["RENDER_WORKER_SERVICE_ID"] = worker_id
    web_spec = specs["web"]
    web_name = str(_need(web_spec, "name", "web"))
    web_region = str(web_spec.get("region") or "")
    existing_web = client.find_service(web_name, workspace=workspace)
    # Check again at the web write boundary: another install may have completed
    # while the store and worker were being created. Never discard a chosen
    # password or turn a confirmed reuse into a new installation.
    _check_password_mode(
        {"password_mode": "existing" if existing_web is not None else "new",
         "existing_web_id": _resource_id(existing_web) if existing_web is not None else ""},
        password_mode=password_mode, existing_web_id=existing_web_id,
    )
    if existing_web is not None:
        _ensure_service_compatible(
            existing_web, expected_type=API_SERVICE_TYPE["web"],
            repo=repo, region=web_region, name=web_name,
        )
        web_id = _resource_id(existing_web)
        web_url = _service_url(existing_web)
        report.app_token_known = True
        _ensure_web_push(client, web_id, web_url, report)
        record(Resource("web", web_name, web_id, web_url, "reused"))
    else:
        # Browser-push keys are generated now and set with the rest of the web
        # service's environment, so the very first deploy already carries a working
        # push configuration (public key, private key and contact). The subject is
        # the service's predicted address: the actual URL is only known after
        # creation, and a later env-var change would need its own deploy to take
        # effect. The private key goes straight onto the service.
        public_key, private_key = generate_vapid_keypair()
        web_values[VAPID_PUBLIC_VAR] = public_key
        web_values[VAPID_PRIVATE_VAR] = private_key
        web_values[VAPID_SUBJECT_VAR] = _vapid_subject(_predicted_url(web_name))
        env = resolve_env_vars(web_spec.get("envVars"), web_values, redis_url)
        created = client.create_service(
            service_body(web_spec, workspace, repo=repo, branch=branch, env_vars=env)
        )
        web_id = _resource_id(created)
        web_url = _service_url(created)
        report.app_token_known = True
        report.vapid_configured = True
        record(Resource("web", web_name, web_id, web_url, "created"))

    return report


def _real_sleep(seconds: float) -> None:
    import time

    if seconds > 0:
        time.sleep(seconds)


def readiness_targets(report: ProvisionReport) -> list[tuple[str, str, str, str | None]]:
    """The (kind, name, id, required_deploy_id) each readiness poll checks. The
    required id is set only for the web when an activation deploy was requested on
    an already-live service, so that specific deploy is what gets confirmed;
    everything else is judged on its latest (and only meaningful) deploy."""
    targets: list[tuple[str, str, str, str | None]] = []
    for resource in report.resources:
        if resource.kind not in ("web", "worker"):
            continue
        required = None
        if resource.kind == "web" and report.web_activation_requested:
            required = report.web_activation_deploy_id
        targets.append((resource.kind, resource.name, resource.id, required))
    return targets


def wait_until_ready(
    client: ProvisionClient,
    services: list[tuple[str, str, str, str | None]],
    *,
    tries: int,
    interval: float,
    sleep: Callable[[float], None] | None = None,
    announce: Callable[[str], None] | None = None,
) -> tuple[bool, dict[str, str], str]:
    """Poll the given (kind, name, id, required_deploy_id) services until every
    deploy is live, one fails, or the attempts run out.

    The web's own health check is not enough: the page can answer while the
    worker's deploy has failed or is still building, so BOTH required deploys are
    checked here. When an entry carries a required deploy id, THAT specific deploy
    is queried (an activation deploy must be confirmed on its own, since the
    listing can still be returning an older live one); otherwise the service's
    latest deploy is used. A failed deploy stops immediately with a message naming
    it; a status that cannot be read stays pending rather than passing; a run out
    of attempts is reported as unconfirmed. Nothing is created, changed or removed
    here - this only reads status.
    """
    naptime = sleep or _real_sleep
    statuses: dict[str, str] = {}
    for attempt in range(max(tries, 1)):
        pending: list[str] = []
        for kind, name, service_id, required in services:
            if required:
                status = client.deploy_status(service_id, required) or "unknown"
            else:
                status = client.latest_deploy_status(service_id) or "unknown"
            statuses[kind] = status
            if status in DEPLOY_FAILED:
                return False, statuses, f"Part of your app did not deploy: {name} ({status})."
            if status not in DEPLOY_LIVE:
                pending.append(f"{kind} {status}")
        if not pending:
            return True, statuses, ""
        if announce is not None:
            announce("waiting for the deploy to finish: " + ", ".join(pending))
        if attempt + 1 < tries:
            naptime(interval)
    trailing = ", ".join(f"{kind} {status}" for kind, status in statuses.items())
    return False, statuses, f"Your app did not come up in time ({trailing})."


# --- secrets on stdin ----------------------------------------------------------


def read_secret_lines(stream: TextIO) -> dict[str, str]:
    """The secret values, one ``NAME=value`` per line, read from stdin.

    stdin so they are in no argv and in no environment: the write to the service
    is the only place they go. The split is on the first '=' so a base64 value's
    own '=' padding stays in the value. Blank lines and '#' comments are ignored.
    """
    values: dict[str, str] = {}
    for number, raw in enumerate(stream.read().splitlines(), start=1):
        line = raw.rstrip("\r")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        name, sep, value = line.partition("=")
        name = name.strip()
        if not sep or not name:
            raise ProvisionError(f"stdin line {number} is not NAME=value")
        values[name] = value
    return values


# --- the command line ----------------------------------------------------------


def _write_report(path: str, report: ProvisionReport) -> None:
    Path(path).write_text(json.dumps(report.as_dict(), indent=2) + "\n", encoding="utf-8")


def _announce(resource: Resource) -> None:
    where = f" -> {resource.url}" if resource.url else ""
    print(f"  {resource.action} {resource.kind} {resource.name}{where}")


def open_client(credential: Credential) -> ProvisionClient:
    """The provisioning client. A normal run talks to Render over the network.

    Offline tests set ``PARATROOPER_PROVISION_MOCK`` and put a ``mock_render_api``
    module on the path; this then routes the same calls through that module's
    httpx MockTransport instead of a socket, so the whole tool can be exercised
    end to end without a network or an account. The installer never sets it. The
    request URLs are unchanged, so the official-host allowlist still applies:
    only the transport underneath is a test double, and the credential's token is
    still attached to every call exactly as a real run would attach it.
    """
    if os.environ.get("PARATROOPER_PROVISION_MOCK"):
        import importlib

        mock = importlib.import_module("mock_render_api")
        return ProvisionClient(credential, http=mock.http_client())
    return ProvisionClient(credential)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m paratrooper.provision",
        description="Create a fresh Paratrooper deployment on Render from render.yaml.",
    )
    parser.add_argument("--blueprint", required=True, help="path to render.yaml")
    parser.add_argument("--config", default="", help="path to the TOML configuration source")
    parser.add_argument("--repo", required=True, help="the service's Git repository URL")
    parser.add_argument("--branch", required=True, help="the branch Render builds from")
    parser.add_argument("--report", default="", help="path to write the JSON report to")
    parser.add_argument("--inspect-app", action="store_true", help="read-only password preflight")
    parser.add_argument("--password-mode", choices=("new", "existing"), default="new")
    parser.add_argument("--existing-web-id", default="", help="web service confirmed for reuse")
    parser.add_argument("--workspace", default=None, help="Render workspace (owner) id")
    parser.add_argument(
        "--wait-ready",
        action="store_true",
        help="after provisioning, wait for the web and worker deploys to go live",
    )
    args = parser.parse_args(argv)

    try:
        specs = load_specs(args.blueprint)
        workspace, workspace_source = resolve_workspace(args.workspace)
        client = open_client(resolve_credential())
        if args.inspect_app:
            state = inspect_app(client, specs, workspace=workspace, repo=args.repo)
            if args.report:
                Path(args.report).write_text(json.dumps(state) + "\n", encoding="utf-8")
            return 0
        if not args.config:
            raise ProvisionError("--config is required when provisioning")
        # Secrets first, from stdin. The configuration file is not a secret; it is
        # validated (the service's own validator) and encoded here so a source
        # that could not boot never reaches a new service.
        values = read_secret_lines(sys.stdin)
        _config, _text, encoded = read_source(args.config)
        values[CONFIG_KEY] = encoded

        report = provision(
            client=client,
            specs=specs,
            workspace=workspace,
            repo=args.repo,
            branch=args.branch,
            values=values,
            password_mode=args.password_mode,
            existing_web_id=args.existing_web_id,
            workspace_source=workspace_source,
            announce=_announce,
        )
        if args.wait_ready:
            tries = int(os.environ.get("PARATROOPER_PROVISION_READY_TRIES", "60") or "60")
            interval = float(os.environ.get("PARATROOPER_PROVISION_READY_INTERVAL", "5") or "5")
            if report.web_activation_requested and not report.web_activation_deploy_id:
                # The activation deploy was requested but the API named no id, so
                # its readiness cannot be confirmed. An older live deploy must not
                # stand in for it: stay unconfirmed.
                report.deploys_ready = False
                report.deploy_detail = "Render did not confirm the restart that turns on notifications."
            else:
                ready, statuses, detail = wait_until_ready(
                    client, readiness_targets(report), tries=tries, interval=interval,
                    announce=lambda line: print(f"  {line}"),
                )
                report.deploys_ready = ready
                report.web_ready = statuses.get("web") in DEPLOY_LIVE
                report.worker_ready = statuses.get("worker") in DEPLOY_LIVE
                report.deploy_detail = detail
                report.deploy_statuses = statuses
        if args.report:
            _write_report(args.report, report)
        return 0
    except DeployError as exc:
        print(wrap_installer_message(str(exc), first_prefix="error: "), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
