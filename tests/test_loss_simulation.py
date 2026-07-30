"""Loss-mode simulations for the dropped-messages diagnosis (2026-07-30).

These run the PRODUCTION transport functions (queue.connect, publish_result,
subscribe_results) against a REAL redis-server — no fakes anywhere in the loss
path — and demonstrate the outbound failure mode: the worker's finished answer
is a bare pub/sub PUBLISH, so if the web process (the only subscriber, and the
only place results get persisted) is down at that instant, the answer is
unrecoverable. Nothing replays it when the web process comes back.

Skipped automatically when redis-server is not installed.
"""

from __future__ import annotations

import asyncio
import shutil
import socket
import subprocess
import time

import pytest

from paratrooper.web.models import ResultMessage
from paratrooper.web.queue import JobQueue, connect

pytestmark = pytest.mark.skipif(
    shutil.which("redis-server") is None, reason="redis-server not installed"
)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def redis_url():
    """A throwaway real redis on a random port, no persistence."""
    port = _free_port()
    proc = subprocess.Popen(
        ["redis-server", "--port", str(port), "--bind", "127.0.0.1",
         "--save", "", "--appendonly", "no"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    url = f"redis://127.0.0.1:{port}/0"
    try:
        async def _ping():  # one loop for connect+ping+close
            client = connect(url)
            try:
                await client.ping()
            finally:
                await client.aclose()

        deadline = time.time() + 5
        while True:  # wait until it answers PING
            try:
                asyncio.run(_ping())
                break
            except Exception:
                if time.time() > deadline:
                    raise
                time.sleep(0.05)
        yield url
    finally:
        proc.terminate()
        proc.wait(timeout=5)


def _answer() -> ResultMessage:
    return ResultMessage(job_id="job-1", kind="done", payload="the answer")


def test_answer_arrives_while_web_is_up(redis_url):
    """Control: web relay subscribed (normal operation) -> the answer arrives."""

    async def scenario():
        worker_q = JobQueue(connect(redis_url))
        web_q = JobQueue(connect(redis_url))

        received = []

        async def relay():  # stands in for app._result_relay's subscription
            async for msg in web_q.subscribe_results("thread-1"):
                received.append(msg)
                return

        task = asyncio.create_task(relay())
        await asyncio.sleep(0.2)  # let SUBSCRIBE land before PUBLISH
        await worker_q.publish_result("thread-1", _answer())
        await asyncio.wait_for(task, timeout=2)
        assert received and received[0].payload == "the answer"
        await worker_q.r.aclose()
        await web_q.r.aclose()

    asyncio.run(scenario())


def test_answer_published_while_web_is_down_is_gone_forever(redis_url):
    """Loss: the web process is restarting when the worker finishes. The
    PUBLISH reaches zero subscribers, and when the web process boots and
    subscribes (all _result_relay does), nothing replays: the answer no longer
    exists anywhere. This is the 'read but never answered' mechanism."""

    async def scenario():
        worker_q = JobQueue(connect(redis_url))

        # web is DOWN: nobody subscribed. The production publish call:
        await worker_q.publish_result("thread-1", _answer())

        # same PUBLISH primitive reports how many subscribers received it:
        receivers = await worker_q.r.publish(
            "paratrooper:results:thread-1", _answer().model_dump_json()
        )
        assert receivers == 0  # nobody was listening; redis drops it

        # web comes back up and subscribes, exactly like _result_relay does:
        web_q = JobQueue(connect(redis_url))

        async def wait_for_answer():
            async for msg in web_q.subscribe_results("thread-1"):
                return msg

        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(wait_for_answer(), timeout=1.5)
        # no replay, no backlog: the answer was never persisted and never will
        # be. The thread keeps its Read watermark with no reply after it.
        await worker_q.r.aclose()
        await web_q.r.aclose()

    asyncio.run(scenario())
