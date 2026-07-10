"""Occupancy, free space, EDT clearance, and feasibility.

Pipeline: stamp every existing pin into a boolean occupancy grid, dilate by the
2% inter-pin gap, treat outside-the-board as occupied (walls), then run a
Euclidean distance transform over the free space. A candidate center is
feasible for a given footprint when its clearance covers the footprint's
half-diagonal (the regular/opaque path), or — for an irregular cutout being
placed — when the silhouette fits via binary erosion.
"""

from __future__ import annotations

import math

import numpy as np
from scipy import ndimage

from .raster import pin_mask
from .types import GAP_PCT, GRID, Pin, half_diagonal


def _disk(radius_cells: float) -> np.ndarray:
    """A boolean disk structuring element of the given radius (cells)."""
    r = max(1, int(round(radius_cells)))
    yy, xx = np.ogrid[-r : r + 1, -r : r + 1]
    return (xx * xx + yy * yy) <= (r * r)


def build_occupancy(pins: list[Pin], grid: int = GRID, gap_pct: float = GAP_PCT) -> np.ndarray:
    """Boolean ``grid`` x ``grid`` occupancy (True = occupied), the union of all
    pin footprints dilated by the inter-pin gap. The dilation bakes the 2% gap
    into the obstacle field, so the regular feasibility test needs only the bare
    half-diagonal (no extra gap term) and the cutout erosion path inherits the
    gap for free."""
    occ = np.zeros((grid, grid), dtype=bool)
    for pin in pins:
        occ |= pin_mask(pin, grid)
    gap_cells = gap_pct * grid / 100.0
    if gap_cells >= 1:
        occ = ndimage.binary_dilation(occ, structure=_disk(gap_cells))
    return occ


def free_space(occupancy: np.ndarray) -> np.ndarray:
    """Free cells = not occupied. (The board edge is handled as a wall inside
    :func:`clearance_edt` by padding, so callers don't pre-mask the border.)"""
    return ~occupancy


def clearance_edt(free: np.ndarray) -> np.ndarray:
    """Per-cell clearance (in cells) to the nearest obstacle *or board wall*.

    The board occupies the whole grid, so the wall sits at the grid edge. We pad
    the free region with occupied cells before the EDT so edge clearance
    reflects the wall, then crop back — this is what makes "outside-board =
    occupied" hold without a pin ever hanging off the edge.
    """
    pad = int(math.ceil(half_diagonal(40.0, 40.0) * free.shape[0] / 100.0)) + 2
    padded = np.pad(free, pad, mode="constant", constant_values=False)
    edt = ndimage.distance_transform_edt(padded)
    return edt[pad:-pad, pad:-pad]


def feasible_regular(edt: np.ndarray, w: float, h: float, grid: int = GRID) -> np.ndarray:
    """Feasible centers for an opaque ``w`` x ``h`` box: clearance >= the box's
    half-diagonal (rotation-independent — the circumscribed circle fits)."""
    half_diag_cells = half_diagonal(w, h) * grid / 100.0
    return edt >= half_diag_cells


def feasible_irregular(free: np.ndarray, silhouette_cells: np.ndarray) -> np.ndarray:
    """Feasible centers for an irregular cutout: the set of centers where the
    silhouette fits entirely in free space, via ``binary_erosion``. Exact for
    the cutout shape (vs. the conservative circle bound of the regular path)."""
    if silhouette_cells.sum() == 0:
        return free.copy()
    return ndimage.binary_erosion(free, structure=silhouette_cells)
