"""Inbox storage for uploaded photos.

The PWA POSTs a photo over an authenticated multipart request; the web service
writes the raw bytes to the staging inbox (persistent disk) under an opaque key
and enqueues a job referencing only that key. The worker reads the file from the
same store and optimizes it into the pin folder; it never deletes the original,
because the same key can be handed to a second job (see ``_cleanup`` in the
worker runner). The store's TTL is what reclaims it.
"""

from __future__ import annotations

import re
import uuid
from pathlib import Path

# Accepted upload extensions -> stored as-is; the worker re-encodes to webp.
_ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"}

# --- keys that are allowed to become part of a path --------------------------
#
# A photo key is minted here and travels a long way: into a persisted thread
# row, across the queue in a job, and back out on the worker, where it is joined
# onto that machine's inbox folder. Every one of those hops is a chance for the
# value to be something other than what was minted — the attachment list on a
# send is client-supplied, and a key that has been through a database is a key
# somebody could have written.
#
# So the joins do not trust it. ``Path(key).name`` was doing that work and is
# not the same promise: it silently rewrites a bad value into a different one
# (``..`` becomes the empty string, and the join lands on the folder itself)
# rather than refusing it. This is the strict form, and anything else raises.
#
# The class is what the keys actually are: a timestamp, a uuid hex, a dot and an
# extension. Nothing here needs a slash, a backslash, a leading dot or a space.
_SAFE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class UnsafeKey(ValueError):
    """A key that must never be joined onto a path."""


def safe_segment(value: object) -> str:
    """Return ``value`` once it is a single safe path segment; raise otherwise.

    One segment: no separator of either kind, no ``..``, no leading dot, and a
    strict character class. The check is on the whole value, so there is no
    "cleaned up" version of a bad key that gets used anyway.
    """
    if not isinstance(value, str) or not _SAFE_SEGMENT_RE.match(value):
        raise UnsafeKey(f"not a usable photo key: {value!r}")
    if ".." in value:
        raise UnsafeKey(f"not a usable photo key: {value!r}")
    return value

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
    key = safe_segment(f"{uuid.uuid4().hex}{_safe_ext(filename)}")
    (inbox_dir / key).write_bytes(content)
    return key, len(content)


def delete_staged(inbox_dir: str | Path, key: str) -> None:
    """Remove a staged upload (called by the worker after optimizing it).
    Refuses any key that is not a single safe segment, so this cannot reach
    outside the inbox and cannot land on the inbox folder itself."""
    (Path(inbox_dir) / safe_segment(key)).unlink(missing_ok=True)
