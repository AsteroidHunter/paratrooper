"""Multiple chats: the chat list, per-chat isolation, the read watermark, the
nudge to other chats, pushes that name their chat, and the one seam that says
which agent answers a chat.

Every stored row already carried its thread; what these pin is the list built
on top of that (title, preview, activity time, unread count), that nothing of
one chat can reach another chat's history, replay or socket, and that the
existing thread keeps its id and shows up as the default chat on upgrade."""

from __future__ import annotations

import asyncio
import json
import re
import sqlite3
import time

import pytest
from fastapi.testclient import TestClient

from confighelpers import example_config, pinboard_config
from paratrooper.web import push
from paratrooper.web.agents import WORKER, agent_for_thread
from paratrooper.web.app import (
    PRESENCE_PING,
    AppState,
    Presence,
    _enqueue_job,
    _interrupt_job,
    _maybe_push,
    _relay_result,
    create_app,
)
from paratrooper.web.db import ThreadStore
from paratrooper.web.inbox import DiskInbox
from paratrooper.web.models import DEFAULT_THREAD_ID, EVENT_POLICY, ResultMessage, ThreadEvent

AUTH = {"Authorization": "Bearer tok"}


def _run(coro):
    return asyncio.run(coro)


def _event(thread, role, payload, *, kind=None, ts="2026-09-01T00:00:00+00:00", attachments=None):
    return ThreadEvent(
        thread_id=thread, role=role, payload=payload, kind=kind, ts=ts,
        attachments=attachments or [],
    )


def _by_id(store):
    return {t.id: t for t in store.thread_list()}


# --- the store: upgrade, titles, previews, unread -------------------------------


_OLD_SCHEMA = """
CREATE TABLE messages (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id   TEXT NOT NULL,
    role        TEXT NOT NULL,
    kind        TEXT,
    payload     TEXT NOT NULL DEFAULT 'null',
    attachments TEXT NOT NULL DEFAULT '[]',
    ts          TEXT NOT NULL
);
"""


def test_an_existing_thread_is_the_default_chat_after_upgrade(tmp_path):
    """A database from before chats existed: one thread of history and no
    threads table. Opening it lists that thread under its own id, with its
    title and preview, and marked read: the upgrade must not light up every old
    reply as unread."""
    path = tmp_path / "threads.sqlite"
    raw = sqlite3.connect(path)
    raw.executescript(_OLD_SCHEMA)
    rows = [
        ("default", "user", None, json.dumps("put my desert photo up"),
         "2026-08-01T10:00:00+00:00"),
        ("default", "agent", "done", json.dumps("Done, it is on the board"),
         "2026-08-01T10:01:00+00:00"),
    ]
    raw.executemany(
        "INSERT INTO messages(thread_id, role, kind, payload, ts) VALUES (?,?,?,?,?)", rows
    )
    raw.commit()
    raw.close()

    store = ThreadStore(path)
    [chat] = store.thread_list()
    assert chat.id == DEFAULT_THREAD_ID
    assert chat.title == "put my desert photo up"
    assert chat.preview == "Done, it is on the board"
    assert chat.updated == "2026-08-01T10:01:00+00:00"
    assert chat.unread == 0
    # the history itself is untouched
    assert [m.payload for _, m in store.messages(DEFAULT_THREAD_ID)] == [
        "put my desert photo up", "Done, it is on the board",
    ]
    store.close()
    # and the backfill is idempotent: a second boot changes nothing
    again = ThreadStore(path)
    assert [(t.id, t.unread) for t in again.thread_list()] == [(DEFAULT_THREAD_ID, 0)]
    again.close()


