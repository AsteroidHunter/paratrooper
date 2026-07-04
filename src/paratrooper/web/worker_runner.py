"""Worker service loop: consume jobs from Key Value, run them, stream results back.

Bridges Phase 4's queue to Phase 3's ``run_job``. One job at a time (the web
coordinator guarantees one in-flight job per thread, and a single worker instance
processes sequentially). A concurrent interrupt listener cancels the running job
when a STOP/CANCEL for its thread arrives, then reports it so the web releases
the next batch.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
from pathlib import Path

from redis import exceptions as redis_exc

from ..agent.config import Config, github_token, load_config
from ..agent.siterepo import SiteRepo
from ..agent.worker import Job, run_job
from .inbox import DiskInbox, RedisInbox
from .models import JobMessage, ResultMessage
from .queue import JobQueue, connect

logger = logging.getLogger(__name__)

# transient transport failures: retry with a short pause, never kill the process
_REDIS_TRANSIENT = (redis_exc.ConnectionError, redis_exc.TimeoutError)


def _screenshot_data_uri(path: str) -> str:
    """Read a worker-local PNG into a data URI. Web and worker don't share a
    disk on Render, so the screenshot rides the result channel as base64 rather
    than a path the PWA can't resolve."""
    data = base64.b64encode(Path(path).read_bytes()).decode()
    return f"data:image/png;base64,{data}"


class Worker:
    def __init__(self, queue: JobQueue, *, auth_mode: str | None = None) -> None:
        self.queue = queue
        self.auth_mode = auth_mode
        self.inbox = RedisInbox(queue.r)  # shared store; web put, worker get
        self._config: Config | None = None
        self._current_thread: str | None = None
        self._current_job: str | None = None
        self._task: asyncio.Task | None = None

    def _cfg(self) -> Config:
        if self._config is None:
            self._config = load_config()
        return self._config

    async def _materialize(self, keys: list[str]) -> None:
        """Pull staged uploads from the shared store onto the worker's local
        inbox so the image tool can read them as plain files."""
        local = DiskInbox(self._cfg().inbox)
        for key in keys:
            await local.put(key, await self.inbox.get(key))

    async def _cleanup(self, keys: list[str]) -> None:
        local = DiskInbox(self._cfg().inbox)
        for key in keys:
            with contextlib.suppress(Exception):
                await self.inbox.delete(key)
                await local.delete(key)

    async def _on_event(self, thread_id: str, event: dict) -> None:
        await self.queue.publish_result(thread_id, ResultMessage(**event))

    async def _run_one(self, msg: JobMessage) -> None:
        job = Job(
            job_id=msg.job_id,
            thread_id=msg.thread_id,
            text=msg.text,
            attachments=msg.attachments,
            context=msg.context,
            pin_hint=msg.pin_hint,
        )

        async def on_event(event: dict) -> None:
            if event.get("kind") == "screenshot" and isinstance(event.get("payload"), str):
                with contextlib.suppress(OSError):
                    event = {**event, "payload": await asyncio.to_thread(
                        _screenshot_data_uri, event["payload"]
                    )}
            await self._on_event(msg.thread_id, event)

        try:
            await self._materialize(msg.attachments)
            await run_job(job, config=self._cfg(), auth_mode=self.auth_mode, on_event=on_event)
        except asyncio.CancelledError:
            # interrupted: tell the web so it releases the next batch
            await self.queue.publish_result(
                msg.thread_id,
                ResultMessage(job_id=msg.job_id, kind="error", payload="interrupted"),
            )
            raise
        finally:
            await self._cleanup(msg.attachments)

    async def _interrupt_listener(self) -> None:
        while True:  # re-subscribe after transient redis drops
            try:
                async for thread_id, job_id in self.queue.subscribe_interrupts():
                    current = thread_id == self._current_thread
                    if current and job_id in (None, self._current_job):
                        if self._task and not self._task.done():
                            self._task.cancel()
            except _REDIS_TRANSIENT as exc:
                logger.warning("interrupt listener redis error, resubscribing: %s", exc)
                await asyncio.sleep(2)

    def _bootstrap_checkout(self) -> None:
        """Clone the site repo on first boot (idempotent)."""
        cfg = self._cfg()
        SiteRepo(
            cfg.site_root,
            default_branch=cfg.default_branch,
            github_token=github_token(),
            remote=cfg.remote,
        ).ensure_checkout()

    async def run(self, *, idle_timeout: int = 5) -> None:
        await asyncio.to_thread(self._bootstrap_checkout)
        listener = asyncio.ensure_future(self._interrupt_listener())
        try:
            while True:
                try:
                    msg = await self.queue.dequeue(timeout=idle_timeout)
                except _REDIS_TRANSIENT as exc:
                    logger.warning("dequeue redis error, retrying: %s", exc)
                    await asyncio.sleep(2)
                    continue
                if msg is None:
                    continue
                self._current_thread, self._current_job = msg.thread_id, msg.job_id
                self._task = asyncio.ensure_future(self._run_one(msg))
                with contextlib.suppress(asyncio.CancelledError):
                    await self._task
                self._current_thread = self._current_job = self._task = None
        finally:
            listener.cancel()


def main() -> None:
    asyncio.run(Worker(JobQueue(connect())).run())


if __name__ == "__main__":
    main()
