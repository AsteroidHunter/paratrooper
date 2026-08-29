"""TEMP DIAGNOSTIC tests (remove with the reply-hold probe): the token-gated
/api/debug/holddiag POST/GET pair round-trips the phone's hold trail, and the
"paratrooper.holddiag" logger names every batching and relay decision, which is
the deploy-log record the device session is reconstructed from."""

from __future__ import annotations

import asyncio
import logging

import pytest
from fastapi.testclient import TestClient

from paratrooper.agent.config import Config
from paratrooper.web import ThreadCoordinator, ThreadStore
from paratrooper.web.app import AppState, _relay_result, create_app
from paratrooper.web.inbox import DiskInbox
from paratrooper.web.models import ResultMessage

AUTH = {"Authorization": "Bearer tok"}


def _run(coro):
    return asyncio.run(coro)


def _recorders():
    enqueued: list = []
    interrupted: list = []

    async def enqueue(t, j, text, atts):
        enqueued.append({"thread": t, "job": j, "text": text, "atts": atts})

    async def interrupt(t, j):
        interrupted.append(j)

    return enqueue, interrupt, enqueued, interrupted


class _IdleCoordinator:
    async def handle_message(self, thread_id, text, attachments):
        return "buffered"

    async def job_finished(self, thread_id):
        pass

    def has_pending(self):
        return False


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
        coordinator=_IdleCoordinator(),
        inbox=DiskInbox(tmp_path / "inbox"),
    )
    app = create_app(injected=state)
    with TestClient(app) as c:
        yield c


def test_holddiag_roundtrip_with_token(client, caplog):
    """The phone posts its trail with the app's bearer token; a curl carrying the
    same token reads the latest back; the digest line lands in the logs with the
    release reasons."""
    trail = {
        "ts": "2026-08-18T00:00:00Z",
        "build": "2026-08-18T00:00Z",
        "events": [
            {"t": 1, "ev": "typed", "d": {"held": 0, "sinceKey": -1}},
            {"t": 2, "ev": "held", "d": {"seq": 9, "held": 1, "sinceKey": 120}},
            {"t": 3, "ev": "release", "d": {"reason": "quiet", "held": 1}},
        ],
    }
    with caplog.at_level(logging.INFO, logger="paratrooper.holddiag"):
        assert client.post("/api/debug/holddiag", headers=AUTH, json=trail).json() == {"ok": True}
    assert client.get("/api/debug/holddiag", headers=AUTH).json() == trail
    digest = [r.message for r in caplog.records if "holddiag client" in r.message]
    assert len(digest) == 1
    assert "events=3" in digest[0] and '"reason": "quiet"' in digest[0]

    # latest wins: a second post replaces the first entirely
    assert client.post(
        "/api/debug/holddiag", headers=AUTH, json={"events": []}
    ).json() == {"ok": True}
    assert client.get("/api/debug/holddiag", headers=AUTH).json() == {"events": []}


# The gate on this pair, pinned in both directions. These two routes shipped
# open for the length of a bug hunt because nothing here would have noticed if
# they were, and the cost of reopening them by accident is not a diagnostic's
# worth of trouble — it is the conversation's shape on one side and the deploy
# logs on the other. Remove these with the probe, not before it.


def test_holddiag_post_refuses_an_unauthenticated_write(client, caplog):
    """Open, the POST let a stranger replace the buffer, hold a body of their
    choosing in the service's memory, and write their own text into the logs a
    session is reconstructed from. Unsigned it now buys nothing at all: the
    stored trail stands and no digest line is written."""
    assert client.post(
        "/api/debug/holddiag", headers=AUTH, json={"build": "mine", "events": []}
    ).json() == {"ok": True}
    intruder = {"build": "theirs", "events": [{"t": 1, "ev": "held", "d": {"seq": 1}}]}
    caplog.clear()  # the legitimate post above wrote its own digest line
    with caplog.at_level(logging.INFO, logger="paratrooper.holddiag"):
        bare = client.post("/api/debug/holddiag", json=intruder)
        wrong = client.post(
            "/api/debug/holddiag", headers={"Authorization": "Bearer nope"}, json=intruder
        )
    assert bare.status_code == 401 and wrong.status_code == 401
    assert [r.message for r in caplog.records if "holddiag client" in r.message] == []
    assert client.get("/api/debug/holddiag", headers=AUTH).json()["build"] == "mine"


