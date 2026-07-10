"""Unit tests for the placement engine on synthetic boards.

Per Open Q#3 there is deliberately **no golden/board-matching test** (calibrating
the engine to reproduce the hand-eyeballed board is circular). These cover the
mechanics: occupancy (alpha vs bbox), EDT feasibility, objective behavior,
overlap rejection, fit/aspect clamping, and the basic validity check.
"""

from __future__ import annotations

import numpy as np
import pytest

from paratrooper.placement import (
    NewItem,
    Pin,
    PlacementError,
    check_overlaps,
    place_pin,
    sanity_check,
)
from paratrooper.placement.objective import (
    balance_gain_grid,
    cell_center_coords,
    com_accumulators,
)
from paratrooper.placement.occupancy import (
    build_occupancy,
    clearance_edt,
    feasible_regular,
    free_space,
)


def circle_silhouette(n: int = 64) -> np.ndarray:
    """A circle inscribed in an n x n box -> ~78.5% fill, transparent corners."""
    yy, xx = np.ogrid[:n, :n]
    cy = cx = (n - 1) / 2.0
    r = n / 2.0
    return ((xx - cx) ** 2 + (yy - cy) ** 2) <= r * r


# --- occupancy: alpha vs bbox -------------------------------------------------

def test_cutout_occupies_less_than_opaque():
    """A frameless cutout stamps its silhouette; the same box as an opaque pin
    stamps the full rectangle -> the cutout must occupy strictly fewer cells."""
    sil = circle_silhouette(64)
    cutout = Pin(id="c", x=50, y=50, w=30, h=30, frameless=True, silhouette=sil)
    opaque = Pin(id="o", x=50, y=50, w=30, h=30, frameless=False, silhouette=sil)
    occ_cut = build_occupancy([cutout]).sum()
    occ_box = build_occupancy([opaque]).sum()
    assert occ_cut < occ_box


def test_walls_are_occupied_in_edt():
    """Clearance near the board edge is small (walls treated as occupied), and
    larger toward the interior."""
    free = free_space(build_occupancy([]))  # empty board: all free
    edt = clearance_edt(free)
    assert edt[0, 0] < edt[50, 50]
    assert edt[50, 50] == pytest.approx(edt.max(), rel=0.05)


# --- EDT feasibility ----------------------------------------------------------

def test_feasibility_shrinks_with_size():
    """Bigger footprints have fewer feasible centers (monotone)."""
    pins = [Pin(id="a", x=50, y=50, w=20, h=20)]
    edt = clearance_edt(free_space(build_occupancy(pins)))
    small = feasible_regular(edt, 8, 8).sum()
    big = feasible_regular(edt, 30, 30).sum()
    assert big < small


# --- objective ----------------------------------------------------------------

def test_balance_gain_pulls_toward_center():
    """With existing mass clustered top-left, placing the new pin bottom-right
    (which pulls the CoM toward center) scores higher than top-left."""
    pins = [Pin(id="a", x=20, y=20, w=20, h=20), Pin(id="b", x=25, y=22, w=18, h=18)]
    coords = cell_center_coords()
    s_acc, w_total = com_accumulators(pins)
    gain = balance_gain_grid(s_acc, w_total, new_area=300.0, coords=coords)
    # grid is [row=y, col=x]; bottom-right ~ (80,80), top-left ~ (20,20)
    assert gain[80, 80] > gain[20, 20]
    assert gain[80, 80] > 0  # bottom-right actually improves balance


def test_empty_board_prefers_center():
    """No existing mass -> balance prefers the center cell."""
    coords = cell_center_coords()
    gain = balance_gain_grid(np.zeros(2), 0.0, new_area=200.0, coords=coords)
    r, c = np.unravel_index(np.argmax(gain), gain.shape)
    # cell centers sit at idx + 0.5, so the cell nearest (50, 50) is idx 49 or 50
    assert abs((c + 0.5) - 50) <= 0.6 and abs((r + 0.5) - 50) <= 0.6


# --- place_pin: end to end ----------------------------------------------------

def test_place_on_empty_board_is_central_and_valid():
    res = place_pin([], NewItem(aspect=1.0))
    assert 40 <= res.position["x"] <= 60
    assert 40 <= res.position["y"] <= 60
    assert sanity_check(res, [], NewItem(aspect=1.0)).ok


def test_place_avoids_existing_pin():
    existing = [Pin(id="big", x=50, y=50, w=30, h=30)]
    item = NewItem(aspect=1.0)
    res = place_pin(existing, item)
    report = sanity_check(res, existing, item)
    assert report.ok, report.message()


