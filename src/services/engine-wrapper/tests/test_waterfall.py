"""Waterfall allocation + Newton-Raphson unit tests (remaining-gaps §2)."""

import pytest

from app.engine.bs import bs_call
from app.engine.errors import EngineInputError
from app.engine.newton import implied_volatility, newton_raphson
from app.engine.waterfall import allocate_waterfall

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
