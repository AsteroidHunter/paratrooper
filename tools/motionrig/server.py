"""The motion rig's backend: the real web service over a seeded, scripted thread.

This is ``paratrooper.web.app.create_app`` with an injected state, the same seam
the route tests use, so the phone app talks to the real routes, the real socket
and the real frame shapes. Only two things are stand-ins:

* the thread store is a throwaway SQLite file seeded with a long conversation
  (hundreds of messages, some of them photos with real previews, sizes and
  blurhashes), spread over several days so the day stamps and runs appear;
* the worker is a script. A send is answered the way a real run answers it:
  the "working" row (the Read receipt), then the typing dots, then the reply,
  each pushed through the real relay (``_relay_result``) after a short pause.

A few extra routes let the driver (``rig.py``) make things happen that the
phone cannot ask for: a reply with no send in front of it, a burst of replies
while the page is away, and a dropped socket.

It binds 127.0.0.1 only, on the port it is given, and serves the ``pwa/dist``
the driver built. Nothing here touches the network beyond that one socket.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import os
import random
import sys
import tempfile
import tomllib
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src"))

import uvicorn  # noqa: E402
from fastapi import Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from paratrooper.agent.config import validate_config  # noqa: E402
from paratrooper.web import app as webapp  # noqa: E402
from paratrooper.web.db import ThreadStore  # noqa: E402
from paratrooper.web.inbox import DiskInbox  # noqa: E402
from paratrooper.web.models import ResultMessage, ThreadEvent  # noqa: E402
from paratrooper.web.thumbs import image_blurhash, make_thumbnail  # noqa: E402

TOKEN = "motionrig-token"
THREAD = "default"

USER_LINES = [
    "can you move the hiking photo to the top of the board",
    "ok",
    "and make the caption smaller",
    "what did you change yesterday?",
    "Perfect, thanks!",
    "hmm the second card looks off on my phone, the title wraps onto three lines "
    "and pushes the picture down. can you tighten it so it fits on two?",
    "swap the order of the two newest pins",
    "lol",
    "Is the site live yet",
    "add this one to the travel section please",
]
AGENT_LINES = [
    "Done. The hiking photo is now the first pin on the board.",
    "Caption size is down from 18px to 15px.",
    "Yesterday I merged two changes: the new book pin and a spacing fix on the "
    "footer. Both are live.",
    "On it.",
    'I shortened the title to "Sunrise at Gates Pass" and dropped the letter '
    "spacing a little. It now fits on two lines at the iPhone width, and the "
    "picture sits where it used to.\n\nWant me to publish it?",
    "Swapped. The concert pin is first now, then the bookshop one.",
    "Yes, the last deploy finished two minutes ago.",
    "Added to travel, third from the left.",
]


def config():
    """The committed example configuration, through the real validator."""
    table = tomllib.loads((REPO / "config" / "paratrooper.example.toml").read_text("utf-8"))
    return validate_config(table, source="the motion rig")


def photo(seed: int, portrait: bool) -> bytes:
    """A camera-sized JPEG with enough structure to cost a real decode."""
    rnd = random.Random(seed)
    w, h = (3024, 4032) if portrait else (4032, 3024)
    small = Image.new("RGB", (w // 8, h // 8))
    draw = ImageDraw.Draw(small)
    top = tuple(rnd.randrange(40, 220) for _ in range(3))
    bottom = tuple(rnd.randrange(20, 200) for _ in range(3))
    for y in range(small.height):
        t = y / small.height
        draw.line(
            [(0, y), (small.width, y)],
            fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bottom, strict=True)),
        )
    for _ in range(40):
        x, y = rnd.randrange(small.width), rnd.randrange(small.height)
        r = rnd.randrange(8, 90)
        draw.ellipse([x - r, y - r, x + r, y + r], fill=tuple(rnd.randrange(256) for _ in range(3)))
    big = small.resize((w, h), Image.Resampling.BICUBIC)
    out = io.BytesIO()
    big.save(out, format="JPEG", quality=85)
    return out.getvalue()


def seed(store: ThreadStore, count: int, photo_every: int) -> None:
    """``count`` messages over the last few days, oldest first."""
    rnd = random.Random(7)
    now = datetime.now(UTC)
    start = now - timedelta(days=4)
    # each message advances the clock about 0.8 of a step on average (the
    # replies plus the odd long silence), so this lands the newest one near now
    step = (now - timedelta(minutes=10) - start) / max(count, 1) * 1.2
    at = start
    made = 0
    turn = 0
    said = ""
    while made < count:
        turn += 1
        ts = at.isoformat()
        attachments: list[str] = []
        if photo_every and turn % photo_every == 0:
            key = f"rig-{turn:05d}.jpg"
            thumb = make_thumbnail(photo(turn, portrait=turn % 3 != 0))
            assert thumb is not None
            data, w, h = thumb
            store.add_thumbnail(key, data, ts=ts, width=w, height=h, blurhash=image_blurhash(data))
            attachments.append(key)
        text = "" if attachments and rnd.random() < 0.5 else rnd.choice(USER_LINES)
        store.add_message(
            ThreadEvent(thread_id=THREAD, role="user", payload=text, attachments=attachments, ts=ts)
        )
        store.add_message(
            ThreadEvent(thread_id=THREAD, role="system", kind="job", payload=None, ts=ts)
        )
        store.add_message(
            ThreadEvent(thread_id=THREAD, role="agent", kind="working", payload=None, ts=ts)
        )
        made += 1
        # a run of two or three replies now and then, like a real turn
        # (never the same line twice in a row: the app folds a repeated reply)
        for _ in range(1 if rnd.random() < 0.7 else rnd.randrange(2, 4)):
            at += step / 3
            said = rnd.choice([line for line in AGENT_LINES if line != said])
            store.add_message(
                ThreadEvent(
                    thread_id=THREAD, role="agent", kind="done", payload=said, ts=at.isoformat()
                )
            )
            made += 1
        # the occasional long silence, so the day and gap stamps show up
        at += step * (6 if rnd.random() < 0.08 else 1)


class ScriptedWorker:
    """Stands where the coordinator stands; answers every send like a run."""

    def __init__(self, reply_after: float, typing_after: float) -> None:
        self.reply_after = reply_after
        self.typing_after = typing_after
        self.state: webapp.AppState | None = None
        self.tasks: set[asyncio.Task] = set()

    # the three calls the service makes on a coordinator
    async def handle_message(self, thread_id: str, text: str, attachments: list[str]) -> str:
        self.spawn(self.answer(thread_id, reply=None))
        return "buffered"

    async def job_finished(self, thread_id: str) -> None:
        return None

    def was_superseded(self, thread_id: str, job_id: str) -> bool:
        return False

    def has_pending(self) -> bool:
        return False

    def spawn(self, coro) -> None:
        task = asyncio.ensure_future(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def relay(self, thread_id: str, job: str, kind: str, payload=None) -> None:
        assert self.state is not None
        await webapp._relay_result(
            self.state, thread_id, ResultMessage(job_id=job, kind=kind, payload=payload)
        )

    async def answer(self, thread_id: str, reply: str | None, working: bool = True) -> None:
        job = uuid.uuid4().hex[:12]
        await asyncio.sleep(0.4)
        if working:
            await self.relay(thread_id, job, "working")
        await asyncio.sleep(self.typing_after)
        await self.relay(thread_id, job, "typing")
        await asyncio.sleep(self.reply_after)
        await self.relay(thread_id, job, "done", reply or random.choice(AGENT_LINES))


def build(args: argparse.Namespace):
    os.environ["PARATROOPER_APP_TOKEN"] = TOKEN
    root = Path(args.data or tempfile.mkdtemp(prefix="motionrig-"))
    store = ThreadStore(root / "threads.sqlite")
    if not store.messages_page(THREAD, limit=1):
        seed(store, args.messages, args.photo_every)
    worker = ScriptedWorker(args.reply_after, args.typing_after)
    state = webapp.AppState(
        config=config(),
        store=store,
        queue=object(),
        coordinator=worker,
        inbox=DiskInbox(root / "inbox"),
    )
    worker.state = state
    app = webapp.create_app(injected=state)

    async def rig_reply(request: Request) -> JSONResponse:
        """A reply the owner did not ask for just now: dots, then the message."""
        body = await request.json() if await request.body() else {}
        worker.spawn(worker.answer(THREAD, body.get("text"), working=False))
        return JSONResponse({"ok": True})

    async def rig_burst(request: Request) -> JSONResponse:
        """Persist ``n`` replies at once and push them to any open socket."""
        body = await request.json() if await request.body() else {}
        for i in range(int(body.get("n", 3))):
            await worker.relay(THREAD, f"burst{i}", "done", random.choice(AGENT_LINES))
        return JSONResponse({"ok": True})

    async def rig_drop(_request: Request) -> JSONResponse:
        """Close every socket, the way iOS takes one from a backgrounded app."""
        sockets = list(state.sockets.get(THREAD, set()))
        for ws in sockets:
            await ws.close(code=1001)
        return JSONResponse({"closed": len(sockets)})

    async def rig_count(_request: Request) -> JSONResponse:
        return JSONResponse({"messages": len(store.messages(THREAD))})

    for path, handler in (
        ("/rig/reply", rig_reply),
        ("/rig/burst", rig_burst),
        ("/rig/drop", rig_drop),
        ("/rig/count", rig_count),
    ):
        app.add_api_route(path, handler, methods=["POST", "GET"])
        # ahead of the static mount, which would otherwise answer first
        app.router.routes.insert(0, app.router.routes.pop())
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--port", type=int, default=5287)
    parser.add_argument("--messages", type=int, default=400)
    parser.add_argument(
        "--photo-every",
        type=int,
        default=9,
        help="one user turn in this many carries a photo (0 for none)",
    )
    parser.add_argument(
        "--reply-after",
        type=float,
        default=1.6,
        help="seconds the dots show before the reply lands",
    )
    parser.add_argument(
        "--typing-after", type=float, default=1.0, help="seconds from the Read receipt to the dots"
    )
    parser.add_argument("--data", help="folder for the store (a fresh temp folder by default)")
    args = parser.parse_args()
    uvicorn.run(build(args), host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
