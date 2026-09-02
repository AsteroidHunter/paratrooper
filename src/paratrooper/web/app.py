"""FastAPI web service: PWA host + auth gate + uploads + threads + socket + publish.

Holds the socket, serves the PWA, stages uploads to the inbox, persists threads to
SQLite, debounce-batches messages into worker jobs over the Key Value queue, relays
streamed results back over the socket, and owns the /publish merge authority.

The token gate is declared per route, not applied to the app as a whole, and that
distinction is stated here because believing otherwise is precisely how two
diagnostic routes came to sit open to the whole internet for a bug hunt's worth of
deploys. Every route that reads or writes thread content demands the shared token —
in the Authorization header, or in a query param on the socket handshake and the
thumbnail reads, since neither of those can carry headers. Deliberately public are
the health check, which answers only with the running commit, and the PWA's own
static bundle, which the browser must fetch before it has anywhere to type a token.
The auto-generated schema and doc pages are switched off, so nothing publishes the
route map either. A route added here is open until its own declaration says
otherwise; there is no blanket to fall back on.

``create_app`` accepts injected state so tests run without Redis; in production
the lifespan connects Key Value and starts the result-relay task.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from redis import exceptions as redis_exc

from ..agent.config import Config, load_config
from . import push
from .auth import require_token, verify_token
from .batching import ThreadCoordinator
from .db import ThreadStore, ThumbMeta
from .inbox import InboxStore, RedisInbox, new_key
from .models import (
    EVENT_POLICY,
    JobMessage,
    PublishRequest,
    ResultMessage,
    SendRequest,
    ThreadEvent,
    UploadResponse,
)
from .publish import (
    PublishError,
    find_open_pr,
    merge_pull_request,
    merge_token,
    owner_repo_from_remote,
    parse_pr_number,
)
from .queue import JobQueue, connect
from .render_control import RenderControl
from .thumbs import image_blurhash, make_thumbnail

logger = logging.getLogger(__name__)

# the /ws handshake carries the bearer token as a query param (browsers can't
# set WS headers), and uvicorn logs the full path on every accept — verified
# leaking the real token into Render logs. Scrub it before any record is emitted.
_TOKEN_PARAM_RE = re.compile(r"(token=)[^&\s\"']+")

# an access line already merged into record.msg, split back into the five fields
# uvicorn's template ('%s - "%s %s HTTP/%s" %d') produced them from
_ACCESS_LINE_RE = re.compile(r'^(.*?) - "(\S+) (\S*) HTTP/([^"]*)" (\d+)$')


class _RedactTokenFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        # scrub inside args rather than merging-and-nulling: uvicorn's access
        # formatter unpacks record.args positionally, so the tuple must survive
        if isinstance(record.args, tuple):
            record.args = tuple(
                _TOKEN_PARAM_RE.sub(r"\1REDACTED", a) if isinstance(a, str) else a
                for a in record.args
            )
        if isinstance(record.msg, str) and "token=" in record.msg:
            record.msg = _TOKEN_PARAM_RE.sub(r"\1REDACTED", record.msg)
        # a uvicorn.access record arriving pre-merged (msg is the whole line,
        # args None — e.g. rebuilt by a queueing handler; the Render
        # "--- Logging error ---" tracebacks on 404 thumb requests showed
        # exactly 'Message: <line>' / 'Arguments: None') cannot survive
        # AccessFormatter, which unpacks record.args into five fields
        # unconditionally. Re-split the line into the native five-tuple so the
        # formatter gets the shape it demands; never null args, never drop the
        # line.
        if record.name == "uvicorn.access" and not record.args and isinstance(record.msg, str):
            m = _ACCESS_LINE_RE.match(record.msg)
            if m:
                client, method, path, version, status = m.groups()
                record.msg = '%s - "%s %s HTTP/%s" %d'
                record.args = (client, method, path, version, int(status))
        return True


def install_log_redaction() -> None:
    """Attach the token scrubber to uvicorn's loggers (idempotent). uvicorn.error
    emits the WebSocket accept lines; uvicorn.access the HTTP request lines."""
    for name in ("uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        if not any(isinstance(f, _RedactTokenFilter) for f in lg.filters):
            lg.addFilter(_RedactTokenFilter())


def install_service_logging() -> None:
    """Give this package's loggers somewhere to go (idempotent).

    uvicorn configures its own uvicorn.* loggers and nothing else. The root
    logger keeps its default WARNING and no handlers, so every ``logger.info``
    in this package was thrown away in the deployed service: the boot line
    saying how many legacy previews had just been measured was written,
    emitted, and dropped, which is why nobody could tell whether that repair
    had ever done anything. One INFO StreamHandler on the package logger and
    the whole of paratrooper reaches the deploy logs, same shape as the
    holddiag logger further down, which had to carry its own handler for
    exactly this reason.

    Scoped to the package rather than the root logger on purpose: root would
    also unmute redis, httpx and asyncio at INFO, and their chatter would bury
    the lines this exists to surface."""
    lg = logging.getLogger("paratrooper")
    if not lg.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
        lg.addHandler(handler)
    lg.setLevel(logging.INFO)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _to_event(thread_id: str, result: ResultMessage) -> ThreadEvent:
    """THE one seam where the worker wire type becomes a chat event. The event
    is persisted verbatim and broadcast identically live and on replay; nothing
    downstream of here sees a ResultMessage."""
    return ThreadEvent(
        thread_id=thread_id, role="agent", kind=result.kind,
        payload=result.payload, ts=_now(),
    )


def _frame(seq: int, event: ThreadEvent, meta: dict[str, ThumbMeta]) -> dict:
    """The one wire shape for keyed events. Events with attachments carry two
    index-aligned lists beside ``attachments``:

    ``attachment_dims`` so the client can reserve each image's box before any
    pixels arrive. An unreserved image renders 0-tall then grows on decode,
    shoving the scroll position under the reader, and a box guessed at the
    wrong ratio squishes a portrait photo into a landscape frame.

    ``attachment_blurhashes`` so it can paint the photo's own colours into that
    box meanwhile, instead of a grey rectangle (the trick Signal's attachment
    pointers carry). Both are null per entry only when the stored preview will
    not decode at all."""
    data = {"seq": seq, **event.model_dump()}
    if event.attachments:
        rows = [meta.get(k) for k in event.attachments]
        data["attachment_dims"] = [(m.width, m.height) if m else None for m in rows]
        data["attachment_blurhashes"] = [m.blurhash if m else None for m in rows]
    return data


def _page_meta(store: ThreadStore, rows: list[tuple[int, ThreadEvent]]) -> dict[str, ThumbMeta]:
    """One attachment lookup for a whole page of events (most events carry
    none). Measures and back-fills anything the store is missing, so a photo
    stored before those columns existed still ships a real size and blurhash."""
    keys = [k for _, m in rows for k in m.attachments]
    return store.thumb_meta(keys) if keys else {}


def _pr_ref(payload: Any) -> str:
    """Short PR reference from a pr event payload ({branch, url} dict; rows
    backfilled from odd legacy bodies may hold a bare url string or nothing)."""
    url = ""
    if isinstance(payload, dict):
        url = str(payload.get("url") or "")
    elif isinstance(payload, str):
        url = payload
    m = re.search(r"/pull/(\d+)", url)
    return f"opened PR #{m.group(1)}" if m else "opened a PR"


def context_line(event: ThreadEvent) -> str | None:
    """Project one persisted event into a job-context line per its kind's policy;
    None drops the row. The prompt is a projection of the thread, not the thread
    itself: a screenshot's data-URI payload and job markers must never reach it."""
    policy = EVENT_POLICY.get(event.kind or "")
    rule = policy.context if policy else "text"  # user rows carry no kind
    if rule == "skip":
        return None
    if rule == "pr_ref":
        return f"{event.role}: {_pr_ref(event.payload)}"
    text = event.payload if isinstance(event.payload, str) else ""
    return f"{event.role}: {text}" if text else None


