"""A scripted stand-in for the Messages API, for driving the real Claude CLI.

The worker's guarantees live in two places at once: in this repository (the
hooks, the permission gate, the tool lists) and in the Claude Code CLI the
pinned SDK bundles, which decides what reaches the model and what runs. A stub
of the CLI proves the first half only. This module lets a test run the real
bundled CLI with its model replaced by a script, so a test can say exactly
which tool the "model" asks for and read back exactly what the CLI sent: the
tool list, the model id, the effort, the user message, and the result each tool
call produced.

Nothing here reaches the network. The server binds 127.0.0.1 on a free port and
the CLI is pointed at it with ANTHROPIC_BASE_URL and a dummy API key, in a
throwaway HOME, so no developer credential or setting is ever read.
"""

from __future__ import annotations

import json
import os
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

# One reply from the scripted model: the content blocks it produces. A block is
# {"type": "text", "text": ...} or {"type": "tool_use", "name": ..., "input": {...}}.
Reply = list[dict[str, Any]]
Script = Callable[[dict[str, Any]], Reply]


def text(value: str) -> dict[str, Any]:
    return {"type": "text", "text": value}


def tool_use(name: str, tool_input: dict[str, Any]) -> dict[str, Any]:
    return {"type": "tool_use", "name": name, "input": tool_input}


def api_error(status: int, message: str) -> dict[str, Any]:
    """A reply that is not a message at all: the API refusing the request."""
    return {"type": "api_error", "status": status, "message": message}


def tool_results(body: dict[str, Any]) -> list[dict[str, Any]]:
    """Every tool_result block the CLI has sent back so far, oldest first."""
    found = []
    for message in body.get("messages", []):
        content = message.get("content")
        if message.get("role") != "user" or not isinstance(content, list):
            continue
        found.extend(block for block in content if block.get("type") == "tool_result")
    return found


def result_text(block: dict[str, Any]) -> str:
    """A tool_result's text, whether the CLI sent a string or a block list."""
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part.get("text", "") for part in content if isinstance(part, dict))
    return ""


def tool_names(body: dict[str, Any]) -> set[str]:
    return {tool.get("name", "") for tool in body.get("tools", [])}


