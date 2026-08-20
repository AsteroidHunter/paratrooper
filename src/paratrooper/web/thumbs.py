"""Small persistent thumbnails of uploaded photos (iMessage-style history).

Full-size uploads live in the Redis inbox and expire in ~24h; the thumbnail is
the only pixel record that survives for thread replay. Pillow is a base
dependency (the placement engine needs it), so this stays inside the web
image's install set and imports nothing from the agent package.
"""

from __future__ import annotations

from io import BytesIO

from PIL import Image, ImageOps

THUMB_EDGE = 1280


def make_thumbnail(data: bytes) -> tuple[bytes, int, int] | None:
    """~1280px-long-edge webp preview (retina-crisp in the bubble, decent zoomed;
    the full upload still expires, so this is the surviving pixel record) as ``(bytes, width, height)``, or None when
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


def image_dims(data: bytes) -> tuple[int, int] | None:
    """Pixel size of already-encoded image bytes, or None when they won't
    decode. Pillow only reads the header here, so this is cheap enough to run
    over every stored preview at once. No EXIF transpose, unlike
    ``make_thumbnail``: the bytes handed to this are previews we encoded
    ourselves, with any phone rotation already baked into the pixels."""
    try:
        with Image.open(BytesIO(data)) as im:
            return im.width, im.height
    except Exception:
        return None