# a drained worker lingers awake this long before suspending, so the next turn
# of an active conversation doesn't pay the ~30-60s cold boot
DEFAULT_LINGER_S = 300.0


def _linger_seconds() -> float:
    raw = os.environ.get("PARATROOPER_WORKER_LINGER_S", "")
    if not raw:
        return DEFAULT_LINGER_S
    try:
        return float(raw)
    except ValueError:
        logger.warning("ignoring PARATROOPER_WORKER_LINGER_S=%r (want seconds)", raw)
        return DEFAULT_LINGER_S


# --- presence: is the app actually in front of the reader? ---------------------
#
# The push used to go out the instant a result arrived, and the server knew
# nothing about where the reader was. Two failures came straight out of that.
# The app deliberately HOLDS a finished reply while he is typing (pwa/src/hold.ts)
# and can take it back entirely when the next message outruns it (the retract
# path in /api/send) — so a banner and a badge announced a reply that was never
# put on screen, or one that had already been deleted. And when Apple delivered a
# push late, it landed after he had left the app, where the service worker's
# "is a window visible right now" rule no longer suppresses anything.
#
# So the client says where it is, over the socket it already holds open. The
# keep-alive frame it was already sending every 25s doubles as "on screen now",
# and it sends one more frame on the way out. No beacon, no extra request: this
# is the one channel that is open exactly when the app is running.
PRESENCE_PING = "p"  # keep-alive AND "the app is on screen now" (pwa/src/main.ts)
PRESENCE_AWAY = "a"  # sent once as the page goes hidden, before the keep-alive stops

# How old the last "on screen now" may be and still be believed.
#
# Derived from the client's keep-alive interval, which the server cannot read:
# pwa/src/resume.ts sets KEEPALIVE_MS = 25s, so this is two intervals (a ping may
# be missed without the connection being gone) plus ten seconds of margin for a
# slow cellular link. Anything longer and a phone whose "away" frame never made
# it off the device stays "on screen" long enough to swallow a real
# notification; anything shorter and one dropped ping on a bad link starts
# pushing to a reader who is looking straight at the reply.
PRESENCE_FRESH_S = 60.0


@dataclass
class Presence:
    """What one socket last said about itself.

    ``seen`` is a monotonic stamp — the wall clock can step under a long-lived
    socket, and this is a duration question, never a date one. Only a ping
    writes it: ``away`` is a flag over the top, so clearing the flag without a
    fresh ping can never resurrect a stale reading.
    """

    seen: float
    away: bool = False


@dataclass
class AppState:
    config: Config
    store: ThreadStore
    queue: JobQueue
    coordinator: ThreadCoordinator
    inbox: InboxStore
    render: RenderControl | None = None  # set -> worker wakes/sleeps per job
    linger_s: float = field(default_factory=_linger_seconds)
    linger_task: asyncio.Task | None = None  # armed countdown to suspend (at most one)
    sockets: dict[str, set[WebSocket]] = field(default_factory=dict)
    # keyed by the socket itself and scoped through ``sockets`` above, so thread
    # membership is stated in exactly one place and the two cannot drift apart.
    # A socket with no row here has never said anything: see _on_screen.
    presence: dict[WebSocket, Presence] = field(default_factory=dict)
    relay_task: asyncio.Task | None = None
    push_tasks: set[asyncio.Task[None]] = field(default_factory=set)


def _note_presence(state: AppState, thread_id: str, ws: WebSocket, *, on_screen: bool) -> None:
    """Record one presence frame, and put a line on the trail when it CHANGED
    the answer. Every ping would otherwise write a line every 25 seconds per
    socket, for ever, and bury the two edges that actually mean something."""
    record = state.presence.get(ws)
    if record is None:
        record = state.presence[ws] = Presence(seen=time.monotonic())
        changed = True
    else:
        changed = record.away != (not on_screen)
    if on_screen:
        record.seen = time.monotonic()
    record.away = not on_screen
    if changed:
        _diag.info("holddiag presence thread=%s state=%s",
                   thread_id, "on-screen" if on_screen else "away")