def test_holddiag_get_refuses_an_unauthenticated_read(client):
    """Open, the GET handed anyone who knew the address the shape of a private
    conversation: which seqs exist, what kind of event each was, and the phone's
    own geometry around them. Unsigned it now returns the refusal and none of
    the trail, while the tokened read is unchanged."""
    trail = {"build": "b", "events": [{"t": 1, "ev": "held", "d": {"seq": 41}}]}
    assert client.post("/api/debug/holddiag", headers=AUTH, json=trail).json() == {"ok": True}
    bare = client.get("/api/debug/holddiag")
    wrong = client.get("/api/debug/holddiag", headers={"Authorization": "Bearer nope"})
    assert bare.status_code == 401 and wrong.status_code == 401
    assert "41" not in bare.text and "41" not in wrong.text
    assert client.get("/api/debug/holddiag", headers=AUTH).json() == trail


def test_holddiag_digest_carries_cold_open_marks(client, caplog):
    """The cold-open trail (cache read/apply, the one batched commit, reconcile
    drops) survives into the digest line, so deploy logs alone tell how a boot
    landed; the per-frame ws-apply chatter stays out of it."""
    trail = {
        "build": "b",
        "events": [
            {"t": 1, "ev": "cache-read", "d": {"frames": 50, "ms": 12}},
            {"t": 2, "ev": "cache-applied", "d": {"lastSeq": 60, "ms": 30}},
            {"t": 3, "ev": "batch-commit", "d": {"n": 0}},
            {"t": 4, "ev": "reconcile-drop", "d": {"seqs": [58]}},
            {"t": 5, "ev": "ws-apply", "d": {"seq": 1}},
        ],
    }
    with caplog.at_level(logging.INFO, logger="paratrooper.holddiag"):
        assert client.post("/api/debug/holddiag", headers=AUTH, json=trail).json() == {"ok": True}
    digest = [r.message for r in caplog.records if "holddiag client" in r.message]
    assert len(digest) == 1
    for name in ("cache-read", "cache-applied", "batch-commit", "reconcile-drop"):
        assert name in digest[0]
    assert "ws-apply" not in digest[0]


def test_holddiag_viewport_digest_carries_send_motion(client, caplog):
    """The send-window motion recorder's records and the receipt-hold marks ride
    the viewport digest line, so deploy logs alone name which quantity moved in
    a send window (scroll, height, seat) and whether the hold parked/applied."""
    trail = {
        "build": "b",
        "events": [
            {"t": 1, "ev": "flight", "d": {"phase": "start", "i": 0}},
            {"t": 2, "ev": "receipt-hold", "d": {"phase": "park"}},
            {"t": 3, "ev": "send-motion", "d": {"at": 133, "moved": "seat", "delta": -18}},
            {"t": 4, "ev": "receipt-hold", "d": {"phase": "apply"}},
        ],
    }
    with caplog.at_level(logging.INFO, logger="paratrooper.holddiag"):
        assert client.post("/api/debug/holddiag", headers=AUTH, json=trail).json() == {"ok": True}
    vp = [r.message for r in caplog.records if "holddiag viewport" in r.message]
    assert len(vp) == 1
    assert '"send-motion"' in vp[0] and '"moved": "seat"' in vp[0]
    assert '"receipt-hold"' in vp[0] and '"apply"' in vp[0]


def test_holddiag_viewport_digest_carries_keyboard_regime_marks(client, caplog):
    """The vv-sized shell's marks ride the viewport digest line: shell-size for
    every shell resize the keyboard caused, kb-close for the close-time
    correction/heal verdict, vv-geom for the raw viewport moves — so deploy
    logs alone reconstruct a keyboard session on device."""
    trail = {
        "build": "b",
        "events": [
            {"t": 1, "ev": "vv-geom", "d": {"src": "resize", "h": 508, "top": 40,
                                            "ih": 844, "kb": True}},
            {"t": 2, "ev": "shell-size", "d": {"top": 40, "h": 508}},
            {"t": 3, "ev": "kb-close", "d": {"phase": "close", "x": 0, "y": 0,
                                             "top": 44, "snap": True, "heal": False,
                                             "ih": 844, "base": 844}},
        ],
    }
    with caplog.at_level(logging.INFO, logger="paratrooper.holddiag"):
        assert client.post("/api/debug/holddiag", headers=AUTH, json=trail).json() == {"ok": True}
    vp = [r.message for r in caplog.records if "holddiag viewport" in r.message]
    assert len(vp) == 1
    assert '"shell-size"' in vp[0]
    assert '"kb-close"' in vp[0] and '"snap": true' in vp[0]
    assert '"vv-geom"' in vp[0]


