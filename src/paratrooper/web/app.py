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
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime

from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from redis import exceptions as redis_exc

from ..agent.config import Config, load_config
from . import push
from .auth import require_token, verify_token
from .batching import ThreadCoordinator
from .db import ThreadStore
from .inbox import InboxStore, RedisInbox, new_key
from .models import (
    JobMessage,
    PublishRequest,
    ResultMessage,
    SendRequest,
    ThreadMessage,
    UploadResponse,
)
from .publish import merge_pull_request, merge_token, owner_repo_from_remote, parse_pr_number
from .queue import JobQueue, connect
from .render_control import RenderControl

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass
class AppState:
    config: Config
    store: ThreadStore
    queue: JobQueue
    coordinator: ThreadCoordinator
    inbox: InboxStore
    render: RenderControl | None = None  # set -> worker wakes/sleeps per job
    sockets: dict[str, set[WebSocket]] = field(default_factory=dict)
    relay_task: asyncio.Task | None = None


async def _enqueue_job(
    state: AppState, thread_id: str, job_id: str, text: str, attachments: list[str]
) -> None:
    context = [f"{m.role}: {m.body}" for m in state.store.recent(thread_id, n=10) if m.body]
    job = JobMessage(
        job_id=job_id, thread_id=thread_id, text=text, attachments=attachments, context=context
    )
    await state.queue.enqueue(job)
    if state.render:  # wake the worker; the job waits durably in the list meanwhile
        await state.render.resume_worker()


async def _maybe_suspend_worker(state: AppState) -> None:
    """Sleep the worker once nothing needs it: no running job, no buffered
    batch, no job still waiting in the queue."""
    if state.render is None or state.coordinator.has_pending():
        return
    if await state.queue.pending_jobs() > 0:
        return
    await state.render.suspend_worker()


async def _send_to_sockets(state: AppState, thread_id: str, data: dict) -> None:
    for ws in list(state.sockets.get(thread_id, set())):
        try:
            await ws.send_json(data)
        except Exception:
            state.sockets.get(thread_id, set()).discard(ws)


async def _maybe_push(state: AppState, result: ResultMessage) -> None:
    """Wake a closed PWA on a terminal result (no-op if VAPID isn't configured)."""
    cfg = push.config()
    text = push.notification_text(result.kind)
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
                result = ResultMessage.model_validate_json(message["data"])
                body = result.payload if isinstance(result.payload, str) else ""
                seq = state.store.add_message(ThreadMessage(
                    thread_id=thread_id, role="agent", body=body, ts=_now(), kind=result.kind,
                ))
                # carry seq so clients advance their catch-up cursor on live
                # pushes too (otherwise reconnect replays from a stale point)
                await _send_to_sockets(state, thread_id, {"seq": seq, **result.model_dump()})
                await _maybe_push(state, result)
                if result.kind in ("done", "error"):
                    # job_finished first: it re-arms the timer for any buffered
                    # batch, so has_pending() correctly blocks the suspend then
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
        try:
            yield
        finally:
            if state.relay_task:
                state.relay_task.cancel()
            store.close()

    return lifespan


def create_app(injected: AppState | None = None) -> FastAPI:
    app = FastAPI(title="Paratrooper", lifespan=_lifespan(injected))

    def st() -> AppState:
        return app.state.app_state

    @app.get("/api/health")
    async def health() -> dict:
        return {"ok": True}

    @app.post("/api/upload", response_model=UploadResponse, dependencies=[Depends(require_token)])
    async def upload(file: UploadFile) -> UploadResponse:
        content = await file.read()
        key = new_key(file.filename)
        await st().inbox.put(key, content)  # cross-service store (Key Value on Render)
        return UploadResponse(inbox_key=key, content_type=file.content_type, size=len(content))

    @app.post("/api/send", dependencies=[Depends(require_token)])
    async def send(req: SendRequest) -> dict:
        state = st()
        msg = ThreadMessage(
            thread_id=req.thread_id, role="user", body=req.text,
            attachments=req.attachments, ts=_now(),
        )
        seq = await asyncio.to_thread(state.store.add_message, msg)
        status = await state.coordinator.handle_message(req.thread_id, req.text, req.attachments)
        return {"status": status, "seq": seq}  # seq: client advances its catch-up cursor

    @app.get("/api/thread/{thread_id}", dependencies=[Depends(require_token)])
    async def thread(thread_id: str, since: int = 0) -> dict:
        rows = await asyncio.to_thread(st().store.messages, thread_id, since_seq=since)
        return {"messages": [{"seq": seq, **m.model_dump()} for seq, m in rows]}

    @app.post("/api/publish", dependencies=[Depends(require_token)])
    async def publish(req: PublishRequest) -> JSONResponse:
        state = st()
        remote = state.config.remote
        if not remote:
            raise HTTPException(status_code=400, detail="site remote not configured")
        owner, repo = owner_repo_from_remote(remote)
        number = parse_pr_number(req.pr)
        result = await asyncio.to_thread(
            merge_pull_request, owner, repo, number, token=merge_token()
        )
        published = ThreadMessage(
            thread_id=req.thread_id, role="system",
            body=f"published PR #{number}", ts=_now(), kind="published",
        )
        await asyncio.to_thread(state.store.add_message, published)
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
        for seq, m in await asyncio.to_thread(state.store.messages, thread_id, since_seq=since):
            await websocket.send_json({"seq": seq, **m.model_dump()})
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
