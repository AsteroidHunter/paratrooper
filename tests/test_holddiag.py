"""TEMP DIAGNOSTIC tests (remove with the reply-hold probe): the unauthenticated
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


def test_holddiag_roundtrip_no_auth(client, caplog):
    """The phone posts its trail with no bearer token; a plain curl reads the
    latest back; the digest line lands in the logs with the release reasons."""
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
        assert client.post("/api/debug/holddiag", json=trail).json() == {"ok": True}
    assert client.get("/api/debug/holddiag").json() == trail
    digest = [r.message for r in caplog.records if "holddiag client" in r.message]
    assert len(digest) == 1
    assert "events=3" in digest[0] and '"reason": "quiet"' in digest[0]

    # latest wins: a second post replaces the first entirely
    assert client.post("/api/debug/holddiag", json={"events": []}).json() == {"ok": True}
    assert client.get("/api/debug/holddiag").json() == {"events": []}


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
        assert client.post("/api/debug/holddiag", json=trail).json() == {"ok": True}
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
        assert client.post("/api/debug/holddiag", json=trail).json() == {"ok": True}
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
        assert client.post("/api/debug/holddiag", json=trail).json() == {"ok": True}
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
        assert client.post("/api/debug/holddiag", json=trail).json() == {"ok": True}
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
        assert client.post("/api/debug/holddiag", json=trail).json() == {"ok": True}
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
        assert client.post("/api/debug/holddiag", json=trail).json() == {"ok": True}
    boot = [r.message for r in caplog.records if "holddiag boot" in r.message]
    assert len(boot) == 1
    assert '"boot-motion"' in boot[0] and '"moved": "vv-top"' in boot[0]
    assert '"boot-repin"' in boot[0] and '"repin": true' in boot[0]
    vp = [r.message for r in caplog.records if "holddiag viewport" in r.message]
    assert len(vp) == 1
    assert '"boot-motion"' in vp[0]


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
