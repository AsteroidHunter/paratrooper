"""Web service: FastAPI PWA host + auth + uploads + threads + queue + publish,
and the worker queue-consumer.

This package init must stay importable on BOTH images, so it re-exports only
modules with no image-specific deps. The FastAPI app is imported directly
(``paratrooper.web.app:create_app`` — web image only, needs fastapi) and the
worker loop directly too (``paratrooper.web.worker_runner`` — worker image
only, needs claude_agent_sdk). Re-exporting either here crashes the other
image at boot.
"""

from .batching import ThreadCoordinator, is_stop_word
from .db import ThreadStore
from .inbox import DiskInbox, RedisInbox
from .models import JobMessage, ResultMessage, ThreadMessage

__all__ = [
    "ThreadStore",
    "ThreadCoordinator",
    "is_stop_word",
    "DiskInbox",
    "RedisInbox",
    "JobMessage",
    "ResultMessage",
    "ThreadMessage",
]