def _on_screen(state: AppState, thread_id: str) -> float | None:
    """Age in seconds of the freshest live "on screen now" for this thread, or
    None if nothing on it is in front of the reader.

    A socket that has never sent a ping counts as absent rather than present.
    The two mistakes are not symmetric: a push sent to a reader who is already
    looking at the reply is caught a second time by the service worker's own
    visibility check (pwa/public/sw.js), while a push withheld from someone who
    is not there is simply lost.
    """
    now = time.monotonic()
    fresh: float | None = None
    for ws in state.sockets.get(thread_id, set()):
        record = state.presence.get(ws)
        if record is None or record.away:
            continue
        age = now - record.seen
        if age <= PRESENCE_FRESH_S and (fresh is None or age < fresh):
            fresh = age
    return fresh


async def _enqueue_job(
    state: AppState, thread_id: str, job_id: str, text: str, attachments: list[str]
) -> None:
    context = [
        line for m in state.store.recent(thread_id, n=33)
        if (line := context_line(m)) is not None
    ]
    job = JobMessage(
        job_id=job_id, thread_id=thread_id, text=text, attachments=attachments, context=context
    )
    await state.queue.enqueue(job)
    # durable marker: every user message at/below this seq is covered by a job,
    # so boot-recovery knows exactly what a restart swallowed
    marker = ThreadEvent(
        thread_id=thread_id, role="system", payload=job_id, ts=_now(), kind="job",
    )
    seq = await asyncio.to_thread(state.store.add_message, marker)
    # and broadcast it: the Read flip derives from this row, and a client that
    # misses it live never gets it again (reconnect replay starts past its seq)
    await _send_to_sockets(state, thread_id, {"seq": seq, **marker.model_dump()})
    if state.render:  # wake the worker; the job waits durably in the list meanwhile
        _cancel_linger(state)  # new work: a pending suspend countdown must not fire now
        await state.render.resume_worker()


async def recover_unprocessed(state: AppState) -> int:
    """Feed user messages that a restart swallowed (sent, persisted, but never
    enqueued) back into the coordinator. Returns how many were recovered."""
    rows = await asyncio.to_thread(state.store.unprocessed_user_messages)
    for thread_id, m in rows:
        await state.coordinator.handle_message(thread_id, str(m.payload or ""), m.attachments)
    if rows:
        logger.info("recovered %d unprocessed message(s) after restart", len(rows))
    return len(rows)


async def _worker_idle(state: AppState) -> bool:
    """The drain check: no running job, no buffered batch, no job still
    waiting in the queue."""
    if state.coordinator.has_pending():
        return False
    return await state.queue.pending_jobs() == 0


async def _maybe_suspend_worker(state: AppState) -> None:
    """The worker looks idle — arm the linger countdown instead of suspending
    on the spot (an immediate suspend put a cold boot between conversational
    turns). The suspend lands in ``_linger_then_suspend`` only if the drain
    still holds when the countdown ends; new activity cancels it meanwhile."""
    if state.render is not None and await _worker_idle(state):
        _arm_linger(state)


def _cancel_linger(state: AppState) -> None:
    """Drop the pending suspend countdown — new activity means the worker is
    (or is about to be) needed."""
    if state.linger_task is not None and not state.linger_task.done():
        state.linger_task.cancel()
    state.linger_task = None


def _arm_linger(state: AppState) -> None:
    """(Re)start the countdown to suspend. Replaces any armed one, so
    countdowns never stack."""
    _cancel_linger(state)
    state.linger_task = asyncio.ensure_future(_linger_then_suspend(state))


async def _linger_then_suspend(state: AppState) -> None:
    try:
        await asyncio.sleep(state.linger_s)
    except asyncio.CancelledError:
        return
    try:
        # re-check with the same drain test that armed us: anything that arrived
        # during the linger (buffered batch, queued job) keeps the worker awake
        if state.render is not None and await _worker_idle(state):
            await state.render.suspend_worker()
    except (redis_exc.ConnectionError, redis_exc.TimeoutError) as exc:
        # best-effort like every render call: a missed nap costs money, not
        # correctness — the next drain arms a fresh countdown
        logger.warning("linger suspend check failed: %s", exc)


async def _send_to_sockets(state: AppState, thread_id: str, data: dict) -> None:
    for ws in list(state.sockets.get(thread_id, set())):
        try:
            await ws.send_json(data)
        except Exception:
            state.sockets.get(thread_id, set()).discard(ws)


async def _maybe_push(state: AppState, thread_id: str, kind: str, payload: object = None) -> None:
    """Deliver one notifying result without doing database work in send threads."""
    cfg = push.config()
    text = push.notification_text(kind, payload)
    if cfg is None or text is None:
        return

    # The reader is looking at this thread right now, so the reply is already on
    # its way onto his screen: no banner, no badge. Asked HERE rather than at
    # schedule time so the reading is taken in the last moment before the send —
    # and after the two guards above, so a kind that never notifies at all does
    # not write a "skipped" line for every log frame a job emits.
    if (fresh := _on_screen(state, thread_id)) is not None:
        logger.info("web push skipped: app on screen (thread=%s, fresh=%.1fs)", thread_id, fresh)
        return

    # Snapshot subscriptions before entering provider threads. Cancellation can
    # stop awaiting a thread but cannot stop the thread itself; keeping all
    # store access on the event-loop task makes shutdown safe to close SQLite.
    subscriptions = state.store.subscriptions()
    results = await asyncio.gather(
        *(asyncio.to_thread(push.send_push, sub, text, cfg) for sub in subscriptions),
        return_exceptions=True,
    )
    for sub, result in zip(subscriptions, results, strict=True):
        endpoint = sub.get("endpoint", "")
        if isinstance(result, BaseException):
            logger.warning(
                "web push to %s failed without result (%s)",
                push.endpoint_fingerprint(endpoint),
                type(result).__name__,
            )
        elif not result:
            # The provider says this address no longer exists. Say so out loud:
            # a silent drop was indistinguishable from a delivery that worked.
            logger.info(
                "dropping push subscription %s: the provider says it is gone",
                push.endpoint_fingerprint(endpoint),
            )
            state.store.remove_subscription(endpoint)


