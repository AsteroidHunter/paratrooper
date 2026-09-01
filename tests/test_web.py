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
from paratrooper.web.inbox import DiskInbox, RedisInbox, key_age_seconds, new_key
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


def test_midrun_send_cancels_run_and_reruns_once():
    """A send while a run is in flight supersedes it: the run is interrupted
    (same machinery as STOP), its batch folds back in front of the new message,
    and after the quiet window ONE fresh job covers everything."""
    async def scenario():
        enq, intr, enqueued, interrupted = _recorders()
        coord = ThreadCoordinator(enq, intr, window=0.02)
        await coord.handle_message("d", "first", ["k1"])
        await asyncio.sleep(0.05)  # fires -> running
        status = await coord.handle_message("d", "actually blue", ["k2"])
        assert status == "superseded"
        assert interrupted == [enqueued[0]["job"]]  # cancelled the running job
        assert coord.was_superseded("d", enqueued[0]["job"])
        await coord.job_finished("d")  # the cancelled run lands its terminal
        assert not coord.was_superseded("d", enqueued[0]["job"])  # bookkeeping done
        await asyncio.sleep(0.05)
        assert [e["text"] for e in enqueued] == ["first", "first\nactually blue"]
        assert enqueued[1]["atts"] == ["k1", "k2"]  # attachments fold back too
        assert enqueued[1]["job"] != enqueued[0]["job"]  # a genuinely fresh run

    _run(scenario())


def test_burst_folds_into_one_rerun():
    """Three texts in a burst -> one interrupt, one rerun, every message in it."""
    async def scenario():
        enq, intr, enqueued, interrupted = _recorders()
        coord = ThreadCoordinator(enq, intr, window=0.02)
        await coord.handle_message("d", "first", [])
        await asyncio.sleep(0.05)  # running
        await coord.handle_message("d", "two", [])  # supersedes the run
        await coord.handle_message("d", "three", [])  # cancel already sent: buffers
        assert interrupted == [enqueued[0]["job"]]  # ONE interrupt, not one per text
        await coord.job_finished("d")
        await coord.handle_message("d", "four", [])  # lands inside the window
        await asyncio.sleep(0.05)
        assert len(enqueued) == 2  # exactly one rerun for the whole burst
        assert enqueued[1]["text"] == "first\ntwo\nthree\nfour"

    _run(scenario())


def test_rerun_window_resets_on_each_send():
    async def scenario():
        enq, intr, enqueued, _ = _recorders()
        coord = ThreadCoordinator(enq, intr, window=0.06)
        await coord.handle_message("d", "first", [])
        await asyncio.sleep(0.1)  # fires -> running
        await coord.handle_message("d", "two", [])  # supersede; window armed
        await coord.job_finished("d")  # cancel confirmed quickly
        await asyncio.sleep(0.04)
        await coord.handle_message("d", "three", [])  # resets the window
        await asyncio.sleep(0.04)  # past the FIRST window's expiry, not the reset one
        assert len(enqueued) == 1  # not fired: the window counts from the last send
        await asyncio.sleep(0.05)  # now past quiet since "three"
        assert len(enqueued) == 2
        assert enqueued[1]["text"] == "first\ntwo\nthree"

    _run(scenario())


def test_stop_mid_window_cancels_without_rerun():
    """STOP arriving while a rerun waits out its quiet window kills the rerun —
    whether the superseded run is still dying or already reported terminal."""
    async def scenario():
        enq, intr, enqueued, _ = _recorders()
        coord = ThreadCoordinator(enq, intr, window=0.02)
        # STOP while the superseded run is still dying
        await coord.handle_message("d", "first", [])
        await asyncio.sleep(0.05)  # running
        await coord.handle_message("d", "wait", [])  # supersede; window armed
        status = await coord.handle_message("d", "STOP", [])
        assert status == "interrupted"
        await coord.job_finished("d")  # the cancelled run lands its terminal
        await asyncio.sleep(0.06)
        assert len(enqueued) == 1  # no rerun ever fires
        assert not coord.has_pending()
        # STOP after the terminal already landed (pure window pending)
        await coord.handle_message("e", "first", [])
        await asyncio.sleep(0.05)
        await coord.handle_message("e", "wait", [])
        await coord.job_finished("e")
        status = await coord.handle_message("e", "CANCEL", [])
        assert status == "discarded"
        await asyncio.sleep(0.06)
        assert [x["thread"] for x in enqueued] == ["d", "e"]  # no rerun on either

    _run(scenario())


def test_default_window_is_seven_seconds():
    # Akash's number — and ONE number: the pre-run batch window and the rerun
    # quiet window are the same timer over the same buffer
    assert DEFAULT_WINDOW == 7.0


def _relay_state(tmp_path, coord):
    """AppState trimmed to what _relay_result touches (no render -> the
    suspend machinery short-circuits before ever reaching the queue)."""
    return AppState(config=None, store=ThreadStore(tmp_path / "t.sqlite"),
                    queue=object(), coordinator=coord, inbox=DiskInbox(tmp_path / "ib"))


def test_relay_discards_everything_from_a_superseded_run(tmp_path, monkeypatch):
    """The history invariant behind send-while-running: the run is cancelled
    BEFORE anything is saved, so no event it still emits — interim or terminal
    — may reach the store; the terminal only does its bookkeeping, releasing
    the rerun, whose own results then persist exactly as always."""
    from paratrooper.web.app import _relay_result
    from paratrooper.web.models import ResultMessage

    monkeypatch.delenv("VAPID_PUBLIC_KEY", raising=False)

    async def scenario():
        enq, intr, enqueued, interrupted = _recorders()
        coord = ThreadCoordinator(enq, intr, window=0.02)
        state = _relay_state(tmp_path, coord)
        await coord.handle_message("d", "first", [])
        await asyncio.sleep(0.05)  # fires -> running
        job1 = enqueued[0]["job"]
        await coord.handle_message("d", "wait, also this", [])  # supersedes job1
        assert interrupted == [job1]
        for r in [ResultMessage(job_id=job1, kind="update", payload="halfway"),
                  ResultMessage(job_id=job1, kind="error", payload="interrupted")]:
            await _relay_result(state, "d", r)
        assert state.store.messages("d") == []  # nothing of the dead run saved
        await asyncio.sleep(0.05)  # the terminal released the rerun's window
        assert [e["text"] for e in enqueued] == ["first", "first\nwait, also this"]
        done = ResultMessage(job_id=enqueued[1]["job"], kind="done", payload="fresh reply")
        await _relay_result(state, "d", done)
        [(_seq, ev)] = state.store.messages("d")
        assert ev.kind == "done" and ev.payload == "fresh reply"  # today-path intact

    _run(scenario())


