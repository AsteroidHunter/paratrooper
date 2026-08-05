"""FastAPI web service: PWA host + auth gate + uploads + threads + socket + publish.

Holds the socket, serves the PWA, gates every request/socket on the shared token,
stages uploads to the inbox, persists threads to SQLite, debounce-batches messages
into worker jobs over the Key Value queue, relays streamed results back over the
socket, and owns the /publish merge authority.

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
from .db import ThreadStore
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
from .thumbs import make_thumbnail

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


def _frame(seq: int, event: ThreadEvent, dims: dict[str, tuple[int, int]]) -> dict:
    """The one wire shape for keyed events. Events with attachments carry
    ``attachment_dims`` (same order as ``attachments``, null for legacy rows
    without recorded sizes) so the client can reserve each image's box before
    any pixels arrive — an unreserved image renders 0-tall then grows on
    decode, shoving the scroll position under the reader."""
    data = {"seq": seq, **event.model_dump()}
    if event.attachments:
        data["attachment_dims"] = [dims.get(k) for k in event.attachments]
    return data


def _page_dims(store: ThreadStore, rows: list[tuple[int, ThreadEvent]]) -> dict:
    """One dims lookup for a whole page of events (most events carry none)."""
    keys = [k for _, m in rows for k in m.attachments]
    return store.thumb_dims(keys) if keys else {}


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
    relay_task: asyncio.Task | None = None


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


async def _maybe_push(state: AppState, kind: str) -> None:
    """Wake a closed PWA on a notifying result (no-op if VAPID isn't configured)."""
    cfg = push.config()
    text = push.notification_text(kind)
    if cfg is None or text is None:
        return

    def _send() -> None:
        for sub in state.store.subscriptions():
            if not push.send_push(sub, text, cfg):
                state.store.remove_subscription(sub.get("endpoint", ""))

    await asyncio.to_thread(_send)


async def _result_relay(state: AppState) -> None:
    """Subscribe to all worker result channels: persist each to the thread and
    fan out to connected sockets; on 'done'/'error' release the thread's batch.
    Transient redis errors re-subscribe rather than silently killing the task —
    a dead relay means results stop reaching the phone with no visible crash."""
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
                policy = EVENT_POLICY[result.kind]
                event = _to_event(thread_id, result)
                if policy.ephemeral:  # sockets only: never persisted, never replayed
                    await _send_to_sockets(state, thread_id, event.model_dump())
                    continue
                seq = state.store.add_message(event)  # persisted verbatim
                # broadcast the STORED event (+seq so clients advance their
                # catch-up cursor on live pushes) — replay re-sends this frame
                await _send_to_sockets(state, thread_id, {"seq": seq, **event.model_dump()})
                await _maybe_push(state, result.kind)
                if policy.terminal:
                    # job_finished first: it re-arms the timer for any buffered
                    # batch, so has_pending() correctly blocks the linger then
                    await state.coordinator.job_finished(thread_id)
                    await _maybe_suspend_worker(state)
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
            _cancel_linger(state)
            store.close()

    return lifespan


def create_app(injected: AppState | None = None) -> FastAPI:
    install_log_redaction()
    app = FastAPI(title="Paratrooper", lifespan=_lifespan(injected))

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
        # is the only pixel record history replay will have. Its dimensions ride
        # along so message frames can tell the client how big each box is.
        thumb = await asyncio.to_thread(make_thumbnail, content)
        if thumb is not None:
            data, w, h = thumb
            await asyncio.to_thread(
                st().store.add_thumbnail, key, data, ts=_now(), width=w, height=h
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
        msg = ThreadEvent(
            thread_id=req.thread_id, role="user", payload=req.text,
            attachments=req.attachments, ts=_now(),
        )
        seq = await asyncio.to_thread(state.store.add_message, msg)
        status = await state.coordinator.handle_message(req.thread_id, req.text, req.attachments)
        # re-arm if this message left everything drained (a STOP can discard
        # the only pending batch — the worker must still get to sleep later)
        await _maybe_suspend_worker(state)
        return {"status": status, "seq": seq}  # seq: client advances its catch-up cursor

    @app.get("/api/thread/{thread_id}", dependencies=[Depends(require_token)])
    async def thread(thread_id: str, since: int = 0) -> dict:
        rows = await asyncio.to_thread(st().store.messages, thread_id, since_seq=since)
        dims = await asyncio.to_thread(_page_dims, st().store, rows)
        return {"messages": [_frame(seq, m, dims) for seq, m in rows]}

    @app.get("/api/history/{thread_id}", dependencies=[Depends(require_token)])
    async def history(thread_id: str, before: int, limit: int = 50) -> dict:
        """One older page for pull-down-at-top (oldest-first, like the socket)."""
        rows = await asyncio.to_thread(
            st().store.messages_page, thread_id, before_seq=before, limit=min(limit, 200)
        )
        dims = await asyncio.to_thread(_page_dims, st().store, rows)
        return {"messages": [_frame(seq, m, dims) for seq, m in rows]}

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
        endpoint = subscription.get("endpoint")
        if not endpoint:
            raise HTTPException(status_code=400, detail="subscription missing endpoint")
        await asyncio.to_thread(st().store.add_subscription, endpoint, json.dumps(subscription))
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
        dims = await asyncio.to_thread(_page_dims, state.store, rows)
        for seq, m in rows:
            await websocket.send_json(_frame(seq, m, dims))
        try:
            while True:
                await websocket.receive_text()  # client keepalive / pings; sends go via POST
        except WebSocketDisconnect:
            pass
        finally:
            state.sockets.get(thread_id, set()).discard(websocket)

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