def test_holddiag_viewport_digest_carries_typing_shove_marks(client, caplog):
    """The typing card's marks ride the viewport digest line: grow-blink for
    every growth frame whose caret reveal was suppressed at the source, and
    kb-shove for the shove-vs-truth verdicts (a scroll-sourced offsetTop jump
    cleared same-frame, or yielded once to the close pass when it re-lands) —
    so deploy logs alone show whether a typing session still moved."""
    trail = {
        "build": "b",
        "events": [
            {"t": 1, "ev": "grow-blink", "d": {"oldH": 39, "newH": 61}},
            {"t": 2, "ev": "kb-shove", "d": {"act": "clear", "x": 0, "y": 50, "top": 412}},
            {"t": 3, "ev": "kb-shove", "d": {"act": "yield", "x": 0, "y": 50, "top": 412}},
        ],
    }
    with caplog.at_level(logging.INFO, logger="paratrooper.holddiag"):
        assert client.post("/api/debug/holddiag", headers=AUTH, json=trail).json() == {"ok": True}
    vp = [r.message for r in caplog.records if "holddiag viewport" in r.message]
    assert len(vp) == 1
    assert '"grow-blink"' in vp[0]
    assert '"kb-shove"' in vp[0]
    assert '"act": "clear"' in vp[0] and '"act": "yield"' in vp[0]


def test_holddiag_viewport_digest_carries_keyboard_dynamics_marks(client, caplog):
    """The keyboard-dynamics card's marks ride the viewport digest line:
    kb-focusing for the tap-time choreography signal's lifecycle (focus,
    keyboard handover, hardware-keyboard lapse, blur) and kb-glide for the
    open/close edges that scope the shell's transition window — so deploy
    logs alone reconstruct how an open and a close played out."""
    trail = {
        "build": "b",
        "events": [
            {"t": 1, "ev": "kb-focusing", "d": {"phase": "focus"}},
            {"t": 2, "ev": "kb-glide", "d": {"edge": "open"}},
            {"t": 3, "ev": "kb-focusing", "d": {"phase": "kb"}},
            {"t": 4, "ev": "kb-glide", "d": {"edge": "close"}},
        ],
    }
    with caplog.at_level(logging.INFO, logger="paratrooper.holddiag"):
        assert client.post("/api/debug/holddiag", headers=AUTH, json=trail).json() == {"ok": True}
    vp = [r.message for r in caplog.records if "holddiag viewport" in r.message]
    assert len(vp) == 1
    assert '"kb-focusing"' in vp[0] and '"phase": "focus"' in vp[0]
    assert '"kb-glide"' in vp[0] and '"edge": "open"' in vp[0] and '"edge": "close"' in vp[0]


def test_holddiag_boot_digest_carries_boot_motion_head_first(client, caplog):
    """The boot-window motion recorder's records ride their own digest line,
    HEAD-first: the frame settles right after first paint, so the earliest
    movers are the verdict and must survive however busy the session gets.
    The same names also ride the viewport tuple like every motion record."""
    trail = {
        "build": "b",
        "events": [
            {"t": 1, "ev": "boot-motion", "d": {"at": 180, "moved": "vv-top",
                                                "delta": -59, "v": 0}},
            {"t": 2, "ev": "boot-motion", "d": {"at": 180, "moved": "shell-h",
                                                "delta": 34, "v": 852}},
            {"t": 3, "ev": "boot-repin", "d": {"src": "vv-scroll", "x": 0, "y": 0,
                                               "top": 0, "snap": False, "repin": True}},
        ],
    }
    with caplog.at_level(logging.INFO, logger="paratrooper.holddiag"):
        assert client.post("/api/debug/holddiag", headers=AUTH, json=trail).json() == {"ok": True}
    boot = [r.message for r in caplog.records if "holddiag boot" in r.message]
    assert len(boot) == 1
    assert '"boot-motion"' in boot[0] and '"moved": "vv-top"' in boot[0]
    assert '"boot-repin"' in boot[0] and '"repin": true' in boot[0]
    vp = [r.message for r in caplog.records if "holddiag viewport" in r.message]
    assert len(vp) == 1
    assert '"boot-motion"' in vp[0]


