"""Participation caps on participating preferred (waterfall.py §3).

A participating class draws its preference *and* a pro-rata slice of the
residual. A cap stops the second part once the class's total proceeds reach it,
and the class then converts to common at the exit value where the as-converted
slice is worth more than the cap. Both events are breakpoints, so both have to
land in the segment list — and the payoff has to stay continuous across them,
because the Black-Scholes call-spread decomposition in ``_allocate`` can only
represent a continuous piecewise-linear payoff.

The fixture below is chosen so every breakpoint is a round number:

    Common     8,000,000 shares
    Series A   4,000,000 shares, $10,000,000 preference, participating,
               $20,000,000 cap, converting 1:1

    preference stack ends at            $10,000,000
    Series A slope in the residual       4M / 12M = 1/3
    cap reached at   10M + (20M-10M)·3 = $40,000,000
    conversion at            20M · 12/4 = $60,000,000
"""

import pytest

from app.engine.compute import compute
from app.engine.errors import EngineInputError
from app.engine.validate import split_issues, validate_payload
from app.engine.waterfall import (
    allocate_waterfall,
    exit_allocation,
    normalize_share_classes,
)

T, R, SIGMA = 3.0, 0.04, 0.6

COMMON = {"name": "Common", "kind": "common", "shares": 8_000_000}


def series_a(cap: object = 20_000_000):
    cls = {
        "name": "Series A",
        "kind": "preferred",
        "shares": 4_000_000,
        "preference": 10_000_000,
        "participating": True,
        "conversion_ratio": 1,
    }
    if cap is not None:
        cls["participation_cap"] = cap
    return cls


CAPPED = [COMMON, series_a()]
UNCAPPED = [COMMON, series_a(cap=None)]


def values(result):
    return {name: cls["value"] for name, cls in result["classes"].items()}


# ── the payoff, exit value by exit value ─────────────────────────────────────


@pytest.mark.parametrize(
    "exit_value,expected",
    [
        # Inside the preference stack: preferred only.
        (5_000_000, {"Series A": 5_000_000, "Common": 0}),
        # Participating: A takes its $10M preference plus 1/3 of the $10M residual.
        (20_000_000, {"Series A": 13_333_333.33, "Common": 6_666_666.67}),
        # Exactly at the cap breakpoint.
        (40_000_000, {"Series A": 20_000_000, "Common": 20_000_000}),
        # Past it: A is flat at the cap, every further dollar is common's.
        (50_000_000, {"Series A": 20_000_000, "Common": 30_000_000}),
        # The conversion breakpoint — as-converted is worth exactly the cap.
        (60_000_000, {"Series A": 20_000_000, "Common": 40_000_000}),
        # Converted: a clean 1/3 : 2/3 split of the whole exit.
        (90_000_000, {"Series A": 30_000_000, "Common": 60_000_000}),
    ],
)
def test_capped_participation_payoff(exit_value, expected):
    got = values(exit_allocation(exit_value, CAPPED))
    for name, want in expected.items():
        assert got[name] == pytest.approx(want, abs=0.01)


def test_cap_is_never_exceeded_before_conversion():
    """Between the cap and the conversion point the class is flat at the cap."""
    for exit_value in range(40_000_000, 60_000_001, 2_000_000):
        got = values(exit_allocation(exit_value, CAPPED))
        assert got["Series A"] == pytest.approx(20_000_000, abs=0.01)


def test_converted_class_tracks_as_converted_share():
    """Above the conversion point the class holds its as-converted fraction."""
    for exit_value in (60_000_000, 75_000_000, 120_000_000):
        got = values(exit_allocation(exit_value, CAPPED))
        assert got["Series A"] == pytest.approx(exit_value / 3.0, abs=0.01)


def test_payoff_is_continuous_across_both_breakpoints():
    """No jumps at the cap or the conversion point.

    This is the property the call-spread decomposition depends on: `_allocate`
    integrates segment slopes, so a payoff that actually jumps would be priced
    as one that does not.
    """
    for breakpoint_ in (40_000_000, 60_000_000):
        low = values(exit_allocation(breakpoint_ - 1_000, CAPPED))
        at = values(exit_allocation(breakpoint_, CAPPED))
        high = values(exit_allocation(breakpoint_ + 1_000, CAPPED))
        for name in ("Series A", "Common"):
            assert at[name] == pytest.approx(low[name], abs=1_000.0)
            assert at[name] == pytest.approx(high[name], abs=1_000.0)


