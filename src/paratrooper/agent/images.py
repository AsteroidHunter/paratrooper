"""Image pipelines. Two of them, one per profile, side by side.

:func:`process_image` is the pinboard pipeline: a staged upload becomes an
optimized webp inside the pin folder. Order matters: **EXIF transpose first** so
a phone photo's orientation is baked into the pixels (upright on the board) and
the *transposed* dimensions set the pin's aspect — which the placement engine
turns into ``size {w,h} = {s, s/aspect}``. Alpha is preserved so transparent
cutouts stay cutouts.

:func:`for_vision` is the plain pipeline: the same photo becomes a base64 image
block inside the user message, because a plain session has no file tools and
nothing to read a path with. Same first step (EXIF transpose), a tighter long
edge, and a hard ceiling on the encoded size, since every byte of it crosses the
CLI's stdin inside one JSON line.
"""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps

DEFAULT_MAX_DIM = 1600  # long-edge cap in px; phone photos are larger than the board ever needs
DEFAULT_QUALITY = 82

# --- the vision pipeline's bounds ---------------------------------------------
#
# 1568 px is the long edge above which the vision guidance says an image is
# scaled down anyway, so sending more is paying for pixels that are thrown away.
# It is a cost choice, not a claim about any model's maximum: check the current
# input limits when the configured model changes.
VISION_MAX_DIM = 1568
VISION_QUALITY = 85
# The encoded ceiling measures the base64 text carried in the user message.
# run_job divides a separate input budget between the photos in a turn; the
# SDK's max_buffer_size controls reading CLI output, not sending this input.
VISION_MAX_BASE64 = 3 * 1024 * 1024
# Do not silently destroy the photo to fit a turn with too many attachments.
# At this floor an oversized image fails visibly so the person can send less.
VISION_MIN_DIM = 256
_VISION_QUALITY_STEPS = (85, 70, 55, 40)


class VisionBudgetError(ValueError):
    """The photos cannot fit the turn's image budget at usable dimensions."""


@dataclass
class ImageResult:
    """Outcome of :func:`process_image`. ``aspect`` = width / height after EXIF
    transpose — the value the placement engine uses to derive height from the
    chosen width."""

    path: Path
    width: int
    height: int
    aspect: float
    has_alpha: bool


def process_image(
    src: str | Path,
    dest: str | Path,
    *,
    max_dim: int = DEFAULT_MAX_DIM,
    quality: int = DEFAULT_QUALITY,
) -> ImageResult:
    """Optimize ``src`` into a webp at ``dest`` and report its post-transpose
    geometry. Downscales so the long edge is at most ``max_dim`` (never upscales).
    Creates the destination folder if needed."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)  # bake orientation -> upright + correct aspect
        has_alpha = "A" in im.getbands() or im.mode in ("RGBA", "LA", "P")
        im = im.convert("RGBA" if has_alpha else "RGB")

        long_edge = max(im.width, im.height)
        if long_edge > max_dim:
            scale = max_dim / long_edge
            im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))))

        w, h = im.width, im.height
        save_kwargs = {"quality": quality, "method": 6}
        im.save(dest, format="WEBP", **save_kwargs)

    aspect = w / h if h else 1.0
    return ImageResult(path=dest, width=w, height=h, aspect=round(aspect, 6), has_alpha=has_alpha)


@dataclass(frozen=True)
class VisionImage:
    """One photo, ready to be an image block in a user message.

    ``data`` is base64 text and ``media_type`` is what the block declares, so the
    caller assembles the block and never has to decide either."""

    media_type: str  # "image/jpeg" or "image/png"
    data: str  # base64, no data-URI prefix: the block carries the type separately
    width: int
    height: int

    @property
    def block(self) -> dict:
        """The documented image-block shape for a streamed user message."""
        return {
            "type": "image",
            "source": {"type": "base64", "media_type": self.media_type, "data": self.data},
        }


def _encode(im: Image.Image, *, alpha: bool, quality: int) -> bytes:
    buffer = io.BytesIO()
    if alpha:
        im.save(buffer, format="PNG", optimize=True)
    else:
        im.save(buffer, format="JPEG", quality=quality, optimize=True, progressive=True)
    return buffer.getvalue()


def for_vision(
    src: str | Path,
    *,
    max_dim: int = VISION_MAX_DIM,
    quality: int = VISION_QUALITY,
    max_base64: int = VISION_MAX_BASE64,
) -> VisionImage:
    """Read ``src`` and return it as base64 image data for a user message.

    EXIF transpose first, exactly as the pin pipeline does, so a photo taken
    sideways is described the way the person sees it rather than the way the
    sensor recorded it. The long edge is capped and never stretched: a small
    photo is sent at its own size, because upscaling invents pixels and costs
    tokens for them.

    A photo carrying alpha stays a PNG so a transparent cutout is not composited
    onto a colour nobody chose; everything else is JPEG. The encoded text is then
    held under ``max_base64`` by lowering JPEG quality and, if that is not
    enough, by shrinking. At the dimension floor an image that still exceeds
    the ceiling raises VisionBudgetError rather than returning oversized input.
    """
    if max_base64 < 1:
        raise VisionBudgetError("no image budget remains for this photo")
    with Image.open(src) as opened:
        im = ImageOps.exif_transpose(opened)  # bake orientation before anything measures it
        alpha = "A" in im.getbands() or im.mode in ("RGBA", "LA", "P")
        im = im.convert("RGBA" if alpha else "RGB")

        long_edge = max(im.width, im.height)
        if long_edge > max_dim:  # never upscales
            scale = max_dim / long_edge
            im = im.resize(
                (max(1, round(im.width * scale)), max(1, round(im.height * scale))),
                Image.LANCZOS,
            )

        steps = ([quality] if alpha else
                 [q for q in _VISION_QUALITY_STEPS if q <= quality] or [quality])
        while True:
            for step in steps:
                data = _encode(im, alpha=alpha, quality=step)
                encoded = base64.b64encode(data).decode("ascii")
                if len(encoded) <= max_base64:
                    return VisionImage(
                        media_type="image/png" if alpha else "image/jpeg",
                        data=encoded,
                        width=im.width,
                        height=im.height,
                    )
            if min(im.width, im.height) <= VISION_MIN_DIM:
                raise VisionBudgetError("photo exceeds its encoded image budget")
            im = im.resize(
                (max(1, round(im.width * 0.75)), max(1, round(im.height * 0.75))),
                Image.LANCZOS,
            )
