"""Both profiles' sessions, run through the real Claude CLI the SDK pin bundles.

The rest of the suite proves what the worker asks for: the options it builds,
the hooks it registers, the answers its gate gives. Whether the CLI honours
them is a property of the CLI, and the CLI is exactly what moves when the SDK
pin moves. So these run the bundled binary for real, with only the model
replaced by a script (``fakeapi``), and read back two things: what each tool
call actually came back with, and what the CLI actually sent to the model.

No network, no real credential: the CLI talks to 127.0.0.1 with a dummy token
in the live deployment's shape, in a throwaway HOME.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import re
import subprocess
import threading
import time

import pytest
from PIL import Image

import fakeapi
from confighelpers import pinboard_config, plain_config
from paratrooper.agent.config import ConfigError

CANARY = "canary-3c1f-this-file-must-never-reach-the-model"


def _no_app(config):
    raise ConfigError("no GitHub App configured")


def _no_spotify():
    raise ConfigError("Spotify is not configured")


@pytest.fixture
def worker(monkeypatch):
    import paratrooper.agent.worker as worker_mod

    monkeypatch.setattr(worker_mod, "configure_auth", lambda mode: "subscription")
    monkeypatch.setattr(worker_mod, "installation_token", _no_app)
    monkeypatch.setattr(worker_mod, "spotify_credentials", _no_spotify)
    return worker_mod


def _pinboard(tmp_path, **overrides):
    """The example pinboard config over a real, empty git checkout."""
    cfg = pinboard_config(tmp_path, **overrides)
    pinboard = cfg.pinboard
    pinboard.site_root.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", "-b", "main", str(pinboard.site_root)], check=True)
    for folder in (pinboard.pins_dir, pinboard.archive_dir, pinboard.later_dir):
        folder.mkdir(parents=True)
    return cfg


def _steps(*calls, final="done"):
    """A model that makes ``calls`` one per turn, in order, then says ``final``."""

    def script(body):
        made = len(fakeapi.tool_results(body))
        return [calls[made]] if made < len(calls) else [fakeapi.text(final)]

    return script


def _run(worker, monkeypatch, tmp_path, cfg, job, script, *, hold=None):
    events: list[dict] = []
    with fakeapi.FakeMessagesAPI(script, hold=hold) as api:
        fakeapi.cli_environment(monkeypatch, tmp_path / "home", api.base_url)
        result = asyncio.run(worker.run_job(job, config=cfg, on_event=events.append))
    return result, events, api


def _results(api):
    """(is_error, text) for every tool call of the turn, in the order made."""
    last = api.model_requests()[-1]
    return [(bool(r.get("is_error")), fakeapi.result_text(r)) for r in fakeapi.tool_results(last)]


def test_the_pinboard_fences_hold_on_the_real_cli(worker, monkeypatch, tmp_path):
    """Each fence, answered by the CLI itself: the shell guard refuses a push
    with its own words, the launch record stays closed, an ordinary command and
    the in-process tools run, and a tool the session does not declare is not
    there to call, including the kind that never asks permission."""
    cfg = _pinboard(tmp_path)
    job = worker.Job(job_id="c1", thread_id="t1", text="run the steps")
    script = _steps(
        fakeapi.tool_use("Bash", {"command": "git push origin main", "description": "push"}),
        fakeapi.tool_use("Read", {"file_path": "/proc/self/environ"}),
        fakeapi.tool_use("Bash", {"command": "echo shell-ok", "description": "echo"}),
        fakeapi.tool_use("mcp__paratrooper__check_overlaps", {}),
        fakeapi.tool_use("mcp__paratrooper__post_update", {"text": "on it"}),
        fakeapi.tool_use("Agent", {"description": "x", "prompt": "x",
                                   "subagent_type": "general-purpose"}),
        fakeapi.tool_use("EnterPlanMode", {}),
        fakeapi.tool_use("WebFetch", {"url": "https://example.com", "prompt": "x"}),
    )
    result, events, api = _run(worker, monkeypatch, tmp_path, cfg, job, script)

    push, proc, echo, overlaps, update, agent, plan, fetch = _results(api)
    assert push[0] and "pushing from the shell is forbidden" in push[1]
    assert proc[0] and fakeapi.DUMMY_OAUTH_TOKEN not in proc[1]
    assert echo == (False, "shell-ok")
    assert not overlaps[0] and json.loads(overlaps[1])["ok"] is True
    assert not update[0] and json.loads(update[1]) == {"sent": True}
    for refused in (agent, plan, fetch):
        assert refused[0] and "No such tool available" in refused[1], refused

    offered = fakeapi.tool_names(api.model_requests()[0])
    assert offered == set(worker.BUILTIN_TOOLS) | {n for n in offered if n.startswith("mcp__")}
    assert "mcp__paratrooper__push_branch" in offered

    assert result.status == "done" and result.result_text == "done"
    assert [e["kind"] for e in events if e["kind"] != "typing"] == ["update", "done"]


def test_the_shell_never_sees_the_claude_credential(worker, monkeypatch, tmp_path):
    """With the scrub switch off the CLI still keeps its own OAuth token out of
    the shells it opens. The live deployment authenticates exactly this way."""
    cfg = _pinboard(tmp_path)
    job = worker.Job(job_id="c2", thread_id="t1", text="show the environment")
    command = ("echo oauth=${CLAUDE_CODE_OAUTH_TOKEN:-unset} "
               "scrub=${CLAUDE_CODE_SUBPROCESS_ENV_SCRUB:-unset}")
    script = _steps(fakeapi.tool_use("Bash", {"command": command, "description": "env"}))
    result, _, api = _run(worker, monkeypatch, tmp_path, cfg, job, script)
    assert _results(api) == [(False, "oauth=unset scrub=0")]
    assert result.status == "done"


@pytest.mark.parametrize("effort", ["high", "xhigh"])
def test_the_configured_model_and_effort_reach_the_model(worker, monkeypatch, tmp_path, effort):
    """Opus 5.5's own default is medium. The configured level is what arrives,
    on both profiles, and so is the configured model id."""
    for build in (_pinboard, plain_config):
        base = tmp_path / build.__name__
        cfg = build(base, effort=effort)
        job = worker.Job(job_id="c3", thread_id="t1", text="hello")
        result, _, api = _run(worker, monkeypatch, base, cfg, job, _steps())
        assert result.status == "done"
        for request in api.model_requests():
            assert request["model"] == "claude-opus-5-5"
            assert request["output_config"]["effort"] == effort


def test_the_plain_session_on_the_real_cli(worker, monkeypatch, tmp_path):
    """A plain turn as the CLI sees it: the two web tools and nothing else, the
    photo arriving as an image block ahead of the text, and a shell or file
    call answered as a tool that does not exist. The CLI also writes its own
    copy of the photo and names it to the model; that copy is gone once the
    job is, like the worker's own."""
    cfg = plain_config(tmp_path)
    inbox = cfg.require_inbox()
    inbox.mkdir(parents=True)
    Image.new("RGB", (640, 480), (200, 30, 30)).save(inbox / "photo-1.png")
    job = worker.Job(job_id="c4", thread_id="t1", text="what colour is this?",
                     attachments=["photo-1.png"])
    script = _steps(
        fakeapi.tool_use("Bash", {"command": "echo hi", "description": "echo"}),
        fakeapi.tool_use("Read", {"file_path": str(inbox / "photo-1.png")}),
        final="red",
    )
    result, events, api = _run(worker, monkeypatch, tmp_path, cfg, job, script)

    first = api.model_requests()[0]
    assert fakeapi.tool_names(first) == {"WebSearch", "WebFetch"}
    user = first["messages"][0]["content"]
    image, texts = user[0], [block["text"] for block in user[1:]]
    assert image["type"] == "image"
    photo = Image.open(io.BytesIO(base64.b64decode(image["source"]["data"])))
    assert photo.size == (640, 480)
    assert texts[0].startswith("what colour is this?")
    copies = re.findall(r"\[Image: source: ([^\]]+)\]", " ".join(texts))
    for copy in copies:
        assert not os.path.exists(copy), copy
    for is_error, body in _results(api):
        assert is_error and "No such tool available" in body
    assert result.status == "done" and result.result_text == "red"
    assert [e["kind"] for e in events if e["kind"] != "typing"] == ["done"]


