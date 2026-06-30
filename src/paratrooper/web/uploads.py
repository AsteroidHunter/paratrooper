"""Inbox storage for uploaded photos.

The PWA POSTs a photo over an authenticated multipart request; the web service
writes the raw bytes to the staging inbox (persistent disk) under an opaque key
and enqueues a job referencing only that key. The worker reads the file from the
same store, optimizes it into the pin folder, then deletes the staged original.
"""

from __future__ import annotations

import uuid
from pathlib import Path

# Accepted upload extensions -> stored as-is; the worker re-encodes to webp.
_ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"}


def _safe_ext(filename: str | None) -> str:
    if not filename:
        return ".bin"
    ext = Path(filename).suffix.lower()
    return ext if ext in _ALLOWED_EXT else ".bin"


def save_upload(inbox_dir: str | Path, filename: str | None, content: bytes) -> tuple[str, int]:
    """Write ``content`` to the inbox under a fresh key; return ``(key, size)``.
    The key is opaque (uuid + extension) — no caller-controlled path component,
    so a crafted filename can't traverse out of the inbox."""
    inbox_dir = Path(inbox_dir)
    inbox_dir.mkdir(parents=True, exist_ok=True)
    key = f"{uuid.uuid4().hex}{_safe_ext(filename)}"
    (inbox_dir / key).write_bytes(content)
    return key, len(content)


def delete_staged(inbox_dir: str | Path, key: str) -> None:
    """Remove a staged upload (called by the worker after optimizing it). Keys
    are basename-only, so this can't escape the inbox."""
    target = Path(inbox_dir) / Path(key).name
    target.unlink(missing_ok=True)
