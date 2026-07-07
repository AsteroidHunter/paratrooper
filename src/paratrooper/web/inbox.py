"""Inbox blob store — the staging area for uploaded photos.

Topology note (refines Open Q#7 for the real Render two-service layout): a Render
persistent disk attaches to a *single* service, so the worker can't read the web
service's disk. The web and worker DO share the Key Value (Redis) instance, so
the inbox uses that as the cross-service blob store — the web service ``put``s
the bytes on upload, the worker ``get``s them by key before optimizing, then both
expire. Only the thread DB needs the persistent disk. ``DiskInbox`` keeps a
filesystem backend for local dev and tests.
"""

from __future__ import annotations

import base64
import uuid
from pathlib import Path
from typing import Protocol

from .uploads import _safe_ext

INBOX_PREFIX = "paratrooper:inbox:"
DEFAULT_TTL = 24 * 3600  # staged uploads must survive deploys + queue waits


def new_key(filename: str | None) -> str:
    """A fresh opaque inbox key (uuid + safe extension)."""
    return f"{uuid.uuid4().hex}{_safe_ext(filename)}"


class InboxStore(Protocol):
    async def put(self, key: str, content: bytes) -> None: ...
    async def get(self, key: str) -> bytes: ...
    async def delete(self, key: str) -> None: ...


class DiskInbox:
    """Filesystem-backed inbox (local dev / single-host / tests)."""

    def __init__(self, directory: str | Path) -> None:
        self.dir = Path(directory)

    async def put(self, key: str, content: bytes) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / Path(key).name).write_bytes(content)

    async def get(self, key: str) -> bytes:
        return (self.dir / Path(key).name).read_bytes()

    async def delete(self, key: str) -> None:
        (self.dir / Path(key).name).unlink(missing_ok=True)


class RedisInbox:
    """Key Value-backed inbox — the cross-service store on Render.

    Blobs are base64-encoded so they survive a ``decode_responses=True`` client
    (the same client the queue uses), avoiding a second binary connection.
    """

    def __init__(self, client, ttl: int = DEFAULT_TTL) -> None:
        self.r = client
        self.ttl = ttl

    async def put(self, key: str, content: bytes) -> None:
        await self.r.set(INBOX_PREFIX + key, base64.b64encode(content).decode(), ex=self.ttl)

    async def get(self, key: str) -> bytes:
        data = await self.r.get(INBOX_PREFIX + key)
        if data is None:
            raise KeyError(f"inbox key not found (expired?): {key}")
        return base64.b64decode(data)

    async def delete(self, key: str) -> None:
        await self.r.delete(INBOX_PREFIX + key)
