"""Small persistent thumbnails of uploaded photos (iMessage-style history).

Full-size uploads live in the Redis inbox and expire in ~24h; the thumbnail is
the only pixel record that survives for thread replay. Pillow is a base
dependency (the placement engine needs it), so this stays inside the web
image's install set and imports nothing from the agent package.
"""

from __future__ import annotations

from io import BytesIO

from PIL import Image, ImageOps

THUMB_EDGE = 320


def make_thumbnail(data: bytes) -> bytes | None:
    """~320px-long-edge webp preview, or None when the bytes aren't an image
    (non-image uploads simply keep their 📎 chip in history)."""
    try:
        im = Image.open(BytesIO(data))
        im = ImageOps.exif_transpose(im)  # phone photos carry orientation in EXIF
        im.thumbnail((THUMB_EDGE, THUMB_EDGE))
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGB")
        out = BytesIO()
        im.save(out, format="WEBP", quality=70)
        return out.getvalue()
    except Exception:
        return None
