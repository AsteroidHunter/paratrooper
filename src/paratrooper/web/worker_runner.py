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
from pathlib import Path

from ..agent.worker import Job, run_job
from .models import JobMessage, ResultMessage
from .queue import JobQueue, connect


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
        self._current_thread: str | None = None
        self._current_job: str | None = None
        self._task: asyncio.Task | None = None

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
            await run_job(job, auth_mode=self.auth_mode, on_event=on_event)
        except asyncio.CancelledError:
            # interrupted: tell the web so it releases the next batch
            await self.queue.publish_result(
                msg.thread_id,
                ResultMessage(job_id=msg.job_id, kind="error", payload="interrupted"),
            )
            raise

    async def _interrupt_listener(self) -> None:
        async for thread_id, job_id in self.queue.subscribe_interrupts():
            if thread_id == self._current_thread and (job_id in (None, self._current_job)):
                if self._task and not self._task.done():
                    self._task.cancel()

    async def run(self, *, idle_timeout: int = 5) -> None:
        listener = asyncio.ensure_future(self._interrupt_listener())
        try:
            while True:
                msg = await self.queue.dequeue(timeout=idle_timeout)
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