def test_relay_discards_a_done_that_lost_the_race(tmp_path, monkeypatch):
    """cancel-before-finish, the razor's edge: the run finished and its 'done'
    was already in flight when the new text superseded it. The cancel decision
    preceded persistence, so that reply must still be discarded — the burst
    ends with the ONE rerun reply, never two."""
    from paratrooper.web.app import _relay_result
    from paratrooper.web.models import ResultMessage

    monkeypatch.delenv("VAPID_PUBLIC_KEY", raising=False)

    async def scenario():
        enq, intr, enqueued, _ = _recorders()
        coord = ThreadCoordinator(enq, intr, window=0.02)
        state = _relay_state(tmp_path, coord)
        await coord.handle_message("d", "first", [])
        await asyncio.sleep(0.05)  # running
        await coord.handle_message("d", "one more thing", [])  # supersede
        stale = ResultMessage(job_id=enqueued[0]["job"], kind="done", payload="stale reply")
        await _relay_result(state, "d", stale)  # the racing terminal
        assert state.store.messages("d") == []  # never saved
        await asyncio.sleep(0.05)
        assert len(enqueued) == 2  # its terminal still released the rerun

    _run(scenario())


def test_concurrent_terminal_pushes_keep_each_thread_and_job_payload_isolated(
    tmp_path, monkeypatch
):
    """Overlapping relay tasks must build each push from their own result,
    never from a process-global or store-level "latest reply" lookup."""
    from paratrooper.web import push
    from paratrooper.web.app import _relay_result
    from paratrooper.web.models import ResultMessage

    class Coordinator:
        def __init__(self):
            self.finished = []

        def was_superseded(self, _thread_id, _job_id):
            return False

        async def job_finished(self, thread_id):
            self.finished.append(thread_id)

    monkeypatch.setenv("VAPID_PRIVATE_KEY", "private")
    monkeypatch.setenv("VAPID_PUBLIC_KEY", "public")
    monkeypatch.setenv("VAPID_SUBJECT", "mailto:push@example.test")
    monkeypatch.setattr(push, "_public_key_for_private", lambda _private: "public")
    sent = []

    def record_send(_subscription, payload, _cfg):
        sent.append(payload)
        return True

    monkeypatch.setattr(push, "send_push", record_send)

    async def scenario():
        coord = Coordinator()
        state = _relay_state(tmp_path, coord)
        state.store.add_subscription("https://push.example/device", '{"endpoint":"x"}')
        alpha = "alpha reply " + "a" * 230
        beta = "beta failure for this job"
        await asyncio.gather(
            _relay_result(
                state, "thread-alpha",
                ResultMessage(job_id="job-alpha", kind="done", payload=alpha),
            ),
            _relay_result(
                state, "thread-beta",
                ResultMessage(job_id="job-beta", kind="error", payload=beta),
            ),
        )

        assert sorted(sent) == sorted([
            push.notification_text("done", alpha),
            push.notification_text("error", beta),
        ])
        [(_, alpha_event)] = state.store.messages("thread-alpha")
        [(_, beta_event)] = state.store.messages("thread-beta")
        assert alpha_event.payload == alpha and alpha_event.kind == "done"
        assert beta_event.payload == beta and beta_event.kind == "error"
        assert sorted(coord.finished) == ["thread-alpha", "thread-beta"]

    _run(scenario())


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


def _aged_key(seconds_old: int, filename: str = "photo.jpeg") -> str:
    """An inbox key that looks minted ``seconds_old`` ago. Built by rewinding a
    real key's own stamp, so it can't drift from whatever new_key mints."""
    stamp, _, rest = new_key(filename).partition("-")
    return f"{int(stamp) - seconds_old}-{rest}"


def test_key_carries_its_upload_time():
    """The key is the only thing a reader still holds once the blob is gone, so
    the age has to travel in it."""
    assert key_age_seconds(new_key("photo.jpeg")) < 5
    assert key_age_seconds(_aged_key(30 * 3600)) > 24 * 3600
    # keys minted before the stamp existed, and anything hand-made: unknown age,
    # never a guess in either direction
    assert key_age_seconds("deadbeef" * 4 + ".jpeg") is None
    assert key_age_seconds("not-a-stamp.jpeg") is None


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

    monkeypatch.setattr(push, "_public_key_for_private", lambda _private: "pub")
    monkeypatch.delenv("VAPID_PRIVATE_KEY", raising=False)
    monkeypatch.delenv("VAPID_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("VAPID_SUBJECT", raising=False)
    assert push.config() is None  # feature is a no-op without VAPID
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "priv")
    monkeypatch.setenv("VAPID_PUBLIC_KEY", "pub")
    monkeypatch.setenv("VAPID_SUBJECT", "mailto:a@b.c")
    cfg = push.config()
    assert cfg and cfg.subject == "mailto:a@b.c" and cfg.public_key == "pub"
    assert push.notification_text("pr") and push.notification_text("log") is None
    # screenshots buzz too (user decision 20260708, overturning the plan-era
    # behavior-preservation): a board preview is worth a notification on its own
    assert push.notification_text("screenshot")


def test_push_config_rejects_invalid_or_mismatched_vapid_pair(monkeypatch, caplog):
    from paratrooper.web import push

    monkeypatch.setenv("VAPID_PRIVATE_KEY", "priv")
    monkeypatch.setenv("VAPID_PUBLIC_KEY", "wrong-public")
    monkeypatch.setenv("VAPID_SUBJECT", "mailto:a@b.c")
    monkeypatch.setattr(push, "_public_key_for_private", lambda _private: "actual-public")
    assert push.config() is None
    assert "do not match" in caplog.text


def test_vapid_public_key_is_derived_from_web_push_raw_private_format():
    from base64 import urlsafe_b64encode

    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    from paratrooper.web import push

    private_value = 1
    private_key = urlsafe_b64encode(private_value.to_bytes(32, "big")).rstrip(b"=").decode()
    public_point = ec.derive_private_key(private_value, ec.SECP256R1()).public_key().public_bytes(
        Encoding.X962, PublicFormat.UncompressedPoint
    )
    expected = urlsafe_b64encode(public_point).rstrip(b"=").decode()
    assert push._public_key_for_private(private_key) == expected


def test_push_send_uses_a_delivery_window_and_immediate_urgency(monkeypatch):
    from paratrooper.web import push

    sent = {}

    class Accepted:
        status_code = 201

    def accept(**kwargs):
        sent.update(kwargs)
        return Accepted()

    monkeypatch.setattr("pywebpush.webpush", accept)
    cfg = push.VapidConfig(private_key="private", public_key="public", subject="mailto:a@b.c")
    subscription = {"endpoint": "https://push.example/device", "keys": {}}
    assert push.send_push(subscription, "reply text", cfg)
    assert sent["ttl"] == push.PUSH_TTL_SECONDS
    assert sent["headers"] == {"Urgency": "high"}
    assert sent["timeout"] == 10
    assert sent["subscription_info"] is subscription


def test_terminal_push_uses_user_facing_message_excerpt():
    from paratrooper.web import push

    assert push.notification_text("done", "  fading\n because\tthis worked  ") == (
        "fading because this worked"
    )
    assert push.notification_text("error", "  The update could not be completed.  ") == (
        "The update could not be completed."
    )