def _schedule_push(state: AppState, thread_id: str, kind: str, payload: object = None) -> None:
    """Start best-effort delivery without backpressuring the sole result relay."""
    task = asyncio.create_task(_maybe_push(state, thread_id, kind, payload))
    state.push_tasks.add(task)

    def finished(done: asyncio.Task[None]) -> None:
        state.push_tasks.discard(done)
        if done.cancelled():
            return
        if exc := done.exception():
            logger.warning("web push delivery task failed (%s)", type(exc).__name__)

    task.add_done_callback(finished)


async def _settle_push_tasks(state: AppState, *, cancel: bool = False) -> None:
    """Wait for tracked deliveries, optionally abandoning them during shutdown."""
    while state.push_tasks:
        tasks = tuple(state.push_tasks)
        if cancel:
            for task in tasks:
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        state.push_tasks.difference_update(tasks)


async def _relay_result(state: AppState, thread_id: str, result: ResultMessage) -> None:
    """Relay ONE worker result: persist + fan out per its kind's policy; on a
    terminal ('done'/'error') release the thread's batch. A superseded job — a
    run cancelled because newer messages arrived — is swallowed whole: the
    cancel came before anything was saved, so no event of that run (a done that
    lost the race included) may reach the store or a socket; only the terminal
    bookkeeping still runs, releasing the rerun."""
    policy = EVENT_POLICY[result.kind]
    sockets = len(state.sockets.get(thread_id, set()))
    if state.coordinator.was_superseded(thread_id, result.job_id):
        _diag.info("holddiag relay drop kind=%s job=%s thread=%s reason=superseded terminal=%s",
                   result.kind, result.job_id, thread_id, policy.terminal)
        if policy.terminal:
            await state.coordinator.job_finished(thread_id)
            await _maybe_suspend_worker(state)
        return
    event = _to_event(thread_id, result)
    if policy.ephemeral:  # sockets only: never persisted, never replayed
        _diag.info("holddiag relay ephemeral kind=%s job=%s thread=%s sockets=%d",
                   result.kind, result.job_id, thread_id, sockets)
        await _send_to_sockets(state, thread_id, event.model_dump())
        return
    seq = state.store.add_message(event)  # persisted verbatim
    _diag.info("holddiag relay persist kind=%s job=%s thread=%s seq=%d terminal=%s sockets=%d",
               result.kind, result.job_id, thread_id, seq, policy.terminal, sockets)
    # broadcast the STORED event (+seq so clients advance their
    # catch-up cursor on live pushes) — replay re-sends this frame
    await _send_to_sockets(state, thread_id, {"seq": seq, **event.model_dump()})
    if policy.terminal:
        # Release the job before any notification work. A Redis failure while
        # checking whether to arm the idle timer still propagates so the relay
        # reconnects, but notification delivery is scheduled in either case.
        await state.coordinator.job_finished(thread_id)
        try:
            await _maybe_suspend_worker(state)
        finally:
            # Pass this result's payload directly: no shared "latest reply"
            # lookup that could cross threads/jobs when deliveries overlap. The
            # thread rides along for the same reason: the notification is held
            # back only if THIS thread is the one on screen.
            _schedule_push(state, thread_id, result.kind, result.payload)
    else:
        _schedule_push(state, thread_id, result.kind, result.payload)


async def _result_relay(state: AppState) -> None:
    """Subscribe to all worker result channels and feed each into
    ``_relay_result``. Transient redis errors re-subscribe rather than silently
    killing the task — a dead relay means results stop reaching the phone with
    no visible crash."""
    while True:
        pubsub = state.queue.r.pubsub()
        try:
            await pubsub.psubscribe("paratrooper:results:*")
            async for message in pubsub.listen():
                if message.get("type") != "pmessage":
                    continue
                channel = message["channel"]
                thread_id = channel.rsplit(":", 1)[-1]
                try:
                    result = ResultMessage.model_validate_json(message["data"])
                except ValidationError:
                    # a malformed result (e.g. version skew mid-deploy: a worker
                    # emitting a kind this web build doesn't know) must never
                    # kill the relay task — skip it, keep relaying
                    logger.warning("relay: skipped unparseable result on %s", channel)
                    continue
                await _relay_result(state, thread_id, result)
        except (redis_exc.ConnectionError, redis_exc.TimeoutError) as exc:
            logger.warning("result relay redis error, resubscribing: %s", exc)
            await asyncio.sleep(2)
        finally:
            await pubsub.aclose()


def _lifespan(injected: AppState | None):
    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if injected is not None:
            app.state.app_state = injected
            yield
            return
        config = load_config()
        store = ThreadStore(config.inbox.parent / "threads.sqlite")
        queue = JobQueue(connect())

        async def enqueue_cb(thread_id, job_id, text, attachments):
            await _enqueue_job(app.state.app_state, thread_id, job_id, text, attachments)

        async def interrupt_cb(thread_id, job_id):
            await queue.publish_interrupt(thread_id, job_id)

        coordinator = ThreadCoordinator(enqueue_cb, interrupt_cb)
        state = AppState(
            config=config, store=store, queue=queue, coordinator=coordinator,
            inbox=RedisInbox(queue.r),
            render=RenderControl.from_env(),  # None -> worker stays always-on
        )
        app.state.app_state = state
        state.relay_task = asyncio.ensure_future(_result_relay(state))
        await recover_unprocessed(state)  # restart swallowed nothing silently
        try:
            yield
        finally:
            if state.relay_task:
                state.relay_task.cancel()
                await asyncio.gather(state.relay_task, return_exceptions=True)
            _cancel_linger(state)
            await _settle_push_tasks(state, cancel=True)
            store.close()

    return lifespan


