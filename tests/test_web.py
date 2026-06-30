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
    assert client.get("/api/health").json() == {"ok": True}


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
    assert sent.json() == {"status": "buffered"}
    calls = client.app.state.app_state.coordinator.calls
    assert calls == [("d", "add it", [key])]

    # the user message was persisted and is fetchable
    rows = client.get("/api/thread/d", headers=auth).json()["messages"]
    assert rows[-1]["role"] == "user" and rows[-1]["body"] == "add it"


def test_push_routes(client, monkeypatch):
    monkeypatch.delenv("VAPID_PUBLIC_KEY", raising=False)
    auth = {"Authorization": "Bearer tok"}
    assert client.get("/api/push/key", headers=auth).json() == {"key": None}  # not configured
    sub = {"endpoint": "https://push.example/xyz", "keys": {"p256dh": "k", "auth": "a"}}
    assert client.post("/api/push/subscribe", headers=auth, json=sub).json() == {"ok": True}
    assert client.app.state.app_state.store.subscriptions() == [sub]
    assert client.post("/api/push/subscribe", headers=auth, json={}).status_code == 400