def _rise_trail():
    """One raise as the phone records it: the glide edge, the edge's own box
    write, the kb-edge mark, thirty kb-rise frames, and the pin drop at the end
    of the settle window."""
    events = [
        {"t": 1, "ev": "kb-focusing", "d": {"phase": "focus"}},
        {"t": 2, "ev": "kb-glide", "d": {"edge": "open"}},
        {"t": 3, "ev": "shell-size",
         "d": {"top": 412, "h": 508, "glide": True, "edge": True, "ems": 0.3}},
        {"t": 4, "ev": "kb-edge",
         "d": {"edge": "open", "n": 7, "src": "resize", "evt": 0.4, "armed": 9.6,
               "frame": 20.2, "read": 24.1, "dTop": 140, "dH": -144, "dPad": -26,
               "sx": 0, "sy": 412, "vvTop": 412, "vvH": 508, "foc": 260,
               "boxTop": 412, "boxH": 508, "seed": True}},
        {"t": 5, "ev": "shell-size",
         "d": {"top": 0, "h": 508, "glide": True, "edge": False, "ems": 16.9}},
    ]
    events += [
        {"t": 10 + i, "ev": "kb-rise",
         "d": {"ms": i * 17, "fts": i * 17 - 1, "padB": 34 - i, "shellH": 508,
               "shellTop": 412 - i * 14, "pillBot": 470, "thBot": 460, "st": 1200}}
        for i in range(30)
    ]
    events.append({"t": 90, "ev": "shell-pin", "d": {"top": 0, "h": 844, "ems": 471.6}})
    return events


def test_holddiag_rise_trail_gets_its_own_line(client, caplog):
    """ONE raise writes thirty kb-rise frames. Riding the shared viewport tail
    they would flush every other mark out of the twenty it keeps, which is why
    the close already has its own line, so the raise gets the same treatment.
    The proof is not that the rise line exists but that the marks it would have
    displaced are still on the viewport line beside it."""
    trail = {"build": "b", "events": _rise_trail()}
    with caplog.at_level(logging.INFO, logger="paratrooper.holddiag"):
        assert client.post("/api/debug/holddiag", headers=AUTH, json=trail).json() == {"ok": True}
    rise = [r.message for r in caplog.records if "holddiag rise" in r.message]
    assert len(rise) == 1
    assert "events=30" in rise[0]
    assert '"kb-rise"' in rise[0] and '"shellTop": 412' in rise[0] and '"fts"' in rise[0]

    # the tail that would have been flushed: every one of these sits BEFORE the
    # thirty frames in the trail, and all of them survive
    vp = [r.message for r in caplog.records if "holddiag viewport" in r.message]
    assert len(vp) == 1
    assert '"kb-glide"' in vp[0] and '"edge": "open"' in vp[0]
    assert '"kb-focusing"' in vp[0]
    assert '"shell-size"' in vp[0] and '"boxTop"' not in vp[0]
    assert '"shell-pin"' in vp[0] and '"ems": 471.6' in vp[0]
    assert '"kb-rise"' not in vp[0]  # the frames stay off the shared tail entirely


def test_holddiag_edge_marks_get_their_own_line(client, caplog):
    """kb-edge is two records per keyboard cycle, so volume is not why it is
    split out: it carries the answer (which clock the start-of-motion delay went
    into) and the viewport tail keeps only the last twenty marks of every kind,
    so a busy typing session between two taps would push it out."""
    noise = [
        {"t": 100 + i, "ev": "grow-blink", "d": {"oldH": 39, "newH": 61}}
        for i in range(25)
    ]
    trail = {"build": "b", "events": _rise_trail() + noise}
    with caplog.at_level(logging.INFO, logger="paratrooper.holddiag"):
        assert client.post("/api/debug/holddiag", headers=AUTH, json=trail).json() == {"ok": True}
    edge = [r.message for r in caplog.records if "holddiag edge" in r.message]
    assert len(edge) == 1
    assert "events=1" in edge[0]
    assert '"armed": 9.6' in edge[0] and '"frame": 20.2' in edge[0] and '"read": 24.1' in edge[0]
    assert '"dTop": 140' in edge[0] and '"dH": -144' in edge[0] and '"dPad": -26' in edge[0]
    assert '"sy": 412' in edge[0] and '"boxTop": 412' in edge[0]  # the double-write edge
    assert '"seed": true' in edge[0] and '"foc": 260' in edge[0]
    # twenty-five keystrokes after the raise have taken the viewport tail whole
    vp = [r.message for r in caplog.records if "holddiag viewport" in r.message]
    assert len(vp) == 1
    assert '"kb-glide"' not in vp[0]
    # and the mark rode through it anyway, which is the point of the split
    assert '"kb-edge"' in edge[0]