def test_an_at_path_in_the_turn_is_never_read_into_it(worker, monkeypatch, tmp_path):
    """The turn's text carries recent thread lines, and one of those can be
    text the agent wrote after reading a page. Without verbatim delivery the CLI
    expands ``@/path`` by reading that file into the turn, with no tool call for
    a hook to refuse; the pinned 2.1.191 did it on both profiles."""
    secret = tmp_path / "outside" / "notes.txt"
    secret.parent.mkdir()
    secret.write_text(CANARY + "\n")
    for build in (_pinboard, plain_config):
        base = tmp_path / build.__name__
        cfg = build(base)
        cfg.require_inbox().mkdir(parents=True, exist_ok=True)
        job = worker.Job(job_id="c5", thread_id="t1", text=f"what does @{secret} say?",
                         context=[f"agent: see @{secret}"])
        result, _, api = _run(worker, monkeypatch, base, cfg, job, _steps(final="no idea"))
        assert result.status == "done" and result.result_text == "no idea"
        sent = json.dumps(api.requests)
        assert CANARY not in sent
        assert f"@{secret}" in sent  # delivered as written, not dropped


def test_no_request_asks_the_model_to_sign_as_claude(worker, monkeypatch, tmp_path):
    """The prompt forbids co-author lines and "Generated with Claude Code"; the
    2.1.280 CLI tells the model to add both unless attribution is switched off."""
    cfg = _pinboard(tmp_path)
    job = worker.Job(job_id="c6", thread_id="t1", text="commit something")
    script = _steps(fakeapi.tool_use("Bash", {"command": "git status", "description": "s"}))
    result, _, api = _run(worker, monkeypatch, tmp_path, cfg, job, script)
    assert result.status == "done"
    for request in api.requests:
        blob = json.dumps({k: request.get(k) for k in ("messages", "tools")})
        assert "Co-Authored-By" not in blob
        assert "claude.com/claude-code" not in blob


