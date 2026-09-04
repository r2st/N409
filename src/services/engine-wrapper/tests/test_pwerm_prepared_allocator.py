"""PWERM builds one breakpoint structure, not one per scenario (R409, M8).

`exit_allocation` is `_normalize` + `_segments` + a fill of the segments by the
exit value that lands in them. Only the fill reads the exit value, and PWERM
allocates up to 50 scenarios over one cap table — so the structure was rebuilt
fifty times. These tests pin that `exit_allocator` is the same function as
`exit_allocation` and that the loop now prepares once.
"""

import pytest

from app.engine import waterfall
from app.engine.errors import EngineInputError
from app.engine.pwerm import allocate_pwerm
from app.engine.waterfall import exit_allocation, exit_allocator

CLASSES = [
    {"name": "Common", "kind": "common", "shares": 7_000_000},
    {"name": "Series A", "kind": "preferred", "shares": 2_000_000, "preference": 5_000_000, "seniority": 1},
    {
        "name": "Series B",
        "kind": "preferred",
        "shares": 3_000_000,
        "preference": 12_000_000,
        "seniority": 2,
        "participating": True,
        "participation_cap": 24_000_000,
    },
    {"name": "Options", "kind": "option", "shares": 1_000_000, "strike": 0.5},
]

SCENARIOS = [
    {"name": "downside", "probability": 0.2, "equity_value": 4_000_000, "time_to_exit_years": 1.0},
    {"name": "base", "probability": 0.5, "equity_value": 40_000_000, "time_to_exit_years": 3.0},
    {"name": "upside", "probability": 0.3, "equity_value": 250_000_000, "time_to_exit_years": 4.0},
]


@pytest.mark.parametrize(
    "exit_value",
    [0.0, 1.0, 4_999_999.0, 5_000_000.0, 17_000_000.0, 24_000_000.0, 4e7, 2.5e8, 1e12],
)
def test_prepared_allocator_is_identical_to_the_one_shot_form(exit_value):
    allocate_at = exit_allocator(CLASSES)
    assert allocate_at(exit_value) == exit_allocation(exit_value, CLASSES)


def test_the_prepared_allocator_is_reusable_and_not_order_dependent():
    """A structure reused across calls must not be mutated by any of them."""
    allocate_at = exit_allocator(CLASSES)
    first = allocate_at(4e7)
    for other in (0.0, 1e12, 5_000_000.0):
        allocate_at(other)
    assert allocate_at(4e7) == first
    assert first == exit_allocation(4e7, CLASSES)


def test_pwerm_builds_the_structure_once_for_the_whole_run():
    calls = {"segments": 0, "normalize": 0}
    real_segments, real_normalize = waterfall._segments, waterfall._normalize

    def counted_segments(classes):
        calls["segments"] += 1
        return real_segments(classes)

    def counted_normalize(classes):
        calls["normalize"] += 1
        return real_normalize(classes)

    waterfall._segments = counted_segments
    waterfall._normalize = counted_normalize
    try:
        out = allocate_pwerm(SCENARIOS, CLASSES, default_discount_rate=0.2)
    finally:
        waterfall._segments = real_segments
        waterfall._normalize = real_normalize
    assert len(out["scenarios"]) == 3
    # One for `normalize_share_classes` up front, one for the allocator.
    assert calls["segments"] == 1
    assert calls["normalize"] == 2


def test_pwerm_conclusion_is_unchanged_by_the_hoist():
    out = allocate_pwerm(SCENARIOS, CLASSES, default_discount_rate=0.2)
    # Recomputed the long way round: the same scenarios, each allocated by the
    # one-shot `exit_allocation`, weighted and discounted by hand.
    from app.engine.compounding import compound_factor

    weighted = 0.0
    common_shares = sum(c["shares"] for c in CLASSES if c["kind"] == "common")
    for s in SCENARIOS:
        alloc = exit_allocation(s["equity_value"], CLASSES)
        factor = compound_factor(0.2, s["time_to_exit_years"], "discount_rate")
        weighted += s["probability"] * (alloc["common_value"] / factor)
    assert out["common_per_share"] == pytest.approx(weighted / common_shares, rel=1e-12)


@pytest.mark.parametrize("bad", [-1.0, float("nan"), float("inf")])
def test_the_exit_value_is_still_checked_on_every_scenario(bad):
    allocate_at = exit_allocator(CLASSES)
    with pytest.raises(EngineInputError) as one:
        allocate_at(bad)
    with pytest.raises(EngineInputError) as many:
        exit_allocation(bad, CLASSES)
    assert str(one.value) == str(many.value)


def test_a_malformed_cap_table_is_refused_before_any_scenario():
    with pytest.raises(EngineInputError):
        allocate_pwerm(SCENARIOS, [*CLASSES, 1.5], default_discount_rate=0.2)
