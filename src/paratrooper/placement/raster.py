"""Rasterization helpers: turn pins (and asset files) into boolean masks on the
occupancy grid.

A pin's footprint is stamped as either a filled rotated rectangle (opaque pins)
or a thresholded, scaled, rotated alpha silhouette (transparent cutouts). PIL
does the scale/rotate; everything returns plain numpy boolean arrays so scipy's
morphology/EDT can take over.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from .types import ALPHA_THRESHOLD, GRID, ROT_SIGN, Pin


def load_silhouette(path: str | Path, threshold: int = ALPHA_THRESHOLD) -> np.ndarray:
    """Load an asset and return its opaque-pixel mask (True = opaque) in the
    asset's own pixel grid, after baking EXIF orientation into the pixels.

    Images with an alpha channel yield the thresholded alpha silhouette (the
    cutout shape). Images with no alpha are fully opaque, so the mask is a solid
    rectangle of the image's transposed dimensions.
    """
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)  # upright orientation -> correct silhouette + aspect
        if "A" in im.getbands():
            alpha = np.asarray(im.getchannel("A"))
            return alpha >= threshold
        return np.ones((im.height, im.width), dtype=bool)


def asset_aspect(path: str | Path) -> float:
    """Return ``width / height`` of an asset after EXIF transpose (the aspect the
    pixels actually render at), used to derive ``h = width / aspect``."""
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        if im.height == 0:
            return 1.0
        return im.width / im.height


def _to_pil_mask(mask: np.ndarray) -> Image.Image:
    return Image.fromarray((mask.astype(np.uint8) * 255), mode="L")


def _stamp_image(
    w_cells: int, h_cells: int, rotation: float, silhouette: np.ndarray | None
) -> np.ndarray:
    """Build the (rotated) stamp for a single pin at a footprint of
    ``w_cells`` x ``h_cells``. Returns a boolean array sized to the rotated
    bounding box (expand=True), True where the pin is present."""
    w_cells = max(1, int(round(w_cells)))
    h_cells = max(1, int(round(h_cells)))
    if silhouette is None:
        base = Image.new("L", (w_cells, h_cells), 255)  # filled rectangle
    else:
        base = _to_pil_mask(silhouette).resize((w_cells, h_cells), Image.NEAREST)
    if rotation:
        base = base.rotate(ROT_SIGN * rotation, expand=True, resample=Image.NEAREST)
    return np.asarray(base) >= 128


def _paste_or(canvas: np.ndarray, stamp: np.ndarray, cx: float, cy: float) -> None:
    """OR ``stamp`` into ``canvas`` centered at grid coords ``(cx, cy)``
    (col, row), clipping anything past the board edge."""
    sh, sw = stamp.shape
    # top-left of the stamp on the canvas (round to nearest cell)
    r0 = int(round(cy - sh / 2.0))
    c0 = int(round(cx - sw / 2.0))
    r1, c1 = r0 + sh, c0 + sw
    # clip to canvas
    cr0, cc0 = max(0, r0), max(0, c0)
    cr1, cc1 = min(canvas.shape[0], r1), min(canvas.shape[1], c1)
    if cr0 >= cr1 or cc0 >= cc1:
        return
    sr0, sc0 = cr0 - r0, cc0 - c0
    sr1, sc1 = sr0 + (cr1 - cr0), sc0 + (cc1 - cc0)
    canvas[cr0:cr1, cc0:cc1] |= stamp[sr0:sr1, sc0:sc1]


def pin_mask(pin: Pin, grid: int = GRID) -> np.ndarray:
    """Boolean ``grid`` x ``grid`` mask (rows = y, cols = x) for a single pin's
    footprint, alpha-aware for cutouts. Outside-board portions are clipped."""
    canvas = np.zeros((grid, grid), dtype=bool)
    scale = grid / 100.0
    w_cells = pin.w * scale
    h_cells = pin.h * scale
    sil = pin.silhouette if pin.is_cutout else None
    stamp = _stamp_image(w_cells, h_cells, pin.rotation, sil)
    _paste_or(canvas, stamp, pin.x * scale, pin.y * scale)
    return canvas


def item_silhouette_cells(
    silhouette: np.ndarray, w: float, h: float, rotation: float, grid: int = GRID
) -> np.ndarray:
    """Rasterize a *new* item's silhouette to footprint cells at a candidate
    ``(w, h)`` size + rotation — the structuring element for irregular
    (cutout) feasibility erosion."""
    scale = grid / 100.0
    return _stamp_image(w * scale, h * scale, rotation, silhouette)
