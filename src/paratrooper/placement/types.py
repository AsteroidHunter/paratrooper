"""Core types and constants for the placement engine.

Everything lives in **board-% space**: the board (`.cloth`) is square
(`aspect-ratio: 1`), so x and y percentages are isotropic. Positions are pin
*centers* (matching the renderer, which centers each polaroid on its
`position`). The size scalar the optimizer searches over is the pin **width**
in board-% — the same unit the renderer turns into `cqw` — and the height
follows from the asset aspect so the JSON `size {w, h}` stays the single source
of truth for a pin's footprint.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

# --- Board geometry (board-% space) -----------------------------------------
BOARD_SIZE: float = 100.0  # the board spans [0, 100] on both axes
GRID: int = 100  # default occupancy resolution (~1% per cell); architecture says ~100x100
GAP_PCT: float = 2.0  # minimum clearance between pins, board-% (the renderer's 2% gap)

# Pin width range, board-%. Matches the schema (`size.w` min 5 / max 40) and the
# renderer's `cqw`. Height is derived from this via the asset aspect.
SIZE_MIN: float = 5.0
SIZE_MAX: float = 40.0

# Pin-center clamp, board-%. Matches the schema (`position` 5..95).
POS_MIN: float = 5.0
POS_MAX: float = 95.0

# Alpha threshold (0..255) above which a cutout pixel counts as opaque when we
# stamp its silhouette into the occupancy grid.
ALPHA_THRESHOLD: int = 128

# Fixed aspect ratios for embed-type pins (no asset to measure). The standard
# Spotify track embed renders ~300x380 -> ~0.79; the compact variant ~300x80.
# These are defaults the agent/tool can override per pin.
SPOTIFY_EMBED_ASPECT: float = 300.0 / 380.0
SPOTIFY_COMPACT_ASPECT: float = 300.0 / 80.0
TEXT_DEFAULT_ASPECT: float = 1.0

# Sign mapping between a pin's `rotation` field (CSS `rotate()`, clockwise-positive
# in screen coords) and PIL's rotate (counter-clockwise-positive). Footprint
# extent is symmetric in rotation sign, so this only matters for the exact
# silhouette of a tilted cutout; flip in one place if a screenshot ever shows a
# mirrored tilt.
ROT_SIGN: int = -1


def half_diagonal(w: float, h: float) -> float:
    """Half the diagonal of a ``w``x``h`` box. The circumscribed-circle radius:
    if a cell's clearance to the nearest obstacle is >= this, the box fits at
    that center under *any* rotation (a conservative, rotation-free feasibility
    bound used by the regular/opaque placement path)."""
    return 0.5 * math.hypot(w, h)


@dataclass
class Pin:
    """An existing pin on the board, in the engine's internal representation.

    Distinct from the on-disk JSON schema — the agent's tools translate a pin
    folder (``index.json`` + asset) into this. ``silhouette`` is the asset's
    alpha mask (True = opaque) in the asset's own pixel grid; it is only
    consulted when ``frameless`` is True (a transparent cutout like the ram),
    in which case occupancy/overlap use the silhouette instead of the bounding
    box. ``w``/``h`` are the footprint in board-%.
    """

    id: str
    x: float  # center x, board-%
    y: float  # center y, board-%
    w: float  # width, board-%
    h: float  # height, board-%
    rotation: float = 0.0  # degrees, CSS convention (clockwise-positive)
    frameless: bool = False
    silhouette: np.ndarray | None = None  # HxW bool, asset-pixel space; only if frameless

    @property
    def is_cutout(self) -> bool:
        return self.frameless and self.silhouette is not None


@dataclass
class NewItem:
    """The thing being placed. ``aspect`` = asset_w / asset_h (after EXIF
    transpose) and drives ``h = width / aspect``. If ``silhouette`` is set the
    item is an irregular cutout: feasibility uses exact silhouette erosion
    rather than the half-diagonal bound, and its visible (alpha) area — not the
    full box — feeds the balance term.
    """

    aspect: float
    rotation: float = 0.0  # degrees; only affects the cutout silhouette feasibility
    silhouette: np.ndarray | None = None  # HxW bool, asset-pixel space (cutout only)

    @property
    def fill_fraction(self) -> float:
        """Visible fraction of the bounding box (1.0 for an opaque rectangle)."""
        if self.silhouette is None:
            return 1.0
        frac = float(self.silhouette.mean())
        return frac if frac > 0 else 1.0


@dataclass
class PlacementResult:
    """Output of :func:`paratrooper.placement.engine.place_pin`."""

    position: dict[str, float]  # {"x": .., "y": ..}, board-%, pin center
    size: dict[str, float]  # {"w": .., "h": ..}, board-%, footprint
    score: float
    feasible_count: int = 0  # number of feasible (cell, size) candidates considered

    def as_pin_fields(self) -> dict:
        """Shape matching the pin JSON's ``position``/``size`` blocks."""
        return {"position": dict(self.position), "size": dict(self.size)}


@dataclass
class OverlapReport:
    """Result of :func:`check_overlaps`. ``ok`` is True iff no overlaps and no
    out-of-bounds pins."""

    ok: bool
    overlaps: list[tuple[str, str]] = field(default_factory=list)
    out_of_bounds: list[str] = field(default_factory=list)

    def message(self) -> str:
        if self.ok:
            return "ok: no overlaps, all pins in bounds"
        parts = []
        if self.overlaps:
            pairs = ", ".join(f"{a}<->{b}" for a, b in self.overlaps)
            parts.append(f"overlaps: {pairs}")
        if self.out_of_bounds:
            parts.append(f"out of bounds: {', '.join(self.out_of_bounds)}")
        return "; ".join(parts)
