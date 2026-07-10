"""Image pipeline: staged upload -> optimized webp in the pin folder.

Order matters: **EXIF transpose first** so a phone photo's orientation is baked
into the pixels (upright on the board) and the *transposed* dimensions set the
pin's aspect — which the placement engine turns into ``size {w,h} = {s, s/aspect}``.
Alpha is preserved so transparent cutouts stay cutouts.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps

DEFAULT_MAX_DIM = 1600  # long-edge cap in px; phone photos are larger than the board ever needs
DEFAULT_QUALITY = 82


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