class FakeMessagesAPI:
    """A local Messages API answering every model request from ``script``.

    ``script`` receives the parsed request body and returns the blocks of the
    reply. Requests are recorded in :attr:`requests` so a test can read exactly
    what the CLI sent. ``hold`` (an Event) makes the server wait before
    answering, for tests that need a turn to be in flight."""

    def __init__(self, script: Script, *, hold: threading.Event | None = None) -> None:
        self.script = script
        self.hold = hold
        self.requests: list[dict[str, Any]] = []
        self.other_paths: list[str] = []
        self.first_request = threading.Event()
        self._lock = threading.Lock()
        self._counter = 0
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def model_requests(self) -> list[dict[str, Any]]:
        """The requests that carried the session's tools: the agent loop itself,
        as opposed to any side request the CLI makes on its own account."""
        return [body for body in self.requests if body.get("tools")]

    def __enter__(self) -> FakeMessagesAPI:
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        if self.hold is not None:
            self.hold.set()
        self._server.shutdown()
        self._server.server_close()

    def _next_id(self, prefix: str) -> str:
        with self._lock:
            self._counter += 1
            return f"{prefix}_fake_{self._counter:04d}"

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        api = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: object) -> None:  # keep test output clean
                return

            def _json(self, status: int, payload: dict[str, Any]) -> None:
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self) -> None:  # noqa: N802
                api.other_paths.append(f"GET {self.path}")
                self._json(404, {"type": "error", "error": {"type": "not_found_error",
                                                            "message": "not here"}})

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                path = self.path.split("?", 1)[0]
                if path.endswith("/count_tokens"):
                    self._json(200, {"input_tokens": 1000})
                    return
                if not path.endswith("/v1/messages"):
                    api.other_paths.append(f"POST {self.path}")
                    self._json(404, {"type": "error", "error": {"type": "not_found_error",
                                                                "message": "not here"}})
                    return
                with api._lock:
                    api.requests.append(body)
                if body.get("tools"):
                    api.first_request.set()
                    if api.hold is not None:
                        api.hold.wait(60)
                    blocks = api.script(body)
                else:
                    # a side request the CLI makes for itself; answer it plainly
                    blocks = [text("ok")]
                self._reply(body, blocks)

            def _reply(self, body: dict[str, Any], blocks: Reply) -> None:
                refusal = next((b for b in blocks if b["type"] == "api_error"), None)
                if refusal is not None:
                    self._json(refusal["status"], {"type": "error", "error": {
                        "type": "invalid_request_error", "message": refusal["message"]}})
                    return
                content = []
                for block in blocks:
                    if block["type"] == "tool_use":
                        content.append({**block, "id": api._next_id("toolu")})
                    else:
                        content.append(block)
                stop = "tool_use" if any(b["type"] == "tool_use" for b in content) else "end_turn"
                message = {
                    "id": api._next_id("msg"), "type": "message", "role": "assistant",
                    "model": body.get("model", "fake"), "content": [],
                    "stop_reason": None, "stop_sequence": None,
                    "usage": {"input_tokens": 10, "output_tokens": 1},
                }
                if not body.get("stream"):
                    self._json(200, {**message, "content": content, "stop_reason": stop})
                    return
                events: list[tuple[str, dict[str, Any]]] = [
                    ("message_start", {"type": "message_start", "message": message})
                ]
                for index, block in enumerate(content):
                    if block["type"] == "tool_use":
                        start = {**block, "input": {}}
                        delta = {"type": "input_json_delta",
                                 "partial_json": json.dumps(block["input"])}
                    else:
                        start = {"type": "text", "text": ""}
                        delta = {"type": "text_delta", "text": block["text"]}
                    events += [
                        ("content_block_start", {"type": "content_block_start",
                                                 "index": index, "content_block": start}),
                        ("content_block_delta", {"type": "content_block_delta",
                                                 "index": index, "delta": delta}),
                        ("content_block_stop", {"type": "content_block_stop", "index": index}),
                    ]
                events += [
                    ("message_delta", {"type": "message_delta",
                                       "delta": {"stop_reason": stop, "stop_sequence": None},
                                       "usage": {"output_tokens": 5}}),
                    ("message_stop", {"type": "message_stop"}),
                ]
                data = "".join(
                    f"event: {name}\ndata: {json.dumps(payload)}\n\n" for name, payload in events
                ).encode()
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        return Handler


# Stand-in credentials. Neither is real and the fake server checks neither.
DUMMY_OAUTH_TOKEN = "sk-ant-oat01-test-not-a-real-token"
DUMMY_API_KEY = "sk-ant-api03-test-not-a-real-key"


def cli_environment(monkeypatch: Any, home: Any, base_url: str) -> None:
    """Point every CLI this test starts at the fake API, in a throwaway HOME.

    The SDK builds the CLI's environment from ``os.environ``, so setting these
    here is exactly how the worker's own sessions would receive them. The
    credential has the live deployment's shape, ``AGENT_AUTH=subscription``:
    an OAuth token and no API key. Nothing reaches Anthropic.

    Every inherited Claude or Anthropic variable goes first. A test run from
    inside another Claude session would otherwise hand the CLI that session's
    switches (safe mode, instruction files off), and the worker's CLI never has
    any of them."""
    for name in list(os.environ):
        if name.startswith(("CLAUDE", "ANTHROPIC")):
            monkeypatch.delenv(name, raising=False)
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(home / ".claude"))
    monkeypatch.setenv("ANTHROPIC_BASE_URL", base_url)
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", DUMMY_OAUTH_TOKEN)
    monkeypatch.setenv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
    monkeypatch.setenv("DISABLE_AUTOUPDATER", "1")
    monkeypatch.setenv("DISABLE_TELEMETRY", "1")
