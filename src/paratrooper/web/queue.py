"""Key Value (Redis) transport between the web and worker services.

Render Key Value is Redis-compatible. Jobs ride a list (web ``lpush`` -> worker
``brpop``); results stream back over a per-thread pub/sub channel that the web
service relays to the socket; interrupts (STOP/CANCEL) ride their own channel so
the worker can cancel the running job. Only keys/paths cross the queue — blobs
live in the inbox store.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

import redis.asyncio as redis

from .models import JobMessage, ResultMessage

JOBS_KEY = "paratrooper:jobs"


def _results_channel(thread_id: str) -> str:
    return f"paratrooper:results:{thread_id}"


INTERRUPT_CHANNEL = "paratrooper:interrupt"


def connect(url: str | None = None) -> redis.Redis:
    """Connect to Key Value. URL from ``url`` or ``$REDIS_URL`` (Render sets this)."""
    url = url or os.environ.get("REDIS_URL") or os.environ.get("PARATROOPER_REDIS_URL")
    if not url:
        raise RuntimeError("no Redis URL (set REDIS_URL)")
    return redis.from_url(url, decode_responses=True)


class JobQueue:
    def __init__(self, client: redis.Redis) -> None:
        self.r = client

    # --- jobs (web -> worker) ---
    async def enqueue(self, job: JobMessage) -> None:
        await self.r.lpush(JOBS_KEY, job.model_dump_json())

    async def dequeue(self, timeout: int = 5) -> JobMessage | None:
        res = await self.r.brpop(JOBS_KEY, timeout=timeout)
        if res is None:
            return None
        _key, raw = res
        return JobMessage.model_validate_json(raw)

    # --- results (worker -> web) ---
    async def publish_result(self, thread_id: str, result: ResultMessage) -> None:
        await self.r.publish(_results_channel(thread_id), result.model_dump_json())

    async def subscribe_results(self, thread_id: str) -> AsyncIterator[ResultMessage]:
        pubsub = self.r.pubsub()
        await pubsub.subscribe(_results_channel(thread_id))
        try:
            async for message in pubsub.listen():
                if message.get("type") == "message":
                    yield ResultMessage.model_validate_json(message["data"])
        finally:
            await pubsub.unsubscribe(_results_channel(thread_id))
            await pubsub.aclose()

    # --- interrupts (STOP/CANCEL) ---
    async def publish_interrupt(self, thread_id: str, job_id: str | None = None) -> None:
        await self.r.publish(INTERRUPT_CHANNEL, f"{thread_id}:{job_id or ''}")

    async def subscribe_interrupts(self) -> AsyncIterator[tuple[str, str | None]]:
        pubsub = self.r.pubsub()
        await pubsub.subscribe(INTERRUPT_CHANNEL)
        try:
            async for message in pubsub.listen():
                if message.get("type") == "message":
                    thread_id, _, job_id = message["data"].partition(":")
                    yield thread_id, (job_id or None)
        finally:
            await pubsub.unsubscribe(INTERRUPT_CHANNEL)
            await pubsub.aclose()
