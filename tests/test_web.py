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
from paratrooper.web.models import ThreadEvent
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

    def msg(thread, role, payload, kind=None):
        return ThreadEvent(
            thread_id=thread, role=role, payload=payload, ts="2026-06-30T00:00:00Z", kind=kind
        )

    s1 = store.add_message(msg("d", "user", "hi"))
    store.add_message(msg("d", "agent", "hello", kind="done"))
    store.add_message(msg("other", "user", "x"))
    # catch-up since seq
    rows = store.messages("d", since_seq=s1)
    assert [m.payload for _, m in rows] == ["hello"]
    # full thread
    assert len(store.messages("d")) == 2
    # recent for job context
    assert [m.payload for m in store.recent("d", n=10)] == ["hi", "hello"]


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
    # screenshots buzz too (user decision 20260708, overturning the plan-era
    # behavior-preservation): a board preview is worth a notification on its own
    assert push.notification_text("screenshot")


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
    assert rows[-1]["role"] == "user" and rows[-1]["payload"] == "add it"


def _seed(store, thread_id, n, prefix="m"):
    return [
        store.add_message(ThreadEvent(
            thread_id=thread_id, role="user", payload=f"{prefix}{i}",
            ts="2026-07-07T00:00:00+00:00",
        ))
        for i in range(n)
    ]


