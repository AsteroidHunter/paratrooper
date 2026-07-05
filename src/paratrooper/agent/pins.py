"""Read/write the pinboard as folders, and bridge pins to the placement engine.

Post-refactor contract (from the companion webpage-pin-refactor plan): each pin
is a folder ``<pins_dir>/<id>/`` holding ``index.json`` plus its asset(s)
(``preview.webp``, optional ``opened.webp``; text pins are asset-less). ``size
{w,h}`` in the JSON is the authoritative footprint. Archive = move the folder.

This module turns those folders into the engine's :class:`~paratrooper.placement.Pin`
objects (loading the alpha silhouette for cutouts so occupancy is alpha-aware),
and writes/moves pin folders for the agent's add/archive/edit operations.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

from ..placement import Pin, load_silhouette
from .config import OPENED_ASSET, PREVIEW_ASSET

INDEX_FILE = "index.json"
_SLUG_RE = re.compile(r"[^a-z0-9]+")


class PinError(RuntimeError):
    """Raised on a malformed pin folder (e.g. missing the authoritative size)."""


def slugify(text: str, *, max_len: int = 40) -> str:
    """Lowercase, hyphenated slug for ids/branch names. Empty input -> 'pin'."""
    slug = _SLUG_RE.sub("-", text.strip().lower()).strip("-")
    slug = slug[:max_len].strip("-")
    return slug or "pin"


def pin_folder(pins_dir: Path, pin_id: str) -> Path:
    return pins_dir / pin_id


def preview_path(pins_dir: Path, pin_id: str) -> Path:
    """Path to the pinned/board preview asset (the image whose alpha drives
    occupancy)."""
    return pins_dir / pin_id / PREVIEW_ASSET


def opened_path(pins_dir: Path, pin_id: str) -> Path:
    return pins_dir / pin_id / OPENED_ASSET


def read_pin(pins_dir: Path, pin_id: str) -> dict:
    idx = pin_folder(pins_dir, pin_id) / INDEX_FILE
    if not idx.is_file():
        raise PinError(f"no pin '{pin_id}' (missing {idx})")
    return json.loads(idx.read_text())


def list_pin_ids(pins_dir: Path) -> list[str]:
    """Ids of all live pins (folders with an index.json). Skips dot/underscore
    folders like ``_archive``."""
    if not pins_dir.is_dir():
        return []
    return sorted(
        p.name
        for p in pins_dir.iterdir()
        if p.is_dir() and not p.name.startswith((".", "_")) and (p / INDEX_FILE).is_file()
    )


def to_engine_pin(pin_id: str, data: dict, folder: Path) -> Pin:
    """Build an engine :class:`Pin` from a pin's JSON + folder.

    ``size`` is required (the post-refactor contract makes it authoritative);
    a missing size is a real defect, raised loudly rather than guessed. Cutouts
    (``frameless`` with a preview asset) carry their alpha silhouette so
    occupancy/overlap use the visible shape, not the bounding box.
    """
    try:
        pos, size = data["position"], data["size"]
        x, y, w, h = float(pos["x"]), float(pos["y"]), float(size["w"]), float(size["h"])
    except (KeyError, TypeError) as exc:
        raise PinError(f"pin '{pin_id}' missing authoritative position/size: {exc}") from exc

    frameless = bool(data.get("frameless", False))
    silhouette = None
    preview = folder / PREVIEW_ASSET
    if frameless and preview.is_file():
        silhouette = load_silhouette(preview)
    return Pin(
        id=pin_id,
        x=x,
        y=y,
        w=w,
        h=h,
        rotation=float(data.get("rotation", 0.0)),
        frameless=frameless,
        silhouette=silhouette,
    )


def load_board(pins_dir: Path, *, exclude: str | None = None) -> list[Pin]:
    """All live pins as engine :class:`Pin` objects, for placement/overlap. Pass
    ``exclude`` to drop one pin (e.g. when re-placing an existing pin, exclude it
    so it isn't treated as an obstacle to itself)."""
    pins: list[Pin] = []
    for pid in list_pin_ids(pins_dir):
        if pid == exclude:
            continue
        folder = pin_folder(pins_dir, pid)
        pins.append(to_engine_pin(pid, read_pin(pins_dir, pid), folder))
    return pins


def write_pin(pins_dir: Path, pin_id: str, data: dict) -> Path:
    """Write (create or overwrite) a pin's ``index.json``. The folder is created
    if needed; assets are placed separately by the image pipeline. Returns the
    folder path."""
    folder = pin_folder(pins_dir, pin_id)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / INDEX_FILE).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    return folder


def move_pin(src_dir: Path, dst_dir: Path, pin_id: str) -> Path:
    """Move a pin folder between stages (on-display / off-display / for-later).
    Returns the new path. Raises if the pin doesn't exist at the source or the
    destination is occupied (never clobber)."""
    src = pin_folder(src_dir, pin_id)
    if not src.is_dir():
        raise PinError(f"cannot move '{pin_id}': folder not found ({src})")
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / pin_id
    if dst.exists():
        raise PinError(f"destination already holds '{pin_id}' ({dst}); refusing to overwrite")
    shutil.move(str(src), str(dst))
    return dst


def archive_pin(pins_dir: Path, archive_dir: Path, pin_id: str) -> Path:
    """Archive = move on-display -> off-display."""
    return move_pin(pins_dir, archive_dir, pin_id)
