"""Tests for the web service — auth gate, threads, batching (4.3b), uploads,
publish parsing, and the FastAPI routes (with injected state, no Redis)."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from paratrooper.agent.config import Config
from paratrooper.web import ThreadCoordinator, ThreadStore, is_stop_word
from paratrooper.web.app import AppState, create_app
from paratrooper.web.auth import verify_token
from paratrooper.web.batching import DEFAULT_WINDOW
from paratrooper.web.inbox import DiskInbox, RedisInbox, new_key
from paratrooper.web.models import ThreadMessage
from paratrooper.web.publish import (
    PublishError,
    owner_repo_from_remote,
    parse_pr_number,
)
from paratrooper.web.uploads import delete_staged, save_upload

# --- auth (4.2) ---------------------------------------------------------------

def test_verify_token(monkeypatch):
    monkeypatch.setenv("PARATROOPER_APP_TOKEN", "s3cret")
    assert verify_token("s3cret")
    assert not verify_token("wrong")
    assert not verify_token(None)
    assert not verify_token("")


# --- db (4.3) -----------------------------------------------------------------

def test_thread_store_roundtrip(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")

    def msg(thread, role, body, kind=None):
        return ThreadMessage(
            thread_id=thread, role=role, body=body, ts="2026-06-30T00:00:00Z", kind=kind
        )

    s1 = store.add_message(msg("d", "user", "hi"))
    store.add_message(msg("d", "agent", "hello", kind="done"))
    store.add_message(msg("other", "user", "x"))
    # catch-up since seq
    rows = store.messages("d", since_seq=s1)
    assert [m.body for _, m in rows] == ["hello"]
    # full thread
    assert len(store.messages("d")) == 2
    # recent for job context
    assert [m.body for m in store.recent("d", n=10)] == ["hi", "hello"]


# --- batching (4.3b) ----------------------------------------------------------

def test_is_stop_word():
    assert is_stop_word("STOP")
    assert is_stop_word("cancel")
    assert is_stop_word("Stop now please")  # leading token
    assert not is_stop_word("please stop")
    assert not is_stop_word("add a photo")
    assert not is_stop_word("")


def _run(coro):
    return asyncio.run(coro)


def _recorders():
    """Async enqueue/interrupt callbacks that record their calls (the coordinator
    awaits them, so they must be coroutines)."""
    enqueued: list = []
    interrupted: list = []

    async def enqueue(t, j, text, atts):
        enqueued.append({"thread": t, "job": j, "text": text, "atts": atts})

    async def interrupt(t, j):
        interrupted.append(j)

    return enqueue, interrupt, enqueued, interrupted


def test_batching_coalesces_into_one_job():
    async def scenario():
        enq, intr, enqueued, _ = _recorders()
        coord = ThreadCoordinator(enq, intr, window=0.05)
        await coord.handle_message("d", "add this", ["k1"])
        await coord.handle_message("d", "make it big", ["k2"])  # resets window
        await asyncio.sleep(0.12)
        assert len(enqueued) == 1  # one bundled job
        assert enqueued[0]["text"] == "add this\nmake it big"
        assert enqueued[0]["atts"] == ["k1", "k2"]

    _run(scenario())


def test_batching_stop_discards_pending():
    async def scenario():
        enq, intr, enqueued, _ = _recorders()
        coord = ThreadCoordinator(enq, intr, window=0.05)
        await coord.handle_message("d", "add this", [])
        status = await coord.handle_message("d", "STOP", [])
        assert status == "discarded"
        await asyncio.sleep(0.12)
        assert enqueued == []  # the pending batch never fired

    _run(scenario())


def test_batching_stop_interrupts_running_job():
    async def scenario():
        enq, intr, enqueued, interrupted = _recorders()
        coord = ThreadCoordinator(enq, intr, window=0.02)
        await coord.handle_message("d", "add this", [])
        await asyncio.sleep(0.06)  # job fires -> running
        assert len(enqueued) == 1
        status = await coord.handle_message("d", "CANCEL", [])
        assert status == "interrupted"
        assert interrupted == [enqueued[0]["job"]]  # interrupted the running job id

    _run(scenario())


def test_batching_buffers_while_running_then_fires():
    async def scenario():
        enq, intr, enqueued, _ = _recorders()
        coord = ThreadCoordinator(enq, intr, window=0.02)
        await coord.handle_message("d", "first", [])
        await asyncio.sleep(0.05)  # first job running
        await coord.handle_message("d", "second", [])  # buffers (job running)
        await asyncio.sleep(0.05)
        assert [e["text"] for e in enqueued] == ["first"]  # second hasn't fired yet
        await coord.job_finished("d")  # releases the next batch
        await asyncio.sleep(0.05)
        assert [e["text"] for e in enqueued] == ["first", "second"]

    _run(scenario())


def test_default_window_is_ten_seconds():
    assert DEFAULT_WINDOW == 10.0


# --- uploads (4.3) ------------------------------------------------------------

def test_save_upload_key_and_traversal(tmp_path):
    key, size = save_upload(tmp_path, "../../etc/passwd", b"data")
    assert "/" not in key and size == 4  # opaque key, no path component
    assert (tmp_path / key).read_bytes() == b"data"
    key2, _ = save_upload(tmp_path, "photo.JPG", b"img")
    assert key2.endswith(".jpg")
    delete_staged(tmp_path, key)
    assert not (tmp_path / key).exists()
    delete_staged(tmp_path, key)  # idempotent (missing_ok)


def test_new_key_extension():
    assert new_key("photo.JPEG").endswith(".jpeg")
    assert new_key("../evil").count("/") == 0


def test_disk_inbox_roundtrip(tmp_path):
    async def scenario():
        ib = DiskInbox(tmp_path / "ib")
        await ib.put("k.png", b"\x00\xff binary")
        assert await ib.get("k.png") == b"\x00\xff binary"
        await ib.delete("k.png")

    _run(scenario())


class _FakeRedis:
    def __init__(self):
        self.store: dict = {}

    async def set(self, k, v, ex=None):
        self.store[k] = v

    async def get(self, k):
        return self.store.get(k)

    async def delete(self, k):
        self.store.pop(k, None)


def test_redis_inbox_preserves_binary_through_base64():
    async def scenario():
        ib = RedisInbox(_FakeRedis())
        blob = bytes(range(256))  # all byte values, incl. non-utf8
        await ib.put("k.webp", blob)
        assert await ib.get("k.webp") == blob  # survives decode_responses=True
        await ib.delete("k.webp")
        with pytest.raises(KeyError):
            await ib.get("k.webp")

    _run(scenario())


# --- publish (4.4) ------------------------------------------------------------

def test_parse_pr_number():
    assert parse_pr_number("https://github.com/o/r/pull/42") == 42
    assert parse_pr_number("12") == 12
    assert parse_pr_number("#7") == 7
    with pytest.raises(PublishError):
        parse_pr_number("not-a-pr")


def test_owner_repo_from_remote():
    https = "https://github.com/AsteroidHunter/webpage.git"
    assert owner_repo_from_remote(https) == ("AsteroidHunter", "webpage")
    assert owner_repo_from_remote("git@github.com:o/r") == ("o", "r")


# --- push (6.1) ---------------------------------------------------------------

def test_push_config_off_when_unset(monkeypatch):
    from paratrooper.web import push

    monkeypatch.delenv("VAPID_PRIVATE_KEY", raising=False)
    monkeypatch.delenv("VAPID_SUBJECT", raising=False)
    assert push.config() is None  # feature is a no-op without VAPID
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "priv")
    monkeypatch.setenv("VAPID_SUBJECT", "mailto:a@b.c")
    cfg = push.config()
    assert cfg and cfg.subject == "mailto:a@b.c"
    assert push.notification_text("pr") and push.notification_text("log") is None


def test_subscription_store(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    store.add_subscription("https://push/abc", '{"endpoint": "https://push/abc"}')
    store.add_subscription("https://push/abc", '{"endpoint": "https://push/abc", "v": 2}')  # upsert
    subs = store.subscriptions()
    assert len(subs) == 1 and subs[0]["v"] == 2
    store.remove_subscription("https://push/abc")
    assert store.subscriptions() == []


# --- app routes (TestClient, injected state, no Redis) ------------------------

class _FakeCoordinator:
    def __init__(self):
        self.calls = []

    async def handle_message(self, thread_id, text, attachments):
        self.calls.append((thread_id, text, attachments))
        return "buffered"

    async def job_finished(self, thread_id):
        pass


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PARATROOPER_APP_TOKEN", "tok")
    cfg = Config(
        inbox=tmp_path / "inbox",
        site_root=tmp_path / "site",
        pins_dir=tmp_path / "pins",
        archive_dir=tmp_path / "arch",
        later_dir=tmp_path / "later",
        changelog=tmp_path / "cl.jsonl",
        remote="https://github.com/AsteroidHunter/webpage.git",
        default_branch="main",
        branch_prefix="paratrooper",
    )
    state = AppState(
        config=cfg,
        store=ThreadStore(tmp_path / "threads.sqlite"),
        queue=object(),  # not exercised by these routes
        coordinator=_FakeCoordinator(),
        inbox=DiskInbox(tmp_path / "inbox"),
    )
    app = create_app(injected=state)
    with TestClient(app) as c:
        yield c


def test_health_open(client):
    body = client.get("/api/health").json()
    assert body["ok"] is True and "version" in body


def test_auth_required(client):
    assert client.post("/api/send", json={"thread_id": "d", "text": "hi"}).status_code == 401
    assert client.get("/api/thread/d").status_code == 401


def test_upload_and_send_flow(client):
    auth = {"Authorization": "Bearer tok"}
    up = client.post("/api/upload", headers=auth, files={"file": ("p.png", b"bytes", "image/png")})
    assert up.status_code == 200
    key = up.json()["inbox_key"]
    assert key.endswith(".png")

    sent = client.post(
        "/api/send", headers=auth,
        json={"thread_id": "d", "text": "add it", "attachments": [key]},
    )
    body = sent.json()
    assert body["status"] == "buffered" and body["seq"] >= 1
    calls = client.app.state.app_state.coordinator.calls
    assert calls == [("d", "add it", [key])]

    # the user message was persisted and is fetchable
    rows = client.get("/api/thread/d", headers=auth).json()["messages"]
    assert rows[-1]["role"] == "user" and rows[-1]["body"] == "add it"


# --- image contracts: each Docker image must import without the other's deps ---

def _import_in_subprocess(blocked_module: str, import_target: str) -> None:
    """Import ``import_target`` in a fresh interpreter with ``blocked_module``
    made unimportable (sys.modules[name] = None), simulating the Docker image
    where that dependency isn't installed."""
    import os
    import subprocess
    import sys

    code = (
        f"import sys; sys.modules[{blocked_module!r}] = None; "
        f"import {import_target}; print('ok')"
    )
    src = str((__import__('pathlib').Path(__file__).parent.parent / "src").resolve())
    env = {**os.environ, "PYTHONPATH": src}
    proc = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env)
    assert proc.returncode == 0, f"{import_target} needs {blocked_module}:\n{proc.stderr[-1500:]}"


