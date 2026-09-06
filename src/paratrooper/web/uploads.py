"""Inbox storage for uploaded photos.

The PWA POSTs a photo over an authenticated multipart request; the web service
writes the raw bytes to the staging inbox (persistent disk) under an opaque key
and enqueues a job referencing only that key. The worker reads the file from the
same store and optimizes it into the pin folder; it never deletes the original,
because the same key can be handed to a second job (see ``_cleanup`` in the
worker runner). The store's TTL is what reclaims it.
"""

from __future__ import annotations

import uuid
from pathlib import Path

# Accepted upload extensions -> stored as-is; the worker re-encodes to webp.
_ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"}

# --- what may be uploaded ----------------------------------------------------
#
# Neither of these existed, and the store they land in never evicts, so one
# authenticated request could put anything of any size on the service's disk and
# leave it there. The cap is counted while the body is read, before a byte is
# stored, and the kind is read out of the bytes themselves: the declared
# content type and the filename are both written by whoever is uploading and
# neither says anything about what actually arrived.
MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB, comfortably over an iPhone photo

# The magic bytes of the formats a photo can arrive in, matched against the head
# of the file. HEIC/HEIF is the ISO base-media box shape iPhones use: a length,
# the literal "ftyp", then a brand naming the flavour.
_HEIF_BRANDS = frozenset({
    b"heic", b"heix", b"heim", b"heis",
    b"hevc", b"hevx", b"hevm", b"hevs",
    b"mif1", b"msf1",
})

# what the phone is told; both are shown to the owner exactly as written
TOO_LARGE = (
    f"That photo is bigger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB, so it was not sent. "
    "Send a smaller one."
)
NOT_A_PHOTO = "That is not a photo I can open, so it was not sent. Send a JPEG, PNG or HEIC."


def image_kind(data: bytes) -> str | None:
    """The image format ``data`` actually is, or None for anything else.

    Read from the bytes, never from the declared type or the filename: those
    come from the uploader and a .png named text file is still a text file.
    """
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[4:8] == b"ftyp" and data[8:12] in _HEIF_BRANDS:
        return "heif"
    return None


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
