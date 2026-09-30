"""Emoji reactions (tapbacks): the store, the route, the socket frames, the
relay of the agent's own reactions, the job context and the worker's tool.

One reaction per person per message, kept per chat in its own table. The phone
learns them from one snapshot frame after every socket replay and from a live
frame per change; the agent learns his from lines in the next job's context and
puts its own on his messages through ``react_to_message``. A reaction never
starts a job and never sends a push."""

from __future__ import annotations

import asyncio
import sqlite3

import pytest
from fastapi.testclient import TestClient

from confighelpers import example_config, pinboard_config
from paratrooper.web.app import (
    AppState,
    _enqueue_job,
    _relay_result,
    create_app,
    job_context,
)
from paratrooper.web.db import ThreadStore
from paratrooper.web.inbox import DiskInbox
from paratrooper.web.models import (
    DEFAULT_THREAD_ID,
    EVENT_POLICY,
    TAPBACKS,
    ResultMessage,
    ThreadEvent,
    normalize_reaction,
)

AUTH = {"Authorization": "Bearer tok"}
TS = "2026-09-29T10:00:00+00:00"


def _run(coro):
    return asyncio.run(coro)


def _event(thread, role, payload, *, kind=None, ts=TS, attachments=None):
    return ThreadEvent(
        thread_id=thread, role=role, payload=payload, kind=kind, ts=ts,
        attachments=attachments or [],
    )


def _at(minute: int) -> str:
    return f"2026-09-29T10:{minute:02d}:00+00:00"


# --- what a reaction may be -----------------------------------------------------


def test_the_six_tapbacks_in_messages_order():
    assert TAPBACKS == ("heart", "like", "dislike", "haha", "emphasize", "question")


@pytest.mark.parametrize("given,stored", [
    ("heart", "heart"), ("like", "like"), ("dislike", "dislike"), ("haha", "haha"),
    ("emphasize", "emphasize"), ("question", "question"),
    # the names the agent might reach for, and the glyphs drawn as the six
    ("Heart", "heart"), ("thumbs up", "like"), ("thumbs_down", "dislike"),
    ("ha ha", "haha"), ("!!", "emphasize"), ("?", "question"),
    ("🩷", "heart"), ("👍", "like"), ("👎", "dislike"), ("‼️", "emphasize"), ("‼", "emphasize"),
    ("❓", "question"),
    # any other single emoji is itself; the red heart is not the heart tapback
    ("❤️", "❤️"), ("😂", "😂"), ("👍🏽", "👍🏽"), ("🇺🇸", "🇺🇸"), ("1️⃣", "1️⃣"),
    ("👨‍👩‍👧‍👦", "👨‍👩‍👧‍👦"), ("  🎈 ", "🎈"),
])
def test_normalize_reaction_accepts_the_six_and_one_emoji(given, stored):
    assert normalize_reaction(given) == stored


@pytest.mark.parametrize("given", [
    "", "   ", "lol", "a", "7", "😂😂", "😂 ok", "日本", "<b>", "heart!", "x" * 40, None, 5,
])
def test_normalize_reaction_refuses_words_and_several_emoji(given):
    assert normalize_reaction(given) is None


def test_the_reaction_kind_is_neither_a_row_nor_context_nor_a_push():
    policy = EVENT_POLICY["reaction"]
    assert not policy.persist and not policy.ephemeral
    assert policy.context == "skip"
    assert not policy.notifies and not policy.terminal and not policy.unread


# --- the store ------------------------------------------------------------------