def test_web_app_imports_without_agent_sdk():
    """The web image installs .[web] only — importing the app must not pull the
    Agent SDK (this exact failure crash-looped the deployed web service)."""
    _import_in_subprocess("claude_agent_sdk", "paratrooper.web.app")


def test_worker_imports_without_fastapi():
    """The worker image installs .[agent] only — its entrypoint must not pull
    FastAPI (the mirror contract)."""
    _import_in_subprocess("fastapi", "paratrooper.web.worker_runner")


def test_connect_keeps_blocking_reads(monkeypatch):
    """redis-py 8 defaults socket_timeout to 5s, which kills BRPOP/pub-sub —
    connect() must pin it back to None (block forever)."""
    from paratrooper.web.queue import connect

    client = connect("redis://localhost:6399/0")  # lazy: no actual connection made
    kwargs = client.connection_pool.connection_kwargs
    assert kwargs["socket_timeout"] is None
    assert kwargs["socket_connect_timeout"] == 5.0


# --- render worker wake/sleep --------------------------------------------------

def test_render_control_from_env(monkeypatch):
    from paratrooper.web.render_control import RenderControl

    monkeypatch.delenv("RENDER_API_KEY", raising=False)
    monkeypatch.delenv("RENDER_WORKER_SERVICE_ID", raising=False)
    assert RenderControl.from_env() is None  # unset -> feature off
    monkeypatch.setenv("RENDER_API_KEY", "rnd_key")
    assert RenderControl.from_env() is None  # one of two -> still off
    monkeypatch.setenv("RENDER_WORKER_SERVICE_ID", "srv-abc123")
    rc = RenderControl.from_env()
    assert rc is not None and rc.worker_id == "srv-abc123"