def test_notification_excerpt_boundary_and_ellipsis_spacing():
    from paratrooper.web import push

    exact = "x" * push.NOTIFICATION_EXCERPT_CHARS
    assert push.notification_text("done", exact) == exact  # no ellipsis at the boundary
    assert push.notification_text("done", exact + "tail") == exact + " ..."

    # The cut lands on normalized whitespace: rstrip + one explicit normal
    # blank must produce exactly one space before the three dots.
    spaced = "x" * (push.NOTIFICATION_EXCERPT_CHARS - 1) + "    tail"
    excerpt = push.notification_text("done", spaced)
    assert excerpt == "x" * (push.NOTIFICATION_EXCERPT_CHARS - 1) + " ..."
    assert excerpt.endswith(" ...") and not excerpt.endswith("  ...")


def test_notification_text_fallbacks_and_special_kinds_are_preserved():
    from paratrooper.web import push

    assert push.notification_text("done", None) == "Paratrooper finished your update."
    assert push.notification_text("done", " \n\t ") == "Paratrooper finished your update."
    assert push.notification_text("error", {"detail": "not user-facing text"}) == (
        "Paratrooper hit a problem with your update."
    )
    assert push.notification_text("screenshot", "ignored") == (
        "Paratrooper sent a board preview 📸"
    )
    assert push.notification_text("pr", "ignored") == (
        "Your pin is ready — tap to review and publish 🪂"
    )
    assert push.notification_text("log", "ignored") is None


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

    def has_pending(self):
        return False  # holds no batches; linger tests inject state.render to reach this


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


def test_make_thumbnail_downscales_reports_dims_and_rejects_non_images():
    from PIL import Image

    from paratrooper.web.thumbs import THUMB_EDGE, make_thumbnail

    result = make_thumbnail(_png_bytes())
    assert result is not None
    data, w, h = result
    from io import BytesIO

    im = Image.open(BytesIO(data))
    assert im.format == "WEBP" and max(im.size) <= THUMB_EDGE
    assert (w, h) == im.size  # the reported dims ARE the stored preview's dims
    assert make_thumbnail(b"not an image") is None


# --- blurhash (the Signal-style placeholder) ----------------------------------

def _rgb_solid(w, h, colour) -> bytes:
    return bytes(v for _ in range(w * h) for v in colour)


def _rgb_ramp(w, h) -> bytes:
    return bytes(
        v for y in range(h) for x in range(w)
        for v in ((x * 7) % 256, (y * 13) % 256, ((x + y) * 3) % 256)
    )


def test_blurhash_matches_the_reference_implementation():
    """Golden vectors, and the only thing that makes this encoder worth
    vendoring: every expected string below came out of woltapp/blurhash's own
    C reference (C/encode.c + C/common.h, compiled and fed the identical
    pixel buffer), not out of this implementation. A hash that decodes to the
    wrong thing on a phone is worse than no hash, so "it returned a string" is
    not the bar."""
    from paratrooper.web.blurhash import encode

    assert encode(_rgb_solid(5, 4, (18, 52, 200)), 5, 4) == "Ll27GZkIfQkIkJfnfQfnfQfQfQfQ"
    assert encode(_rgb_ramp(21, 13), 21, 13) == "LK9k7l7DsVbtqMWEjue;f~fkfQfj"
    assert encode(_rgb_ramp(21, 13), 21, 13, 1, 1) == "009k7l"  # DC only, no AC terms
    assert encode(_rgb_ramp(6, 9), 6, 9, 3, 2) == "B72QoVTXWol^a3a|"


