"""Waterfall allocation + Newton-Raphson unit tests (remaining-gaps §2)."""

import pytest

from app.engine.bs import bs_call
from app.engine.errors import EngineInputError
from app.engine.newton import implied_volatility, newton_raphson
from app.engine.waterfall import (
    MAX_SHARE_CLASSES,
    _segments,
    allocate_waterfall,
    exit_allocation,
    normalize_share_classes,
)

T, R, SIGMA = 3.0, 0.04, 0.6

COMMON = {"name": "Common", "kind": "common", "shares": 8_000_000}


def classes_of(*extra):
    return [COMMON, *extra]


# ── newton_raphson ───────────────────────────────────────────────────────────


def test_newton_solves_quadratic():
    root, iters = newton_raphson(lambda x: x * x - 4.0, 1.0)
    assert root == pytest.approx(2.0, abs=1e-6)
    assert iters < 20


def test_newton_bisection_fallback_on_flat_derivative():
    # f is flat at x0=0 (derivative 0) — must fall back to bisection.
    root, _ = newton_raphson(lambda x: x**3 - 8.0, 0.0, min_x=0.0, max_x=10.0)
    assert root == pytest.approx(2.0, abs=1e-5)


def test_newton_respects_bounds():
    # Newton from x0=10 on 1/x - 0.5 would jump around; bounds keep it sane.
    root, _ = newton_raphson(lambda x: 1.0 / x - 0.5, 10.0, min_x=0.1, max_x=100.0)
    assert root == pytest.approx(2.0, abs=1e-5)


def test_newton_unbracketed_raises():
    with pytest.raises(EngineInputError):
        newton_raphson(lambda x: x * x + 1.0, 1.0, min_x=-10.0, max_x=10.0)


# ── implied_volatility ───────────────────────────────────────────────────────


def test_implied_volatility_round_trip():
    price = bs_call(100.0, 90.0, 2.0, 0.03, 0.45)
    assert implied_volatility(price, 100.0, 90.0, 2.0, 0.03) == pytest.approx(0.45, abs=1e-4)


def test_implied_volatility_rejects_out_of_range_price():
    with pytest.raises(EngineInputError):
        implied_volatility(150.0, 100.0, 90.0, 2.0, 0.03)  # price > spot
    with pytest.raises(EngineInputError):
        implied_volatility(0.0, 100.0, 50.0, 2.0, 0.03)  # below intrinsic


# ── waterfall structure ──────────────────────────────────────────────────────


def test_single_preferred_matches_single_breakpoint_math():
    """One non-participating preferred + common reproduces the aggregate model
    below its conversion point, plus the conversion refinement above."""
    pref = {
        "name": "Series A",
        "kind": "preferred",
        "shares": 2_000_000,
        "preference": 5_000_000,
        "seniority": 1,
    }
    equity = 6_000_000  # barely above the preference: conversion is far away
    out = allocate_waterfall(equity, classes_of(pref), T, R, SIGMA)

    assert out["method"] == "opm_waterfall"
    # Segment 1 is the preference tranche owned 100% by Series A.
    first = out["breakpoints"][0]
    assert first["from"] == 0 and first["to"] == 5_000_000
    assert first["participants"] == {"Series A": 1.0}
    # Common's value is bounded by the upside call over the aggregate
    # preference (it shares the middle tranche with nobody until conversion).
    upside = bs_call(equity, 5_000_000, T, R, SIGMA)
    assert out["common_value"] <= upside + 1e-6
    assert out["common_value"] > 0


def test_conservation_of_value():
    cases = [
        classes_of({"name": "A", "kind": "preferred", "shares": 1e6, "preference": 4e6}),
        classes_of(
            {"name": "A", "kind": "preferred", "shares": 1e6, "preference": 4e6, "seniority": 1},
            {"name": "B", "kind": "preferred", "shares": 2e6, "preference": 6e6, "seniority": 2},
            {"name": "Options", "kind": "option", "shares": 5e5, "strike": 1.25},
        ),
        classes_of(
            {"name": "Part", "kind": "preferred", "shares": 1e6, "preference": 3e6, "participating": True},
        ),
    ]
    for classes in cases:
        for equity in (2e6, 15e6, 80e6):
            out = allocate_waterfall(equity, classes, T, R, SIGMA)
            total = sum(c["value"] for c in out["classes"].values())
            assert total == pytest.approx(equity, rel=1e-6)


def test_seniority_orders_the_preference_stack():
    senior = {"name": "B", "kind": "preferred", "shares": 1e6, "preference": 3e6, "seniority": 1}
    junior = {"name": "A", "kind": "preferred", "shares": 1e6, "preference": 3e6, "seniority": 2}
    out = allocate_waterfall(4_000_000, classes_of(senior, junior), T, R, SIGMA)
    bps = out["breakpoints"]
    assert bps[0]["participants"] == {"B": 1.0} and bps[0]["to"] == 3_000_000
    assert bps[1]["participants"] == {"A": 1.0} and bps[1]["to"] == 6_000_000
    # Equity below combined preference: the senior class is worth strictly more.
    assert out["classes"]["B"]["value"] > out["classes"]["A"]["value"]


