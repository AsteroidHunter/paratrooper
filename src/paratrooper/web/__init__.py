"""Web service: FastAPI PWA host + auth + uploads + threads + queue + publish,
and the worker queue-consumer.

The FastAPI app is imported directly (``paratrooper.web.app:create_app``), NOT
re-exported here — so the worker (which uses ``Worker`` and the shared
contracts) can import this package without pulling in FastAPI.
"""

from .batching import ThreadCoordinator, is_stop_word
from .db import ThreadStore
from .inbox import DiskInbox, RedisInbox
from .models import JobMessage, ResultMessage, ThreadMessage
from .worker_runner import Worker

__all__ = [
    "ThreadStore",
    "ThreadCoordinator",
    "is_stop_word",
    "DiskInbox",
    "RedisInbox",
    "JobMessage",
    "ResultMessage",
    "ThreadMessage",
    "Worker",
]