def test_place_preserves_aspect_and_clamps_size():
    """Wide asset (aspect 2): chosen size keeps w/h ~ 2 and both within [5, 40]."""
    item = NewItem(aspect=2.0)
    res = place_pin([], item)
    w, h = res.size["w"], res.size["h"]
    assert 5 <= w <= 40 and 5 <= h <= 40
    assert w / h == pytest.approx(2.0, abs=0.06)


def test_place_respects_rhythm():
    """Neighbors all ~12 wide and balance near-neutral -> the new pin sizes
    close to the neighbors rather than to an extreme."""
    existing = [
        Pin(id="a", x=35, y=35, w=12, h=12),
        Pin(id="b", x=65, y=35, w=12, h=12),
        Pin(id="c", x=35, y=65, w=12, h=12),
        Pin(id="d", x=65, y=65, w=12, h=12),
    ]
    res = place_pin(existing, NewItem(aspect=1.0), w_rhythm=2.0)
    assert abs(res.size["w"] - 12) <= 6


def test_full_board_raises():
    """A dense lattice of overlapping pins leaves no feasible center, even for
    the smallest (5-wide) pin -> place_pin raises."""
    existing = [
        Pin(id=f"p{x}-{y}", x=float(x), y=float(y), w=14, h=14)
        for x in range(10, 95, 8)
        for y in range(10, 95, 8)
    ]
    with pytest.raises(PlacementError):
        place_pin(existing, NewItem(aspect=1.0))


def test_cutout_placement_valid():
    """Placing an irregular cutout uses silhouette erosion and stays valid."""
    sil = circle_silhouette(48)
    existing = [Pin(id="x", x=30, y=30, w=20, h=20)]
    item = NewItem(aspect=1.0, silhouette=sil, rotation=8)
    res = place_pin(existing, item)
    assert sanity_check(res, existing, item).ok


def test_sampling_is_deterministic_and_valid():
    existing = [Pin(id="a", x=30, y=30, w=15, h=15), Pin(id="b", x=70, y=70, w=15, h=15)]
    item = NewItem(aspect=1.0)
    r1 = place_pin(existing, item, sample=True, rng=np.random.default_rng(42))
    r2 = place_pin(existing, item, sample=True, rng=np.random.default_rng(42))
    assert (r1.position, r1.size) == (r2.position, r2.size)
    assert sanity_check(r1, existing, item).ok


# --- check_overlaps -----------------------------------------------------------

def test_overlap_detected():
    a = Pin(id="a", x=50, y=50, w=20, h=20)
    b = Pin(id="b", x=52, y=50, w=20, h=20)  # heavily overlapping
    report = check_overlaps([a, b])
    assert not report.ok
    assert ("a", "b") in report.overlaps


def test_no_overlap_when_separated():
    a = Pin(id="a", x=25, y=25, w=15, h=15)
    b = Pin(id="b", x=75, y=75, w=15, h=15)
    assert check_overlaps([a, b]).ok


def test_gap_enforced():
    """Two boxes whose edges sit < 2% apart conflict; comfortably apart, fine."""
    # widths 10 -> half-width 5; centers 11 apart => 1% edge gap (< 2%) -> conflict
    near = check_overlaps(
        [Pin(id="a", x=44.5, y=50, w=10, h=10), Pin(id="b", x=55.5, y=50, w=10, h=10)]
    )
    assert not near.ok
    # centers 16 apart => 6% edge gap (> 2%) -> ok
    far = check_overlaps(
        [Pin(id="a", x=42, y=50, w=10, h=10), Pin(id="b", x=58, y=50, w=10, h=10)]
    )
    assert far.ok


def test_out_of_bounds_detected():
    # center fine but footprint spills past the right wall
    spill = Pin(id="spill", x=92, y=50, w=30, h=30)
    report = check_overlaps([spill])
    assert "spill" in report.out_of_bounds
    assert not report.ok


def test_cutout_corner_tuck_allowed():
    """A neighbor tucked into a cutout's transparent corner is fine for the
    cutout but conflicts with the same pin treated as opaque -> alpha awareness
    in check_overlaps."""
    sil = circle_silhouette(64)
    # cutout circle in a 40-wide box at center; corners (~ x,y 64..70 region) free
    cutout = Pin(id="cut", x=50, y=50, w=40, h=40, frameless=True, silhouette=sil)
    opaque = Pin(id="cut", x=50, y=50, w=40, h=40, frameless=False, silhouette=sil)
    neighbor = Pin(id="nb", x=72, y=72, w=8, h=8)  # near the box corner
    assert check_overlaps([cutout, neighbor]).ok
    assert not check_overlaps([opaque, neighbor]).ok
