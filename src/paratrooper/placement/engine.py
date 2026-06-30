"""The placement engine the agent *calls* — it never eyeballs geometry.

``place_pin`` sweeps the size scalar (pin width) and, for each size, finds the
feasible centers and scores them, returning the global best ``{position, size}``
(or a weighted sample for variety). ``check_overlaps`` is the alpha-aware
runtime validator the agent runs before committing. Both are deterministic and
run in well under a second on a ~100x100 grid.
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage

from .objective import (
    W_BALANCE,
    W_RHYTHM,
    balance_gain_grid,
    cell_center_coords,
    com_accumulators,
    local_median_width_grid,
    rhythm_penalty,
    score_grid,
)
from .occupancy import (
    build_occupancy,
    clearance_edt,
    feasible_irregular,
    feasible_regular,
    free_space,
)
from .raster import item_silhouette_cells, pin_mask
from .types import (
    GAP_PCT,
    GRID,
    POS_MAX,
    POS_MIN,
    SIZE_MAX,
    SIZE_MIN,
    NewItem,
    OverlapReport,
    Pin,
    PlacementResult,
)


class PlacementError(RuntimeError):
    """Raised when nothing fits — the board is full for this item. The agent
    surfaces this as 'it won't fit, want to archive something?'"""


def _disk(radius_cells: float) -> np.ndarray:
    r = max(1, int(round(radius_cells)))
    yy, xx = np.ogrid[-r : r + 1, -r : r + 1]
    return (xx * xx + yy * yy) <= (r * r)


def _size_sweep(size_min: float, size_max: float, step: float) -> np.ndarray:
    n = int(round((size_max - size_min) / step)) + 1
    return size_min + step * np.arange(n)


def place_pin(
    existing: list[Pin],
    item: NewItem,
    *,
    grid: int = GRID,
    size_min: float = SIZE_MIN,
    size_max: float = SIZE_MAX,
    size_step: float = 1.0,
    w_balance: float = W_BALANCE,
    w_rhythm: float = W_RHYTHM,
    pos_min: float = POS_MIN,
    pos_max: float = POS_MAX,
    sample: bool = False,
    temperature: float = 1.0,
    top_k_per_size: int = 5,
    rng: np.random.Generator | None = None,
) -> PlacementResult:
    """Choose ``{position, size}`` for ``item`` on a board holding ``existing``.

    The size scalar is the pin **width**; height is derived as ``w / aspect`` so
    the returned ``size`` preserves the asset's shape and stays the footprint
    source of truth. Feasibility uses the half-diagonal/EDT bound for opaque
    items and exact silhouette erosion for cutouts (``item.silhouette`` set).
    With ``sample=True`` the result is drawn ``∝ exp(score / T)`` over the best
    candidates per size for variety; otherwise it's the argmax.
    """
    occ = build_occupancy(existing, grid)
    free = free_space(occ)
    edt = clearance_edt(free)
    coords = cell_center_coords(grid)
    x_grid, y_grid = coords

    in_bounds = (
        (x_grid >= pos_min) & (x_grid <= pos_max) & (y_grid >= pos_min) & (y_grid <= pos_max)
    )
    s_acc, w_total = com_accumulators(existing)
    local_med = local_median_width_grid(existing, coords)

    candidates: list[tuple[float, float, float, float, float]] = []  # (score, x, y, w, h)
    best: tuple[float, float, float, float, float] | None = None
    feasible_count = 0

    for s in _size_sweep(size_min, size_max, size_step):
        w = float(s)
        h = w / item.aspect
        if h < size_min or h > size_max:
            continue  # this width can't honor the asset aspect within schema bounds

        if item.silhouette is not None:
            sil_cells = item_silhouette_cells(item.silhouette, w, h, item.rotation, grid)
            feas = feasible_irregular(free, sil_cells)
            new_area = w * h * item.fill_fraction
        else:
            feas = feasible_regular(edt, w, h, grid)
            new_area = w * h
        feas &= in_bounds
        n_feas = int(feas.sum())
        if n_feas == 0:
            continue
        feasible_count += n_feas

        bgain = balance_gain_grid(s_acc, w_total, new_area, coords)
        rhythm = rhythm_penalty(w, local_med)
        sgrid = score_grid(bgain, rhythm, w_balance, w_rhythm)
        sgrid = np.where(feas, sgrid, -np.inf)

        flat = sgrid.ravel()
        k = min(top_k_per_size, n_feas)
        top_idx = np.argpartition(flat, -k)[-k:]
        for idx in top_idx:
            val = float(flat[idx])
            if not np.isfinite(val):
                continue
            cx = float(x_grid.ravel()[idx])
            cy = float(y_grid.ravel()[idx])
            cand = (val, cx, cy, w, h)
            candidates.append(cand)
            if best is None or val > best[0]:
                best = cand

    if best is None:
        raise PlacementError(
            f"no feasible placement for item (aspect={item.aspect:.3f}, "
            f"cutout={item.silhouette is not None}) on a board of {len(existing)} pins"
        )

    if sample and len(candidates) > 1:
        chosen = _weighted_choice(candidates, temperature, rng)
    else:
        chosen = best

    score, cx, cy, w, h = chosen
    return PlacementResult(
        position={"x": round(float(np.clip(cx, pos_min, pos_max)), 1),
                  "y": round(float(np.clip(cy, pos_min, pos_max)), 1)},
        size={"w": round(w, 1), "h": round(h, 2)},
        score=score,
        feasible_count=feasible_count,
    )


