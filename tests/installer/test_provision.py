#!/usr/bin/env python3
"""Offline tests for paratrooper.provision.

Real code, real parser, real HTTP client: PyYAML parses the actual render.yaml,
and the network is mocked only at the httpx boundary with httpx.MockTransport
(see mock_render_api). Nothing here reaches a socket, an account or a service.

Run directly with the deploy dependencies installed:
    python3 tests/installer/test_provision.py
PARATROOPER_INSTALL_TEST_DEPS optionally points to vendored offline libraries.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
for entry in (os.environ.get("PARATROOPER_INSTALL_TEST_DEPS", ""), PROJECT / "src", Path(__file__).parent):
    if entry:
        sys.path.insert(0, str(entry))

import mock_render_api  # noqa: E402  (after sys.path bootstrap)
from paratrooper import deploy, provision  # noqa: E402
from paratrooper.agent.config import parse_config  # noqa: E402

BLUEPRINT = str(PROJECT / "render.yaml")
WORKSPACE = "tea-testworkspace00000001"
REPO = "https://github.com/example/paratrooper.git"
BRANCH = "main"

# Fake, obviously-not-real credentials. The provisioning key signs the API calls;
# the idle key is a different value that must only ever land in the web service.
PROVISION_KEY = "rnd_provisioning_key_AAAAAAA"
IDLE_KEY = "rnd_idle_sleeping_key_ZZZZZZZ"
APP_PASSWORD = "fake violet lantern orchard comet 7!"
CLAUDE_TOKEN = "sk-ant-oat01-CLAUDETOKEN000"

# The plain configuration the installer writes (the tracked example's own short
# plain source). base64 of this is what should reach both services.
CONFIG_TEXT = (
    "schema = 1\n"
    'model = "claude-sonnet-5"\n'
    'notifications.reply = "Paratrooper replied."\n'
    'notifications.error = "Paratrooper hit a problem."\n'
    "uploads.ttl_hours = 1\n"
    'profile = "plain"\n'
)
ENCODED = deploy.encode_source(CONFIG_TEXT)


def _fresh_state() -> str:
    d = tempfile.mkdtemp(prefix="ptp-provision-test-")
    os.environ["MOCK_STATE_DIR"] = d
    return d


def _client() -> provision.ProvisionClient:
    client = provision.ProvisionClient(
        deploy.Credential(PROVISION_KEY, "offline fixture"), http=mock_render_api.http_client()
    )
    client._conn_interval = 0  # never sleep in a test
    client._conn_tries = 5
    return client


def _calls() -> list[dict]:
    path = Path(os.environ["MOCK_STATE_DIR"]) / "api_calls.jsonl"
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _state() -> dict:
    return json.loads((Path(os.environ["MOCK_STATE_DIR"]) / "api_state.json").read_text())


def _writes(calls) -> list[dict]:
    return [c for c in calls if c["method"] in ("POST", "PUT")]


def _seed_service(name, *, service_type, repo, region, env=None):
    """Pre-place a service in the mock's state, to stand in for a resource that
    already exists (an unrelated same-named one, or a partially-configured one
    from an earlier interrupted run)."""
    path = Path(os.environ["MOCK_STATE_DIR"]) / "api_state.json"
    state = json.loads(path.read_text()) if path.is_file() else {
        "services": {}, "key_values": {}, "counter": 0, "conn_reads": 0
    }
    state.setdefault("services", {})[name] = {
        "id": f"srv-seed-{name}", "name": name, "ownerId": WORKSPACE,
        "type": service_type, "repo": repo, "suspended": "not_suspended",
        "serviceDetails": {"region": region, "url": f"https://{name}.onrender.com"},
        "_envVars": dict(env or {}),
    }
    path.write_text(json.dumps(state))


def _seed_key_value(name, *, region):
    path = Path(os.environ["MOCK_STATE_DIR"]) / "api_state.json"
    state = json.loads(path.read_text()) if path.is_file() else {
        "services": {}, "key_values": {}, "counter": 0, "conn_reads": 0
    }
    state.setdefault("key_values", {})[name] = {
        "id": f"kv-seed-{name}", "name": name, "ownerId": WORKSPACE,
        "owner": {"id": WORKSPACE}, "region": region, "status": "available",
    }
    path.write_text(json.dumps(state))


def _posts_to(calls, path):
    return [c for c in calls if c["method"] == "POST" and c["path"] == path]


def _last_post(calls, path, name=None):
    for call in reversed(calls):
        if call["method"] == "POST" and call["path"] == path:
            body = call["body"] or {}
            if name is None or body.get("name") == name:
                return body
    return None


def _envmap(body) -> dict:
    return {item["key"]: item["value"] for item in (body or {}).get("envVars", [])}


def _base_values() -> dict:
    return {
        "PARATROOPER_APP_TOKEN": APP_PASSWORD,
        "CLAUDE_CODE_OAUTH_TOKEN": CLAUDE_TOKEN,
        provision.CONFIG_KEY: ENCODED,
    }


def _resume_options() -> dict:
    values = _base_values()
    values.pop(provision.APP_TOKEN_VAR)
    web_id = _state()["services"]["paratrooper-web"]["id"]
    return dict(values=values, password_mode="existing", existing_web_id=web_id)


# --- the checks ----------------------------------------------------------------


def test_parser_reads_real_blueprint():
    specs = provision.load_specs(BLUEPRINT)
    assert set(specs) == {"web", "worker", "keyvalue"}, list(specs)
    web, worker, kv = specs["web"], specs["worker"], specs["keyvalue"]
    assert web["runtime"] == "docker" and worker["runtime"] == "docker"
    assert web["plan"] == "starter" and worker["plan"] == "standard"
    assert web["healthCheckPath"] == "/api/health"
    assert web["disk"] == {"name": "paratrooper-data", "mountPath": "/data", "sizeGB": 1}
    assert web["dockerfilePath"] == "./Dockerfile.web"
    assert worker["dockerfilePath"] == "./Dockerfile.worker"
    assert kv["plan"] == "starter" and kv["maxmemoryPolicy"] == "noeviction"
    assert kv["ipAllowList"] == []
    # the one cross-service link the blueprint declares
    links = [e for e in web["envVars"] if isinstance(e.get("fromService"), dict)]
    assert links and links[0]["key"] == "REDIS_URL"
    assert links[0]["fromService"]["property"] == "connectionString"


def test_fresh_install_idle_off():
    _fresh_state()
    report = provision.provision(
        client=_client(), specs=provision.load_specs(BLUEPRINT), workspace=WORKSPACE,
        repo=REPO, branch=BRANCH, values=_base_values(),
    )
    assert [r.kind for r in report.resources] == ["keyvalue", "worker", "web"]
    assert all(r.action == "created" for r in report.resources)
    assert report.web_url == "https://paratrooper-web.onrender.com"
    assert report.web_created is True

    calls = _calls()
    order = [c["path"] for c in calls if c["method"] == "POST"]
    assert order[0] == "/key-value", order  # store before services
    assert order.count("/services") == 2

    kv_body = _last_post(calls, "/key-value")
    assert kv_body["plan"] == "starter" and kv_body["maxmemoryPolicy"] == "noeviction"
    assert kv_body["ownerId"] == WORKSPACE and kv_body["ipAllowList"] == []

    worker_body = _last_post(calls, "/services", "paratrooper-worker")
    wdetails = worker_body["serviceDetails"]
    assert worker_body["type"] == "background_worker"
    assert worker_body["repo"] == REPO and worker_body["branch"] == BRANCH
    assert worker_body["autoDeploy"] == "yes"
    assert wdetails["runtime"] == "docker" and wdetails["plan"] == "standard"
    assert wdetails["envSpecificDetails"]["dockerfilePath"] == "./Dockerfile.worker"
    assert "disk" not in wdetails and "healthCheckPath" not in wdetails
    wenv = _envmap(worker_body)
    assert wenv[provision.CONFIG_KEY] == ENCODED
    assert wenv["CLAUDE_CODE_OAUTH_TOKEN"] == CLAUDE_TOKEN
    assert wenv["AGENT_AUTH"] == "subscription"
    assert wenv["PARATROOPER_INBOX"] == "/tmp/paratrooper-inbox"
    assert wenv["PARATROOPER_SITE_ROOT"] == "/app/site_checkout"
    assert wenv["REDIS_URL"].startswith("redis://red-")
    # pinboard-only and idle-only secrets must be absent on a plain worker
    for absent in ("PARATROOPER_GITHUB_APP_ID", "PARATROOPER_GITHUB_APP_KEY_PEM",
                   "SPOTIFY_CLIENT_ID", "PARATROOPER_APP_TOKEN", "RENDER_API_KEY"):
        assert absent not in wenv, absent

    web_body = _last_post(calls, "/services", "paratrooper-web")
    ddetails = web_body["serviceDetails"]
    assert web_body["type"] == "web_service"
    assert ddetails["healthCheckPath"] == "/api/health"
    assert ddetails["disk"] == {"name": "paratrooper-data", "mountPath": "/data", "sizeGB": 1}
    assert ddetails["envSpecificDetails"]["dockerfilePath"] == "./Dockerfile.web"
    denv = _envmap(web_body)
    assert denv[provision.CONFIG_KEY] == ENCODED
    assert denv["PARATROOPER_APP_TOKEN"] == APP_PASSWORD
    assert denv["PARATROOPER_INBOX"] == "/data/inbox"
    assert denv["REDIS_URL"] == wenv["REDIS_URL"]  # both wired to the same store
    # browser-push keys are generated and set on the web service at creation, as
    # compact base64url values (the format pywebpush's from_string reads)
    assert denv["VAPID_PUBLIC_KEY"] and denv["VAPID_PRIVATE_KEY"]
    assert "-----" not in denv["VAPID_PRIVATE_KEY"]
    for absent in ("RENDER_API_KEY", "RENDER_WORKER_SERVICE_ID", "CLAUDE_CODE_OAUTH_TOKEN",
                   "PARATROOPER_GITHUB_TOKEN"):
        assert absent not in denv, absent

    # the live password is reported (in memory), and the subject is set to the
    # app's own URL in a follow-up once the URL is known
    assert report.app_token_known
    assert APP_PASSWORD not in repr(report)
    assert report.vapid_configured is True
    web_env = _state()["services"]["paratrooper-web"]["_envVars"]
    assert web_env["VAPID_SUBJECT"] == report.web_url

    # the report file carries no secret
    dumped = json.dumps(report.as_dict())
    for secret in (APP_PASSWORD, CLAUDE_TOKEN, ENCODED, denv["VAPID_PRIVATE_KEY"]):
        assert secret not in dumped


def test_config_round_trips_to_valid_plain():
    _fresh_state()
    provision.provision(
        client=_client(), specs=provision.load_specs(BLUEPRINT), workspace=WORKSPACE,
        repo=REPO, branch=BRANCH, values=_base_values(),
    )
    web_body = _last_post(_calls(), "/services", "paratrooper-web")
    encoded = _envmap(web_body)[provision.CONFIG_KEY]
    text = base64.b64decode(encoded).decode("utf-8")
    config = parse_config(text)  # the service's own validator
    assert config.profile == "plain" and config.schema == 1


def test_idle_on_wires_pair_and_keeps_keys_distinct():
    _fresh_state()
    values = _base_values()
    values["RENDER_API_KEY"] = IDLE_KEY  # the idle key, destined for the web env only
    report = provision.provision(
        client=_client(), specs=provision.load_specs(BLUEPRINT), workspace=WORKSPACE,
        repo=REPO, branch=BRANCH, values=values,
    )
    worker = next(r for r in report.resources if r.kind == "worker")
    calls = _calls()
    denv = _envmap(_last_post(calls, "/services", "paratrooper-web"))
    assert denv["RENDER_API_KEY"] == IDLE_KEY
    assert denv["RENDER_WORKER_SERVICE_ID"] == worker.id
    # every API call was signed with the provisioning key, never the idle key
    tokens = {c["token"] for c in calls}
    assert tokens == {PROVISION_KEY}, tokens
    assert IDLE_KEY not in tokens
    # the worker never receives the idle key either
    assert "RENDER_API_KEY" not in _envmap(_last_post(calls, "/services", "paratrooper-worker"))


def test_rerun_is_idempotent():
    _fresh_state()
    kwargs = dict(specs=provision.load_specs(BLUEPRINT), workspace=WORKSPACE,
                  repo=REPO, branch=BRANCH, values=_base_values())
    provision.provision(client=_client(), **kwargs)
    first = len(_calls())
    kwargs.update(_resume_options())
    report = provision.provision(client=_client(), **kwargs)
    assert all(r.action == "reused" for r in report.resources)
    assert report.web_created is False
    # nothing is created or written again: a clean re-run makes no POST or PUT
    second = _calls()[first:]
    assert not _writes(second), second
    # the live password and push config are recovered from the service, not reset
    assert report.app_token_known
    assert APP_PASSWORD not in repr(report)
    assert report.vapid_configured is True


def test_partial_failure_then_resume():
    _fresh_state()
    kwargs = dict(specs=provision.load_specs(BLUEPRINT), workspace=WORKSPACE,
                  repo=REPO, branch=BRANCH, values=_base_values())
    os.environ["MOCK_API_FAIL_SERVICE"] = "paratrooper-web"
    try:
        provision.provision(client=_client(), **kwargs)
        raise AssertionError("expected the web create to fail")
    except provision.DeployError:
        pass
    finally:
        os.environ.pop("MOCK_API_FAIL_SERVICE", None)
    # the store and worker were created before the web failed
    state = json.loads((Path(os.environ["MOCK_STATE_DIR"]) / "api_state.json").read_text())
    assert "paratrooper-kv" in state["key_values"]
    assert "paratrooper-worker" in state["services"]
    assert "paratrooper-web" not in state["services"]
    # the re-run reuses those two and finishes the web service
    report = provision.provision(client=_client(), **kwargs)
    actions = {r.kind: r.action for r in report.resources}
    assert actions == {"keyvalue": "reused", "worker": "reused", "web": "created"}


def test_connection_info_is_polled():
    _fresh_state()
    os.environ["MOCK_API_CONN_404"] = "2"  # first two reads 404, third answers
    try:
        report = provision.provision(
            client=_client(), specs=provision.load_specs(BLUEPRINT), workspace=WORKSPACE,
            repo=REPO, branch=BRANCH, values=_base_values(),
        )
    finally:
        os.environ.pop("MOCK_API_CONN_404", None)
    assert _envmap(_last_post(_calls(), "/services", "paratrooper-web"))["REDIS_URL"].startswith("redis://red-")
    assert report.web_created is True


def test_unreachable_is_reported_not_swallowed():
    _fresh_state()
    os.environ["MOCK_API_UNREACHABLE"] = "/key-value"
    try:
        provision.provision(
            client=_client(), specs=provision.load_specs(BLUEPRINT), workspace=WORKSPACE,
            repo=REPO, branch=BRANCH, values=_base_values(),
        )
        raise AssertionError("expected an unreachable error")
    except provision.DeployError as exc:
        assert "no answer" in str(exc)
    finally:
        os.environ.pop("MOCK_API_UNREACHABLE", None)


def test_reuse_refuses_wrong_type():
    _fresh_state()
    # a service of the WRONG type shares the web service's name
    _seed_service("paratrooper-web", service_type="background_worker", repo=REPO, region="oregon")
    try:
        provision.provision(client=_client(), specs=provision.load_specs(BLUEPRINT),
                            workspace=WORKSPACE, repo=REPO, branch=BRANCH, values=_base_values())
        raise AssertionError("expected a wrong-type collision to stop the run")
    except provision.DeployError as exc:
        assert "not the" in str(exc) or "unrelated" in str(exc)
    # the impostor was not adopted, reconfigured or overwritten
    impostor = _state()["services"]["paratrooper-web"]
    assert impostor["type"] == "background_worker"
    assert impostor["_envVars"] == {}


def test_reuse_refuses_different_repo():
    _fresh_state()
    # a worker of the right type but built from someone else's repository. Its id
    # must never be wired into the web service's suspend/resume controls.
    _seed_service("paratrooper-worker", service_type="background_worker",
                  repo="https://github.com/someone-else/unrelated.git", region="oregon")
    values = _base_values()
    values["RENDER_API_KEY"] = IDLE_KEY  # would wire the worker id in, if adopted
    try:
        provision.provision(client=_client(), specs=provision.load_specs(BLUEPRINT),
                            workspace=WORKSPACE, repo=REPO, branch=BRANCH, values=values)
        raise AssertionError("expected a different-repo collision to stop the run")
    except provision.DeployError as exc:
        assert "different repository" in str(exc) or "unrelated" in str(exc)
    # the impostor was not written to, and no web service was created that could
    # carry its id
    impostor = _state()["services"]["paratrooper-worker"]
    assert impostor["_envVars"] == {}
    assert "paratrooper-web" not in _state()["services"]


def test_create_lost_then_rerun_recovers_password():
    _fresh_state()
    kwargs = dict(specs=provision.load_specs(BLUEPRINT), workspace=WORKSPACE, repo=REPO, branch=BRANCH)
    # run 1: the web service is created on the server, but the response is lost
    os.environ["MOCK_API_LOSE_RESPONSE"] = "paratrooper-web"
    try:
        provision.provision(client=_client(), values=_base_values(), **kwargs)
        raise AssertionError("expected the lost response to surface as an error")
    except provision.DeployError as exc:
        assert "no answer" in str(exc)
    finally:
        os.environ.pop("MOCK_API_LOSE_RESPONSE", None)
    # the web service exists on the server, carrying run 1's password
    stored = _state()["services"]["paratrooper-web"]["_envVars"]["PARATROOPER_APP_TOKEN"]
    assert stored == APP_PASSWORD
    # A new candidate must be rejected rather than silently ignored.
    values2 = _base_values()
    values2["PARATROOPER_APP_TOKEN"] = "A-DIFFERENT-FRESH-CANDIDATE-000"
    before = len(_calls())
    try:
        provision.provision(client=_client(), values=values2, **kwargs)
        raise AssertionError("expected a new-password conflict")
    except provision.ProvisionError as exc:
        assert "changed since the password step" in str(exc)
        assert values2["PARATROOPER_APP_TOKEN"] not in str(exc)
    assert not _writes(_calls()[before:])
    report = provision.provision(client=_client(), **_resume_options(), **kwargs)
    assert report.web is not None and report.web.action == "reused"
    assert report.app_token_known
    assert stored not in repr(report)
    assert _state()["services"]["paratrooper-web"]["_envVars"][provision.APP_TOKEN_VAR] == stored


def test_vapid_keys_are_valid_and_app_loadable():
    _fresh_state()
    report = provision.provision(client=_client(), specs=provision.load_specs(BLUEPRINT),
                                 workspace=WORKSPACE, repo=REPO, branch=BRANCH, values=_base_values())
    web_env = _state()["services"]["paratrooper-web"]["_envVars"]
    public_b64 = web_env["VAPID_PUBLIC_KEY"]
    private_b64 = web_env["VAPID_PRIVATE_KEY"]
    subject = web_env["VAPID_SUBJECT"]
    assert subject == report.web_url and subject.startswith("https://")
    assert report.vapid_configured is True
    assert "-----" not in private_b64  # raw base64url, the from_string format

    # the app's own loader (py_vapid, the library pywebpush signs with) accepts
    # the private key: what was wired is what the web service will sign with
    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid01

    vapid = Vapid01.from_string(private_b64)
    assert vapid.private_key is not None
    # and the public key it derives is exactly the applicationServerKey the
    # browser is handed, so the pair the service holds is internally consistent
    point = vapid.private_key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    assert base64.urlsafe_b64encode(point).rstrip(b"=").decode() == public_b64


def test_resume_activates_missing_vapid_subject():
    # An already-live web from an interrupted run: the key pair is present but the
    # subject was never set. The rerun must complete AND activate it (a saved env
    # var is not active until a deploy), and recover the live password.
    _fresh_state()
    seeded_token = "legacy"  # existing passwords are reused without applying the new rule
    _seed_key_value("paratrooper-kv", region="oregon")
    _seed_service("paratrooper-worker", service_type="background_worker", repo=REPO, region="oregon")
    _seed_service("paratrooper-web", service_type="web_service", repo=REPO, region="oregon", env={
        "PARATROOPER_APP_TOKEN": seeded_token,
        "VAPID_PUBLIC_KEY": "seeded-public-key",
        "VAPID_PRIVATE_KEY": "seeded-private-key",
        # VAPID_SUBJECT intentionally absent
    })
    report = provision.provision(client=_client(), specs=provision.load_specs(BLUEPRINT),
                                 workspace=WORKSPACE, repo=REPO, branch=BRANCH, **_resume_options())
    assert report.web is not None and report.web.action == "reused"
    web_env = _state()["services"]["paratrooper-web"]["_envVars"]
    # the missing subject was completed on the service
    assert web_env["VAPID_SUBJECT"] == "https://paratrooper-web.onrender.com"
    # a save is not activation: a deploy was requested so the running web reloads,
    # and its id was retained for readiness to confirm specifically
    assert _posts_to(_calls(), "/services/srv-seed-paratrooper-web/deploys")
    assert report.web_activation_requested is True
    assert report.web_activation_deploy_id
    assert report.vapid_configured is True
    # the live password was recovered, not reset; the keys were not regenerated
    assert report.app_token_known
    assert web_env[provision.APP_TOKEN_VAR] == seeded_token
    assert seeded_token not in repr(report)
    assert web_env["VAPID_PUBLIC_KEY"] == "seeded-public-key"


def _seed_all_reusable(subject_present=True):
    """Seed a full, reusable deployment (kv + worker + a live web with keys), so a
    provision run reuses everything. subject_present controls whether the web
    already has VAPID_SUBJECT (missing => an activation deploy will be requested)."""
    env = {"PARATROOPER_APP_TOKEN": "seeded-token",
           "VAPID_PUBLIC_KEY": "seeded-public", "VAPID_PRIVATE_KEY": "seeded-private"}
    if subject_present:
        env["VAPID_SUBJECT"] = "https://paratrooper-web.onrender.com"
    _seed_key_value("paratrooper-kv", region="oregon")
    _seed_service("paratrooper-worker", service_type="background_worker", repo=REPO, region="oregon")
    _seed_service("paratrooper-web", service_type="web_service", repo=REPO, region="oregon", env=env)


def test_readiness_both_live():
    _fresh_state()
    report = provision.provision(client=_client(), specs=provision.load_specs(BLUEPRINT),
                                 workspace=WORKSPACE, repo=REPO, branch=BRANCH, values=_base_values())
    ready, statuses, detail = provision.wait_until_ready(
        _client(), provision.readiness_targets(report), tries=3, interval=0)
    assert ready is True and detail == ""
    assert statuses == {"web": "live", "worker": "live"}


def test_readiness_worker_failed_is_caught():
    _fresh_state()
    report = provision.provision(client=_client(), specs=provision.load_specs(BLUEPRINT),
                                 workspace=WORKSPACE, repo=REPO, branch=BRANCH, values=_base_values())
    os.environ["MOCK_DEPLOY_STATUS_WORKER"] = "build_failed"
    try:
        ready, statuses, detail = provision.wait_until_ready(
            _client(), provision.readiness_targets(report), tries=3, interval=0)
    finally:
        os.environ.pop("MOCK_DEPLOY_STATUS_WORKER", None)
    assert ready is False
    assert statuses["worker"] == "build_failed"
    assert detail == "Part of your app did not deploy: paratrooper-worker (build_failed)."


def test_readiness_worker_pending_times_out():
    _fresh_state()
    report = provision.provision(client=_client(), specs=provision.load_specs(BLUEPRINT),
                                 workspace=WORKSPACE, repo=REPO, branch=BRANCH, values=_base_values())
    os.environ["MOCK_DEPLOY_STATUS_WORKER"] = "build_in_progress"
    try:
        ready, statuses, detail = provision.wait_until_ready(
            _client(), provision.readiness_targets(report), tries=2, interval=0)
    finally:
        os.environ.pop("MOCK_DEPLOY_STATUS_WORKER", None)
    assert ready is False
    assert statuses["worker"] == "build_in_progress"
    assert "did not come up in time" in detail


def test_activation_deploy_pending_is_not_accepted_over_older_live():
    # The activation deploy is still building, but the deploys LISTING still
    # returns the older live deploy. Readiness must check the specific requested
    # deploy and stay unconfirmed, never accepting the older live one.
    _fresh_state()
    _seed_all_reusable(subject_present=False)  # forces an activation deploy
    report = provision.provision(client=_client(), specs=provision.load_specs(BLUEPRINT),
                                 workspace=WORKSPACE, repo=REPO, branch=BRANCH, **_resume_options())
    assert report.web_activation_requested and report.web_activation_deploy_id
    os.environ["MOCK_DEPLOY_STATUS_WEB"] = "live"            # the listing's older deploy
    os.environ["MOCK_DEPLOY_ACTIVATION_STATUS"] = "build_in_progress"  # the requested one
    try:
        ready, statuses, detail = provision.wait_until_ready(
            _client(), provision.readiness_targets(report), tries=2, interval=0)
    finally:
        os.environ.pop("MOCK_DEPLOY_STATUS_WEB", None)
        os.environ.pop("MOCK_DEPLOY_ACTIVATION_STATUS", None)
    assert ready is False                          # not accepted despite the live listing
    assert statuses["web"] == "build_in_progress"  # the specific deploy, not the listing
    assert "did not come up in time" in detail


def test_activation_deploy_reaching_live_succeeds():
    _fresh_state()
    _seed_all_reusable(subject_present=False)
    report = provision.provision(client=_client(), specs=provision.load_specs(BLUEPRINT),
                                 workspace=WORKSPACE, repo=REPO, branch=BRANCH, **_resume_options())
    assert report.web_activation_requested and report.web_activation_deploy_id
    os.environ["MOCK_DEPLOY_ACTIVATION_STATUS"] = "live"  # the requested deploy is now live
    try:
        ready, statuses, detail = provision.wait_until_ready(
            _client(), provision.readiness_targets(report), tries=3, interval=0)
    finally:
        os.environ.pop("MOCK_DEPLOY_ACTIVATION_STATUS", None)
    assert ready is True and detail == ""
    assert statuses["web"] == "live"


def test_password_rules_preserve_compatible_values():
    for value in (APP_PASSWORD, "Ab1!cdefghi", "Ab1! cdefgh",
                  "Aa7 = $() `quotes` \\ ! " + "word" * 5, "A" * 1000 + "7!"):
        provision.validate_app_password(value)
    for value, expected in (
        ("", "That was empty"), (" ", "at least 11"),
        ("Ab1!cdefgh", "at least 11"),  # 10 characters
        ("1234567890!", "letter, a number and a symbol"),
        ("Abcdefghij!", "letter, a number and a symbol"),
        ("Abcdefghi12", "letter, a number and a symbol"),
        ("Ab1 cdefghi", "spaces are not symbols"),
        (" " + APP_PASSWORD, "beginning and end"),
        (APP_PASSWORD + " ", "beginning and end"),
        (APP_PASSWORD + "\t", "letters, numbers, spaces or symbols"),
        (APP_PASSWORD + "\n", "letters, numbers, spaces or symbols"),
        (APP_PASSWORD + "\r", "letters, numbers, spaces or symbols"),
        (APP_PASSWORD + "\x00", "letters, numbers, spaces or symbols"),
        (APP_PASSWORD + "é", "letters, numbers, spaces or symbols"),
    ):
        try:
            provision.validate_app_password(value)
            raise AssertionError("accepted an incompatible password")
        except provision.ProvisionError as exc:
            assert expected in str(exc)
            assert APP_PASSWORD not in str(exc)


def _run_options():
    return dict(specs=provision.load_specs(BLUEPRINT), workspace=WORKSPACE,
                repo=REPO, branch=BRANCH)


def _expect_password_stop(**overrides):
    before = len(_calls())
    kwargs = dict(client=_client(), values=_base_values(), **_run_options())
    kwargs.update(overrides)
    try:
        provision.provision(**kwargs)
        raise AssertionError("expected password preflight to stop")
    except provision.ProvisionError as exc:
        assert APP_PASSWORD not in str(exc)
    assert not _writes(_calls()[before:])


def test_password_decision_never_silently_ignores_or_rotates():
    _fresh_state()
    first = provision.provision(client=_client(), values=_base_values(), **_run_options())
    old = _state()["services"]["paratrooper-web"]["_envVars"].copy()
    # New password offered for an already-existing app, or hidden in a resume.
    _expect_password_stop()
    resume = _resume_options()
    _expect_password_stop(**(resume | {"values": _base_values()}))
    # A confirmation refers to one exact web service, never a replacement.
    _expect_password_stop(**(resume | {"existing_web_id": "srv-different"}))
    # Cross-branch reuse remains allowed once the existing app is confirmed.
    report = provision.provision(client=_client(), **(_run_options() | {"branch": "other"}),
                                 **resume)
    assert report.web.id == first.web.id
    assert _state()["services"]["paratrooper-web"]["_envVars"] == old
    assert APP_PASSWORD not in json.dumps(report.as_dict()) + repr(report)


def test_absent_or_unconfigured_password_stops_before_writes():
    _fresh_state()
    _expect_password_stop(values={})
    _expect_password_stop(values={}, password_mode="existing", existing_web_id="srv-old")
    _seed_service("paratrooper-web", service_type="web_service", repo=REPO, region="oregon")
    _expect_password_stop(values={}, password_mode="existing",
                          existing_web_id="srv-seed-paratrooper-web")


def test_inspection_is_read_only_and_returns_no_secret():
    _fresh_state()
    state = provision.inspect_app(_client(), provision.load_specs(BLUEPRINT),
                                  workspace=WORKSPACE, repo=REPO)
    assert state["password_mode"] == "new" and not _writes(_calls())
    provision.provision(client=_client(), values=_base_values(), **_run_options())
    before = len(_calls())
    state = provision.inspect_app(_client(), provision.load_specs(BLUEPRINT),
                                  workspace=WORKSPACE, repo=REPO)
    assert state["password_mode"] == "existing"
    assert state["existing_web_id"] == _state()["services"]["paratrooper-web"]["id"]
    assert APP_PASSWORD not in json.dumps(state)
    assert not _writes(_calls()[before:])


def test_web_appearing_after_preflight_does_not_discard_chosen_password():
    _fresh_state()
    client = _client()
    original = client.find_service
    web_reads = 0

    def racing_find(name, *, workspace):
        nonlocal web_reads
        if name == "paratrooper-web":
            web_reads += 1
            if web_reads == 2:
                _seed_service(name, service_type="web_service", repo=REPO, region="oregon",
                              env={provision.APP_TOKEN_VAR: "some other existing password"})
        return original(name, workspace=workspace)

    client.find_service = racing_find
    try:
        provision.provision(client=client, values=_base_values(), **_run_options())
        raise AssertionError("expected the concurrent web create to stop this run")
    except provision.ProvisionError as exc:
        assert "changed since the password step" in str(exc)
        assert APP_PASSWORD not in str(exc)
    assert not _last_post(_calls(), "/services", "paratrooper-web")
    assert not [c for c in _writes(_calls()) if c["method"] == "PUT"]
    assert _state()["services"]["paratrooper-web"]["_envVars"][provision.APP_TOKEN_VAR] != APP_PASSWORD


def test_malformed_stored_password_is_not_evidence_for_reuse():
    for value in ({"echo": APP_PASSWORD}, [APP_PASSWORD], True, 123):
        _fresh_state()
        _seed_service("paratrooper-web", service_type="web_service", repo=REPO, region="oregon",
                      env={provision.APP_TOKEN_VAR: value})
        _expect_password_stop(values={}, password_mode="existing",
                              existing_web_id="srv-seed-paratrooper-web")


def test_malformed_create_id_cannot_leak_into_progress_report_or_error():
    import httpx

    for value in ({"echo": APP_PASSWORD}, [APP_PASSWORD], True, 123, APP_PASSWORD):
        _fresh_state()

        def malformed_response(request):
            response = mock_render_api.handler(request)
            if request.method == "POST" and request.url.path == "/v1/services":
                body = response.json()
                if body.get("service", {}).get("type") == "web_service":
                    body["service"]["id"] = value
                    return httpx.Response(201, json=body)
            return response

        client = provision.ProvisionClient(deploy.Credential(PROVISION_KEY, "offline fixture"),
                                          http=httpx.Client(transport=httpx.MockTransport(malformed_response)))
        progress = []
        try:
            provision.provision(client=client, values=_base_values(), **_run_options(),
                                announce=lambda resource: progress.append(repr(resource)))
            raise AssertionError("malformed id reached the report")
        except provision.ProvisionError as exc:
            assert str(exc) == "Render returned an invalid resource id."
            assert APP_PASSWORD not in str(exc) + repr(progress)


def main() -> int:
    os.environ["RENDER_API_KEY"] = PROVISION_KEY  # provisioning credential
    os.environ["RENDER_WORKSPACE"] = WORKSPACE
    os.environ.pop("PARATROOPER_PROVISION_MOCK", None)  # we inject http directly here
    checks = [obj for name, obj in sorted(globals().items()) if name.startswith("test_")]
    failures = 0
    for check in checks:
        try:
            check()
            print(f"PASS {check.__name__}")
        except Exception as exc:  # noqa: BLE001 - a test runner wants every failure
            failures += 1
            print(f"FAIL {check.__name__}: {type(exc).__name__}: {exc}")
    print(f"\n{len(checks) - failures}/{len(checks)} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