def test_one_reaction_per_person_per_message_replaced_and_cleared(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    reply = store.add_message(_event("d", "agent", "Added it.", kind="done"))
    assert store.set_reaction("d", reply, "user", "heart", ts=_at(1))
    assert [(r.target, r.role, r.reaction) for r in store.reactions("d")] == [
        (reply, "user", "heart"),
    ]
    # another pick replaces his, it never stacks a second one of his
    assert store.set_reaction("d", reply, "user", "haha", ts=_at(2))
    [only] = store.reactions("d")
    assert (only.reaction, only.ts) == ("haha", _at(2))
    # and None takes it off
    assert store.set_reaction("d", reply, "user", None, ts=_at(3))
    assert store.reactions("d") == []


def test_his_and_the_agents_reactions_stand_side_by_side(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    mine = store.add_message(_event("d", "user", "ship it"))
    assert store.set_reaction("d", mine, "agent", "like", ts=_at(1))
    assert store.set_reaction("d", mine, "user", "😂", ts=_at(2))
    got = {(r.role, r.reaction) for r in store.reactions("d")}
    assert got == {("agent", "like"), ("user", "😂")}


def test_only_a_drawn_row_of_the_same_chat_can_carry_one(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    here = store.add_message(_event("d", "user", "in d"))
    there = store.add_message(_event("other", "user", "in other"))
    marker = store.add_message(_event("d", "system", "job1", kind="job"))
    working = store.add_message(_event("d", "agent", None, kind="working"))
    photo = store.add_message(_event("d", "user", "", attachments=["k.jpg"]))
    shot = store.add_message(_event("d", "agent", "data:image/png;base64,AA", kind="screenshot"))
    assert not store.set_reaction("d", there, "user", "heart", ts=TS)  # another chat's row
    assert not store.set_reaction("d", 99999, "user", "heart", ts=TS)  # no such row
    assert not store.set_reaction("d", marker, "user", "heart", ts=TS)  # bookkeeping
    assert not store.set_reaction("d", working, "user", "heart", ts=TS)  # draws nothing
    assert store.set_reaction("d", here, "user", "heart", ts=TS)
    assert store.set_reaction("d", photo, "user", "heart", ts=TS)
    assert store.set_reaction("d", shot, "user", "heart", ts=TS)
    # the agent's reactions go on his messages and nowhere else
    reply = store.add_message(_event("d", "agent", "a reply", kind="done"))
    assert not store.set_reaction("d", reply, "agent", "like", ts=TS, target_roles=("user",))
    assert store.set_reaction("d", here, "agent", "like", ts=TS, target_roles=("user",))
    assert store.reactions("other") == []


def test_reactions_are_kept_per_chat(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    a = store.add_message(_event("a", "user", "in a"))
    b = store.add_message(_event("b", "user", "in b"))
    store.set_reaction("a", a, "user", "heart", ts=TS)
    store.set_reaction("b", b, "user", "question", ts=TS)
    assert [(r.target, r.reaction) for r in store.reactions("a")] == [(a, "heart")]
    assert [(r.target, r.reaction) for r in store.reactions("b")] == [(b, "question")]


def test_an_existing_database_gains_the_table_and_keeps_its_rows(tmp_path):
    path = tmp_path / "threads.sqlite"
    raw = sqlite3.connect(path)
    raw.executescript(
        "CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,"
        " role TEXT NOT NULL, kind TEXT, payload TEXT NOT NULL DEFAULT 'null',"
        " attachments TEXT NOT NULL DEFAULT '[]', ts TEXT NOT NULL);"
        "INSERT INTO messages(thread_id, role, payload, ts)"
        " VALUES ('default', 'user', '\"old one\"', '2026-08-01T00:00:00+00:00');"
    )
    raw.commit()
    raw.close()
    store = ThreadStore(path)
    [(seq, _)] = store.messages(DEFAULT_THREAD_ID)
    assert store.set_reaction(DEFAULT_THREAD_ID, seq, "user", "like", ts=TS)
    store.close()
    again = ThreadStore(path)  # a second boot changes nothing
    assert [r.reaction for r in again.reactions(DEFAULT_THREAD_ID)] == ["like"]


def test_the_take_back_drops_the_replys_reactions_with_it(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    reply = store.add_message(_event("d", "agent", "caught", kind="done"))
    store.set_reaction("d", reply, "user", "heart", ts=TS)
    assert store.delete_agent_messages("d", [reply]) == [reply]
    assert store.reactions("d") == []


def test_his_recent_messages_are_the_reactable_targets(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    seqs = [store.add_message(_event("d", "user", f"message {i}", ts=_at(i))) for i in range(12)]
    store.add_message(_event("d", "agent", "a reply", kind="done", ts=_at(13)))
    photo = store.add_message(_event("d", "user", "", attachments=["a.jpg"], ts=_at(14)))
    two = store.add_message(_event("d", "user", "", attachments=["b.jpg", "c.jpg"], ts=_at(15)))
    store.add_message(_event("elsewhere", "user", "not this chat", ts=_at(16)))
    targets = store.reactable_messages("d", n=10)
    assert [t.seq for t in targets] == [*seqs[4:], photo, two]  # oldest first, newest last
    assert targets[0].text == "message 4"
    assert (targets[-2].text, targets[-1].text) == ("a photo", "2 photos")


# --- the route --------------------------------------------------------------------


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
    state = AppState(
        config=pinboard_config(tmp_path),
        store=ThreadStore(tmp_path / "threads.sqlite"),
        queue=object(),
        coordinator=_FakeCoordinator(),
        inbox=DiskInbox(tmp_path / "inbox"),
    )
    with TestClient(create_app(injected=state)) as c:
        yield c


def _react(client, seq, reaction, thread=DEFAULT_THREAD_ID, headers=AUTH):
    return client.post(
        "/api/react", headers=headers,
        json={"thread_id": thread, "seq": seq, "reaction": reaction},
    )


def test_the_react_route_takes_the_token(client):
    assert _react(client, 1, "heart", headers={}).status_code == 401


def test_the_react_route_sets_replaces_and_clears(client):
    store = client.app.state.app_state.store
    reply = store.add_message(_event(DEFAULT_THREAD_ID, "agent", "Done", kind="done"))
    body = _react(client, reply, "👍").json()
    assert body["target"] == reply and body["role"] == "user" and body["reaction"] == "like"
    _react(client, reply, "😂")
    assert [r.reaction for r in store.reactions(DEFAULT_THREAD_ID)] == ["😂"]
    assert _react(client, reply, None).json()["reaction"] is None
    assert store.reactions(DEFAULT_THREAD_ID) == []


def test_the_react_route_refuses_what_it_cannot_store(client):
    store = client.app.state.app_state.store
    here = store.add_message(_event(DEFAULT_THREAD_ID, "user", "hi"))
    elsewhere = store.add_message(_event("0123456789abcdef", "user", "there"))
    assert _react(client, elsewhere, "heart").status_code == 404  # another chat's message
    assert _react(client, 424242, "heart").status_code == 404
    assert _react(client, here, "lol").status_code == 400  # words are not a reaction
    assert _react(client, here, "heart", thread="a:b").status_code == 422
    assert _react(client, 0, "heart").status_code == 422
    assert store.reactions(DEFAULT_THREAD_ID) == []


def test_a_reaction_never_starts_a_job(client):
    store = client.app.state.app_state.store
    reply = store.add_message(_event(DEFAULT_THREAD_ID, "agent", "Done", kind="done"))
    _react(client, reply, "heart")
    assert client.app.state.app_state.coordinator.calls == []
    # and it is not a message: nothing new in the chat's history
    rows = client.get(f"/api/thread/{DEFAULT_THREAD_ID}", headers=AUTH).json()["messages"]
    assert [m["seq"] for m in rows] == [reply]


def test_the_snapshot_follows_the_replay_on_every_socket(client):
    store = client.app.state.app_state.store
    other = client.post("/api/threads", headers=AUTH).json()["id"]
    mine = store.add_message(_event(DEFAULT_THREAD_ID, "user", "hi"))
    reply = store.add_message(_event(DEFAULT_THREAD_ID, "agent", "hello", kind="done"))
    theirs = store.add_message(_event(other, "user", "other chat"))
    _react(client, reply, "heart")
    _react(client, theirs, "question", thread=other)
    store.set_reaction(DEFAULT_THREAD_ID, mine, "agent", "like", ts=TS, target_roles=("user",))
    with client.websocket_connect(f"/ws?token=tok&thread={DEFAULT_THREAD_ID}&since=0") as sock:
        replayed = [sock.receive_json()["seq"] for _ in range(2)]
        assert replayed == [mine, reply]
        snap = sock.receive_json()
    assert snap["kind"] == "reactions" and snap["thread_id"] == DEFAULT_THREAD_ID
    assert "seq" not in snap  # keyless: a build from before reactions drops it
    got = {(r["target"], r["role"], r["reaction"]) for r in snap["reactions"]}
    assert got == {(reply, "user", "heart"), (mine, "agent", "like")}
    # a reconnect past every row still gets the whole chat's reactions
    with client.websocket_connect(f"/ws?token=tok&thread={other}&since={theirs}") as sock:
        snap = sock.receive_json()
    assert [(r["target"], r["reaction"]) for r in snap["reactions"]] == [(theirs, "question")]


def test_a_live_reaction_reaches_only_its_own_chats_sockets(client):
    state = client.app.state.app_state
    other = client.post("/api/threads", headers=AUTH).json()["id"]
    reply = state.store.add_message(_event(DEFAULT_THREAD_ID, "agent", "hello", kind="done"))
    here, there = _Socket(), _Socket()
    state.sockets.setdefault(DEFAULT_THREAD_ID, set()).add(here)
    state.sockets.setdefault(other, set()).add(there)
    _react(client, reply, "haha")
    _react(client, reply, None)
    first, second = here.sent
    assert first == {
        "kind": "reaction", "thread_id": DEFAULT_THREAD_ID, "target": reply,
        "role": "user", "reaction": "haha", "ts": first["ts"],
    }
    assert second["reaction"] is None
    assert there.sent == []


# --- the agent's reactions through the relay --------------------------------------


class _Socket:
    def __init__(self):
        self.sent = []

    async def send_json(self, data):
        self.sent.append(data)


def _relay_state(tmp_path, coordinator=None):
    return AppState(config=example_config(), store=ThreadStore(tmp_path / "t.sqlite"),
                    queue=object(), coordinator=coordinator or _FakeCoordinator(),
                    inbox=DiskInbox(tmp_path / "ib"))


def test_the_agents_reaction_is_stored_and_sent_live_not_as_a_row(tmp_path, monkeypatch):
    monkeypatch.delenv("VAPID_PRIVATE_KEY", raising=False)
    state = _relay_state(tmp_path)
    sock = _Socket()
    state.sockets.setdefault("d", set()).add(sock)
    mine = state.store.add_message(_event("d", "user", "thanks!"))
    _run(_relay_result(state, "d", ResultMessage(
        job_id="j1", kind="reaction", payload={"seq": mine, "reaction": "❤️"},
    )))
    [r] = state.store.reactions("d")
    assert (r.target, r.role, r.reaction) == (mine, "agent", "❤️")
    [frame] = sock.sent
    assert frame["kind"] == "reaction" and frame["role"] == "agent" and "seq" not in frame
    assert [seq for seq, _ in state.store.messages("d")] == [mine]  # no row was written
    assert not state.push_tasks  # and nothing was scheduled to notify


def test_the_relay_refuses_an_agent_reaction_it_cannot_place(tmp_path):
    state = _relay_state(tmp_path)
    sock = _Socket()
    state.sockets.setdefault("d", set()).add(sock)
    reply = state.store.add_message(_event("d", "agent", "a reply", kind="done"))
    elsewhere = state.store.add_message(_event("x", "user", "other chat"))
    for payload in (
        {"seq": reply, "reaction": "like"},  # its own message
        {"seq": elsewhere, "reaction": "like"},  # another chat
        {"seq": reply + 100, "reaction": "like"},  # nothing there
        {"seq": "one", "reaction": "like"},
        {"reaction": "like"},
        "like",
    ):
        _run(_relay_result(state, "d", ResultMessage(job_id="j", kind="reaction", payload=payload)))
    mine = state.store.add_message(_event("d", "user", "hi"))
    _run(_relay_result(state, "d", ResultMessage(
        job_id="j", kind="reaction", payload={"seq": mine, "reaction": "lol"},
    )))
    assert state.store.reactions("d") == [] and state.store.reactions("x") == []
    assert sock.sent == []


def test_a_superseded_jobs_reaction_is_dropped(tmp_path):
    class Superseded(_FakeCoordinator):
        def was_superseded(self, thread_id, job_id):
            return True

    state = _relay_state(tmp_path, Superseded())
    mine = state.store.add_message(_event("d", "user", "hi"))
    _run(_relay_result(state, "d", ResultMessage(
        job_id="old", kind="reaction", payload={"seq": mine, "reaction": "like"},
    )))
    assert state.store.reactions("d") == []


def test_the_agent_can_take_its_reaction_back(tmp_path):
    state = _relay_state(tmp_path)
    mine = state.store.add_message(_event("d", "user", "hi"))
    for value in ("like", None):
        _run(_relay_result(state, "d", ResultMessage(
            job_id="j", kind="reaction", payload={"seq": mine, "reaction": value},
        )))
    assert state.store.reactions("d") == []


# --- what the agent reads -----------------------------------------------------------


def test_the_job_context_carries_his_reactions_where_they_happened(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    ask = store.add_message(_event("d", "user", "put my desert photo up", ts=_at(0)))
    reply = store.add_message(_event("d", "agent", "Added it bottom left.", kind="done", ts=_at(1)))
    store.add_message(_event("d", "user", "", attachments=["p.jpg"], ts=_at(2)))
    photo_seq = store.messages("d")[-1][0]
    later = store.add_message(_event("d", "user", "also the lake one", ts=_at(4)))
    store.set_reaction("d", reply, "user", "heart", ts=_at(3))
    store.set_reaction("d", photo_seq, "user", "😂", ts=_at(5))
    store.set_reaction("d", ask, "agent", "like", ts=_at(0).replace(":00+", ":30+"),
                       target_roles=("user",))
    assert later
    assert job_context(store, "d") == [
        "user: put my desert photo up",
        'agent reacted with a thumbs up to user\'s message "put my desert photo up"',
        "agent: Added it bottom left.",
        'user reacted with a heart to agent\'s message "Added it bottom left."',
        "user: also the lake one",
        "user reacted with 😂 to user's photo",
    ]


def test_the_job_context_words_for_every_tapback_and_a_long_message(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    words = {
        "heart": "a heart", "like": "a thumbs up", "dislike": "a thumbs down",
        "haha": "ha ha", "emphasize": "!!", "question": "?",
    }
    long = "word " * 40
    for i, (name, said) in enumerate(words.items()):
        seq = store.add_message(_event("d", "agent", long, kind="done", ts=_at(i)))
        store.set_reaction("d", seq, "user", name, ts=_at(i).replace(":00+", ":30+"))
        lines = job_context(store, "d")
        assert lines[-1].startswith(f"user reacted with {said} to agent's message \"word word")
        quoted = lines[-1].split('"')[1]
        assert len(quoted) <= 60 and quoted.endswith("…")


def test_reactions_on_rows_outside_the_window_are_left_out(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    old = store.add_message(_event("d", "agent", "long ago", kind="done", ts=_at(0)))
    for i in range(40):
        store.add_message(_event("d", "user", f"m{i}", ts=_at(1)))
    store.set_reaction("d", old, "user", "heart", ts=_at(2))
    assert not any("reacted" in line for line in job_context(store, "d"))


class _RecordingQueue:
    def __init__(self):
        self.jobs = []

    async def enqueue(self, job):
        self.jobs.append(job)


def test_the_job_carries_the_reaction_lines_and_his_reactable_messages(tmp_path):
    queue = _RecordingQueue()
    state = AppState(config=example_config(), store=ThreadStore(tmp_path / "t.sqlite"),
                     queue=queue, coordinator=_FakeCoordinator(),
                     inbox=DiskInbox(tmp_path / "ib"))
    reply = state.store.add_message(_event("c", "agent", "Done.", kind="done", ts=_at(0)))
    mine = state.store.add_message(_event("c", "user", "love it", ts=_at(1)))
    state.store.set_reaction("c", reply, "user", "heart", ts=_at(2))
    _run(_enqueue_job(state, "c", "job-1", "love it", []))
    [job] = queue.jobs
    assert job.context == [
        "agent: Done.",
        "user: love it",
        'user reacted with a heart to agent\'s message "Done."',
    ]
    assert [(t.seq, t.text) for t in job.reactable] == [(mine, "love it")]


def test_an_older_job_message_without_targets_still_parses():
    from paratrooper.web.models import JobMessage

    job = JobMessage.model_validate({"job_id": "j", "thread_id": "t"})
    assert job.reactable == []