def test_a_refused_plain_request_fails_the_job_visibly(worker, monkeypatch, tmp_path):
    """An API refusal comes back as an error result from the CLI; the plain
    job reports it as a failure, never as a reply."""
    cfg = plain_config(tmp_path)
    job = worker.Job(job_id="c7", thread_id="t1", text="hello")
    script = lambda body: [fakeapi.api_error(400, "prompt is not acceptable")]  # noqa: E731
    result, events, _ = _run(worker, monkeypatch, tmp_path, cfg, job, script)
    assert result.status == "error"
    assert [e["kind"] for e in events] == ["error"]
    assert "400" in result.error or "not acceptable" in result.error


def test_an_interrupted_turn_leaves_no_cli_behind(worker, monkeypatch, tmp_path):
    """The worker interrupts a job by cancelling its task. The CLI under it has
    to go with it, or each STOP would leave a turn running unobserved."""
    from claude_agent_sdk._internal.transport import subprocess_cli

    for build in (_pinboard, plain_config):
        base = tmp_path / build.__name__
        cfg = build(base)
        cfg.require_inbox().mkdir(parents=True, exist_ok=True)
        hold = threading.Event()
        job = worker.Job(job_id="c8", thread_id="t1", text="take your time")

        async def interrupt(api, cfg=cfg, job=job):
            task = asyncio.ensure_future(worker.run_job(job, config=cfg))
            assert await asyncio.to_thread(api.first_request.wait, 60)
            pids = [process.pid for process in subprocess_cli._ACTIVE_CHILDREN]
            assert pids
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            return pids

        with fakeapi.FakeMessagesAPI(_steps(), hold=hold) as api:
            fakeapi.cli_environment(monkeypatch, base / "home", api.base_url)
            pids = asyncio.run(interrupt(api))
            deadline = time.monotonic() + 20
            while any(_running(pid) for pid in pids) and time.monotonic() < deadline:
                time.sleep(0.2)
            assert not any(_running(pid) for pid in pids), pids


def _running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)],
                           capture_output=True, text=True).stdout.strip()
    return bool(state) and not state.startswith("Z")