def test_pari_passu_splits_pro_rata_by_preference():
    a = {"name": "A", "kind": "preferred", "shares": 1e6, "preference": 2e6, "seniority": 1}
    b = {"name": "B", "kind": "preferred", "shares": 1e6, "preference": 6e6, "seniority": 1}
    out = allocate_waterfall(4_000_000, classes_of(a, b), T, R, SIGMA)
    first = out["breakpoints"][0]
    assert first["participants"]["A"] == pytest.approx(0.25)
    assert first["participants"]["B"] == pytest.approx(0.75)


def test_participating_preferred_gets_preference_plus_pro_rata():
    part = {
        "name": "P",
        "kind": "preferred",
        "shares": 2_000_000,
        "preference": 5_000_000,
        "participating": True,
    }
    non = {**part, "name": "NP", "participating": False}
    equity = 20_000_000
    v_part = allocate_waterfall(equity, classes_of(part), T, R, SIGMA)["classes"]["P"]["value"]
    v_non = allocate_waterfall(equity, classes_of(non), T, R, SIGMA)["classes"]["NP"]["value"]
    assert v_part > v_non  # double dip beats convert-or-take-preference


def test_nonparticipating_converts_at_high_equity_value():
    pref = {"name": "A", "kind": "preferred", "shares": 2_000_000, "preference": 5_000_000}
    equity = 1_000_000_000  # deep in the money: behaves as-converted
    out = allocate_waterfall(equity, classes_of(pref), T, R, SIGMA)
    as_converted = equity * 2 / 10  # 2M of 10M as-converted shares
    assert out["classes"]["A"]["value"] == pytest.approx(as_converted, rel=0.02)


def test_options_worthless_below_strike_valuable_above():
    opt = {"name": "Opts", "kind": "option", "shares": 1_000_000, "strike": 2.0}
    low = allocate_waterfall(100_000, classes_of(opt), 1.0, R, 0.2)
    high = allocate_waterfall(500_000_000, classes_of(opt), 1.0, R, 0.2)
    assert low["classes"]["Opts"]["value"] < low["common_value"] * 0.01
    assert high["classes"]["Opts"]["value"] > 0.05 * high["common_value"]


def test_validation_errors():
    with pytest.raises(EngineInputError, match="non-empty"):
        allocate_waterfall(1e6, [], T, R, SIGMA)
    with pytest.raises(EngineInputError, match="common"):
        allocate_waterfall(
            1e6, [{"name": "A", "kind": "preferred", "shares": 1, "preference": 1}], T, R, SIGMA
        )
    with pytest.raises(EngineInputError, match="preference"):
        allocate_waterfall(1e6, classes_of({"name": "A", "kind": "preferred", "shares": 1e6}), T, R, SIGMA)
    with pytest.raises(EngineInputError, match="strike"):
        allocate_waterfall(1e6, classes_of({"name": "O", "kind": "option", "shares": 1e6}), T, R, SIGMA)
    with pytest.raises(EngineInputError, match="duplicate"):
        allocate_waterfall(1e6, [COMMON, COMMON], T, R, SIGMA)
    with pytest.raises(EngineInputError, match="volatility"):
        allocate_waterfall(1e6, classes_of(), T, R, 0.0)


# ── class-count ceiling ──────────────────────────────────────────────────────
#
# The breakpoint method is quadratic in the class count in both CPU and
# response size, so an oversized cap table has to be refused as input rather
# than allocated: 2,000 classes fit in a 200 KB request and produce a 36 MB
# body. These pin the ceiling, its error, and that a real cap table clears it.


def _preferred_stack(n: int) -> list[dict]:
    return classes_of(
        *(
            {
                "name": f"Series-{i}",
                "kind": "preferred",
                "shares": 100_000,
                "preference": 1_000_000.0 + i,
                "seniority": i + 1,
            }
            for i in range(n)
        )
    )


def test_share_classes_over_the_ceiling_are_refused():
    classes = _preferred_stack(MAX_SHARE_CLASSES)  # + Common == one over
    assert len(classes) == MAX_SHARE_CLASSES + 1
    with pytest.raises(EngineInputError, match="at most 200 classes"):
        allocate_waterfall(1e9, classes, T, R, SIGMA)


def test_share_class_ceiling_names_the_count_it_got():
    with pytest.raises(EngineInputError, match=r"got 501"):
        allocate_waterfall(1e9, _preferred_stack(500), T, R, SIGMA)


def test_share_classes_at_the_ceiling_still_allocate():
    classes = _preferred_stack(MAX_SHARE_CLASSES - 1)
    assert len(classes) == MAX_SHARE_CLASSES
    out = allocate_waterfall(1e9, classes, T, R, SIGMA)
    # Value is still conserved at the limit — the ceiling bounds the work, it
    # does not truncate the table.
    assert sum(c["value"] for c in out["classes"].values()) == pytest.approx(1e9, rel=1e-6)