def _weighted_choice(
    candidates: list[tuple[float, float, float, float, float]],
    temperature: float,
    rng: np.random.Generator | None,
) -> tuple[float, float, float, float, float]:
    rng = rng or np.random.default_rng()
    scores = np.array([c[0] for c in candidates])
    logits = scores / max(temperature, 1e-6)
    logits -= logits.max()  # stability
    probs = np.exp(logits)
    probs /= probs.sum()
    return candidates[int(rng.choice(len(candidates), p=probs))]


def check_overlaps(
    pins: list[Pin], *, grid: int = GRID, gap_pct: float = GAP_PCT
) -> OverlapReport:
    """Alpha-aware overlap + bounds validator (the runtime ``check_overlaps`` the
    agent runs before committing). Two pins conflict when their footprints —
    silhouette for cutouts, rotated box otherwise — sit closer than the ``gap``.
    A pin is out of bounds when its center leaves the 5..95 box or its footprint
    spills past the board edge.

    Extends the website's bbox-based ``validate-pins`` with alpha + rotation
    awareness; the companion webpage-refactor plan keeps the simpler bbox
    checker, this is for the agent's runtime placement.
    """
    masks = [pin_mask(p, grid) for p in pins]
    gap_cells = gap_pct * grid / 100.0
    disk = _disk(gap_cells) if gap_cells >= 1 else None

    overlaps: list[tuple[str, str]] = []
    for i in range(len(pins)):
        dilated_i = (
            ndimage.binary_dilation(masks[i], structure=disk) if disk is not None else masks[i]
        )
        for j in range(i + 1, len(pins)):
            if (dilated_i & masks[j]).any():
                overlaps.append((pins[i].id, pins[j].id))

    out_of_bounds = [p.id for p in pins if _out_of_bounds(p, grid)]
    return OverlapReport(
        ok=not overlaps and not out_of_bounds,
        overlaps=overlaps,
        out_of_bounds=out_of_bounds,
    )


def _out_of_bounds(pin: Pin, grid: int, pos_min: float = POS_MIN, pos_max: float = POS_MAX) -> bool:
    if not (pos_min <= pin.x <= pos_max and pos_min <= pin.y <= pos_max):
        return True
    # footprint within the board: re-derive the (unclipped) rotated stamp box
    from .raster import _stamp_image  # local import; internal helper

    scale = grid / 100.0
    sil = pin.silhouette if pin.is_cutout else None
    stamp = _stamp_image(pin.w * scale, pin.h * scale, pin.rotation, sil)
    sh, sw = stamp.shape
    r0 = pin.y * scale - sh / 2.0
    c0 = pin.x * scale - sw / 2.0
    return r0 < 0 or c0 < 0 or (r0 + sh) > grid or (c0 + sw) > grid


def sanity_check(
    result: PlacementResult,
    existing: list[Pin],
    item: NewItem,
    *,
    grid: int = GRID,
    gap_pct: float = GAP_PCT,
) -> OverlapReport:
    """The basic validity check kept from Open Q#3 (golden test dropped):
    confirm a placement is in-bounds and overlap-free once added to the board.
    Independent of the search internals, so it's a real check, not a tautology.
    """
    placed = Pin(
        id="__placed__",
        x=result.position["x"],
        y=result.position["y"],
        w=result.size["w"],
        h=result.size["h"],
        rotation=item.rotation,
        frameless=item.silhouette is not None,
        silhouette=item.silhouette,
    )
    return check_overlaps([*existing, placed], grid=grid, gap_pct=gap_pct)