def test_holddiag_fall_and_rise_lines_do_not_clip_each_other(client, caplog):
    """A raise and a close inside one post window: each frame trail lands whole
    on its own line. Sharing one would leave one of the two motions half
    recorded, since the tail is bounded per line."""
    events = _rise_trail() + [
        {"t": 200, "ev": "kb-glide", "d": {"edge": "close"}},
        {"t": 201, "ev": "kb-close",
         "d": {"phase": "close", "x": 0, "y": 0, "top": 0, "snap": False,
               "heal": False, "ih": 844, "base": 844}},
    ] + [
        {"t": 210 + i, "ev": "kb-fall",
         "d": {"ms": i * 17, "padB": 8 + i, "shellH": 508 + i * 11,
               "shellTop": 0, "pillBot": 470, "thBot": 460, "st": 1200}}
        for i in range(30)
    ]
    with caplog.at_level(logging.INFO, logger="paratrooper.holddiag"):
        assert client.post(
            "/api/debug/holddiag", headers=AUTH, json={"build": "b", "events": events}
        ).json() == {"ok": True}
    fall = [r.message for r in caplog.records if "holddiag fall" in r.message]
    rise = [r.message for r in caplog.records if "holddiag rise" in r.message]
    assert len(fall) == 1 and len(rise) == 1
    assert "events=30" in fall[0] and "events=30" in rise[0]
    # neither trail carries the other's frames
    assert '"kb-rise"' not in fall[0]
    assert '"kb-fall"' not in rise[0]
    # and the close's first frame is still on the fall line, thirty raise frames
    # and two close marks later in the trail
    assert '"ms": 0' in fall[0] and '"ms": 493' in fall[0]


def test_holddiag_scroll_jank_gets_its_own_line(client, caplog):
    """scroll-jank batches one gesture's whole verdict (both frame cadences,
    the worst gaps with what ran inside them) into one wide record, so it rides
    its own line, and the shared viewport tail never
    carries or clips it. TEMP DIAGNOSTIC (scroll-jank): remove with the
    pwa/src/scrolljank.ts block."""
    record = {
        "n": 2, "t0": 5200, "dur": 1240, "raf": 41, "sc": 96, "long": 3,
        "ltMs": 180,
        "worst": [
            {"ms": 87, "at": 310, "clock": "raf", "led": ["slack-read"], "lt": 71},
            {"ms": 52, "at": 640, "clock": "sc", "led": ["cache-put"]},
            {"ms": 41, "at": 1290, "clock": "raf"},
        ],
    }
    trail = {"build": "b", "events": [
        {"t": 1, "ev": "followtail", "d": {"to": False, "trigger": "scroll-away"}},
        {"t": 2, "ev": "scroll-jank", "d": record},
    ]}
    with caplog.at_level(logging.INFO, logger="paratrooper.holddiag"):
        assert client.post("/api/debug/holddiag", headers=AUTH, json=trail).json() == {"ok": True}
    jank = [r.message for r in caplog.records if "holddiag jank" in r.message]
    assert len(jank) == 1
    assert "events=1" in jank[0]
    # the attribution survives the digest: the gap, its clock, and the names
    assert '"ms": 87' in jank[0] and '"clock": "raf"' in jank[0]
    assert '"slack-read"' in jank[0] and '"cache-put"' in jank[0]
    assert '"ltMs": 180' in jank[0]
    # the wide record stays off the shared viewport tail entirely, and the
    # scroll mark beside it still rides that tail as before
    vp = [r.message for r in caplog.records if "holddiag viewport" in r.message]
    assert len(vp) == 1
    assert '"scroll-jank"' not in vp[0]
    assert '"followtail"' in vp[0]