def test_value_is_conserved_at_every_exit_value():
    for exit_value in (1, 9_999_999, 10_000_000, 33_333_333, 40_000_000, 59_999_999, 1e12):
        result = exit_allocation(exit_value, CAPPED)
        assert sum(values(result).values()) == pytest.approx(exit_value, rel=1e-9)


# ── what the cap actually changes ────────────────────────────────────────────


def test_cap_moves_value_from_preferred_to_common():
    """The whole point: a binding cap is common's gain, to the dollar."""
    capped = values(exit_allocation(90_000_000, CAPPED))
    uncapped = values(exit_allocation(90_000_000, UNCAPPED))
    # Uncapped, A takes $10M + 1/3 of the $80M residual = $36.67M.
    assert uncapped["Series A"] == pytest.approx(36_666_666.67, abs=0.01)
    assert capped["Series A"] == pytest.approx(30_000_000, abs=0.01)
    assert capped["Common"] - uncapped["Common"] == pytest.approx(
        uncapped["Series A"] - capped["Series A"], abs=0.01
    )


def test_cap_raises_the_opm_common_per_share():
    """Through the OPM too, not just the deterministic limit."""
    capped = allocate_waterfall(50_000_000, CAPPED, T, R, SIGMA)
    uncapped = allocate_waterfall(50_000_000, UNCAPPED, T, R, SIGMA)
    assert capped["common_per_share"] > uncapped["common_per_share"]
    assert capped["classes"]["Series A"]["value"] < uncapped["classes"]["Series A"]["value"]


def test_opm_allocation_conserves_equity_value():
    result = allocate_waterfall(50_000_000, CAPPED, T, R, SIGMA)
    total = sum(cls["value"] for cls in result["classes"].values())
    assert total == pytest.approx(50_000_000, rel=1e-6)


def test_a_cap_out_of_reach_allocates_as_uncapped():
    """A cap nothing can reach must not perturb the allocation."""
    far = [COMMON, series_a(cap=10_000_000_000)]
    assert values(exit_allocation(90_000_000, far)) == pytest.approx(
        values(exit_allocation(90_000_000, UNCAPPED)), abs=0.01
    )


def test_uncapped_cap_table_is_unchanged():
    """Regression: no `participation_cap` key behaves exactly as before."""
    legacy = [COMMON, {**series_a(cap=None)}]
    assert normalize_share_classes(legacy)[1]["participation_cap"] is None
    got = values(exit_allocation(20_000_000, legacy))
    assert got["Series A"] == pytest.approx(13_333_333.33, abs=0.01)


# ── caps alongside the other breakpoint events ───────────────────────────────


def test_cap_interacts_with_an_option_pool_and_a_junior_preferred():
    """A cap, a conversion and an exercise in one cap table still conserve."""
    classes = [
        COMMON,
        series_a(),
        {
            "name": "Series B",
            "kind": "preferred",
            "shares": 2_000_000,
            "preference": 5_000_000,
            "seniority": 1,
            "participating": False,
        },
        {"name": "Pool", "kind": "option", "shares": 1_500_000, "strike": 1.25},
    ]
    uncapped = [COMMON, series_a(cap=None), *classes[2:]]
    for exit_value in (1_000_000, 25_000_000, 45_000_000, 80_000_000, 500_000_000):
        got = values(exit_allocation(exit_value, classes))
        assert sum(got.values()) == pytest.approx(exit_value, rel=1e-9)
        # Capping a class can only ever cost that class and pay the others.
        was = values(exit_allocation(exit_value, uncapped))
        assert got["Series A"] <= was["Series A"] + 0.01
        assert got["Common"] >= was["Common"] - 0.01


