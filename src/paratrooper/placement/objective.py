"""The placement objective.

``score(x, y, s) = w_balance * balance_gain - w_rhythm * |s - local_median| - inf if infeasible``

* **balance** formalizes "vibes" as visual balance: each pin's weight is its
  visible (alpha) area, and a good spot tugs the board's weighted center-of-mass
  toward the center (50, 50). ``balance_gain`` is the *reduction* in CoM-offset
  the new pin buys at a candidate center — positive = better.
* **rhythm** keeps a new pin sized like its neighbors: the absolute difference
  between its width ``s`` and the local median neighbor width.

Both terms are computed vectorized over the whole candidate grid for a given
size ``s``; the engine sweeps ``s`` and takes the argmax (or samples).
"""

from __future__ import annotations

import numpy as np

from .types import GRID, Pin

# Default objective weights. Starting points only — the real calibration is the
# screenshot + chat loop (Open Q#3: a golden/board-matching test was dropped as
# circular). `balance_gain` is in board-% distance (small on a populated board);
# `|s - median|` is in board-% width (0..35). w_rhythm keeps sizes coherent
# without letting rhythm steamroll a balance-motivated big/small pin.
W_BALANCE: float = 1.0
W_RHYTHM: float = 0.5

BOARD_CENTER = np.array([50.0, 50.0])


def visible_area(pin: Pin) -> float:
    """Visual weight of a pin = footprint area x visible fraction. Cutouts count
    only their opaque silhouette; opaque pins count the full box."""
    box = pin.w * pin.h
    if pin.is_cutout:
        frac = float(pin.silhouette.mean())
        return box * (frac if frac > 0 else 1.0)
    return box


def com_accumulators(pins: list[Pin]) -> tuple[np.ndarray, float]:
    """Return ``(S, W)`` where ``S = sum(weight_i * center_i)`` (2-vector) and
    ``W = sum(weight_i)`` over existing pins — the running center-of-mass
    numerator/denominator the balance term extends with the new pin."""
    s = np.zeros(2)
    w_total = 0.0
    for pin in pins:
        wt = visible_area(pin)
        s += wt * np.array([pin.x, pin.y])
        w_total += wt
    return s, w_total


def cell_center_coords(grid: int = GRID) -> tuple[np.ndarray, np.ndarray]:
    """Board-% center coordinate grids ``(X, Y)``, each ``grid`` x ``grid``
    (rows = y, cols = x)."""
    centers = (np.arange(grid) + 0.5) * 100.0 / grid
    x = np.broadcast_to(centers[None, :], (grid, grid))
    y = np.broadcast_to(centers[:, None], (grid, grid))
    return x, y


def balance_gain_grid(
    s_acc: np.ndarray, w_total: float, new_area: float, coords: tuple[np.ndarray, np.ndarray]
) -> np.ndarray:
    """Vectorized ``balance_gain`` over every candidate center.

    On a populated board: ``dist(CoM_before, center) - dist(CoM_after, center)``
    — how much placing ``new_area`` at each cell pulls the CoM toward center. On
    an empty board the CoM is undefined, so we simply prefer the center:
    ``-dist(cell, center)``.
    """
    x, y = coords
    if w_total <= 0:
        return -np.hypot(x - BOARD_CENTER[0], y - BOARD_CENTER[1])
    com0 = s_acc / w_total
    d0 = np.hypot(com0[0] - BOARD_CENTER[0], com0[1] - BOARD_CENTER[1])
    denom = w_total + new_area
    com1_x = (s_acc[0] + new_area * x) / denom
    com1_y = (s_acc[1] + new_area * y) / denom
    d1 = np.hypot(com1_x - BOARD_CENTER[0], com1_y - BOARD_CENTER[1])
    return d0 - d1


def local_median_width_grid(
    pins: list[Pin], coords: tuple[np.ndarray, np.ndarray], k: int = 3
) -> np.ndarray:
    """Per-cell median width of the ``k`` nearest existing pins (board rhythm).
    All-NaN when the board is empty, so the rhythm term contributes nothing."""
    grid = coords[0].shape[0]
    if not pins:
        return np.full((grid, grid), np.nan)
    px = np.array([p.x for p in pins])
    py = np.array([p.y for p in pins])
    widths = np.array([p.w for p in pins])
    x, y = coords
    # distance from each cell to each pin: (grid, grid, n_pins)
    d = np.hypot(x[..., None] - px, y[..., None] - py)
    kk = min(k, len(pins))
    nearest = np.argsort(d, axis=-1)[..., :kk]
    neighbor_w = widths[nearest]  # (grid, grid, kk)
    return np.median(neighbor_w, axis=-1)


def rhythm_penalty(s: float, local_median: np.ndarray) -> np.ndarray:
    """``|s - local_median|`` per cell; 0 where the median is undefined (empty
    board)."""
    pen = np.abs(s - local_median)
    return np.where(np.isnan(local_median), 0.0, pen)


def score_grid(
    balance_gain: np.ndarray,
    rhythm: np.ndarray,
    w_balance: float = W_BALANCE,
    w_rhythm: float = W_RHYTHM,
) -> np.ndarray:
    """Combine the two terms (the infeasibility ``-inf`` is applied by the engine
    via the feasibility mask)."""
    return w_balance * balance_gain - w_rhythm * rhythm
