"""The take-back (one reply per burst): a reply the client held unseen dies at
send time. /api/send carries the held seqs; the server validates and deletes
them (thread-scoped, agent-only), broadcasts a retract frame so every connected
client drops the bubble, and only then handles the message — so the rerun's
context (store.recent) can never contain a retracted reply, and a reconnect
replay cannot resurrect it."""

from __future__ import annotations

import asyncio
import logging

import pytest
from fastapi.testclient import TestClient

from paratrooper.agent.config import Config
from paratrooper.web.app import AppState, _enqueue_job, create_app
from paratrooper.web.db import ThreadStore
from paratrooper.web.inbox import DiskInbox
from paratrooper.web.models import ThreadEvent

AUTH = {"Authorization": "Bearer tok"}


def _run(coro):
    return asyncio.run(coro)


class _FakeCoordinator:
    def __init__(self):
        self.calls = []

    async def handle_message(self, thread_id, text, attachments):
        self.calls.append((thread_id, text, attachments))
        return "buffered"

    async def job_finished(self, thread_id):
        pass

    def has_pending(self):
        return False


class _WS:
    def __init__(self):
        self.sent = []

    async def send_json(self, data):
        self.sent.append(data)


def _event(thread_id, role, payload, kind=None):
    return ThreadEvent(
        thread_id=thread_id, role=role, kind=kind, payload=payload,
        ts="2026-08-18T00:00:00+00:00",
    )


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
        queue=object(),
        coordinator=_FakeCoordinator(),
        inbox=DiskInbox(tmp_path / "inbox"),
    )
    app = create_app(injected=state)
    with TestClient(app) as c:
        yield c


# --- the store's delete: validation is the WHERE clause ---


