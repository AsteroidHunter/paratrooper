"""Which agent answers a chat.

Every job the service hands to an agent, and every interrupt it sends one, goes
through ``agent_for_thread``. Today there is one answer for every chat: the
existing worker, reached through the job queue it has always been reached
through.

How other agents would connect to a chat, and where they would run, is
deliberately undecided. When it is decided, this is the one place that learns
it; nothing else in the service assumes which agent is on the other end of a
chat. The worker's own job model (one job at a time, results back per chat on
its results channel) is not this module's business and does not change here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .models import JobMessage

# the existing worker, the only agent there is today
WORKER = "worker"


@dataclass(frozen=True)
class AgentRoute:
    """How a job for one chat reaches the agent that answers it."""

    name: str
    queue: Any  # the job queue (queue.JobQueue); typed loosely for test fakes

    async def enqueue(self, job: JobMessage) -> None:
        await self.queue.enqueue(job)

    async def interrupt(self, thread_id: str, job_id: str) -> None:
        await self.queue.publish_interrupt(thread_id, job_id)


def agent_for_thread(thread_id: str, queue: Any) -> AgentRoute:
    """The agent that answers ``thread_id``. Every chat resolves to the
    existing worker until the owner decides otherwise."""
    del thread_id  # the question is per chat; today every chat has one answer
    return AgentRoute(name=WORKER, queue=queue)