def test_render_control_calls_api(monkeypatch):
    import httpx

    from paratrooper.web import render_control

    calls = []

    class _FakeClient:
        def __init__(self, timeout=None):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None):
            calls.append((url, headers["Authorization"]))
            return httpx.Response(202, request=httpx.Request("POST", url))

    monkeypatch.setattr(render_control.httpx, "AsyncClient", _FakeClient)
    rc = render_control.RenderControl("rnd_key", "srv-abc123")
    assert _run(rc.resume_worker()) is True
    assert _run(rc.suspend_worker()) is True
    assert calls == [
        ("https://api.render.com/v1/services/srv-abc123/resume", "Bearer rnd_key"),
        ("https://api.render.com/v1/services/srv-abc123/suspend", "Bearer rnd_key"),
    ]


def test_coordinator_has_pending():
    async def scenario():
        enq, intr, enqueued, _ = _recorders()
        coord = ThreadCoordinator(enq, intr, window=0.02)
        assert not coord.has_pending()
        await coord.handle_message("d", "add this", [])
        assert coord.has_pending()  # buffered
        await asyncio.sleep(0.05)
        assert coord.has_pending()  # running
        await coord.job_finished("d")
        assert not coord.has_pending()  # drained

    _run(scenario())


def test_maybe_suspend_only_when_drained(tmp_path):
    from paratrooper.web.app import _maybe_suspend_worker

    class _FakeRender:
        def __init__(self):
            self.suspended = 0

        async def suspend_worker(self):
            self.suspended += 1
            return True

    class _FakeQueue:
        def __init__(self, pending):
            self._pending = pending

        async def pending_jobs(self):
            return self._pending

    class _State:
        def __init__(self, render, coordinator, queue):
            self.render, self.coordinator, self.queue = render, coordinator, queue

    async def scenario():
        enq, intr, *_ = _recorders()
        coord = ThreadCoordinator(enq, intr, window=0.02)
        render = _FakeRender()
        # nothing pending anywhere -> suspends
        await _maybe_suspend_worker(_State(render, coord, _FakeQueue(0)))
        assert render.suspended == 1
        # a job still queued -> no suspend
        await _maybe_suspend_worker(_State(render, coord, _FakeQueue(1)))
        assert render.suspended == 1
        # a buffered batch -> no suspend
        await coord.handle_message("d", "more", [])
        await _maybe_suspend_worker(_State(render, coord, _FakeQueue(0)))
        assert render.suspended == 1
        # render off -> no-op
        await _maybe_suspend_worker(_State(None, coord, _FakeQueue(0)))

    _run(scenario())