def test_messages_page_paginates_backwards(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    _seed(store, "other", 3)  # global AUTOINCREMENT: other threads shift seqs
    seqs = _seed(store, "d", 10)

    newest = store.messages_page("d", limit=4)
    assert [m.payload for _, m in newest] == ["m6", "m7", "m8", "m9"]  # oldest-first
    older = store.messages_page("d", before_seq=newest[0][0], limit=4)
    assert [m.payload for _, m in older] == ["m2", "m3", "m4", "m5"]
    first = store.messages_page("d", before_seq=older[0][0], limit=4)
    assert [m.payload for _, m in first] == ["m0", "m1"]
    assert store.messages_page("d", before_seq=seqs[0]) == []  # top reached


def test_history_route_and_cursor_stability(client):
    auth = {"Authorization": "Bearer tok"}
    store = client.app.state.app_state.store
    seqs = _seed(store, "d", 6)

    assert client.get("/api/history/d", params={"before": seqs[3]}).status_code == 401
    page = client.get(
        "/api/history/d", headers=auth, params={"before": seqs[3], "limit": 2}
    ).json()["messages"]
    assert [m["payload"] for m in page] == ["m1", "m2"]

    # live rows arriving after a page is cut don't disturb either cursor:
    # the same ?before page is identical, and ?since still yields only the new row
    new_seq = store.add_message(ThreadEvent(
        thread_id="d", role="agent", payload="fresh", ts="2026-07-07T00:00:01+00:00", kind="done",
    ))
    again = client.get(
        "/api/history/d", headers=auth, params={"before": seqs[3], "limit": 2}
    ).json()["messages"]
    assert again == page
    since = client.get(f"/api/thread/d?since={seqs[-1]}", headers=auth).json()["messages"]
    assert [m["seq"] for m in since] == [new_seq]


def test_ws_fresh_login_gets_bounded_window(client):
    store = client.app.state.app_state.store
    _seed(store, "d", 60)
    with client.websocket_connect("/ws?token=tok&thread=d&since=0") as sock:
        first = sock.receive_json()
        assert first["payload"] == "m10"  # 60 rows, window of 50 -> starts at m10
        for i in range(11, 60):
            assert sock.receive_json()["payload"] == f"m{i}"


def _png_bytes(size=(640, 480), color=(200, 60, 60)) -> bytes:
    from io import BytesIO

    from PIL import Image

    buf = BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


def test_make_thumbnail_downscales_and_rejects_non_images():
    from PIL import Image

    from paratrooper.web.thumbs import THUMB_EDGE, make_thumbnail

    thumb = make_thumbnail(_png_bytes())
    assert thumb is not None
    from io import BytesIO

    im = Image.open(BytesIO(thumb))
    assert im.format == "WEBP" and max(im.size) <= THUMB_EDGE
    assert make_thumbnail(b"not an image") is None


def test_thumbnail_store_roundtrip(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    store.add_thumbnail("inbox/abc.png", b"webpbytes", ts="2026-07-07T00:00:00+00:00")
    data, ctype = store.thumbnail("inbox/abc.png")
    assert data == b"webpbytes" and ctype == "image/webp"
    assert store.thumbnail("inbox/missing.png") is None


def test_thumb_route_serves_persisted_previews(client):
    auth = {"Authorization": "Bearer tok"}
    up = client.post(
        "/api/upload", headers=auth, files={"file": ("p.png", _png_bytes(), "image/png")}
    )
    key = up.json()["inbox_key"]

    # <img src> can't set headers, so the token rides the query string like /ws
    ok = client.get(f"/api/thumb/{key}", params={"token": "tok"})
    assert ok.status_code == 200 and ok.headers["content-type"] == "image/webp"

    assert client.get(f"/api/thumb/{key}").status_code == 401
    assert client.get(f"/api/thumb/{key}", params={"token": "wrong"}).status_code == 401
    assert client.get("/api/thumb/nope.png", params={"token": "tok"}).status_code == 404

    # a non-image upload stores no thumbnail: history keeps its chip via 404
    up2 = client.post(
        "/api/upload", headers=auth, files={"file": ("f.txt", b"plain text", "text/plain")}
    )
    key2 = up2.json()["inbox_key"]
    assert client.get(f"/api/thumb/{key2}", params={"token": "tok"}).status_code == 404


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

    def add(role, payload, kind=None, thread="d"):
        return store.add_message(ThreadEvent(
            thread_id=thread, role=role, payload=payload, ts="2026-07-06T00:00:00Z", kind=kind,
        ))

    add("user", "covered msg")
    add("system", "job-abc", kind="job")  # marker: everything above is covered
    add("agent", "reply", kind="done")
    add("user", "swallowed one")
    add("user", "swallowed two")
    add("user", "other thread msg", thread="e")  # no marker in e at all
    got = store.unprocessed_user_messages()
    assert [(t, m.payload) for t, m in got] == [
        ("d", "swallowed one"), ("d", "swallowed two"), ("e", "other thread msg"),
    ]


def test_recover_unprocessed_feeds_coordinator(tmp_path):
    from paratrooper.web.app import recover_unprocessed

    store = ThreadStore(tmp_path / "t.sqlite")
    store.add_message(ThreadEvent(
        thread_id="d", role="user", payload="lost msg", ts="2026-07-06T00:00:00Z",
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
    assert rows[-1]["kind"] == "published" and "PR #7" in rows[-1]["payload"]


# --- canonical ThreadEvent: replay must equal the live frame (phase 2) ---------

def test_thread_event_roundtrip_replay_equals_live(tmp_path):
    """The 'works live, breaks on replay' bug class: persist the broadcast
    event, replay it, and the frame must be identical — for every payload
    shape the worker emits plus user text."""
    from paratrooper.web.app import _to_event
    from paratrooper.web.models import ResultMessage

    store = ThreadStore(tmp_path / "t.sqlite")
    results = [
        ResultMessage(job_id="j", kind="done", payload="all set"),
        ResultMessage(job_id="j", kind="update", payload="on it"),
        ResultMessage(job_id="j", kind="screenshot", payload="data:image/png;base64,AAAA"),
        ResultMessage(job_id="j", kind="pr",
                      payload={"branch": "paratrooper/x", "url": "https://github.com/o/r/pull/9"}),
        ResultMessage(job_id="j", kind="done", payload=None),
    ]
    events = [_to_event("d", r) for r in results]
    events.append(ThreadEvent(  # user text is a plain string payload
        thread_id="d", role="user", payload="hi there", ts="2026-07-07T00:00:00+00:00",
    ))
    for event in events:
        seq = store.add_message(event)
        live = {"seq": seq, **event.model_dump()}
        [(rseq, replayed)] = store.messages("d", since_seq=seq - 1)
        assert {"seq": rseq, **replayed.model_dump()} == live


def test_migration_backfills_payload_and_drops_body(tmp_path):
    """An old-schema DB (body column, no payload) must come out of ThreadStore
    boot migrated: payload backfilled for every row, JSON-in-body pr rows
    parsed, plain text kept verbatim, body column gone."""
    import sqlite3

    path = tmp_path / "old.sqlite"
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE messages (
            seq         INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id   TEXT NOT NULL,
            role        TEXT NOT NULL,
            body        TEXT NOT NULL DEFAULT '',
            attachments TEXT NOT NULL DEFAULT '[]',
            ts          TEXT NOT NULL,
            kind        TEXT
        );
        CREATE INDEX idx_messages_thread ON messages(thread_id, seq);
    """)
    rows = [
        ("d", "user", "hi", "[]", "2026-07-01T00:00:00Z", None),
        ("d", "user", "123", "[]", "2026-07-01T00:00:01Z", None),  # numeric text stays text
        ("d", "agent", '{"branch": "paratrooper/x", "url": "https://github.com/o/r/pull/9"}',
         "[]", "2026-07-01T00:00:02Z", "pr"),
        ("d", "agent", "", "[]", "2026-07-01T00:00:03Z", "pr"),  # pre-6da5b3c empty pr row
        ("d", "system", "job-abc", "[]", "2026-07-01T00:00:04Z", "job"),
    ]
    conn.executemany(
        "INSERT INTO messages(thread_id, role, body, attachments, ts, kind) VALUES (?,?,?,?,?,?)",
        rows,
    )
    conn.commit()
    conn.close()

    store = ThreadStore(path)  # boot runs the migration
    cols = {r[1] for r in store._conn.execute("PRAGMA table_info(messages)")}
    assert "payload" in cols and "body" not in cols
    got = [m.payload for _, m in store.messages("d")]
    assert got[0] == "hi"
    assert got[1] == "123"  # NOT the number 123: non-pr rows are never JSON-parsed
    assert got[2] == {"branch": "paratrooper/x", "url": "https://github.com/o/r/pull/9"}
    assert got[3] == ""
    assert got[4] == "job-abc"
    # idempotent: reopening a migrated DB is a no-op
    store.close()
    again = ThreadStore(path)
    assert [m.payload for _, m in again.messages("d")] == got


# --- pr ref must survive persistence + empty-ref publish (the replay bug) ------


def test_find_open_pr_resolves_single_prefixed_pr(monkeypatch):
    import httpx as _httpx

    from paratrooper.web import publish as pub

    prs = [
        {"number": 3, "head": {"ref": "dependabot/npm"}},
        {"number": 2, "head": {"ref": "paratrooper/desert-new-photo"}},
    ]

    def fake_get(url, **kw):
        return _httpx.Response(200, json=prs, request=_httpx.Request("GET", url))

    monkeypatch.setattr(pub.httpx, "get", fake_get)
    found = pub.find_open_pr("o", "r", token="t", branch_prefix="paratrooper")
    assert found["number"] == 2


def test_find_open_pr_zero_or_many_is_an_error(monkeypatch):
    import httpx as _httpx

    from paratrooper.web import publish as pub

    def fake_empty(url, **kw):
        return _httpx.Response(200, json=[], request=_httpx.Request("GET", url))

    monkeypatch.setattr(pub.httpx, "get", fake_empty)
    with pytest.raises(PublishError, match="no open PR"):
        pub.find_open_pr("o", "r", token="t", branch_prefix="paratrooper")

    two = [
        {"number": 1, "head": {"ref": "paratrooper/a"}},
        {"number": 2, "head": {"ref": "paratrooper/b"}},
    ]

    def fake_two(url, **kw):
        return _httpx.Response(200, json=two, request=_httpx.Request("GET", url))

    monkeypatch.setattr(pub.httpx, "get", fake_two)
    with pytest.raises(PublishError, match="2 open PRs"):
        pub.find_open_pr("o", "r", token="t", branch_prefix="paratrooper")


def test_publish_empty_ref_resolves_open_pr(client, monkeypatch):
    """A replayed pr bubble (body persisted as "" pre-fix) still publishes: the
    server resolves the one open agent PR instead of 409ing on the empty ref."""
    import paratrooper.web.app as app_mod

    monkeypatch.setenv("PARATROOPER_GITHUB_TOKEN", "tok")
    seen = {}

    def fake_find(owner, repo, *, token, branch_prefix=""):
        seen["prefix"] = branch_prefix
        return {"number": 2, "head": {"ref": "paratrooper/desert-new-photo"}}

    monkeypatch.setattr(app_mod, "find_open_pr", fake_find)
    monkeypatch.setattr(app_mod, "merge_pull_request", lambda *a, **kw: {"sha": "d34d"})
    auth = {"Authorization": "Bearer tok"}
    r = client.post("/api/publish", headers=auth, json={"thread_id": "d", "pr": ""})
    assert r.status_code == 200 and r.json()["merged"] is True
    assert seen["prefix"] == "paratrooper"
    rows = client.get("/api/thread/d", headers=auth).json()["messages"]
    assert "PR #2" in rows[-1]["payload"]


def test_ws_token_redacted_from_uvicorn_logs(client):
    """The /ws accept line uvicorn logs must never contain the real bearer token
    (verified leaking into Render logs on every reconnect before this filter)."""
    import logging

    lg = logging.getLogger("uvicorn.error")
    record = lg.makeRecord(
        lg.name, logging.INFO, __file__, 0,
        '%s - "WebSocket %s" [accepted]',
        ("1.2.3.4:5", "/ws?token=s3cr3ttok3n&thread=default&since=76"),
        None,
    )
    for f in lg.filters:
        f.filter(record)
    rendered = record.getMessage()
    assert "s3cr3ttok3n" not in rendered
    assert "token=REDACTED" in rendered
    assert "thread=default" in rendered  # only the secret is scrubbed


def test_publish_empty_ref_with_no_open_pr_is_409(client, monkeypatch):
    import paratrooper.web.app as app_mod

    monkeypatch.setenv("PARATROOPER_GITHUB_TOKEN", "tok")

    def none_found(*a, **kw):
        raise PublishError("no open PR to publish")

    monkeypatch.setattr(app_mod, "find_open_pr", none_found)
    auth = {"Authorization": "Bearer tok"}
    r = client.post("/api/publish", headers=auth, json={"thread_id": "d", "pr": ""})
    assert r.status_code == 409
    assert "no open PR" in r.json()["detail"]


# --- event policy + job-context projection (chat-event-refactor phase 1) -------

def test_event_policy_covers_every_kind():
    """Every ResultKind and system kind must have a policy row — a new kind
    added without one should fail here, not misbehave in the relay."""
    from typing import get_args

    from paratrooper.web.models import EVENT_POLICY, SYSTEM_KINDS, ResultKind

    for kind in [*get_args(ResultKind), *SYSTEM_KINDS]:
        assert kind in EVENT_POLICY, f"kind {kind!r} has no policy row"
    for kind, p in EVENT_POLICY.items():
        assert not (p.ephemeral and p.persist), f"{kind}: ephemeral rows must not persist"
    assert EVENT_POLICY["done"].terminal and EVENT_POLICY["error"].terminal
    assert not EVENT_POLICY["update"].terminal
    # working is the pickup watermark: it must persist (the phone derives its
    # Read receipt from stored rows on replay) and must never reach job context
    assert EVENT_POLICY["working"].persist and not EVENT_POLICY["working"].ephemeral
    assert EVENT_POLICY["working"].context == "skip"


def test_job_context_projection_skips_blobs_and_markers(tmp_path):
    """The prompt-blob defect: raw bodies pasted a multi-MB screenshot data URI
    and job-marker hex into the agent prompt as 'context'. The projection must
    keep text, compress pr rows to a short ref, and drop the rest."""
    from paratrooper.web.app import _enqueue_job

    store = ThreadStore(tmp_path / "t.sqlite")

    def add(role, payload, kind=None):
        store.add_message(ThreadEvent(
            thread_id="d", role=role, payload=payload, ts="2026-07-07T00:00:00Z", kind=kind,
        ))

    add("user", "put my desert photo up")
    add("system", "a1b2c3d4e5", kind="job")
    add("agent", None, kind="working")  # pickup watermark row: persisted, never context
    add("agent", "on it — resizing now", kind="update")
    add("agent", "data:image/png;base64," + "A" * 4096, kind="screenshot")
    add("agent", {"branch": "paratrooper/desert",
                  "url": "https://github.com/o/r/pull/9"}, kind="pr")
    add("agent", "done — PR is up", kind="done")

    class _RecordingQueue:
        def __init__(self):
            self.jobs = []

        async def enqueue(self, job):
            self.jobs.append(job)

    queue = _RecordingQueue()
    state = AppState(config=None, store=store, queue=queue,
                     coordinator=_FakeCoordinator(), inbox=DiskInbox(tmp_path / "ib"))
    _run(_enqueue_job(state, "d", "job-xyz", "next request", []))

    [job] = queue.jobs
    assert job.context == [
        "user: put my desert photo up",
        "agent: on it — resizing now",
        "agent: opened PR #9",
        "agent: done — PR is up",
    ]
    joined = "\n".join(job.context)
    assert "data:" not in joined and "a1b2c3d4e5" not in joined


def test_pr_context_ref_survives_bad_payloads():
    """Backfilled pr rows can hold "" (pre-6da5b3c) or url-less dicts — the ref
    line must degrade gracefully, never crash the enqueue path."""
    from paratrooper.web.app import context_line

    def pr_row(payload):
        return ThreadEvent(thread_id="d", role="agent", payload=payload,
                           ts="2026-07-07T00:00:00Z", kind="pr")

    assert context_line(pr_row({"url": "https://github.com/o/r/pull/12"})) == "agent: opened PR #12"
    assert context_line(pr_row("https://github.com/o/r/pull/12")) == "agent: opened PR #12"
    assert context_line(pr_row("")) == "agent: opened a PR"
    assert context_line(pr_row({"branch": "x"})) == "agent: opened a PR"
    assert context_line(pr_row(None)) == "agent: opened a PR"