def test_delete_agent_messages_is_thread_scoped_and_agent_only(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    user_seq = store.add_message(_event("d", "user", "hello"))
    reply_seq = store.add_message(_event("d", "agent", "held reply", kind="done"))
    other_seq = store.add_message(_event("other", "agent", "wrong thread", kind="done"))

    deleted = store.delete_agent_messages(
        "d", [user_seq, reply_seq, other_seq, reply_seq + 999]
    )
    assert deleted == [reply_seq]  # only the in-thread agent row went

    left = [(m.role, m.payload) for _, m in store.messages("d")]
    assert left == [("user", "hello")]  # the user row survived
    assert [m.payload for _, m in store.messages("other")] == ["wrong thread"]


def test_delete_agent_messages_empty_and_all_nonsense(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    seq = store.add_message(_event("d", "user", "hello"))
    assert store.delete_agent_messages("d", []) == []
    assert store.delete_agent_messages("d", [seq, 12345]) == []
    assert len(store.messages("d")) == 1


def test_deleted_seq_is_never_reused(tmp_path):
    """Client cursors point at seqs; AUTOINCREMENT must not hand a retracted
    seq to a later event (a reused seq would no-op in the client store)."""
    store = ThreadStore(tmp_path / "t.sqlite")
    reply_seq = store.add_message(_event("d", "agent", "held reply", kind="done"))
    store.delete_agent_messages("d", [reply_seq])
    next_seq = store.add_message(_event("d", "user", "after"))
    assert next_seq > reply_seq


# --- the route: delete, broadcast, then handle the message ---


def test_send_with_retract_deletes_broadcasts_and_logs(client, caplog):
    state = client.app.state.app_state
    reply_seq = state.store.add_message(_event("d", "agent", "caught reply", kind="done"))
    ws = _WS()
    state.sockets.setdefault("d", set()).add(ws)

    with caplog.at_level(logging.INFO, logger="paratrooper.holddiag"):
        resp = client.post(
            "/api/send", headers=AUTH,
            json={"thread_id": "d", "text": "actually, also this",
                  "retract_seqs": [reply_seq]},
        )
    assert resp.status_code == 200 and resp.json()["seq"] > reply_seq

    # the row is gone; the user message persisted and reached the coordinator
    payloads = [(m.role, m.payload) for _, m in state.store.messages("d")]
    assert payloads == [("user", "actually, also this")]
    assert state.coordinator.calls == [("d", "actually, also this", [])]

    # every connected client got the retract frame — no top-level seq, so a
    # stale bundle drops it as ephemeral instead of rendering a ghost
    retracts = [f for f in ws.sent if f.get("kind") == "retract"]
    assert retracts == [{"thread_id": "d", "kind": "retract", "retract_seq": reply_seq}]
    assert all("seq" not in f for f in retracts)

    # one holddiag relay line per retract, deploy-log readable
    lines = [r.message for r in caplog.records if "holddiag relay retract" in r.message]
    assert lines == [f"holddiag relay retract thread=d seq={reply_seq}"]


def test_send_with_nonsense_retracts_is_harmless(client):
    state = client.app.state.app_state
    user_seq = state.store.add_message(_event("d", "user", "mine"))
    ws = _WS()
    state.sockets.setdefault("d", set()).add(ws)

    resp = client.post(
        "/api/send", headers=AUTH,
        json={"thread_id": "d", "text": "next",
              "retract_seqs": [user_seq, 424242, -3]},
    )
    assert resp.status_code == 200

    # nothing was deleted, nothing retract-broadcast; the send went through
    payloads = [m.payload for _, m in state.store.messages("d")]
    assert payloads == ["mine", "next"]
    assert [f for f in ws.sent if f.get("kind") == "retract"] == []


def test_send_without_retracts_unchanged(client):
    resp = client.post("/api/send", headers=AUTH, json={"thread_id": "d", "text": "plain"})
    body = resp.json()
    assert resp.status_code == 200 and body["status"] == "buffered" and body["seq"] >= 1


# --- downstream guarantees: context exclusion and replay ---


def test_retracted_reply_never_reaches_the_next_runs_context(client):
    """The rerun's context comes from store.recent at enqueue time; deletion
    at send must keep the retracted text out of the job that reruns."""
    state = client.app.state.app_state
    state.store.add_message(_event("d", "user", "first ask"))
    reply_seq = state.store.add_message(
        _event("d", "agent", "half-answer he never saw", kind="done")
    )
    client.post(
        "/api/send", headers=AUTH,
        json={"thread_id": "d", "text": "and one more thing",
              "retract_seqs": [reply_seq]},
    )

    class _RecordingQueue:
        def __init__(self):
            self.jobs = []

        async def enqueue(self, job):
            self.jobs.append(job)

    queue = _RecordingQueue()
    state.queue = queue
    _run(_enqueue_job(state, "d", "job-1", "and one more thing", []))
    [job] = queue.jobs
    assert not any("half-answer" in line for line in job.context)
    assert any("first ask" in line for line in job.context)
    assert any("and one more thing" in line for line in job.context)


def test_reconnect_replay_does_not_resurrect_a_retracted_reply(client):
    state = client.app.state.app_state
    before = state.store.add_message(_event("d", "user", "ask"))
    reply_seq = state.store.add_message(_event("d", "agent", "caught", kind="done"))
    client.post(
        "/api/send", headers=AUTH,
        json={"thread_id": "d", "text": "outran it", "retract_seqs": [reply_seq]},
    )

    # a client reconnecting from before the retract (its cursor predates the
    # deleted seq) replays the thread WITHOUT the retracted reply
    with client.websocket_connect(f"/ws?token=tok&thread=d&since={before}") as sock:
        frame = sock.receive_json()
        assert frame["payload"] == "outran it" and frame["seq"] > reply_seq

    # and a fresh login's bounded window never sees it either
    with client.websocket_connect("/ws?token=tok&thread=d&since=0") as sock:
        replayed = [sock.receive_json()["seq"] for _ in range(2)]
        assert reply_seq not in replayed
