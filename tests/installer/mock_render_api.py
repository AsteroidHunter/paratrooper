"""An httpx.MockTransport handler that stands in for Render's REST API offline.

This is test scaffolding. It mocks only the HTTP boundary: real httpx builds the
request, real paratrooper.provision code runs, and this handler answers instead
of a socket. The request URL is still the official Render host, so the client's
host allowlist is exercised unchanged.

State (created services and Key Value stores) lives in a JSON file under
MOCK_STATE_DIR, so a second provisioning run in the same test finds and reuses
what the first created. Every request is appended to a calls log: method, path,
the bearer token it carried, and the JSON body, so a test can assert what was
sent to each service (the configuration, the tokens, the wired links) and that
the provisioning credential is not the idle key.

Failure injection, all via environment variables:
  MOCK_API_FAIL_KV=1             POST /key-value answers 500
  MOCK_API_FAIL_SERVICE=<name>   POST /services for that service name answers 500
  MOCK_API_UNREACHABLE=<substr>  any request whose path contains <substr> raises
                                 a transport error (the "no answer" case)
  MOCK_API_CONN_404=<n>          the first <n> connection-info reads answer 404
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import httpx

API_PREFIX = "/v1"


def http_client() -> httpx.Client:
    """A real httpx.Client whose transport is this mock. trust_env is off so no
    ambient proxy or certificate environment changes what the tests see."""
    return httpx.Client(transport=httpx.MockTransport(handler), trust_env=False)


def _state_dir() -> Path:
    state = os.environ.get("MOCK_STATE_DIR")
    if not state:
        raise RuntimeError("MOCK_STATE_DIR must be set for the mock Render API")
    path = Path(state)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _load_state() -> dict:
    path = _state_dir() / "api_state.json"
    if path.is_file():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"services": {}, "key_values": {}, "counter": 0, "conn_reads": 0}


def _save_state(state: dict) -> None:
    (_state_dir() / "api_state.json").write_text(json.dumps(state, indent=2), encoding="utf-8")


def _record(entry: dict) -> None:
    with (_state_dir() / "api_calls.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry) + "\n")


def _next_id(state: dict, prefix: str) -> str:
    state["counter"] += 1
    return f"{prefix}-{state['counter']:016d}"


def handler(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path.startswith(API_PREFIX):
        path = path[len(API_PREFIX):]
    auth = request.headers.get("Authorization", "")
    token = auth[len("Bearer "):] if auth.startswith("Bearer ") else auth
    body = json.loads(request.content) if request.content else None
    _record({"method": request.method, "path": path, "token": token, "body": body})

    unreachable = os.environ.get("MOCK_API_UNREACHABLE", "")
    if unreachable and unreachable in path:
        raise httpx.ConnectError(f"mock: no answer for {path}", request=request)

    state = _load_state()
    try:
        return _dispatch(request.method, path, request.url.params, body, state)
    finally:
        _save_state(state)


def _dispatch(method, path, params, body, state) -> httpx.Response:
    if method == "GET" and path == "/services":
        return _list(state["services"], "service", params)
    if method == "POST" and path == "/services":
        return _create_service(body, state)
    if path.startswith("/services/") and "/env-vars/" in path:
        return _env_var(method, path, body, state)
    if path.startswith("/services/") and "/deploys" in path:
        return _deploys(method, path, state)
    if method == "GET" and path == "/key-value":
        return _list(state["key_values"], "keyValue", params)
    if method == "POST" and path == "/key-value":
        return _create_key_value(body, state)
    if method == "GET" and path.startswith("/key-value/") and path.endswith("/connection-info"):
        return _connection_info(path, state)
    return httpx.Response(404, json={"message": f"mock: no route {method} {path}"})


def _find_service_by_id(state, service_id):
    for service in state["services"].values():
        if service.get("id") == service_id:
            return service
    return None


def _deploy_status(service) -> str:
    """The deploy status the tests want for this service, by type. Default live.
    MOCK_DEPLOY_STATUS_WEB / MOCK_DEPLOY_STATUS_WORKER override, to simulate a
    failed or still-building deploy."""
    kind = service.get("type")
    if kind == "web_service":
        return os.environ.get("MOCK_DEPLOY_STATUS_WEB", "live") or "live"
    if kind == "background_worker":
        return os.environ.get("MOCK_DEPLOY_STATUS_WORKER", "live") or "live"
    return "live"


def _deploys(method, path, state) -> httpx.Response:
    parts = path.split("/")  # ['', 'services', '{id}', 'deploys'(, '{deployId}')]
    service_id = parts[2]
    service = _find_service_by_id(state, service_id)
    if service is None:
        return httpx.Response(404, json={"message": "mock: no such service"})
    # A specific deploy's status can differ from the listing's, so the tests can
    # reproduce "a new activation deploy is still building while the listing still
    # returns the older live deploy". MOCK_DEPLOY_ACTIVATION_STATUS drives the
    # specific-deploy and POST responses; the listing keeps the service's status.
    activation = os.environ.get("MOCK_DEPLOY_ACTIVATION_STATUS", "") or _deploy_status(service)
    if method == "GET" and len(parts) >= 5 and parts[4]:
        return httpx.Response(200, json={"deploy": {"id": parts[4], "status": activation}})
    if method == "GET":
        return httpx.Response(200, json=[{"deploy": {"id": _next_id(state, "dep"), "status": _deploy_status(service)}}])
    if method == "POST":
        return httpx.Response(201, json={"id": _next_id(state, "dep"), "status": activation})
    return httpx.Response(405, json={"message": "mock: method not allowed"})


def _env_var(method, path, body, state) -> httpx.Response:
    parts = path.split("/")  # ['', 'services', '{id}', 'env-vars', '{key}']
    service_id, key = parts[2], parts[4]
    service = _find_service_by_id(state, service_id)
    if service is None:
        return httpx.Response(404, json={"message": "mock: no such service"})
    env = service.setdefault("_envVars", {})
    if method == "GET":
        if key in env:
            return httpx.Response(200, json={"key": key, "value": env[key]})
        return httpx.Response(404, json={"message": "mock: no such variable"})
    if method == "PUT":
        env[key] = (body or {}).get("value", "")
        return httpx.Response(200, json={"key": key, "value": env[key]})
    return httpx.Response(405, json={"message": "mock: method not allowed"})


def _list(store, wrapper, params) -> httpx.Response:
    name = params.get("name")
    owner = params.get("ownerId")
    rows = []
    for obj in store.values():
        if name is not None and obj.get("name") != name:
            continue
        if owner is not None and obj.get("ownerId") != owner:
            continue
        # the real listing does not return env var values inline; drop internals
        public = {k: v for k, v in obj.items() if not k.startswith("_")}
        rows.append({wrapper: public})
    return httpx.Response(200, json=rows)


def _create_service(body, state) -> httpx.Response:
    name = body.get("name")
    if os.environ.get("MOCK_API_FAIL_SERVICE", "") == name:
        return httpx.Response(500, json={"message": "mock: create service failed"})
    details = body.get("serviceDetails") or {}
    service = {
        "id": _next_id(state, "srv"),
        "name": name,
        "ownerId": body.get("ownerId"),
        "type": body.get("type"),
        "repo": body.get("repo"),
        "suspended": "not_suspended",
        "serviceDetails": {},
        # what the single-env-var endpoints read and write; the real API stores
        # these too, this just keeps them where the mock can answer for them
        "_envVars": {ev["key"]: ev["value"] for ev in (body.get("envVars") or [])},
    }
    if details.get("region"):
        service["serviceDetails"]["region"] = details["region"]
    if body.get("type") == "web_service":
        service["serviceDetails"]["url"] = f"https://{name}.onrender.com"
    state["services"][name] = service
    if os.environ.get("MOCK_API_LOSE_RESPONSE", "") == name:
        # The server created it, but the caller never sees the answer: the write
        # landed and the response was lost. (State is saved in handler's finally.)
        raise httpx.ConnectError("mock: create succeeded but the response was lost")
    return httpx.Response(201, json={"service": service, "deployId": _next_id(state, "dep")})


def _create_key_value(body, state) -> httpx.Response:
    if os.environ.get("MOCK_API_FAIL_KV", "") == "1":
        return httpx.Response(500, json={"message": "mock: create key value failed"})
    name = body.get("name")
    kv = {
        "id": _next_id(state, "kv"),
        "name": name,
        "ownerId": body.get("ownerId"),
        "owner": {"id": body.get("ownerId")},
        "region": body.get("region"),
        "status": "creating",
    }
    state["key_values"][name] = kv
    return httpx.Response(201, json=kv)


def _connection_info(path, state) -> httpx.Response:
    want_404 = int(os.environ.get("MOCK_API_CONN_404", "0") or "0")
    if state.get("conn_reads", 0) < want_404:
        state["conn_reads"] = state.get("conn_reads", 0) + 1
        return httpx.Response(404, json={"message": "mock: still creating"})
    kv_id = path.split("/")[2]
    return httpx.Response(
        200,
        json={
            "internalConnectionString": f"redis://red-{kv_id}:6379",
            "externalConnectionString": f"rediss://red-{kv_id}.oregon:6379",
            "cliCommand": "redis-cli -u ...",
        },
    )
