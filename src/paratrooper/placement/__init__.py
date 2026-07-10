"""Deterministic placement + sizing engine for the pinboard.

Public API:

* :func:`place_pin` — choose ``{position, size}`` for a new item (the agent's
  ``place_pin`` tool).
* :func:`check_overlaps` — alpha-aware overlap + bounds validator.
* :func:`sanity_check` — in-bounds / no-overlap validity check for a result.
* :class:`Pin`, :class:`NewItem`, :class:`PlacementResult`, :class:`OverlapReport`.
* :func:`load_silhouette`, :func:`asset_aspect` — asset -> engine inputs.
"""

from .engine import PlacementError, check_overlaps, place_pin, sanity_check
from .objective import W_BALANCE, W_RHYTHM
from .raster import asset_aspect, load_silhouette
from .types import (
    GAP_PCT,
    GRID,
    SIZE_MAX,
    SIZE_MIN,
    SPOTIFY_EMBED_ASPECT,
    NewItem,
    OverlapReport,
    Pin,
    PlacementResult,
)

__all__ = [
    "place_pin",
    "check_overlaps",
    "sanity_check",
    "PlacementError",
    "Pin",
    "NewItem",
    "PlacementResult",
    "OverlapReport",
    "load_silhouette",
    "asset_aspect",
    "W_BALANCE",
    "W_RHYTHM",
    "GRID",
    "GAP_PCT",
    "SIZE_MIN",
    "SIZE_MAX",
    "SPOTIFY_EMBED_ASPECT",
]