def test_share_class_ceiling_also_guards_the_deterministic_waterfall():
    # exit_allocation and PWERM share the normaliser, so the same table that
    # the OPM path refuses must not slip in through the intrinsic path.
    with pytest.raises(EngineInputError, match="at most 200 classes"):
        exit_allocation(1e9, _preferred_stack(MAX_SHARE_CLASSES))
    with pytest.raises(EngineInputError, match="at most 200 classes"):
        normalize_share_classes(_preferred_stack(MAX_SHARE_CLASSES))


# ── option exercise proceeds ─────────────────────────────────────────────────
#
# The strike is paid *into* the company when a pool exercises, and the module's
# own note says the proceeds are "captured by the slope algebra rather than
# modeled as a cash inflow". They were, for the pool's own payoff and for
# common's — and only while the exercise was the last event on the table. Any
# threshold struck *after* one was computed as though the money had never
# arrived, and was late by exactly the proceeds.
#
# Nothing already in this file could see it: value conserves either way, because
# the segment slopes sum to one whatever the breakpoints are, and the
# single-pool tables above are exactly the case that is right regardless.

_SPLIT_BASE = [
    {"name": "Series A", "kind": "preferred", "shares": 2_000_000, "preference": 8_000_000, "seniority": 1},
    {"name": "Common", "kind": "common", "shares": 6_000_000},
]


def _values(pools, equity=60_000_000.0):
    out = allocate_waterfall(equity, _SPLIT_BASE + pools, T, R, SIGMA)
    return {n: c["value"] for n, c in out["classes"].items()}


def _pool(name, shares, strike=1.0):
    return {"name": name, "kind": "option", "shares": shares, "strike": strike}


def test_identical_option_pools_are_worth_the_same():
    # Two pools alike in every respect are at the money at the same exit value.
    # The second was placed a full `strike x pool` further up the axis, so three
    # identical pools came back at three different values.
    v = _values([_pool(f"Pool {i}", 500_000) for i in (1, 2, 3)])
    assert v["Pool 1"] == pytest.approx(v["Pool 2"], rel=1e-12)
    assert v["Pool 2"] == pytest.approx(v["Pool 3"], rel=1e-12)


def test_splitting_one_pool_into_three_changes_nothing():
    # The model-free invariant, and the one that says which of the two answers
    # was wrong: how a grant is written down on the cap table is not a fact about
    # the company. Splitting 1,500,000 options at $1.00 into three pools of
    # 500,000 moved $58,422 from the option holders to common.
    one = _values([_pool("Pool", 1_500_000)])
    three = _values([_pool(f"Pool {i}", 500_000) for i in (1, 2, 3)])
    # To the cent, not to the float: `allocate_waterfall` rounds each class's
    # value for the response, so three rounded pools can miss one rounded pool
    # by a cent and a half. That is the presentation, not the allocation — the
    # defect this pins was worth $58,422.
    assert sum(v for n, v in three.items() if n.startswith("Pool")) == pytest.approx(one["Pool"], abs=0.02)
    assert three["Common"] == pytest.approx(one["Common"], abs=0.02)
    assert three["Series A"] == pytest.approx(one["Series A"], abs=0.02)


def test_pools_at_different_strikes_still_exercise_in_order():
    # Crediting the proceeds must not collapse genuinely different strikes onto
    # one breakpoint: a $2.00 pool is still out of the money where a $1.00 pool
    # is at it, and is worth less.
    v = _values([_pool("Cheap", 500_000, 1.0), _pool("Dear", 500_000, 2.0)])
    assert v["Cheap"] > v["Dear"] > 0


def test_a_conversion_after_an_exercise_is_struck_at_the_right_value():
    # The other half of the defect, on a table where the pool exercises before
    # the preferred converts.
    #
    # Hand-derived: the pool exercises at $8M, putting $2M of strike money into a
    # residual then shared by 6,000,000 shares. Series A converts to 2,000,000
    # shares and gives up its $4M preference, so it is indifferent where its 2/8
    # of the pool is worth $4M — at an exit of $14M. It was struck at $16M, late
    # by exactly the $2M of proceeds, so the class held a preference it should
    # already have given up.
    classes = [
        {"name": "Series A", "kind": "preferred", "shares": 2_000_000, "preference": 4_000_000, "seniority": 1},
        _pool("Pool", 2_000_000),
        {"name": "Common", "kind": "common", "shares": 4_000_000},
    ]
    segments = _segments(normalize_share_classes(classes))
    conversion = next(s["from"] for s in segments if "Series A" in s["participants"] and s["from"] > 0)
    assert conversion == pytest.approx(14_000_000.0, rel=1e-9)


def test_value_still_conserves_across_split_pools():
    # The invariant the module documents, on the table that exposed the defect —
    # it held before the fix too, which is why nothing caught this.
    for pools in ([_pool("Pool", 1_500_000)], [_pool(f"Pool {i}", 500_000) for i in (1, 2, 3)]):
        out = allocate_waterfall(60_000_000.0, _SPLIT_BASE + pools, T, R, SIGMA)
        assert sum(c["value"] for c in out["classes"].values()) == pytest.approx(60_000_000.0, rel=1e-9)