def test_push_routes(client, monkeypatch):
    monkeypatch.delenv("VAPID_PUBLIC_KEY", raising=False)
    auth = {"Authorization": "Bearer tok"}
    assert client.get("/api/push/key", headers=auth).json() == {"key": None}  # not configured
    sub = {"endpoint": "https://push.example/xyz", "keys": {"p256dh": "k", "auth": "a"}}
    assert client.post("/api/push/subscribe", headers=auth, json=sub).json() == {"ok": True}
    assert client.app.state.app_state.store.subscriptions() == [sub]
    assert client.post("/api/push/subscribe", headers=auth, json={}).status_code == 400


def test_watchdog_clears_stuck_job():
    """A job whose done/error never arrived must not block the thread forever."""
    async def scenario():
        enq, intr, enqueued, _ = _recorders()
        coord = ThreadCoordinator(enq, intr, window=0.02, job_deadline=0.05)
        await coord.handle_message("d", "first", [])
        await asyncio.sleep(0.05)  # fires -> running
        assert len(enqueued) == 1 and coord.has_pending()
        await asyncio.sleep(0.06)  # deadline passes, no done ever arrives
        await coord.handle_message("d", "second", [])  # watchdog unblocks
        await asyncio.sleep(0.05)
        assert [e["text"] for e in enqueued] == ["first", "second"]

    _run(scenario())