def test_holddiag_pick_timing_gets_its_own_line(client, caplog):
    """pick-timing batches one photo pick's whole timeline (every step from the
    file input's change event out to the frame the picture is painted in, the
    file's kind and size, and what held the main thread meanwhile) into one wide
    record, so it rides its own line like scroll-jank does. The tail is twenty
    records, which is the ten picks the session needs with room to spare. TEMP
    DIAGNOSTIC (pick-timing): remove with the pwa/src/picktiming.ts block."""
    record = {
        "n": 3, "from": "input-change", "t0": 51230, "total": 732,
        "s": {"handler": 2, "meta": 2, "url": 3, "elem": 4, "seat": 5,
              "open": 9, "sync": 11, "laid": 33, "decode": 700, "reveal": 701,
              "paint": 732},
        "nf": 1,
        "f": [{"kind": "heic", "bytes": 2481923, "w": 4032, "h": 3024}],
        "blk": {"lt": 210, "long": 3, "ledMs": 224,
                "led": [["pick-open", 180], ["shot-drawn", 44]]},
    }
    trail = {"build": "b", "events": [
        {"t": 1, "ev": "pick-anchor", "d": {"end": "focus", "upMs": 51100}},
        {"t": 2, "ev": "pick-timing", "d": record},
    ]}
    with caplog.at_level(logging.INFO, logger="paratrooper.holddiag"):
        assert client.post("/api/debug/holddiag", headers=AUTH, json=trail).json() == {"ok": True}
    pick = [r.message for r in caplog.records if "holddiag pick" in r.message]
    assert len(pick) == 1
    assert "events=1" in pick[0]
    # the whole verdict survives the digest: the total, the slowest step, what
    # kind of photo it was, and what held the thread while it came
    assert '"total": 732' in pick[0] and '"decode": 700' in pick[0]
    assert '"kind": "heic"' in pick[0] and '"w": 4032' in pick[0]
    assert '"pick-open"' in pick[0] and '"lt": 210' in pick[0]
    # the wide record stays off the shared viewport tail entirely, and the
    # picker mark beside it still rides that tail as before
    vp = [r.message for r in caplog.records if "holddiag viewport" in r.message]
    assert len(vp) == 1
    assert '"pick-timing"' not in vp[0]
    assert '"pick-anchor"' in vp[0]


def test_relay_logs_persist_and_superseded_drop(tmp_path, monkeypatch, caplog):
    """One line per delivery decision: a live done logs persist with its seq and
    terminal flag; a superseded run's output logs drop with the reason."""
    monkeypatch.delenv("VAPID_PUBLIC_KEY", raising=False)

    async def scenario():
        enq, intr, enqueued, _ = _recorders()
        coord = ThreadCoordinator(enq, intr, window=0.02)
        state = AppState(config=None, store=ThreadStore(tmp_path / "t.sqlite"),
                         queue=object(), coordinator=coord, inbox=DiskInbox(tmp_path / "ib"))
        await coord.handle_message("d", "first", [])
        await asyncio.sleep(0.05)  # fires -> running
        job1 = enqueued[0]["job"]
        await _relay_result(state, "d", ResultMessage(job_id=job1, kind="done", payload="hi"))
        await coord.handle_message("d", "more", [])
        await asyncio.sleep(0.05)  # rerun fires
        job2 = enqueued[1]["job"]
        await coord.handle_message("d", "again", [])  # supersedes job2 mid-flight
        await _relay_result(state, "d", ResultMessage(job_id=job2, kind="done", payload="stale"))
        return job1, job2

    with caplog.at_level(logging.INFO, logger="paratrooper.holddiag"):
        job1, job2 = _run(scenario())
    lines = [r.message for r in caplog.records if r.message.startswith("holddiag relay")]
    assert any(f"persist kind=done job={job1}" in ln and "terminal=True" in ln for ln in lines)
    assert any(f"drop kind=done job={job2}" in ln and "reason=superseded" in ln for ln in lines)


def test_batching_logs_reconstruct_the_burst(caplog):
    """The supersede-and-rerun burst leaves its whole story in the logs: timer
    armed per send, supersede naming the cancelled job, and the rerun fire."""
    async def scenario():
        enq, intr, enqueued, _ = _recorders()
        coord = ThreadCoordinator(enq, intr, window=0.02)
        await coord.handle_message("d", "first", [])
        await asyncio.sleep(0.05)  # fires -> running
        await coord.handle_message("d", "actually blue", [])  # supersede
        await coord.job_finished("d")
        await asyncio.sleep(0.05)  # rerun fires
        return enqueued

    with caplog.at_level(logging.INFO, logger="paratrooper.holddiag"):
        enqueued = _run(scenario())
    lines = [r.message for r in caplog.records if r.message.startswith("holddiag batch")]
    assert sum("timer-armed" in ln for ln in lines) >= 2  # first send + supersede re-arm
    assert any(f"supersede thread=d job={enqueued[0]['job']}" in ln for ln in lines)
    assert any(f"fire thread=d job={enqueued[1]['job']} msgs=2" in ln for ln in lines)
    assert any("finished thread=d" in ln for ln in lines)