def test_blurhash_shape_and_bad_input():
    """4x3 components is what rides to the client: 28 characters, and the
    first one encodes the component counts so a decoder can read them back."""
    from paratrooper.web.blurhash import encode

    h = encode(_rgb_ramp(20, 20), 20, 20)
    # size flag + AC scale + 4-char DC + two chars per AC term
    assert len(h) == 1 + 1 + 4 + 2 * (4 * 3 - 1) == 28
    size_flag = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".index(h[0])
    assert (size_flag % 9 + 1, size_flag // 9 + 1) == (4, 3)

    with pytest.raises(ValueError):
        encode(_rgb_ramp(4, 4), 4, 4, 0, 3)  # components are 1..9
    with pytest.raises(ValueError):
        encode(_rgb_ramp(4, 4), 8, 8)  # buffer smaller than the claimed size


def test_image_blurhash_reads_encoded_bytes_and_survives_junk():
    """The store hands this webp bytes, not pixels. Anything that will not
    decode comes back None rather than raising: a broken preview must not be
    able to take a photo out of the chat."""
    from paratrooper.web.thumbs import image_blurhash, make_thumbnail

    thumb, _, _ = make_thumbnail(_png_bytes(size=(400, 300)))
    got = image_blurhash(thumb)
    assert got is not None and len(got) == 28
    assert image_blurhash(b"not an image") is None
    assert image_blurhash(b"") is None


def test_thumbnail_store_roundtrip(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    store.add_thumbnail("inbox/abc.png", b"webpbytes", ts="2026-07-07T00:00:00+00:00")
    data, ctype = store.thumbnail("inbox/abc.png")
    assert data == b"webpbytes" and ctype == "image/webp"
    assert store.thumbnail("inbox/missing.png") is None


def test_thumb_dims_roundtrip_and_legacy_null(tmp_path):
    store = ThreadStore(tmp_path / "t.sqlite")
    store.add_thumbnail("a.png", b"x", ts="t", width=320, height=240)
    store.add_thumbnail("legacy.png", b"y", ts="t")  # pre-dims row: no sizes
    dims = store.thumb_dims(["a.png", "legacy.png", "missing.png"])
    assert dims == {"a.png": (320, 240)}
    assert store.thumb_dims([]) == {}


# --- heal on read: a photo is never allowed to have no size -------------------

def _meta_row(store, key):
    row = store._conn.execute(
        "SELECT width, height, blurhash FROM attachments WHERE key=?", (key,)
    ).fetchone()
    return (row["width"], row["height"], row["blurhash"])


def test_thumb_meta_heals_missing_size_and_blurhash_and_persists(tmp_path):
    """The squish bug's root: a preview stored before the size columns existed
    ships no dims, the client falls back to a fixed 4:3 box, and a portrait
    photo opens out of a landscape crop. A one-time boot repair was supposed to
    fix those and nobody could tell whether it had, so the answer is not to
    depend on a repair at all: the first read of a row measures it, answers
    with the truth, and writes it back."""
    from paratrooper.web.thumbs import make_thumbnail

    store = ThreadStore(tmp_path / "heal.sqlite")
    thumb, w, h = make_thumbnail(_png_bytes(size=(800, 500)))
    store.add_thumbnail("legacy.webp", thumb, ts="t")  # no dims, no blurhash

    assert _meta_row(store, "legacy.webp") == (None, None, None)  # before
    assert store.thumb_dims(["legacy.webp"]) == {}  # nothing on file to answer with

    meta = store.thumb_meta(["legacy.webp"])["legacy.webp"]
    assert (meta.width, meta.height) == (w, h)  # the real shape, measured now
    assert meta.blurhash is not None and len(meta.blurhash) == 28

    # and it stuck: the row itself now carries both, so the next read is a
    # plain SELECT
    assert _meta_row(store, "legacy.webp") == (w, h, meta.blurhash)


def test_thumb_meta_second_read_does_no_measuring(tmp_path, monkeypatch):
    """Healed once, healed forever. Proven by making measuring impossible on
    the way back in: if the second read still answers, it read the columns."""
    from paratrooper.web import db as db_mod
    from paratrooper.web.thumbs import make_thumbnail

    store = ThreadStore(tmp_path / "once.sqlite")
    thumb, w, h = make_thumbnail(_png_bytes(size=(640, 480)))
    store.add_thumbnail("k.webp", thumb, ts="t")
    first = store.thumb_meta(["k.webp"])["k.webp"]

    def _boom(_data):
        raise AssertionError("second read must not measure anything")

    monkeypatch.setattr(db_mod, "image_dims", _boom)
    monkeypatch.setattr(db_mod, "image_blurhash", _boom)
    assert store.thumb_meta(["k.webp"])["k.webp"] == first
    assert (first.width, first.height) == (w, h)


def test_thumb_meta_heals_a_portrait_photo_as_portrait(tmp_path):
    """The actual complaint: portrait photos drawn into a landscape frame.
    A tall preview with no recorded size must come back tall."""
    from paratrooper.web.thumbs import make_thumbnail

    store = ThreadStore(tmp_path / "tall.sqlite")
    portrait, pw, ph = make_thumbnail(_png_bytes(size=(480, 640)))
    landscape, lw, lh = make_thumbnail(_png_bytes(size=(800, 500)))
    store.add_thumbnail("tall.webp", portrait, ts="t")
    store.add_thumbnail("wide.webp", landscape, ts="t")

    meta = store.thumb_meta(["tall.webp", "wide.webp"])
    assert (meta["tall.webp"].width, meta["tall.webp"].height) == (pw, ph)
    assert meta["tall.webp"].height > meta["tall.webp"].width  # portrait stays portrait
    assert (meta["wide.webp"].width, meta["wide.webp"].height) == (lw, lh)
    assert meta["wide.webp"].width > meta["wide.webp"].height


def test_thumb_meta_survives_an_undecodable_preview(tmp_path, caplog):
    """One unreadable blob must never fail the read that touched it, or take
    its neighbours down with it: it is simply absent from the answer (the
    client's fixed-ratio fallback exists for exactly that row) and it says so
    in the log instead of raising."""
    import logging

    from paratrooper.web.thumbs import make_thumbnail

    store = ThreadStore(tmp_path / "junk.sqlite")
    good, w, h = make_thumbnail(_png_bytes(size=(300, 200)))
    store.add_thumbnail("junk.webp", b"not an image at all", ts="t")
    store.add_thumbnail("good.webp", good, ts="t")

    with caplog.at_level(logging.INFO, logger="paratrooper.web.db"):
        meta = store.thumb_meta(["junk.webp", "good.webp", "never-stored.webp"])
    assert "junk.webp" not in meta and "never-stored.webp" not in meta
    assert (meta["good.webp"].width, meta["good.webp"].height) == (w, h)
    assert _meta_row(store, "junk.webp") == (None, None, None)  # keeps its NULLs
    assert any("junk.webp" in r.message for r in caplog.records)  # and says why

    # a row with sizes on file but bytes that will not encode still answers
    # with those sizes, just without a blurhash
    store.add_thumbnail("halfjunk.webp", b"still not an image", ts="t", width=12, height=34)
    half = store.thumb_meta(["halfjunk.webp"])["halfjunk.webp"]
    assert (half.width, half.height, half.blurhash) == (12, 34, None)


def test_thumb_meta_read_survives_a_failing_write(tmp_path, monkeypatch):
    """The write-back is an optimisation, not a precondition. If the UPDATE
    itself blows up, the reader still gets the measured truth for this photo
    and the next read simply measures again."""
    import sqlite3

    from paratrooper.web.thumbs import make_thumbnail

    store = ThreadStore(tmp_path / "nowrite.sqlite")
    thumb, w, h = make_thumbnail(_png_bytes(size=(640, 480)))
    store.add_thumbnail("k.webp", thumb, ts="t")

    class _NoUpdates:
        def __init__(self, conn):
            self._conn = conn

        def execute(self, sql, *a, **kw):
            if sql.lstrip().upper().startswith("UPDATE"):
                raise sqlite3.OperationalError("disk I/O error")
            return self._conn.execute(sql, *a, **kw)

        def commit(self):
            return self._conn.commit()

    monkeypatch.setattr(store, "_conn", _NoUpdates(store._conn))
    meta = store.thumb_meta(["k.webp"])["k.webp"]
    assert (meta.width, meta.height) == (w, h)
    assert meta.blurhash is not None


def test_history_frames_carry_attachment_dims(client):
    auth = {"Authorization": "Bearer tok"}
    up = client.post(
        "/api/upload", headers=auth, files={"file": ("p.png", _png_bytes(), "image/png")}
    )
    key = up.json()["inbox_key"]
    client.post(
        "/api/send", headers=auth,
        json={"thread_id": "dimt", "text": "pic", "attachments": [key]},
    )
    client.post(
        "/api/send", headers=auth,
        json={"thread_id": "dimt", "text": "words only", "attachments": []},
    )
    rows = client.get("/api/thread/dimt", headers=auth).json()["messages"]
    msg = next(m for m in rows if m.get("attachments"))
    dims = msg["attachment_dims"]
    assert len(dims) == 1 and dims[0] is not None
    w, h = dims[0]
    assert w > 0 and h > 0  # the client reserves the image box from these
    # text-only events carry no dims field at all
    textual = next(m for m in rows if not m.get("attachments"))
    assert "attachment_dims" not in textual
    assert "attachment_blurhashes" not in textual


def test_history_frames_carry_attachment_blurhashes(client):
    """Every photo frame ships a blurhash next to its size, index-aligned with
    ``attachments`` exactly like the dims are. The client paints it into the
    reserved box instead of a grey rectangle while the preview loads."""
    auth = {"Authorization": "Bearer tok"}
    up = client.post(
        "/api/upload", headers=auth, files={"file": ("p.png", _png_bytes(), "image/png")}
    )
    key = up.json()["inbox_key"]
    client.post(
        "/api/send", headers=auth,
        json={"thread_id": "bht", "text": "pic", "attachments": [key]},
    )
    rows = client.get("/api/thread/bht", headers=auth).json()["messages"]
    msg = next(m for m in rows if m.get("attachments"))
    hashes = msg["attachment_blurhashes"]
    assert len(hashes) == len(msg["attachments"]) == 1
    assert isinstance(hashes[0], str) and len(hashes[0]) == 28


def test_legacy_photo_frame_heals_through_the_route(client):
    """End to end, through the route the phone actually calls: a row with no
    size and no blurhash on file comes back with both, and a portrait one comes
    back portrait rather than in the 4:3 box that squished it."""
    from paratrooper.web.thumbs import make_thumbnail

    auth = {"Authorization": "Bearer tok"}
    store = client.app.state.app_state.store
    portrait, pw, ph = make_thumbnail(_png_bytes(size=(480, 640)))
    store.add_thumbnail("old-tall.webp", portrait, ts="t")  # pre-columns row
    store.add_thumbnail("old-junk.webp", b"unreadable", ts="t")  # and a broken one
    store.add_message(ThreadEvent(
        thread_id="legacy", role="user", payload="two photos",
        attachments=["old-tall.webp", "old-junk.webp"], ts="2026-07-07T00:00:00+00:00",
    ))

    body = client.get("/api/thread/legacy", headers=auth)
    assert body.status_code == 200  # the broken row must not fail the read
    msg = body.json()["messages"][0]
    assert msg["attachment_dims"] == [[pw, ph], None]
    assert msg["attachment_dims"][0][1] > msg["attachment_dims"][0][0]  # portrait
    tall_hash, junk_hash = msg["attachment_blurhashes"]
    assert isinstance(tall_hash, str) and len(tall_hash) == 28
    assert junk_hash is None


def _history_frame(client, thread_id, seq, auth):
    """The one row history returns for a seq, the way the client pages it."""
    rows = client.get(
        f"/api/history/{thread_id}", headers=auth, params={"before": seq + 1, "limit": 1}
    ).json()["messages"]
    return next(m for m in rows if m["seq"] == seq)


def test_send_acks_with_the_history_frame(client):
    """THE contract the client leans on: the ACK is the finished frame, equal
    field for field to the one history hands back for that same seq. It lets
    the send path store the server's own row rather than invent one, so no
    second request is needed and the stored ts is the server clock. ``status``
    rides beside the frame and is the only key that is not part of it."""
    auth = {"Authorization": "Bearer tok"}
    up = client.post(
        "/api/upload", headers=auth, files={"file": ("p.png", _png_bytes(), "image/png")}
    )
    key = up.json()["inbox_key"]

    photo = client.post(
        "/api/send", headers=auth,
        json={"thread_id": "ackt", "text": "pic", "attachments": [key]},
    ).json()
    text = client.post(
        "/api/send", headers=auth, json={"thread_id": "ackt", "text": "words only"},
    ).json()

    for ack in (photo, text):
        assert ack["status"] == "buffered"  # the transport field stays put
        frame = {k: v for k, v in ack.items() if k != "status"}
        assert frame == _history_frame(client, "ackt", ack["seq"], auth)

    # and the photo ACK really carries the fields the client used to fetch back
    assert photo["attachment_dims"][0] is not None
    assert isinstance(photo["attachment_blurhashes"][0], str)
    # a text-only send stays lean: no attachment fields invented for it
    assert "attachment_dims" not in text and "attachment_blurhashes" not in text
    assert text["role"] == "user" and text["payload"] == "words only" and text["ts"]


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


def test_render_control_resume_already_awake_is_success(monkeypatch, caplog):
    # Render refuses to resume a running service with a 400; that means the
    # worker is already awake — the desired state — so it must read as success
    # and stay out of the error log, not cry wolf on every warm wake
    import httpx

    from paratrooper.web import render_control

    def _client_returning(status, body):
        class _FakeClient:
            def __init__(self, timeout=None):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            async def post(self, url, headers=None):
                return httpx.Response(
                    status, text=body, request=httpx.Request("POST", url)
                )

        return _FakeClient

    rc = render_control.RenderControl("rnd_key", "srv-abc123")

    monkeypatch.setattr(
        render_control.httpx, "AsyncClient",
        _client_returning(400, '{"message":"only services suspended by a user can be resumed"}'),
    )
    with caplog.at_level("ERROR"):
        assert _run(rc.resume_worker()) is True
    assert not caplog.records

    # any other 400 is still a real failure and still logged loudly
    monkeypatch.setattr(
        render_control.httpx, "AsyncClient",
        _client_returning(400, '{"message":"service not found"}'),
    )
    assert _run(rc.resume_worker()) is False


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


class _FakeRender:
    def __init__(self):
        self.suspended = 0

    async def suspend_worker(self):
        self.suspended += 1
        return True


class _FakeJobQueue:
    def __init__(self, pending=0):
        self.pending = pending

    async def pending_jobs(self):
        return self.pending


def _linger_state(render, coord, queue, **kw):
    """AppState trimmed to what the worker-sleep machinery touches."""
    return AppState(config=None, store=None, queue=queue, coordinator=coord,
                    inbox=None, render=render, **kw)


def test_maybe_suspend_only_when_drained():
    """A drain no longer suspends on the spot — it arms the linger countdown;
    non-drained states and render-off arm nothing (and never suspend)."""
    from paratrooper.web.app import _cancel_linger, _maybe_suspend_worker

    async def scenario():
        enq, intr, *_ = _recorders()
        coord = ThreadCoordinator(enq, intr, window=0.02)
        render = _FakeRender()
        # nothing pending anywhere -> arms the countdown, no immediate suspend
        state = _linger_state(render, coord, _FakeJobQueue(0), linger_s=60)
        await _maybe_suspend_worker(state)
        assert state.linger_task is not None and render.suspended == 0
        _cancel_linger(state)  # don't leak the 60s timer out of the test
        # a job still queued -> no countdown
        state = _linger_state(render, coord, _FakeJobQueue(1), linger_s=60)
        await _maybe_suspend_worker(state)
        assert state.linger_task is None
        # a buffered batch -> no countdown
        await coord.handle_message("d", "more", [])
        state = _linger_state(render, coord, _FakeJobQueue(0), linger_s=60)
        await _maybe_suspend_worker(state)
        assert state.linger_task is None
        # render off -> no-op, no timers
        state = _linger_state(None, coord, _FakeJobQueue(0), linger_s=60)
        await _maybe_suspend_worker(state)
        assert state.linger_task is None and render.suspended == 0

    _run(scenario())


def test_linger_arms_on_drain_and_suspends_when_still_drained(monkeypatch):
    """Drain -> countdown; countdown firing with everything still drained ->
    suspend. Re-arming replaces the previous countdown (never stacks), and the
    linger length comes from PARATROOPER_WORKER_LINGER_S."""
    from paratrooper.web.app import DEFAULT_LINGER_S, _linger_seconds, _maybe_suspend_worker

    assert DEFAULT_LINGER_S == 300.0  # 5 min between turns without a cold boot
    monkeypatch.setenv("PARATROOPER_WORKER_LINGER_S", "0.02")

    async def scenario():
        enq, intr, *_ = _recorders()
        coord = ThreadCoordinator(enq, intr, window=0.02)
        render = _FakeRender()
        state = _linger_state(render, coord, _FakeJobQueue(0))  # linger_s read from env
        assert state.linger_s == 0.02
        await _maybe_suspend_worker(state)
        assert state.linger_task is not None and render.suspended == 0
        await asyncio.sleep(0.06)
        assert render.suspended == 1  # fired still-drained -> napped
        # two drains back to back arm ONE countdown -> one more suspend, not two
        await _maybe_suspend_worker(state)
        await _maybe_suspend_worker(state)
        await asyncio.sleep(0.06)
        assert render.suspended == 2

    _run(scenario())
    monkeypatch.setenv("PARATROOPER_WORKER_LINGER_S", "soon")
    assert _linger_seconds() == DEFAULT_LINGER_S  # junk env value -> default, no crash


def test_activity_during_linger_cancels_suspend():
    """A message arriving mid-linger cancels the countdown (the send path:
    cancel, ingest, re-evaluate) — an active conversation never naps the
    worker, and nothing re-arms while its batch is pending."""
    from paratrooper.web.app import _cancel_linger, _maybe_suspend_worker

    async def scenario():
        enq, intr, *_ = _recorders()
        coord = ThreadCoordinator(enq, intr, window=0.02)
        render = _FakeRender()
        state = _linger_state(render, coord, _FakeJobQueue(0), linger_s=0.05)
        await _maybe_suspend_worker(state)  # drained -> countdown armed
        assert state.linger_task is not None
        _cancel_linger(state)  # what /api/send does on any new message
        await coord.handle_message("d", "one more thing", [])
        await _maybe_suspend_worker(state)  # buffered batch -> must NOT re-arm
        assert state.linger_task is None
        await asyncio.sleep(0.1)  # well past the linger window
        assert render.suspended == 0

    _run(scenario())


def test_linger_fire_recheck_blocks_suspend_when_work_arrived():
    """Even an uncancelled countdown must not nap the worker if work showed up
    during the linger: the fire-time re-check covers both a buffered batch and
    a job already sitting in the queue."""
    from paratrooper.web.app import _maybe_suspend_worker

    async def scenario():
        enq, intr, *_ = _recorders()
        render = _FakeRender()
        # a message buffers into a long batch window while the countdown runs
        coord = ThreadCoordinator(enq, intr, window=60)
        state = _linger_state(render, coord, _FakeJobQueue(0), linger_s=0.02)
        await _maybe_suspend_worker(state)
        await coord.handle_message("d", "surprise", [])  # nothing cancels the countdown
        await asyncio.sleep(0.06)
        assert render.suspended == 0  # re-check saw the buffer
        # a job lands in the queue while the countdown runs
        idle_coord = ThreadCoordinator(enq, intr, window=60)
        state = _linger_state(render, idle_coord, _FakeJobQueue(0), linger_s=0.02)
        await _maybe_suspend_worker(state)
        state.queue.pending = 1
        await asyncio.sleep(0.06)
        assert render.suspended == 0  # re-check saw the queued job

    _run(scenario())


def test_send_route_resets_linger(client):
    """The wiring: /api/send cancels a pending countdown and re-arms only when
    the message leaves everything drained (_FakeCoordinator holds nothing, so
    each send ends drained -> a fresh countdown replaces the old one)."""
    state = client.app.state.app_state
    render = _FakeRender()
    state.render, state.queue, state.linger_s = render, _FakeJobQueue(0), 9999.0
    auth = {"Authorization": "Bearer tok"}
    client.post("/api/send", headers=auth, json={"thread_id": "d", "text": "hi"})
    first = state.linger_task
    assert first is not None and not first.done()
    client.post("/api/send", headers=auth, json={"thread_id": "d", "text": "again"})
    assert state.linger_task is not first  # replaced, never stacked
    assert render.suspended == 0  # long linger: nothing fired during the test


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
                     attachments=[_aged_key(30 * 3600)])  # really is past the TTL

    _run(w._run_one(msg))  # must NOT raise

    kinds = [r.kind for r in published]
    assert kinds[0] == "working"
    assert "error" in kinds
    err = next(r for r in published if r.kind == "error")
    assert "older than 24 hours" in str(err.payload)


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


class _RecordingQueue:
    """Worker-side fake: the shared store plus a log of what reached the phone."""

    def __init__(self):
        self.r = _FakeRedis()
        self.published: list = []
        self.requeued: list = []

    async def publish_result(self, thread_id, result):
        self.published.append(result)

    async def requeue_front(self, job):
        self.requeued.append(job.job_id)


def _worker(tmp_path):
    from paratrooper.web.worker_runner import Worker

    w = Worker(_RecordingQueue())
    w._config = Config(  # skip load_config
        inbox=tmp_path / "inbox", site_root=tmp_path / "site",
        pins_dir=tmp_path / "pins", archive_dir=tmp_path / "arch",
        later_dir=tmp_path / "later", changelog=tmp_path / "cl.jsonl",
        remote=None, default_branch="main", branch_prefix="paratrooper",
    )
    return w


def _scratch_exists(tmp_path, key) -> bool:
    """Is the worker's own materialized copy on its local disk right now?"""
    return (tmp_path / "inbox" / key).exists()


def test_superseded_run_leaves_the_photo_there_for_the_rerun(tmp_path, monkeypatch):
    """The incident: he sent photos, then sent another message while the run was
    still going. That send supersedes the run (batching folds the running batch
    back in front of the buffer, so the rerun carries the SAME keys) and then
    cancels it. The dying run's teardown deleted the shared copy, and the rerun
    found nothing. A job only reads that copy, so a cancelled job must leave it
    exactly where it found it."""
    import paratrooper.web.worker_runner as wr
    from paratrooper.web.models import JobMessage

    w = _worker(tmp_path)
    key = new_key("photo.jpeg")
    _run(w.inbox.put(key, b"pixels"))
    seen, park = [], [True]

    async def fake_run_job(job, **kw):
        seen.append(list(job.attachments))
        if park[0]:
            await asyncio.sleep(30)  # pin it in flight so the cancel lands mid-run

    monkeypatch.setattr(wr, "run_job", fake_run_job)

    async def scenario():
        first = JobMessage(job_id="j1", thread_id="d", text="these two",
                           attachments=[key])
        task = asyncio.ensure_future(w._run_one(first))
        await asyncio.sleep(0.05)
        task.cancel()  # exactly what the interrupt listener does on a supersede
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not _scratch_exists(tmp_path, key)  # its own copy IS gone
        assert await w.inbox.get(key) == b"pixels"  # the shared one is untouched

        park[0] = False  # the rerun the coordinator fires next, same key
        rerun = JobMessage(job_id="j2", thread_id="d", text="these two\nand this",
                           attachments=[key])
        await w._run_one(rerun)

    _run(scenario())
    assert seen == [[key], [key]]  # the rerun really did get the photo
    # the cancel itself is the only error, and the web swallows that one for a
    # superseded run: nothing about a lost photo ever reaches him
    assert [str(r.payload) for r in w.queue.published if r.kind == "error"] == ["interrupted"]


def test_local_scratch_copy_is_cleaned_up_on_every_path(tmp_path, monkeypatch):
    """The copy a job materializes on its own disk is the one thing it does own,
    so it goes on the way out of every path: finished, failed, interrupted, and
    deploy shutdown. The shared copy goes on none of them, which is why the
    teardown needs no special cases any more."""
    import paratrooper.web.worker_runner as wr
    from paratrooper.web.models import JobMessage

    w = _worker(tmp_path)
    outcome = ["ok"]

    async def fake_run_job(job, **kw):
        # the scratch copy must be sitting there while the job is running
        assert _scratch_exists(tmp_path, job.attachments[0])
        if outcome[0] == "boom":
            raise RuntimeError("agent blew up")
        if outcome[0] == "hang":
            await asyncio.sleep(30)

    monkeypatch.setattr(wr, "run_job", fake_run_job)

    def one_run(name, *, cancel=False, shutting_down=False):
        key = new_key(f"{name}.jpeg")
        _run(w.inbox.put(key, b"pixels"))
        msg = JobMessage(job_id=name, thread_id="d", text=name, attachments=[key])

        async def scenario():
            w._shutting_down = shutting_down
            if not cancel:
                await w._run_one(msg)
                return
            task = asyncio.ensure_future(w._run_one(msg))
            await asyncio.sleep(0.05)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

        _run(scenario())
        w._shutting_down = False
        assert not _scratch_exists(tmp_path, key), f"{name}: scratch copy left behind"
        assert _run(w.inbox.get(key)) == b"pixels", f"{name}: shared copy deleted"

    one_run("finished")
    outcome[0] = "boom"
    one_run("failed")
    outcome[0] = "hang"
    one_run("interrupted", cancel=True)
    one_run("shutdown", cancel=True, shutting_down=True)


# words from inside the machine that must never reach a chat bubble
_INTERNAL_WORDS = ("staging", "stage", "inbox", "blob", "key", "ttl", "redis", "store")


def test_missing_photo_message_never_claims_a_cause_it_did_not_check():
    """The old line said photos "expired from staging" whatever had happened,
    and it once said that 93ms after he sent them. The TTL runs from the upload and
    the key carries the upload second, so running out of time is checkable.
    Claim it only when it checks out, and say it in words he'd use."""
    from paratrooper.web.worker_runner import _missing_photos_message

    day = 24 * 3600
    ran_out = _missing_photos_message([_aged_key(day + 3600)], day)
    assert ran_out == (
        "That photo is older than 24 hours, and I only keep photos for that long. "
        "Please send it again."
    )
    # sent minutes ago and already gone: something else happened, so say only
    # what is known. Never the word expired, never a duration.
    fresh = _missing_photos_message([_aged_key(120)], day)
    assert fresh == (
        "I couldn't find that photo when I went to open it. Please send it again."
    )
    assert "expire" not in fresh and "24 hours" not in fresh and "older" not in fresh
    # a key with no readable upload time is unknown, not old
    assert _missing_photos_message(["deadbeef" * 4 + ".jpeg"], day) == fresh
    # one of them recent is enough to drop the claim for all of them
    mixed = _missing_photos_message([_aged_key(day + 3600), _aged_key(60)], day)
    assert "24 hours" not in mixed and "them again" in mixed
    both_old = _missing_photos_message([_aged_key(day + 60), _aged_key(day + 90)], day)
    assert both_old.startswith("Those photos are older than 24 hours")

    for message in (ran_out, fresh, mixed, both_old):
        low = message.lower()
        assert not any(w in low for w in _INTERNAL_WORDS), message


def test_missing_photo_reaches_the_phone_in_plain_words(tmp_path, monkeypatch):
    """End to end: a photo genuinely past its day, and one that just isn't
    there, both land as an error bubble that reads like a person wrote it."""
    import paratrooper.web.worker_runner as wr
    from paratrooper.web.models import JobMessage

    async def never(*a, **kw):
        raise AssertionError("the job must not run with photos it couldn't read")

    monkeypatch.setattr(wr, "run_job", never)
    w = _worker(tmp_path)

    _run(w._run_one(JobMessage(job_id="j1", thread_id="d", text="look",
                               attachments=[_aged_key(30 * 3600)])))
    _run(w._run_one(JobMessage(job_id="j2", thread_id="d", text="look",
                               attachments=[new_key("photo.jpeg")])))

    old_err, new_err = (str(r.payload) for r in w.queue.published if r.kind == "error")
    assert "older than 24 hours" in old_err
    assert "older" not in new_err and "expire" not in new_err
    for message in (old_err, new_err):
        assert not any(word in message.lower() for word in _INTERNAL_WORDS), message


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


def _dims_row(store, key):
    row = store._conn.execute(
        "SELECT width, height FROM attachments WHERE key=?", (key,)
    ).fetchone()
    return (row["width"], row["height"])


def test_migration_fills_thumb_dims_from_stored_bytes(tmp_path):
    """A preview stored before the dims columns existed must come out of the
    next boot carrying its real pixel size, measured from its own bytes. Until
    it does, thumb_dims skips the row, the client reserves a fixed 4:3 box, and
    a portrait photo opens out of a landscape crop looking squished."""
    from paratrooper.web.thumbs import make_thumbnail

    path = tmp_path / "legacy-dims.sqlite"
    portrait, _, _ = make_thumbnail(_png_bytes(size=(480, 640)))
    landscape, _, _ = make_thumbnail(_png_bytes(size=(800, 500)))

    store = ThreadStore(path)
    store.add_thumbnail("tall.webp", portrait, ts="t")  # pre-dims rows: no sizes
    store.add_thumbnail("wide.webp", landscape, ts="t")
    store.add_thumbnail("known.webp", landscape, ts="t", width=1, height=1)
    assert store.thumb_dims(["tall.webp", "wide.webp"]) == {}  # nothing to reserve from
    store.close()

    migrated = ThreadStore(path)  # boot runs the migration
    assert _dims_row(migrated, "tall.webp") == (480, 640)  # portrait stays portrait
    assert _dims_row(migrated, "wide.webp") == (800, 500)
    assert _dims_row(migrated, "known.webp") == (1, 1)  # a row with dims is never touched
    # and now the client gets a box for both, so the 4:3 fallback stops firing
    assert migrated.thumb_dims(["tall.webp", "wide.webp"]) == {
        "tall.webp": (480, 640), "wide.webp": (800, 500),
    }
    migrated.close()

    # idempotent: the second boot finds no NULL rows and changes nothing
    again = ThreadStore(path)
    assert _dims_row(again, "tall.webp") == (480, 640)
    assert _dims_row(again, "wide.webp") == (800, 500)


def test_migration_leaves_unmeasurable_thumb_null_and_still_boots(tmp_path):
    """One preview whose bytes won't decode must not take the service down or
    block its neighbours: it keeps its NULLs (the client's fixed-ratio fallback
    covers exactly that row) while every readable row still gets filled."""
    from paratrooper.web.thumbs import make_thumbnail

    path = tmp_path / "junk-dims.sqlite"
    good, _, _ = make_thumbnail(_png_bytes(size=(300, 200)))

    store = ThreadStore(path)
    store.add_thumbnail("junk.webp", b"not an image at all", ts="t")
    store.add_thumbnail("good.webp", good, ts="t")
    store.close()

    migrated = ThreadStore(path)  # must not raise
    assert _dims_row(migrated, "junk.webp") == (None, None)
    assert _dims_row(migrated, "good.webp") == (300, 200)
    assert migrated.thumb_dims(["junk.webp", "good.webp"]) == {"good.webp": (300, 200)}
    migrated.close()

    ThreadStore(path)  # the unreadable row is re-tried forever, still harmlessly


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


# --- token redaction (roadmap 5) ----------------------------------------------

def test_token_redaction_keeps_access_log_args_intact():
    """uvicorn's access formatter unpacks record.args positionally; the old
    filter nulled args after merging, crashing the formatter with a
    '--- Logging error ---' traceback on every token-bearing URL (all
    /api/thumb requests). Redact inside the tuple and keep its shape."""
    import logging as _logging

    from paratrooper.web.app import _RedactTokenFilter

    rec = _logging.LogRecord(
        "uvicorn.access", _logging.INFO, __file__, 0,
        '%s - "%s %s HTTP/%s" %d',
        ("1.2.3.4:5", "GET", "/api/thumb/k.webp?token=hunter2", "1.1", 200),
        None,
    )
    assert _RedactTokenFilter().filter(rec)
    assert len(rec.args) == 5  # the formatter unpacks exactly five
    assert "hunter2" not in rec.getMessage()
    assert "token=REDACTED" in rec.getMessage()


def test_token_redaction_scrubs_argless_records():
    """The WebSocket accept line arrives pre-merged (no args) on uvicorn.error
    — the original leak the filter was built for. Still scrubbed."""
    import logging as _logging

    from paratrooper.web.app import _RedactTokenFilter

    rec = _logging.LogRecord(
        "uvicorn.error", _logging.INFO, __file__, 0,
        '1.2.3.4:0 - "WebSocket /ws?token=hunter2" [accepted]', None, None,
    )
    assert _RedactTokenFilter().filter(rec)
    assert "hunter2" not in rec.getMessage()
    assert "token=REDACTED" in rec.getMessage()


_ACCESS_FMT = '%(levelprefix)s %(client_addr)s - "%(request_line)s" %(status_code)s'


def test_token_redaction_rebuilds_premerged_access_records():
    """The crash that outlived the first redaction fix (Render '--- Logging
    error ---' tracebacks on 404s for missing /api/thumb keys): an access
    record arriving pre-merged — msg is the whole line, args None, exactly
    what the traceback tail showed ('Message: ...token=REDACTED... 404' /
    'Arguments: None'). AccessFormatter unpacks record.args into five fields
    unconditionally, so scrubbing msg alone still dies with 'TypeError:
    cannot unpack non-iterable NoneType object'. The filter must hand the
    formatter the native five-tuple shape, token scrubbed."""
    import logging as _logging

    from uvicorn.logging import AccessFormatter

    from paratrooper.web.app import _RedactTokenFilter

    rec = _logging.LogRecord(
        "uvicorn.access", _logging.INFO, __file__, 0,
        '1.2.3.4:5 - "GET /api/thumb/0dfcd1df.jpeg?token=hunter2 HTTP/1.1" 404',
        None, None,
    )
    assert _RedactTokenFilter().filter(rec)
    line = AccessFormatter(_ACCESS_FMT, use_colors=False).format(rec)  # raised before
    assert "hunter2" not in line
    assert '1.2.3.4:5 - "GET /api/thumb/0dfcd1df.jpeg?token=REDACTED HTTP/1.1" 404' in line


def test_token_redaction_native_access_records_survive_real_formatter():
    """Native access records (five-tuple args, the shape uvicorn itself logs
    for every /api/thumb response, 404s included) must pass through the real
    AccessFormatter with only the token scrubbed — the pre-merged rebuild
    must not fire on them."""
    import logging as _logging

    from uvicorn.logging import AccessFormatter

    from paratrooper.web.app import _RedactTokenFilter

    rec = _logging.LogRecord(
        "uvicorn.access", _logging.INFO, __file__, 0,
        '%s - "%s %s HTTP/%s" %d',
        ("1.2.3.4:5", "GET", "/api/thumb/gone.webp?token=hunter2", "1.1", 404),
        None,
    )
    assert _RedactTokenFilter().filter(rec)
    assert len(rec.args) == 5
    line = AccessFormatter(_ACCESS_FMT, use_colors=False).format(rec)
    assert "hunter2" not in line
    assert '1.2.3.4:5 - "GET /api/thumb/gone.webp?token=REDACTED HTTP/1.1" 404 Not Found' in line


# --- the package's own logs actually reaching the deploy logs -----------------

def test_service_logging_unmutes_the_package_under_uvicorns_config():
    """Two days of this bug were spent blind: uvicorn configures its own
    uvicorn.* loggers and leaves the root logger at WARNING with no handlers,
    so every logger.info in this package was written and thrown away, the one
    line that would have said whether the legacy-preview repair had done
    anything included. Reproduce uvicorn's own logging setup and show the
    package go from muted to audible."""
    import logging as _logging
    import logging.config as _logging_config

    from uvicorn.config import LOGGING_CONFIG

    from paratrooper.web.app import install_service_logging

    pkg = _logging.getLogger("paratrooper")
    saved_handlers, saved_level = list(pkg.handlers), pkg.level
    try:
        pkg.handlers.clear()
        pkg.setLevel(_logging.NOTSET)
        _logging_config.dictConfig(LOGGING_CONFIG)  # what uvicorn does on boot
        assert not _logging.getLogger("paratrooper.web.db").isEnabledFor(_logging.INFO)

        install_service_logging()
        assert _logging.getLogger("paratrooper.web.db").isEnabledFor(_logging.INFO)
        assert _logging.getLogger("paratrooper.web.app").isEnabledFor(_logging.INFO)

        # idempotent: the factory runs once per boot, but tests build many apps
        install_service_logging()
        install_service_logging()
        assert len(pkg.handlers) == 1  # and holddiag is not printed twice
        assert not _logging.getLogger("paratrooper.holddiag").handlers
    finally:
        pkg.handlers[:] = saved_handlers
        pkg.setLevel(saved_level)


# --- live job-marker broadcast (roadmap 7) ------------------------------------

def test_enqueue_broadcasts_job_marker_to_connected_sockets(tmp_path):
    """Read-flip bug (2026-07-30): the job marker was persisted but never
    pushed to already-connected apps, so the Delivered→Read flip could not
    happen until a force-quit re-read the thread (reconnect replay starts past
    the missed seq, so it never healed). Enqueue must broadcast the stored row,
    seq included, exactly like every other persisted event."""
    from paratrooper.web.app import _enqueue_job

    store = ThreadStore(tmp_path / "t.sqlite")

    class _RecordingQueue:
        def __init__(self):
            self.jobs = []

        async def enqueue(self, job):
            self.jobs.append(job)

    class _WS:
        def __init__(self):
            self.sent = []

        async def send_json(self, data):
            self.sent.append(data)

    ws = _WS()
    state = AppState(config=None, store=store, queue=_RecordingQueue(),
                     coordinator=_FakeCoordinator(), inbox=DiskInbox(tmp_path / "ib"))
    state.sockets["d"] = {ws}
    _run(_enqueue_job(state, "d", "job-7", "hi", []))

    [frame] = ws.sent
    assert frame["kind"] == "job" and frame["role"] == "system"
    assert frame["payload"] == "job-7"
    [(stored_seq, stored)] = store.messages("d")
    assert frame["seq"] == stored_seq  # client store keys by seq; must match