def test_a_fresh_install_lists_the_default_chat(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    [chat] = store.thread_list()
    assert (chat.id, chat.title, chat.preview) == (DEFAULT_THREAD_ID, "New chat", "")
    assert chat.unread == 0
    assert chat.updated  # its creation time stands in until something is said


def test_title_is_the_first_user_text_and_preview_the_last_drawn_row(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    add = store.add_message
    add(_event("a", "user", "", attachments=["k1.jpeg"], ts="2026-09-01T00:00:01+00:00"))
    add(_event("a", "user", "  Put the   desert\nphoto up  ", ts="2026-09-01T00:00:02+00:00"))
    add(_event("a", "system", "job123", kind="job", ts="2026-09-01T00:00:03+00:00"))
    add(_event("a", "agent", None, kind="working", ts="2026-09-01T00:00:04+00:00"))
    add(_event("a", "agent", "on it", kind="update", ts="2026-09-01T00:00:05+00:00"))
    add(_event("a", "agent", "Done,\n\nPR is up", kind="done", ts="2026-09-01T00:00:06+00:00"))
    add(_event("a", "system", "job456", kind="job", ts="2026-09-01T00:00:07+00:00"))
    chat = _by_id(store)["a"]
    # a photo-only first message has no words to title the chat with
    assert chat.title == "Put the desert photo up"
    # markers draw nothing, so the preview is the reply before them
    assert chat.preview == "Done, PR is up"
    assert chat.updated == "2026-09-01T00:00:06+00:00"


def test_previews_for_photos_board_previews_and_pull_requests(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    store.add_message(_event("p", "user", "", attachments=["k.jpeg"]))
    store.add_message(_event("s", "user", "show me"))
    shot = "data:image/png;base64," + "A" * 5000
    store.add_message(_event("s", "agent", shot, kind="screenshot"))
    store.add_message(_event("r", "user", "ship it"))
    store.add_message(_event("r", "agent", {"branch": "b", "url": "https://x/pull/3"}, kind="pr"))
    chats = _by_id(store)
    assert chats["p"].preview == "Photo"
    assert chats["p"].title == "New chat"
    assert chats["s"].preview == "Board preview"
    assert "data:" not in chats["s"].preview
    assert chats["r"].preview == "Pull request"


def test_long_titles_and_previews_are_cut_to_one_line(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    store.add_message(_event("a", "user", "word " * 60))
    chat = _by_id(store)["a"]
    assert "\n" not in chat.title and len(chat.title) <= 80
    assert len(chat.preview) <= 120


def test_unread_counts_bubble_replies_above_the_watermark(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    store.add_message(_event("a", "user", "hi"))
    store.add_message(_event("a", "system", "j1", kind="job"))
    store.add_message(_event("a", "agent", None, kind="working"))
    update = store.add_message(_event("a", "agent", "halfway", kind="update"))
    store.add_message(_event("a", "agent", "data:image/png;base64,AA", kind="screenshot"))
    done = store.add_message(_event("a", "agent", "done", kind="done"))
    # the three rows that draw a bubble count; the markers and the user's own do not
    assert _by_id(store)["a"].unread == 3
    store.mark_read("a", update)
    assert _by_id(store)["a"].unread == 2
    store.mark_read("a", done)
    assert _by_id(store)["a"].unread == 0
    store.mark_read("a", update)  # never backwards
    assert _by_id(store)["a"].unread == 0


def test_the_unread_kinds_are_exactly_the_agent_kinds_that_draw_a_bubble():
    counted = {kind for kind, policy in EVENT_POLICY.items() if policy.unread}
    assert counted == {"log", "update", "screenshot", "pr", "done", "error"}


def test_mark_read_to_end_takes_the_chat_to_its_newest_row(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    store.add_message(_event("a", "agent", "one", kind="done"))
    store.add_message(_event("b", "agent", "other chat", kind="done"))
    store.add_message(_event("a", "agent", "two", kind="done"))
    store.mark_read_to_end("a")
    chats = _by_id(store)
    assert chats["a"].unread == 0
    assert chats["b"].unread == 1  # another chat's rows are not this chat's watermark


def test_the_list_is_newest_activity_first(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    store.add_message(_event(DEFAULT_THREAD_ID, "user", "old", ts="2026-09-01T00:00:00+00:00"))
    store.add_message(_event("b", "user", "newer", ts="2026-09-02T00:00:00+00:00"))
    store.add_message(_event("c", "user", "middle", ts="2026-09-01T12:00:00+00:00"))
    assert [t.id for t in store.thread_list()] == ["b", "c", DEFAULT_THREAD_ID]
    fresh = store.create_thread()
    # a chat made just now, still empty, is the newest thing there is
    assert [t.id for t in store.thread_list()][0] == fresh.id


def test_created_ids_are_safe_for_the_channel_names(tmp_path):
    """The results channel and the interrupt payload are split on ':'
    (queue.py), so an id must never carry one."""
    store = ThreadStore(tmp_path / "t.sqlite")
    ids = {store.create_thread().id for _ in range(20)}
    assert len(ids) == 20
    for tid in ids:
        assert re.fullmatch(r"[0-9a-f]{16}", tid)


# --- routes ------------------------------------------------------------------


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

    def was_superseded(self, thread_id, job_id):
        return False


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PARATROOPER_APP_TOKEN", "tok")
    cfg = pinboard_config(tmp_path, remote="https://github.com/AsteroidHunter/webpage.git")
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


def test_the_chat_list_routes_take_the_token(client):
    assert client.get("/api/threads").status_code == 401
    assert client.post("/api/threads").status_code == 401


def test_get_threads_lists_the_default_chat(client):
    body = client.get("/api/threads", headers=AUTH).json()
    [chat] = body["threads"]
    assert set(chat) == {"id", "title", "preview", "updated", "unread"}
    assert chat["id"] == DEFAULT_THREAD_ID


def test_post_threads_makes_a_new_chat_listed_first(client):
    made = client.post("/api/threads", headers=AUTH).json()
    assert re.fullmatch(r"[0-9a-f]{16}", made["id"])
    assert (made["title"], made["preview"], made["unread"]) == ("New chat", "", 0)
    listed = client.get("/api/threads", headers=AUTH).json()["threads"]
    assert [t["id"] for t in listed] == [made["id"], DEFAULT_THREAD_ID]


def test_a_send_in_one_chat_never_shows_in_another(client):
    other = client.post("/api/threads", headers=AUTH).json()["id"]
    for thread, text in [(DEFAULT_THREAD_ID, "in default"), (other, "in the new chat")]:
        client.post("/api/send", headers=AUTH, json={"thread_id": thread, "text": text})

    def texts(route):
        return [m["payload"] for m in client.get(route, headers=AUTH).json()["messages"]]

    assert texts(f"/api/thread/{DEFAULT_THREAD_ID}") == ["in default"]
    assert texts(f"/api/thread/{other}") == ["in the new chat"]
    big = 2**53
    assert texts(f"/api/history/{DEFAULT_THREAD_ID}?before={big}") == ["in default"]
    assert texts(f"/api/history/{other}?before={big}") == ["in the new chat"]
    # each chat's own batch, never the other's
    coordinator = client.app.state.app_state.coordinator
    assert [(t, text) for t, text, _ in coordinator.calls] == [
        (DEFAULT_THREAD_ID, "in default"), (other, "in the new chat"),
    ]
    listed = client.get("/api/threads", headers=AUTH).json()["threads"]
    titles = {t["id"]: t["title"] for t in listed}
    assert titles == {DEFAULT_THREAD_ID: "in default", other: "in the new chat"}


def test_replay_is_per_chat(client):
    other = client.post("/api/threads", headers=AUTH).json()["id"]
    for thread, text in [(DEFAULT_THREAD_ID, "a1"), (other, "b1"), (DEFAULT_THREAD_ID, "a2")]:
        client.post("/api/send", headers=AUTH, json={"thread_id": thread, "text": text})
    for thread, expected in [(DEFAULT_THREAD_ID, ["a1", "a2"]), (other, ["b1"])]:
        with client.websocket_connect(f"/ws?token=tok&thread={thread}&since=0") as sock:
            got = [sock.receive_json()["payload"] for _ in expected]
            assert got == expected
    # and the catch-up after a cursor stays inside the chat too
    rows = client.get(f"/api/thread/{DEFAULT_THREAD_ID}", headers=AUTH).json()["messages"]
    since = rows[0]["seq"]
    url = f"/ws?token=tok&thread={DEFAULT_THREAD_ID}&since={since}"
    with client.websocket_connect(url) as sock:
        frame = sock.receive_json()
        assert (frame["payload"], frame["thread_id"]) == ("a2", DEFAULT_THREAD_ID)


def test_a_socket_with_no_chat_named_is_the_default_chat(client):
    client.post("/api/send", headers=AUTH, json={"thread_id": DEFAULT_THREAD_ID, "text": "hello"})
    with client.websocket_connect("/ws?token=tok&since=0") as sock:
        assert sock.receive_json()["payload"] == "hello"


def test_send_refuses_a_chat_id_the_channels_cannot_carry(client):
    response = client.post("/api/send", headers=AUTH, json={"thread_id": "a:b", "text": "x"})
    assert response.status_code == 422


def _eventually(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def test_the_on_screen_ping_marks_that_chat_read(client):
    state = client.app.state.app_state
    other = client.post("/api/threads", headers=AUTH).json()["id"]
    state.store.add_message(_event(DEFAULT_THREAD_ID, "agent", "reply", kind="done"))
    state.store.add_message(_event(other, "agent", "reply elsewhere", kind="done"))

    def unread():
        return {t.id: t.unread for t in state.store.thread_list()}

    assert unread() == {DEFAULT_THREAD_ID: 1, other: 1}
    with client.websocket_connect(f"/ws?token=tok&thread={DEFAULT_THREAD_ID}&since=0") as sock:
        sock.receive_json()  # the replayed reply
        sock.send_text(PRESENCE_PING)
        assert _eventually(lambda: unread()[DEFAULT_THREAD_ID] == 0)
    assert unread()[other] == 1  # the chat that was not on screen is still unread


# --- the relay: read while on screen, and the nudge to other chats ------------


class _Socket:
    def __init__(self):
        self.sent = []

    async def send_json(self, data):
        self.sent.append(data)


def _relay_state(tmp_path):
    return AppState(config=example_config(), store=ThreadStore(tmp_path / "t.sqlite"),
                    queue=object(), coordinator=_FakeCoordinator(),
                    inbox=DiskInbox(tmp_path / "ib"))


def _on_screen(state, thread_id):
    ws = _Socket()
    state.sockets.setdefault(thread_id, set()).add(ws)
    state.presence[ws] = Presence(seen=time.monotonic())
    return ws


def test_a_reply_goes_to_its_own_chat_and_nudges_the_others(tmp_path, monkeypatch):
    monkeypatch.delenv("VAPID_PRIVATE_KEY", raising=False)
    state = _relay_state(tmp_path)
    here = _Socket()
    there = _Socket()
    state.sockets.setdefault("a", set()).add(here)
    state.sockets.setdefault("b", set()).add(there)

    async def scenario():
        await _relay_result(state, "a", ResultMessage(job_id="j", kind="update", payload="halfway"))
        await _relay_result(state, "a", ResultMessage(job_id="j", kind="typing"))
        await _relay_result(state, "a", ResultMessage(job_id="j", kind="working"))

    _run(scenario())
    assert [f.get("kind") for f in here.sent] == ["update", "typing", "working"]
    assert all(f.get("thread_id") == "a" for f in here.sent)
    # only the frame that draws a bubble is news for the other chat, and the
    # nudge carries no seq, so an older build drops it untouched
    assert there.sent == [{"kind": "threads", "thread_id": "a"}]


def test_a_reply_on_screen_is_stored_read_and_one_off_screen_is_not(tmp_path, monkeypatch):
    monkeypatch.delenv("VAPID_PRIVATE_KEY", raising=False)
    state = _relay_state(tmp_path)
    _on_screen(state, "a")
    _run(_relay_result(state, "a", ResultMessage(job_id="j", kind="update", payload="seen")))
    _run(_relay_result(state, "b", ResultMessage(job_id="k", kind="update", payload="unseen")))
    unread = {t.id: t.unread for t in state.store.thread_list()}
    assert unread["a"] == 0
    assert unread["b"] == 1


# --- pushes name their chat -----------------------------------------------------


def test_a_push_names_its_chat_and_the_default_chat_stays_plain_text(tmp_path, monkeypatch):
    """The default chat's push is byte-identical to before chats existed, so a
    phone still running the old service worker shows it right. Any other chat
    can only exist once the new build has run, so its push carries the chat."""
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "private")
    monkeypatch.setenv("VAPID_SUBJECT", "mailto:push@example.test")
    sent: list = []
    monkeypatch.setattr(push, "send_push", lambda _sub, payload, _cfg: sent.append(payload) or True)
    state = _relay_state(tmp_path)
    state.store.add_subscription("https://web.push.apple.com/x", '{"endpoint":"x"}')
    _run(_maybe_push(state, DEFAULT_THREAD_ID, "done", "reply one"))
    _run(_maybe_push(state, "0123456789abcdef", "done", "reply two"))
    assert sent[0] == "reply one"
    assert json.loads(sent[1]) == {"body": "reply two", "thread": "0123456789abcdef"}


def test_a_push_is_still_held_back_only_for_the_chat_on_screen(tmp_path, monkeypatch):
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "private")
    monkeypatch.setenv("VAPID_SUBJECT", "mailto:push@example.test")
    sent: list = []
    monkeypatch.setattr(push, "send_push", lambda _sub, payload, _cfg: sent.append(payload) or True)
    state = _relay_state(tmp_path)
    state.store.add_subscription("https://web.push.apple.com/x", '{"endpoint":"x"}')
    _on_screen(state, "a")
    _run(_maybe_push(state, "a", "done", "on screen"))
    _run(_maybe_push(state, "b", "done", "elsewhere"))
    assert [json.loads(p)["body"] for p in sent] == ["elsewhere"]


# --- the seam: which agent answers a chat -------------------------------------


class _RecordingQueue:
    def __init__(self):
        self.jobs = []
        self.interrupts = []

    async def enqueue(self, job):
        self.jobs.append(job)

    async def publish_interrupt(self, thread_id, job_id=None):
        self.interrupts.append((thread_id, job_id))


def test_every_chat_resolves_to_the_existing_worker_today():
    queue = _RecordingQueue()
    for thread in (DEFAULT_THREAD_ID, "0123456789abcdef"):
        route = agent_for_thread(thread, queue)
        assert route.name == WORKER


def test_jobs_and_interrupts_reach_the_agent_through_the_seam(tmp_path, monkeypatch):
    import paratrooper.web.app as app_mod

    queue = _RecordingQueue()
    state = AppState(config=example_config(), store=ThreadStore(tmp_path / "t.sqlite"),
                     queue=queue, coordinator=_FakeCoordinator(), inbox=DiskInbox(tmp_path / "ib"))
    asked: list = []
    real = app_mod.agent_for_thread

    def recording(thread_id, q):
        asked.append(thread_id)
        return real(thread_id, q)

    monkeypatch.setattr(app_mod, "agent_for_thread", recording)
    state.store.add_message(_event("c", "user", "context from this chat"))
    state.store.add_message(_event("elsewhere", "user", "never this chat's context"))
    _run(_enqueue_job(state, "c", "job-1", "go", []))
    _run(_interrupt_job(state, "c", "job-1"))
    assert asked == ["c", "c"]
    [job] = queue.jobs
    assert job.thread_id == "c"
    assert job.context == ["user: context from this chat"]
    assert queue.interrupts == [("c", "job-1")]