def test_holddiag_photo_box_marks_get_their_own_line(client, caplog):
    """A photo the app was never told the size of gets a guessed box, and that
    box reshapes when the pixels land, shoving everything under it down the page.
    The guess, the real size arriving, and the view being held still across the
    correction only mean anything read together, so they ride one line of their
    own, and so does the served-shape check on the photos that never guessed at
    all. This test exists because those marks were being posted by the phone and
    dropped here: a mark no block claims never reaches the logs, so its absence
    reads as "never happened" when it means "never carried". TEMP DIAGNOSTIC
    (photo boxes): remove with the pwa/src/main.ts blocks."""
    trail = {"build": "b", "events": [
        {"t": 1, "ev": "guessed-box",
         "d": {"seq": 412, "i": 0, "n": 3, "keys": 2, "dims": None, "hash": 1}},
        {"t": 2, "ev": "photo-learned", "d": {"seq": 412, "i": 0, "w": 3024, "h": 4032}},
        {"t": 3, "ev": "keep-view", "d": {"seq": 412, "fix": 268.5}},
        {"t": 4, "ev": "sized-box",
         "d": {"seq": 413, "i": 0, "n": 1, "w": 3024, "h": 4032, "tall": 1, "ck": 2}},
        # the eyewitness case, if it is real: a photo that never guessed, laid
        # out landscape from the size the frame carried and served the portrait
        # picture that stands its box back up
        {"t": 5, "ev": "served-shape",
         "d": {"seq": 414, "i": 0, "n": 1, "w": 4032, "h": 3024,
               "nw": 3024, "nh": 4032, "swap": 1, "r": 1.778}},
        {"t": 6, "ev": "tail-gap", "d": {"when": "photo"}},
    ]}
    with caplog.at_level(logging.INFO, logger="paratrooper.holddiag"):
        assert client.post("/api/debug/holddiag", headers=AUTH, json=trail).json() == {"ok": True}
    photo = [r.message for r in caplog.records if "holddiag photo" in r.message]
    assert len(photo) == 1
    assert "events=5" in photo[0]
    # the twin channel rides the same line: without it, silence from the guessing
    # side cannot be told apart from no photo having been drawn at all
    assert '"sized-box"' in photo[0] and '"tall": 1' in photo[0]
    # and the same trap one level down: the served-shape check writes nothing
    # when the pixels agree, so the count of photos it managed to look at rides
    # the record that always fires, and has to arrive with it
    assert '"ck": 2' in photo[0]
    # the disagreement itself, in the only terms that settle the argument: what
    # the app was told, what it was served, and that the two are transposed
    assert '"served-shape"' in photo[0] and '"seq": 414' in photo[0]
    assert '"nw": 3024' in photo[0] and '"nh": 4032' in photo[0]
    assert '"swap": 1' in photo[0] and '"r": 1.778' in photo[0]
    # the whole story survives: which photo guessed and how many have, the real
    # size when it arrived, and whether anything compensated for the reshape
    assert '"seq": 412' in photo[0] and '"n": 3' in photo[0]
    assert '"dims": null' in photo[0] and '"hash": 1' in photo[0]
    assert '"w": 3024' in photo[0] and '"fix": 268.5' in photo[0]
    # they stay off the shared viewport tail, which still carries its own marks
    vp = [r.message for r in caplog.records if "holddiag viewport" in r.message]
    assert len(vp) == 1
    assert '"guessed-box"' not in vp[0]
    assert '"tail-gap"' in vp[0]


def test_holddiag_settle_marks_get_their_own_line(client, caplog):
    """The app's one scroll write, on the one channel that was reaching nobody:
    the phone has been posting tail-settle all along and no block claimed it, so
    every correction it made was discarded here. Both shapes ride the line — a
    single settle carrying its mode, and a whole run of the per-frame ones
    folded into a summary carrying n — because a box that eases writes two dozen
    of them and the pair only reads as one event. TEMP DIAGNOSTIC (blank-thread):
    remove with the pwa/src/viewport.ts block."""
    trail = {"build": "b", "events": [
        {"t": 1, "ev": "followtail", "d": {"to": False, "trigger": "scroll-away"}},
        # the drawer's beat: twenty-four writes, none of which moved the reader
        {"t": 2, "ev": "tail-settle",
         "d": {"via": "box", "n": 24, "moved": 0, "from": 2180, "to": 2180,
               "over": 0, "ms": 396, "sh": 4329, "ch": 700}},
        # and the louder settle that ended it
        {"t": 3, "ev": "tail-settle",
         "d": {"via": "drawer-close", "mode": "clamp", "from": 2180, "to": 2180,
               "over": 0, "sh": 4329, "ch": 770, "cut": False, "air": 0}},
    ]}
    with caplog.at_level(logging.INFO, logger="paratrooper.holddiag"):
        assert client.post("/api/debug/holddiag", headers=AUTH, json=trail).json() == {"ok": True}
    settle = [r.message for r in caplog.records if "holddiag settle" in r.message]
    assert len(settle) == 1
    assert "events=2" in settle[0]
    # the run's whole verdict survives: how many writes landed, how many moved
    # the reader, and where the scroll stood at the first and at the last
    assert '"n": 24' in settle[0] and '"moved": 0' in settle[0]
    assert '"from": 2180' in settle[0] and '"ms": 396' in settle[0]
    # and the mark that closed the run is on the same line, so the beat and its
    # ending read as one sequence
    assert '"via": "drawer-close"' in settle[0] and '"mode": "clamp"' in settle[0]
    # a burst of them stays off the shared viewport tail, which keeps its own
    vp = [r.message for r in caplog.records if "holddiag viewport" in r.message]
    assert len(vp) == 1
    assert '"tail-settle"' not in vp[0]
    assert '"followtail"' in vp[0]


