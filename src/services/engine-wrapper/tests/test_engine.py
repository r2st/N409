"""Engine math tests — golden values + behavioral properties."""

import math

import pytest

from app.engine.approaches import EngineInputError, asset_value, income_dcf, market_multiples
from app.engine.bs import bs_call, bs_put
from app.engine.dlom import chaffee_dlom, finnerty_dlom


# ── Black-Scholes ─────────────────────────────────────────────────────────────
def test_bs_call_textbook_value():
    # Standard reference: S=100, K=100, T=1, r=5%, σ=20% → C ≈ 10.4506
    assert bs_call(100, 100, 1, 0.05, 0.2) == pytest.approx(10.4506, abs=1e-3)


def test_bs_put_parity():
    s, k, t, r, sigma = 100, 110, 2, 0.03, 0.35
    call = bs_call(s, k, t, r, sigma)
    put = bs_put(s, k, t, r, sigma)
    assert call - put == pytest.approx(s - k * math.exp(-r * t), abs=1e-9)


def test_bs_call_degenerates_to_intrinsic():
    assert bs_call(100, 60, 0, 0.05, 0.2) == pytest.approx(40)
    assert bs_call(50, 60, 0, 0.05, 0.2) == 0.0
    # zero vol ≈ discounted intrinsic
    assert bs_call(100, 60, 1, 0.05, 0) == pytest.approx(100 - 60 * math.exp(-0.05), abs=1e-9)


def test_bs_call_monotonic_in_vol():
    values = [bs_call(100, 120, 2, 0.04, sigma) for sigma in (0.2, 0.4, 0.6, 0.8)]
    assert values == sorted(values)
    assert all(v > 0 for v in values)


# ── DLOM ──────────────────────────────────────────────────────────────────────
def test_chaffee_equals_atm_put():
    assert chaffee_dlom(0.6, 2, 0.04) == pytest.approx(bs_put(1, 1, 2, 0.04, 0.6), abs=1e-12)


def test_chaffee_increases_with_vol_and_time():
    assert chaffee_dlom(0.8, 2, 0.04) > chaffee_dlom(0.4, 2, 0.04)
    assert chaffee_dlom(0.5, 3, 0.04) > chaffee_dlom(0.5, 1, 0.04)
    assert chaffee_dlom(0, 2, 0.04) == 0.0


def test_finnerty_bounded_and_monotonic():
    d1 = finnerty_dlom(0.3, 1)
    d2 = finnerty_dlom(0.6, 2)
    assert 0 < d1 < d2 < 0.35  # Finnerty caps around ~32.2%
    assert finnerty_dlom(0, 1) == 0.0


def test_finnerty_below_chaffee_for_typical_inputs():
    # The average-strike put is cheaper than the full ATM put.
    assert finnerty_dlom(0.6, 2) < chaffee_dlom(0.6, 2, 0.04)


# ── Approaches ────────────────────────────────────────────────────────────────
def test_income_dcf_hand_computed():
    # FCF 100/110/121 @ r=20%, g=3%:
    #   PV = 83.3333 + 76.3889 + 70.0231 = 229.7454
    #   TV = 121*1.03/0.17 = 733.1176; PV(TV) = 733.1176/1.728 = 424.2579
    res = income_dcf([100, 110, 121], 0.2, 0.03)
    assert res["pv_explicit"] == pytest.approx(229.745, abs=1e-2)
    assert res["pv_terminal"] == pytest.approx(424.258, abs=1e-2)
    assert res["equity_value"] == pytest.approx(654.003, abs=1e-2)


def test_income_dcf_cash_debt_bridge():
    base = income_dcf([100], 0.2, 0.0)
    bridged = income_dcf([100], 0.2, 0.0, cash=50, debt=30)
    assert bridged["equity_value"] == pytest.approx(base["equity_value"] + 20)


def test_income_dcf_rejects_growth_above_discount():
    with pytest.raises(EngineInputError):
        income_dcf([100], 0.05, 0.06)


def test_market_uses_median_multiple():
    res = market_multiples(1_000_000, [4.0, 6.0, 100.0], cash=10, debt=0)
    assert res["selected_multiple"] == 6.0
    assert res["equity_value"] == pytest.approx(6_000_010)


def test_market_filters_junk_multiples():
    with pytest.raises(EngineInputError):
        market_multiples(1_000_000, [-2, 0])


def test_asset_nav_and_cost_to_replicate():
    nav = asset_value(total_assets=900_000, total_liabilities=250_000)
    assert nav["equity_value"] == 650_000
    ctr = asset_value(cost_to_replicate=400_000, method="cost_to_replicate")
    assert ctr["equity_value"] == 400_000
    with pytest.raises(EngineInputError):
        asset_value(total_assets=None, total_liabilities=1)