def test_unprocessed_user_messages(tmp_path):
    """Messages after the last job marker are the ones a restart swallowed."""
    store = ThreadStore(tmp_path / "t.sqlite")

    def add(role, body, kind=None, thread="d"):
        return store.add_message(ThreadMessage(
            thread_id=thread, role=role, body=body, ts="2026-07-06T00:00:00Z", kind=kind,
        ))

    add("user", "covered msg")
    add("system", "job-abc", kind="job")  # marker: everything above is covered
    add("agent", "reply", kind="done")
    add("user", "swallowed one")
    add("user", "swallowed two")
    add("user", "other thread msg", thread="e")  # no marker in e at all
    got = store.unprocessed_user_messages()
    assert [(t, m.body) for t, m in got] == [
        ("d", "swallowed one"), ("d", "swallowed two"), ("e", "other thread msg"),
    ]


def test_recover_unprocessed_feeds_coordinator(tmp_path):
    from paratrooper.web.app import recover_unprocessed

    store = ThreadStore(tmp_path / "t.sqlite")
    store.add_message(ThreadMessage(
        thread_id="d", role="user", body="lost msg", ts="2026-07-06T00:00:00Z",
    ))
    coord = _FakeCoordinator()
    state = AppState(
        config=None, store=store, queue=object(), coordinator=coord,
        inbox=DiskInbox(tmp_path / "ib"),
    )

    async def scenario():
        n = await recover_unprocessed(state)
        assert n == 1
        assert coord.calls == [("d", "lost msg", [])]

    _run(scenario())


def test_failed_job_reports_error_and_spares_the_loop(tmp_path):
    """The production incident: an expired attachment raised KeyError, which
    killed the whole worker and silently ate the queue. A failing job must
    publish a visible error and leave the loop alive."""
    from paratrooper.web.models import JobMessage
    from paratrooper.web.worker_runner import Worker

    published = []

    class _FakeQueue:
        def __init__(self):
            self.r = _FakeRedis()  # empty store -> attachment lookup misses

        async def publish_result(self, thread_id, result):
            published.append(result)

    from paratrooper.agent.config import Config

    cfg = Config(
        inbox=tmp_path / "inbox", site_root=tmp_path / "site",
        pins_dir=tmp_path / "pins", archive_dir=tmp_path / "arch",
        later_dir=tmp_path / "later", changelog=tmp_path / "cl.jsonl",
        remote=None, default_branch="main", branch_prefix="paratrooper",
    )
    w = Worker(_FakeQueue())
    w._config = cfg  # skip load_config
    msg = JobMessage(job_id="j1", thread_id="d", text="add this",
                     attachments=["expired-key.jpeg"])

    _run(w._run_one(msg))  # must NOT raise

    kinds = [r.kind for r in published]
    assert kinds[0] == "working"
    assert "error" in kinds
    err = next(r for r in published if r.kind == "error")
    assert "expired" in str(err.payload)