# ===================== TEMP DIAGNOSTIC (remove after the hold session) =====================
# Reply-hold probe, same shape as the removed history-spinner one (74b0095).
# Two halves:
#   - _holddiag_latest: the latest hold event trail POSTed by the PWA
#     (pwa/src/hold.ts, same banner). The phone has no reachable console, so
#     the client posts its trail here and it is read back with a curl on
#     GET /api/debug/holddiag, bearing the app token like every other call.
#     Single web instance, so a module global (latest wins) is fine.
#   - the "paratrooper.holddiag" logger: one structured line per batching and
#     delivery decision (this file + batching.py), tagged "holddiag" so the
#     deploy logs alone reconstruct a session. It used to carry its own INFO
#     StreamHandler because nothing configured logging under uvicorn; it now
#     rides install_service_logging's package handler like every other logger
#     here, so these lines are not printed twice.
# TO REMOVE: delete this block, the two /api/debug/holddiag routes below, every
# _diag line in this file and batching.py, and the matching TEMP DIAGNOSTIC
# block in pwa/src/hold.ts.
_holddiag_latest: dict[str, Any] = {}
_diag = logging.getLogger("paratrooper.holddiag")
# =================== END TEMP DIAGNOSTIC (remove after the hold session) ===================


def create_app(injected: AppState | None = None) -> FastAPI:
    install_service_logging()
    install_log_redaction()
    # The interactive docs and the schema they are built from are off. They take
    # no token, so in the deployed service they were an unauthenticated index of
    # every route, its method and its request shape — a map handed to anyone who
    # guessed the hostname, and of no use at all to a single-user phone client
    # that was written against these routes by hand.
    app = FastAPI(
        title="Paratrooper",
        lifespan=_lifespan(injected),
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    def st() -> AppState:
        return app.state.app_state

    @app.get("/api/health")
    async def health() -> dict:
        # Render injects RENDER_GIT_COMMIT; 'dev' locally. Ground truth for
        # "which code is actually serving" — no more guessing.
        return {"ok": True, "version": os.environ.get("RENDER_GIT_COMMIT", "dev")[:7]}

    @app.post("/api/upload", response_model=UploadResponse, dependencies=[Depends(require_token)])
    async def upload(file: UploadFile) -> UploadResponse:
        content = await file.read()
        key = new_key(file.filename)
        await st().inbox.put(key, content)  # cross-service store (Key Value on Render)
        # persist a small preview NOW — the inbox blob expires in ~24h and this
        # is the only pixel record history replay will have. Its dimensions and
        # blurhash ride along so message frames can tell the client how big each
        # box is and what to paint in it. Measured here rather than left to the
        # first read purely to save that read the work; a row that somehow
        # arrives without them heals the first time it is looked at.
        thumb = await asyncio.to_thread(make_thumbnail, content)
        if thumb is not None:
            data, w, h = thumb
            blurhash = await asyncio.to_thread(image_blurhash, data)
            await asyncio.to_thread(
                st().store.add_thumbnail, key, data, ts=_now(),
                width=w, height=h, blurhash=blurhash,
            )
        return UploadResponse(inbox_key=key, content_type=file.content_type, size=len(content))

    @app.get("/api/thumb/{key}")
    async def thumb(key: str, token: str = "") -> Response:
        # token rides the query string like /ws does: <img src> can't set headers
        if not verify_token(token):
            raise HTTPException(status_code=401, detail="bad token")
        row = await asyncio.to_thread(st().store.thumbnail, key)
        if row is None:
            raise HTTPException(status_code=404, detail="no thumbnail")
        data, content_type = row
        return Response(content=data, media_type=content_type,
                        headers={"Cache-Control": "private, max-age=31536000, immutable"})

    @app.post("/api/send", dependencies=[Depends(require_token)])
    async def send(req: SendRequest) -> dict:
        state = st()
        # activity: cancel any suspend countdown BEFORE the first await, so a
        # countdown firing mid-request can't nap the worker under this message
        _cancel_linger(state)
        # the take-back: replies the client held unseen die before the message
        # that outran them. Validation lives inside the delete (thread-scoped,
        # agent-only) — nonsense seqs delete nothing, harmlessly. Deletion
        # precedes handle_message, so store.recent — the rerun's context — can
        # never see a retracted reply; the retract frame carries its seq in a
        # dedicated field (no top-level ``seq``) so a stale client treats it
        # as ephemeral and ignores it instead of rendering a ghost bubble.
        if req.retract_seqs:
            retracted = await asyncio.to_thread(
                state.store.delete_agent_messages, req.thread_id, req.retract_seqs
            )
            for rseq in retracted:
                _diag.info("holddiag relay retract thread=%s seq=%d", req.thread_id, rseq)
                await _send_to_sockets(
                    state, req.thread_id,
                    {"thread_id": req.thread_id, "kind": "retract", "retract_seq": rseq},
                )
        msg = ThreadEvent(
            thread_id=req.thread_id, role="user", payload=req.text,
            attachments=req.attachments, ts=_now(),
        )
        seq = await asyncio.to_thread(state.store.add_message, msg)
        status = await state.coordinator.handle_message(req.thread_id, req.text, req.attachments)
        _diag.info("holddiag send thread=%s seq=%d status=%s", req.thread_id, seq, status)
        # re-arm if this message left everything drained (a STOP can discard
        # the only pending batch — the worker must still get to sleep later)
        await _maybe_suspend_worker(state)
        # The ACK IS the frame: the same wire shape /api/history returns for
        # this seq, built from the event just stored. The client adopts it
        # whole instead of inventing a frame and then fetching the real one
        # back, so a photo send's sizes and blurhashes arrive with the ACK and
        # every stored row carries the server clock. A text-only send pays
        # nothing extra for it: with no attachment keys the meta lookup skips
        # its query and _frame short-circuits. ``status`` and ``seq`` stay
        # where they were; the frame carries seq too.
        meta = await asyncio.to_thread(_page_meta, state.store, [(seq, msg)])
        return {"status": status, **_frame(seq, msg, meta)}

    @app.get("/api/thread/{thread_id}", dependencies=[Depends(require_token)])
    async def thread(thread_id: str, since: int = 0) -> dict:
        rows = await asyncio.to_thread(st().store.messages, thread_id, since_seq=since)
        meta = await asyncio.to_thread(_page_meta, st().store, rows)
        return {"messages": [_frame(seq, m, meta) for seq, m in rows]}

    @app.get("/api/history/{thread_id}", dependencies=[Depends(require_token)])
    async def history(thread_id: str, before: int, limit: int = 50) -> dict:
        """One older page for pull-down-at-top (oldest-first, like the socket)."""
        rows = await asyncio.to_thread(
            st().store.messages_page, thread_id, before_seq=before, limit=min(limit, 200)
        )
        meta = await asyncio.to_thread(_page_meta, st().store, rows)
        return {"messages": [_frame(seq, m, meta) for seq, m in rows]}

    @app.post("/api/publish", dependencies=[Depends(require_token)])
    async def publish(req: PublishRequest) -> JSONResponse:
        state = st()
        remote = state.config.remote
        if not remote:
            raise HTTPException(status_code=400, detail="site remote not configured")
        try:
            owner, repo = owner_repo_from_remote(remote)
            if req.pr.strip():
                number = parse_pr_number(req.pr)
            else:
                # pr rows persisted before 6da5b3c carry an empty payload —
                # resolve the one open agent PR instead of 409ing on it
                found = await asyncio.to_thread(
                    find_open_pr, owner, repo,
                    token=merge_token(), branch_prefix=state.config.branch_prefix,
                )
                number = int(found["number"])
            result = await asyncio.to_thread(
                merge_pull_request, owner, repo, number, token=merge_token()
            )
        except PublishError as exc:
            # surface WHY (already merged, conflicts, bad PR ref) instead of a 500
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        published = ThreadEvent(
            thread_id=req.thread_id, role="system",
            payload=f"published PR #{number}", ts=_now(), kind="published",
        )
        seq = await asyncio.to_thread(state.store.add_message, published)
        # live confirmation on the phone, not just a row in history
        await _send_to_sockets(state, req.thread_id, {"seq": seq, **published.model_dump()})
        return JSONResponse({"merged": True, "sha": result.get("sha")})

    @app.get("/api/push/key", dependencies=[Depends(require_token)])
    async def push_key() -> dict:
        return {"key": push.public_key()}  # null when push isn't configured

    @app.post("/api/push/subscribe", dependencies=[Depends(require_token)])
    async def push_subscribe(subscription: dict) -> dict:
        """Register this device's push address, REPLACING the one it rotated off.

        A phone's endpoint can change while the app is closed, and nothing in
        the subscription tells the server that the new address and an old row
        are the same device — so a plain add left both, and every result went
        out twice, once into an address Apple accepts and never shows. The
        client (page on open, worker on the rotation event) names the address it
        supersedes in "replaces"; that row leaves in this same request.

        "replaces" is transport, not part of the subscription, so it is taken
        off before the record is stored. Adding comes first: a failure between
        the two steps must leave the phone reachable, never unreachable.
        """
        replaces = subscription.pop("replaces", None)
        endpoint = subscription.get("endpoint")
        if not endpoint:
            raise HTTPException(status_code=400, detail="subscription missing endpoint")
        store = st().store
        # keyed by endpoint, so re-registering an unchanged address is an upsert
        await asyncio.to_thread(store.add_subscription, endpoint, json.dumps(subscription))
        if isinstance(replaces, str) and replaces and replaces != endpoint:
            await asyncio.to_thread(store.remove_subscription, replaces)
            logger.info(
                "push subscription %s replaces %s (old row dropped)",
                push.endpoint_fingerprint(endpoint),
                push.endpoint_fingerprint(replaces),
            )
        return {"ok": True}

    @app.websocket("/ws")
    async def ws(websocket: WebSocket) -> None:
        token = websocket.query_params.get("token")
        thread_id = websocket.query_params.get("thread", "default")
        since = int(websocket.query_params.get("since", "0"))
        if not verify_token(token):
            await websocket.close(code=4401)
            return
        await websocket.accept()
        state = st()
        state.sockets.setdefault(thread_id, set()).add(websocket)
        # catch-up: replay everything the client missed
        if since == 0:
            # fresh login: only the recent window — older pages come via
            # /api/history as the user pulls down (a year of thread should
            # not replay on every reinstall)
            rows = await asyncio.to_thread(state.store.messages_page, thread_id, limit=50)
        else:
            rows = await asyncio.to_thread(state.store.messages, thread_id, since_seq=since)
        meta = await asyncio.to_thread(_page_meta, state.store, rows)
        for seq, m in rows:
            await websocket.send_json(_frame(seq, m, meta))
        _diag.info("holddiag ws open thread=%s since=%d replayed=%d sockets=%d",
                   thread_id, since, len(rows), len(state.sockets.get(thread_id, set())))
        try:
            while True:
                # the only frames the client sends up this socket, and both are
                # one byte: where the reader is. Sends still go via POST, and
                # anything else is ignored exactly as it always was.
                frame = await websocket.receive_text()
                if frame == PRESENCE_PING:
                    _note_presence(state, thread_id, websocket, on_screen=True)
                elif frame == PRESENCE_AWAY:
                    _note_presence(state, thread_id, websocket, on_screen=False)
        except WebSocketDisconnect:
            pass
        finally:
            state.sockets.get(thread_id, set()).discard(websocket)
            # the record dies with the socket: a phone iOS took the connection
            # away from has said nothing, which is not the same as being here
            if state.presence.pop(websocket, None) is not None:
                _diag.info("holddiag presence thread=%s state=closed", thread_id)
            _diag.info("holddiag ws close thread=%s sockets=%d",
                       thread_id, len(state.sockets.get(thread_id, set())))

    # ===================== TEMP DIAGNOSTIC (remove after the hold session) =====================
    # reply-hold probe: the PWA POSTs its hold event trail (the phone has no
    # reachable console) and a curl reads it back. Latest POST wins. The digest
    # line puts the release reasons into the deploy logs, so logs alone tell WHY
    # the hold let go even if nobody curls the GET.
    #
    # Both carry the token like everything else. They were left open so that
    # curl could be typed without one, and the convenience was not worth what it
    # bought: the GET was handing any stranger the shape of a private
    # conversation — how many messages, of what kind, in what order, the moments
    # someone was typing in it, the geometry of the phone it was read on — while
    # the POST let that same stranger replace the buffer, hold a payload of
    # their choosing in the service's memory, and write text of their choosing
    # into the deploy logs, which are the one record a device session is
    # reconstructed from. The curl now sends the header the phone already sends.
    # TO REMOVE: delete these two routes, the TEMP DIAGNOSTIC block above
    # _holddiag_latest, and the matching pwa/src/hold.ts block.
    @app.post("/api/debug/holddiag", dependencies=[Depends(require_token)])
    async def debug_holddiag_post(payload: dict) -> dict:
        _holddiag_latest.clear()
        _holddiag_latest.update(payload)
        events = payload.get("events") or []
        # "resume"/"resume-ride" ride BOTH this line and the viewport one below,
        # and the duplication is deliberate. A return to the screen is at most
        # four records, so it costs nothing; here it is the headline (a return
        # happened at all, was the socket replaced, was the bottom taken and
        # why), and below it sits in among the followTail flips and scroll
        # ghosts that are the only things that can explain a landing that went
        # wrong. Named in neither, they reached the deploy logs from nowhere —
        # a record the client posts but no block here claims is dropped on
        # arrival, which is exactly how the whole channel went missing before.
        marks = [e for e in events if isinstance(e, dict)
                 and e.get("ev") in ("held", "release", "pass", "reset", "vis",
                                     "retract-sent", "retract-applied", "cache-read",
                                     "cache-applied", "batch-commit", "reconcile-drop",
                                     "resume", "resume-ride")]
        _diag.info("holddiag client build=%s events=%d marks=%s",
                   payload.get("build"), len(events), json.dumps(marks[-10:]))
        # viewport/flight digest, its own line so the hold pin above holds: the
        # autosize decisions, snap-back doors, followTail flips, and flight
        # deltas the client recorded — deploy logs alone reconstruct why the
        # view moved even if nobody curls the GET
        vp = [e for e in events if isinstance(e, dict)
              and e.get("ev") in ("autosize", "vv-geom", "snapback",
                                  "followtail", "ft-suppress", "flight",
                                  "shell-size", "kb-close", "send-motion",
                                  "receipt-hold", "boot-motion", "boot-repin",
                                  "grow-blink", "kb-shove",
                                  "kb-focusing", "kb-lift", "lift-pad", "shell-pin",
                                  "dom-census", "pick-anchor", "tail-gap",
                                  "scroll-ghost",
                                  "resume", "resume-ride")]
        if vp:
            _diag.info("holddiag viewport events=%d tail=%s",
                       len(vp), json.dumps(vp[-20:]))
        # boot-window digest, its own line and HEAD-first: the cold-open
        # recorder's earliest records are the verdict (the frame settles right
        # after first paint), and the viewport tail above would clip them the
        # moment a session gets busy
        bm = [e for e in events if isinstance(e, dict)
              and e.get("ev") in ("boot-motion", "boot-repin", "boot-blank",
                                  "safe-area")]
        if bm:
            _diag.info("holddiag boot events=%d head=%s", len(bm), json.dumps(bm[:30]))
        # keyboard-close frame trail, its own line and a long tail: ONE close
        # writes about thirty kb-fall records, which would flush every other
        # mark out of the viewport tail above if they rode it
        kf = [e for e in events if isinstance(e, dict) and e.get("ev") == "kb-fall"]
        if kf:
            _diag.info("holddiag fall events=%d tail=%s", len(kf), json.dumps(kf[-40:]))
        # keyboard-raise frame trail, its own line for exactly the same reason:
        # the raise probe writes the same thirty records per edge, and the two
        # trails must not clip each other either: a session that raises and
        # closes in one breath posts once, and a shared line would leave one of
        # the two motions half recorded
        kr = [e for e in events if isinstance(e, dict) and e.get("ev") == "kb-rise"]
        if kr:
            _diag.info("holddiag rise events=%d tail=%s", len(kr), json.dumps(kr[-40:]))
        # keyboard-edge marks, their own line as well. Only two per keyboard
        # cycle, so volume is not the reason: they carry the answer this session
        # was built for, and the viewport tail above holds the last twenty marks
        # of every kind, so a busy typing session would push them out. On their
        # own line a dozen cycles survive whatever else the trail is doing.
        ke = [e for e in events if isinstance(e, dict) and e.get("ev") == "kb-edge"]
        if ke:
            _diag.info("holddiag edge events=%d tail=%s", len(ke), json.dumps(ke[-24:]))
        # scroll-jank records, their own line: one
        # record batches a whole gesture (both frame cadences, the ten worst
        # gaps with what ran inside them), so records are wide and few, and a
        # twelve-record tail holds a whole test drive of gestures whole.
        # TEMP DIAGNOSTIC (scroll-jank, pwa/src/scrolljank.ts owns the banner):
        # remove this block and its test in tests/test_holddiag.py with it.
        sj = [e for e in events if isinstance(e, dict) and e.get("ev") == "scroll-jank"]
        if sj:
            _diag.info("holddiag jank events=%d tail=%s", len(sj), json.dumps(sj[-12:]))
        # pick-timing records, their own line for the jank line's reason: one
        # record batches a whole photo pick (every step's offset from the file
        # input's change event out to the frame the picture is painted in, the
        # file's kind and size, and the blocked-time summary), so records are
        # wide and few. A twenty-record tail holds ten picks whole, which is the
        # sample the session needs, and on the shared viewport tail a couple of
        # picks would clip everything else off it.
        # TEMP DIAGNOSTIC (pick-timing, pwa/src/picktiming.ts owns the banner):
        # remove this block and its test in tests/test_holddiag.py with it.
        pt = [e for e in events if isinstance(e, dict) and e.get("ev") == "pick-timing"]
        if pt:
            _diag.info("holddiag pick events=%d tail=%s", len(pt), json.dumps(pt[-20:]))
        # photo-box records, their own line: a photo the app was never told the
        # size of gets a guessed box that reshapes when the pixels land, which
        # shoves everything below it down the page. The marks are the whole
        # story of that — the guess being made, the real size arriving, the view
        # being held still across the correction, and now the served pixels of a
        # photo that never guessed at all being compared to the size it was
        # promised, since the eyewitness account is of exactly that branch
        # reshaping and the box is written in a way that would let it. They only
        # mean anything read together, so they share one line and no other. Note
        # that every mark below has to be named here or it is silently dropped: a
        # record the client posts but no block claims never reaches the logs at
        # all, which is exactly how this channel went missing.
        #
        # photo-strip is the answer that came out of all of the above, standing
        # watch over itself. The reshape was never the pixels: a parked photo has
        # no source at all, and WebKit took the box's shape from the ALT TEXT,
        # which is one wide strip whatever picture is coming. The photo now
        # declares its real ratio, and this mark is the box being measured
        # against the size it was promised in the last moment before the source
        # goes on. It should never arrive. One that does names an engine doing
        # the same thing again.
        # TEMP DIAGNOSTIC (photo boxes, pwa/src/main.ts owns the banners):
        # remove this block and its test in tests/test_holddiag.py with it.
        pb = [e for e in events if isinstance(e, dict)
              and e.get("ev") in ("guessed-box", "sized-box", "photo-learned",
                                  "keep-view", "served-shape", "photo-strip")]
        if pb:
            _diag.info("holddiag photo events=%d tail=%s", len(pb), json.dumps(pb[-30:]))
        # tail-settle records, their own line. The client has been posting these
        # for some time and no block here ever claimed them, so every one was
        # discarded on arrival — the same way the photo-box marks above went
        # missing, and this time on the channel carrying the app's only scroll
        # write. Two shapes ride it: one settle, which carries mode, and a whole
        # run of the per-frame ones folded into a summary, which carries n. A box
        # that eases rather than hops writes a run of them, so the tail is
        # generous enough to hold several beats whole.
        # TEMP DIAGNOSTIC (blank-thread, pwa/src/viewport.ts owns the banner):
        # remove this block and its test in tests/test_holddiag.py with it.
        tl = [e for e in events if isinstance(e, dict) and e.get("ev") == "tail-settle"]
        if tl:
            _diag.info("holddiag settle events=%d tail=%s", len(tl), json.dumps(tl[-24:]))
        # thread-blank records, their own line: one record batches a whole armed
        # photo cancel — seven readings of the conversation's geometry, from
        # before the tap out to the frame after the touch that repaired it — so
        # records are wide and few. Six is more device sessions than the question
        # needs, and on the shared viewport tail a single record would clip
        # everything else off it.
        # TEMP DIAGNOSTIC (blank-thread, pwa/src/blankprobe.ts owns the banner):
        # remove this block and its test in tests/test_holddiag.py with it.
        tb = [e for e in events if isinstance(e, dict) and e.get("ev") == "thread-blank"]
        if tb:
            _diag.info("holddiag blank events=%d tail=%s", len(tb), json.dumps(tb[-6:]))
        # the scroll writes nobody made: scroll-ghost is every move of the
        # thread's scroll no app write accounts for, which is what decides
        # whether the engine or one of our own unannounced writers put it
        # there. It rides the viewport tuple above like every motion mark, AND
        # this line of its own: one record per unexplained run, and the
        # viewport tail keeps only the last twenty marks of every kind, so a
        # busy typing session would push exactly the answer off the end of it.
        # (kb-restore, the post-close correction that used to share this line,
        # is gone with the box change it corrected: pwa/src/viewport.ts.)
        # TEMP DIAGNOSTIC (scroll-ghost, pwa/src/scrollghost.ts owns the
        # banner): drop "scroll-ghost" from the tuple above and delete this
        # block when that block goes.
        kr = [e for e in events if isinstance(e, dict) and e.get("ev") == "scroll-ghost"]
        if kr:
            _diag.info("holddiag ghost events=%d tail=%s", len(kr), json.dumps(kr[-16:]))
        return {"ok": True}

    @app.get("/api/debug/holddiag", dependencies=[Depends(require_token)])
    async def debug_holddiag_get() -> dict:
        return _holddiag_latest
    # =================== END TEMP DIAGNOSTIC (remove after the hold session) ===================

    # serve the built PWA if present (mounted last so /api and /ws win)
    pwa_dist = _pwa_dist()
    if pwa_dist is not None:
        app.mount("/", StaticFiles(directory=str(pwa_dist), html=True), name="pwa")

    return app


def _pwa_dist():
    from pathlib import Path

    # repo_root/pwa/dist ; this file is src/paratrooper/web/app.py
    candidate = Path(__file__).resolve().parents[3] / "pwa" / "dist"
    return candidate if candidate.is_dir() else None