def test_a_junior_capped_class_reaches_its_cap_first():
    """Two capped classes, resolved in the order the exit value reaches them.

    Preferences total $14M (Series A $10M senior, Series B $4M junior). The
    residual is shared on 14M as-converted shares, so from $14M to $42M of exit
    value Series B draws 2/14 and fills its $8M cap while Series A, drawing
    4/14, is still $2M short of its own.
    """
    classes = [
        COMMON,
        series_a(),
        {
            "name": "Series B",
            "kind": "preferred",
            "shares": 2_000_000,
            "preference": 4_000_000,
            "seniority": 2,
            "participating": True,
            "participation_cap": 8_000_000,
        },
    ]
    got = values(exit_allocation(45_000_000, classes))
    assert sum(got.values()) == pytest.approx(45_000_000, rel=1e-9)
    assert got["Series B"] == pytest.approx(8_000_000, abs=0.01)  # capped at $42M
    assert got["Series A"] == pytest.approx(19_000_000, abs=0.01)  # still drawing
    assert got["Common"] == pytest.approx(18_000_000, abs=0.01)


# ── validation ───────────────────────────────────────────────────────────────


def test_cap_on_a_non_participating_class_is_refused():
    classes = [COMMON, {**series_a(), "participating": False}]
    with pytest.raises(EngineInputError, match="participating preferred"):
        normalize_share_classes(classes)


@pytest.mark.parametrize("cap", [10_000_000, 9_999_999, 0])
def test_cap_at_or_below_the_preference_is_refused(cap):
    with pytest.raises(EngineInputError, match="must exceed the liquidation preference"):
        normalize_share_classes([COMMON, series_a(cap=cap)])


@pytest.mark.parametrize("cap", ["20000000x", [], float("nan"), float("inf")])
def test_unusable_cap_is_refused(cap):
    with pytest.raises(EngineInputError, match="participation_cap"):
        normalize_share_classes([COMMON, series_a(cap=cap)])


# ── pre-flight and engine agree ──────────────────────────────────────────────
#
# `validate_payload` exists to answer, before a run starts, the question
# `/compute` will answer by raising. A cap the pre-flight clears and the
# allocation then refuses is the failure mode that whole module is there to
# prevent, so each refusal is asserted on both sides.

PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 1.0,
    "weight_income": 0.0,
    "weight_market": 0.0,
    "dloc": 0.10,
    "dlom": 0.25,
    "allocation_method": "opm",
}
INPUTS = {
    "valuation_date": "2026-06-30",
    "shares_outstanding_common": 8_000_000,
    "volatility": 0.6,
    "risk_free_rate": 0.042,
    "time_to_exit_years": 3.0,
    "last_round_post_money": 50_000_000,
}


def _payload(classes):
    return PARAMS, {**INPUTS, "share_classes": classes}


def test_a_capped_cap_table_clears_the_pre_flight_and_computes():
    params, inputs = _payload(CAPPED)
    assert split_issues(validate_payload(params, inputs))[0] == []
    assert compute(params, inputs)["results"]["fmv_per_share"] > 0


def test_a_binding_cap_raises_the_concluded_fmv_end_to_end():
    """The cap has to reach the deliverable, not just the allocation."""
    capped = compute(*_payload(CAPPED))["results"]
    uncapped = compute(*_payload(UNCAPPED))["results"]
    assert capped["fmv_per_share"] > uncapped["fmv_per_share"]
    assert capped["allocation"]["method"] == "opm_waterfall"


def test_the_pre_flight_refuses_a_cap_on_a_non_participating_class():
    params, inputs = _payload([COMMON, {**series_a(), "participating": False}])
    errors, _ = split_issues(validate_payload(params, inputs))
    assert "inputs.share_classes[1].participation_cap" in {e.field for e in errors}
    with pytest.raises(EngineInputError):
        compute(params, inputs)


def test_the_pre_flight_refuses_a_cap_below_the_preference():
    params, inputs = _payload([COMMON, series_a(cap=5_000_000)])
    errors, _ = split_issues(validate_payload(params, inputs))
    assert "out_of_range" in {e.code for e in errors}
    assert "inputs.share_classes[1].participation_cap" in {e.field for e in errors}
    with pytest.raises(EngineInputError):
        compute(params, inputs)
