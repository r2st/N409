"""`class_per_share_objective` is `class_per_share` with the prep hoisted (R409, M8).

The backsolve moves one number — the equity value — and the breakpoint structure
it re-derived on every evaluation (`_normalize` over the raw list, `_segments`'
event loop over the normalised one) reads none of it. These tests pin the two
things the hoist rests on: that the prepared closure is the same function to the
last bit, and that the errors it used to raise per evaluation still come out of
the same call.
"""

import math

import pytest

from app.engine import waterfall
from app.engine.errors import EngineInputError
from app.engine.waterfall import (
    class_per_share,
    class_per_share_objective,
)

T, R, SIGMA = 3.0, 0.04, 0.6

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


@pytest.mark.parametrize("class_name", ["Common", "Series A", "Series B", "Options"])
def test_prepared_objective_is_bit_identical_across_the_solver_range(class_name):
    per_share = class_per_share_objective(CLASSES, class_name, T, R, SIGMA)
    # The span a Newton solve walks, plus the two arms of its central
    # difference at each point — a re-derived structure and a reused one must
    # not differ by so much as an ulp, because the derivative is a difference
    # of two of these and rounding noise is what it would read as slope.
    for equity in (1e-3, 1.0, 1e5, 2.5e7, 6.66e7, 1e9, 1e12):
        for x in (equity, equity * (1 + 1e-6), equity * (1 - 1e-6)):
            assert per_share(x) == class_per_share(x, CLASSES, class_name, T, R, SIGMA)


def test_prepared_objective_matches_the_solved_equity_exactly():
    from app.engine.approaches import opm_backsolve

    target = 4.25
    out = opm_backsolve(
        last_round_pps=target,
        share_classes=CLASSES,
        last_round_class="Series A",
        t=T,
        r=R,
        sigma=SIGMA,
    )
    assert out["method"] == "backsolve_waterfall"
    equity = out["equity_value"]
    assert out["solved_pps"] == class_per_share(equity, CLASSES, "Series A", T, R, SIGMA)
    assert out["solved_pps"] == pytest.approx(target, rel=1e-6)


def test_the_structure_is_built_once_per_solve():
    """The whole point: N evaluations, one `_segments`."""
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
        per_share = class_per_share_objective(CLASSES, "Series A", T, R, SIGMA)
        for equity in (1e6, 2e6, 3e6, 4e6, 5e6, 6e6, 7e6, 8e6):
            per_share(equity)
    finally:
        waterfall._segments = real_segments
        waterfall._normalize = real_normalize
    assert calls == {"segments": 1, "normalize": 1}


@pytest.mark.parametrize(
    "scalars, message",
    [
        ((None, R, SIGMA), "time_to_exit is required"),
        ((float("nan"), R, SIGMA), "time_to_exit"),
        ((-1.0, R, SIGMA), "time_to_exit must be >= 0"),
        ((T, None, SIGMA), "risk_free_rate is required"),
        ((T, R, None), "volatility is required"),
        ((T, R, 0.0), "volatility is required"),
        ((T, R, float("nan")), "volatility"),
    ],
)
def test_the_opm_scalars_are_still_refused(scalars, message):
    t, r, sigma = scalars
    with pytest.raises(EngineInputError) as one:
        class_per_share_objective(CLASSES, "Series A", t, r, sigma)
    with pytest.raises(EngineInputError) as many:
        class_per_share(1e7, CLASSES, "Series A", t, r, sigma)
    assert message in str(one.value)
    assert str(one.value) == str(many.value)


def test_an_unknown_class_is_still_refused_with_the_same_message():
    with pytest.raises(EngineInputError) as one:
        class_per_share_objective(CLASSES, "Series Z", T, R, SIGMA)
    with pytest.raises(EngineInputError) as many:
        class_per_share(1e7, CLASSES, "Series Z", T, R, SIGMA)
    assert "not found in share_classes" in str(one.value)
    assert str(one.value) == str(many.value)


@pytest.mark.parametrize("equity", [0.0, -1.0, float("nan"), math.inf])
def test_the_equity_value_is_still_checked_on_every_evaluation(equity):
    """It is the one argument that moves, so its guard cannot be hoisted."""
    per_share = class_per_share_objective(CLASSES, "Series A", T, R, SIGMA)
    with pytest.raises(EngineInputError) as one:
        per_share(equity)
    with pytest.raises(EngineInputError) as many:
        class_per_share(equity, CLASSES, "Series A", T, R, SIGMA)
    assert str(one.value) == str(many.value)


def test_a_malformed_cap_table_is_refused_when_the_objective_is_built():
    with pytest.raises(EngineInputError):
        class_per_share_objective([*CLASSES, 1.5], "Series A", T, R, SIGMA)