def test_holddiag_thread_blank_gets_its_own_line(client, caplog):
    """One armed photo cancel batches seven readings of the conversation's
    geometry into one wide record, from before the tap out to the frame after
    the touch that repaired the blank, so it rides its own line like scroll-jank
    and pick-timing do. The reading that decides the whole question is vis, the
    rows standing inside the visible band, so the digest has to carry it
    unclipped for every one of the seven. TEMP DIAGNOSTIC (thread-blank): remove
    with the pwa/src/blankprobe.ts block."""
    def frame(w, ms, vis, sc):
        return {"w": w, "ms": ms, "st": 2180, "sh": 4329, "ch": 700, "over": 0,
                "kids": 656, "rows": 11, "vis": vis, "bw": "ok", "look": 24,
                "top1": -22, "botN": 690, "h1": 44,
                "nearT": -66, "nearB": None, "nearH": 44,
                "pendH": 76, "pendD": "flex",
                "anA": 0, "anT": 0, "app": "", "thr": "", "peek": "0px",
                "ft": False, "sc": sc, "set": 0, "setMoved": 0}

    record = {
        "n": 1, "why": "open", "t0": 51230, "paired": True,
        "f": [
            frame("edge", 0, 9, 0),
            frame("frame", 16, 9, 1),
            frame("mid", 132, 9, 4),
            frame("beat", 401, 9, 7),
            frame("rest", 703, 9, 7),
            frame("touch", 2140, 9, 7),
            frame("after", 2156, 9, 8),
        ],
    }
    trail = {"build": "b", "events": [
        {"t": 1, "ev": "tail-settle",
         "d": {"via": "box", "n": 24, "moved": 0, "from": 2180, "to": 2180,
               "over": 0, "ms": 396, "sh": 4329, "ch": 700}},
        {"t": 2, "ev": "thread-blank", "d": record},
    ]}
    with caplog.at_level(logging.INFO, logger="paratrooper.holddiag"):
        assert client.post("/api/debug/holddiag", headers=AUTH, json=trail).json() == {"ok": True}
    blank = [r.message for r in caplog.records if "holddiag blank" in r.message]
    assert len(blank) == 1
    assert "events=1" in blank[0]
    # every moment of the run reaches the line, the pair included: a record that
    # arrived without its two halves cannot answer anything
    for moment in ("edge", "frame", "mid", "beat", "rest", "touch", "after"):
        assert f'"w": "{moment}"' in blank[0]
    assert '"paired": true' in blank[0]
    # and which of the drawer's edges armed the run, without which an open and
    # a cancel read back as the same event
    assert '"why": "open"' in blank[0]
    # and the readings that decide it: rows standing in the band, the list still
    # being in the document, where the scroll was, and whether the walk was clipped
    assert '"vis": 9' in blank[0] and '"kids": 656' in blank[0]
    assert '"st": 2180' in blank[0]
    # the verdict beside the count, without which a zero cannot be told apart
    # from a search that never reached the band — the fault that made this
    # channel's first device record worthless
    assert '"bw": "ok"' in blank[0]
    # and the neighbourhood, which is what makes a genuine zero readable
    assert '"nearT": -66' in blank[0] and '"nearH": 44' in blank[0]
    # the wide record stays off both the shared viewport tail and the settle line
    vp = [r.message for r in caplog.records if "holddiag viewport" in r.message]
    assert vp == [] or '"thread-blank"' not in vp[0]
    settle = [r.message for r in caplog.records if "holddiag settle" in r.message]
    assert len(settle) == 1
    assert '"thread-blank"' not in settle[0]