def test_shutdown_requeues_job_without_user_facing_noise(tmp_path, monkeypatch):
    """A deploy SIGTERM killed a job mid-screenshot and blocked its thread for
    11 hours. On shutdown-cancel the job must be requeued whole: no 'interrupted'
    error published, staged attachments kept for the re-run."""
    from paratrooper.web.models import JobMessage
    from paratrooper.web.worker_runner import Worker

    published, requeued = [], []

    class _FakeQueue:
        def __init__(self):
            self.r = _FakeRedis()

        async def publish_result(self, thread_id, result):
            published.append(result)

        async def requeue_front(self, job):
            requeued.append(job.job_id)

    from paratrooper.agent.config import Config

    cfg = Config(
        inbox=tmp_path / "inbox", site_root=tmp_path / "site",
        pins_dir=tmp_path / "pins", archive_dir=tmp_path / "arch",
        later_dir=tmp_path / "later", changelog=tmp_path / "cl.jsonl",
        remote=None, default_branch="main", branch_prefix="paratrooper",
    )
    q = _FakeQueue()
    w = Worker(q)
    w._config = cfg
    # stage an attachment so we can assert it survives a shutdown-cancel
    _run(w.inbox.put("k.jpeg", b"img"))
    msg = JobMessage(job_id="j1", thread_id="d", text="add", attachments=["k.jpeg"])

    # pin the job in-flight so the cancel deterministically lands mid-run
    import paratrooper.web.worker_runner as wr

    async def slow_run_job(*a, **kw):
        await asyncio.sleep(30)

    monkeypatch.setattr(wr, "run_job", slow_run_job)

    async def scenario():
        w._shutting_down = True  # simulate SIGTERM arriving
        task = asyncio.ensure_future(w._run_one(msg))
        await asyncio.sleep(0.05)  # let it reach run_job and park there
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    _run(scenario())
    kinds = [r.kind for r in published]
    assert "error" not in kinds  # no fake 'interrupted' bubble on deploys
    assert _run(w.inbox.get("k.jpeg")) == b"img"  # attachment kept for the re-run


def test_requeue_front_puts_job_next_in_line():
    from paratrooper.web.models import JobMessage
    from paratrooper.web.queue import JobQueue

    calls = []

    class _R:
        async def rpush(self, key, val):
            calls.append(("rpush", key))

    q = JobQueue(_R())
    _run(q.requeue_front(JobMessage(job_id="j", thread_id="d", text="x")))
    assert calls == [("rpush", "paratrooper:jobs")]  # consumption end of the list


def test_open_pr_returns_existing_pr(monkeypatch, tmp_path):
    """Pushing more commits to a branch that already has a PR must yield that
    PR's URL (the phone's Publish button depends on it), not a 422 error."""
    import httpx as _httpx

    from paratrooper.agent import siterepo as sr

    def fake_post(url, **kw):
        return _httpx.Response(
            422, text='{"message": "A pull request already exists for x."}',
            request=_httpx.Request("POST", url),
        )

    def fake_get(url, **kw):
        return _httpx.Response(
            200, json=[{"html_url": "https://github.com/o/r/pull/7"}],
            request=_httpx.Request("GET", url),
        )

    monkeypatch.setattr(sr.httpx, "post", fake_post)
    monkeypatch.setattr(sr.httpx, "get", fake_get)
    repo = sr.SiteRepo(tmp_path, github_token="tok", remote="https://github.com/o/r.git")
    assert repo.open_pr("paratrooper/x", "t") == "https://github.com/o/r/pull/7"


def test_publish_maps_error_to_409_with_detail(client, monkeypatch):
    """A failed merge must tell the phone WHY (409 + detail), not 500."""
    import paratrooper.web.app as app_mod
    from paratrooper.web.publish import PublishError

    monkeypatch.setenv("PARATROOPER_GITHUB_TOKEN", "tok")

    def boom(*a, **kw):
        raise PublishError("merge failed (405): Pull Request is not mergeable")

    monkeypatch.setattr(app_mod, "merge_pull_request", boom)
    auth = {"Authorization": "Bearer tok"}
    r = client.post("/api/publish", headers=auth,
                    json={"thread_id": "d", "pr": "https://github.com/o/r/pull/3"})
    assert r.status_code == 409
    assert "not mergeable" in r.json()["detail"]


def test_publish_success_persists_confirmation(client, monkeypatch):
    import paratrooper.web.app as app_mod

    monkeypatch.setenv("PARATROOPER_GITHUB_TOKEN", "tok")
    monkeypatch.setattr(app_mod, "merge_pull_request", lambda *a, **kw: {"sha": "abc123"})
    auth = {"Authorization": "Bearer tok"}
    r = client.post("/api/publish", headers=auth,
                    json={"thread_id": "d", "pr": "7"})
    assert r.json() == {"merged": True, "sha": "abc123"}
    rows = client.get("/api/thread/d", headers=auth).json()["messages"]
    assert rows[-1]["kind"] == "published" and "PR #7" in rows[-1]["body"]
