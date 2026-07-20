"""Explicit negative-path coverage for the engine numerics (audit T-1 P3).

Locks the guards the code relies on: non-convergence, empty cap table,
negative/zero volatility, and NaN/Inf inputs.
"""

import math

import pytest

from app.engine.bs import bs_call, bs_put
from app.engine.compute import compute
from app.engine.errors import EngineInputError
from app.engine.newton import implied_volatility, newton_raphson
from app.engine.volatility import estimate_volatility
from app.engine.waterfall import allocate_waterfall

PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 1.0,
    "weight_income": 0.0,
    "weight_market": 0.0,
    "dloc": 0.1,
    "dlom_method": "finnerty",
    "exit_timeline": "2029-06-30",
}
INPUTS = {
    "valuation_date": "2026-06-30",
    "shares_outstanding_common": 7_000_000,
    "options_outstanding": 1_000_000,
    "shares_outstanding_preferred": 2_000_000,
    "liquidation_preference": 5_000_000,
    "volatility": 0.6,
    "risk_free_rate": 0.042,
    "last_round_post_money": 20_000_000,
}


# ── Non-convergence ───────────────────────────────────────────────────────────
def test_newton_without_bounds_raises_when_it_cannot_converge():
    with pytest.raises(EngineInputError, match="did not converge"):
        newton_raphson(lambda x: 1.0, 0.0, max_iter=5)  # f never zero, no bracket


def test_newton_with_unbracketed_bounds_raises():
    # Falls back to bisection, but f(lo) and f(hi) share a sign → not bracketed.
    with pytest.raises(EngineInputError, match="not bracketed"):
        newton_raphson(lambda x: x * x + 1.0, 0.0, min_x=1.0, max_x=2.0)


def test_implied_vol_outside_no_arbitrage_band_raises():
    with pytest.raises(EngineInputError, match="no-arbitrage"):
        implied_volatility(1e9, 100.0, 50.0, 1.0, 0.04)  # price above spot


# ── Empty cap table ───────────────────────────────────────────────────────────
def test_waterfall_empty_classes_raises():
    with pytest.raises(EngineInputError, match="non-empty"):
        allocate_waterfall(10_000_000.0, [], 3.0, 0.04, 0.6)


def test_estimate_volatility_empty_comparables_raises():
    with pytest.raises(EngineInputError):
        estimate_volatility([], method="historical")


# ── Negative / zero volatility ────────────────────────────────────────────────
def test_manual_override_zero_or_negative_rejected():
    with pytest.raises(EngineInputError, match="fraction"):
        estimate_volatility([], method="historical", manual_override=0.0)
    with pytest.raises(EngineInputError, match="fraction"):
        estimate_volatility([], method="historical", manual_override=-0.2)


def test_bs_call_degenerates_to_intrinsic_at_zero_vol():
    # σ ≤ 0 is defined behaviour: the call is worth its (discounted) intrinsic value.
    intrinsic = 120.0 - 100.0 * math.exp(-0.05 * 1.0)
    assert bs_call(120.0, 100.0, 1.0, 0.05, 0.0) == pytest.approx(intrinsic)
    assert bs_call(80.0, 100.0, 1.0, 0.05, 0.0) == 0.0  # out of the money
    # Put-call parity still holds at σ=0.
    assert bs_put(120.0, 100.0, 1.0, 0.05, 0.0) == pytest.approx(
        bs_call(120.0, 100.0, 1.0, 0.05, 0.0) - 120.0 + 100.0 * math.exp(-0.05)
    )


def test_negative_volatility_input_rejected_by_compute():
    with pytest.raises(EngineInputError, match="positive"):
        compute(PARAMS, {**INPUTS, "volatility": -0.5})


# ── NaN / Inf inputs ──────────────────────────────────────────────────────────
@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_compute_rejects_non_finite_numeric_inputs(bad):
    with pytest.raises(EngineInputError, match="finite"):
        compute(PARAMS, {**INPUTS, "volatility": bad})
    with pytest.raises(EngineInputError, match="finite"):
        compute(PARAMS, {**INPUTS, "last_round_post_money": bad})


def test_non_finite_never_produces_a_nan_fmv():
    # Belt-and-braces: the guard means a NaN input can't yield a NaN result.
    try:
        out = compute(PARAMS, {**INPUTS, "cash": float("nan")})
    except EngineInputError:
        return  # rejected up front — the intended path
    assert math.isfinite(out["results"]["fmv_per_share"])  # pragma: no cover
