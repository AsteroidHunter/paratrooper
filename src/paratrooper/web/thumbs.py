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


def make_thumbnail(data: bytes) -> tuple[bytes, int, int] | None:
    """~320px-long-edge webp preview as ``(bytes, width, height)``, or None when
    the bytes aren't an image (non-image uploads simply keep their 📎 chip in
    history). The dimensions ride to the client with each message so it can
    reserve the image's box before any pixels arrive — an unreserved image
    renders 0-tall, then grows on decode and shoves the scroll position."""
    try:
        im = Image.open(BytesIO(data))
        im = ImageOps.exif_transpose(im)  # phone photos carry orientation in EXIF
        im.thumbnail((THUMB_EDGE, THUMB_EDGE))
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGB")
        out = BytesIO()
        im.save(out, format="WEBP", quality=70)
        return out.getvalue(), im.width, im.height
    except Exception:
        return None
