"""Small persistent thumbnails of uploaded photos (iMessage-style history).

Full-size uploads live in the Redis inbox and expire in ~24h; the thumbnail is
the only pixel record that survives for thread replay. Pillow is a base
dependency (the placement engine needs it), so this stays inside the web
image's install set and imports nothing from the agent package.
"""

from __future__ import annotations

from io import BytesIO

from PIL import Image, ImageOps

from .blurhash import encode as blurhash_encode

THUMB_EDGE = 1280

# the blurhash is 4x3 cosine components over the whole picture, so it cannot
# see anything finer than a twelfth of the frame anyway. Encoding a 32px-long-
# edge copy costs a few milliseconds instead of a few seconds and produces the
# same string to within a character.
BLURHASH_EDGE = 32


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


def image_blurhash(data: bytes) -> str | None:
    """~28-character blurhash of already-encoded image bytes, or None when they
    won't decode. The client paints this while the real preview is still coming
    down the wire, so a photo bubble shows the photo's own colours and shape
    from the first frame instead of a grey rectangle.

    Alpha is dropped rather than composited, matching every reference
    implementation: they read the RGB of an RGBA pixel and ignore the A. Same
    no-transpose reasoning as ``image_dims``."""
    try:
        with Image.open(BytesIO(data)) as im:
            im.thumbnail((BLURHASH_EDGE, BLURHASH_EDGE), Image.Resampling.BOX)
            small = im.convert("RGB")
        return blurhash_encode(small.tobytes(), small.width, small.height)
    except Exception:
        return None
