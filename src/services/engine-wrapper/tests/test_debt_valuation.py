"""Debt / credit instrument valuation unit tests (feature: Debt Valuation Engine)."""

import pytest

from app.engine.errors import EngineInputError
from app.engine.debt_valuation import (
    convertible_note,
    coupon_schedule,
    credit_spread_valuation,
    duration_convexity,
    present_value,
    rating_implied_spread,
    safe_conversion,
    term_loan_fair_value,
    value_instrument,
    yield_dcf,
    yield_to_maturity,
)


# ── Schedules ────────────────────────────────────────────────────────────────


def test_bullet_schedule_pays_face_at_maturity():
    rows = coupon_schedule(face=1000, coupon_rate=0.06, frequency=2, maturity_years=3)
    assert len(rows) == 6
    assert all(r["principal"] == 0 for r in rows[:-1])
    assert rows[-1]["principal"] == pytest.approx(1000)
    assert rows[0]["interest"] == pytest.approx(30.0)  # 1000 * 6% / 2


def test_amortizing_schedule_declines_balance_and_interest():
    rows = coupon_schedule(face=1000, coupon_rate=0.06, frequency=2, maturity_years=3, amortizing=True)
    assert rows[-1]["balance"] == pytest.approx(0.0)
    assert sum(r["principal"] for r in rows) == pytest.approx(1000)
    assert rows[1]["interest"] < rows[0]["interest"]  # interest on a shrinking balance


# ── Pricing ──────────────────────────────────────────────────────────────────


def test_par_bond_prices_at_par_when_yield_equals_coupon():
    v = yield_dcf(face=1000, coupon_rate=0.05, frequency=2, maturity_years=5, market_yield=0.05)
    assert v["dirty_price"] == pytest.approx(1000, abs=1e-3)
    assert v["clean_price"] == pytest.approx(1000, abs=1e-3)


def test_bond_below_par_when_yield_above_coupon():
    v = yield_dcf(face=1000, coupon_rate=0.05, frequency=2, maturity_years=5, market_yield=0.08)
    assert v["dirty_price"] < 1000


def test_accrued_interest_between_coupons():
    v = yield_dcf(face=1000, coupon_rate=0.06, frequency=2, maturity_years=5, market_yield=0.06, settlement_fraction=0.5)
    # Half a period into a $30 coupon → ~$15 accrued.
    assert v["accrued_interest"] == pytest.approx(15.0, abs=1e-6)
    assert v["dirty_price"] == pytest.approx(v["clean_price"] + v["accrued_interest"], abs=1e-6)


def test_present_value_matches_manual_discount():
    pv = present_value([{"amount": 105, "t_years": 1.0}], 0.05, frequency=1)
    assert pv == pytest.approx(100.0)


# ── YTM ──────────────────────────────────────────────────────────────────────


def test_ytm_inverts_pricing():
    price = yield_dcf(face=1000, coupon_rate=0.05, frequency=2, maturity_years=7, market_yield=0.065)["dirty_price"]
    ytm = yield_to_maturity(price=price, face=1000, coupon_rate=0.05, frequency=2, maturity_years=7)
    assert ytm == pytest.approx(0.065, abs=1e-4)


# ── Duration / convexity ─────────────────────────────────────────────────────


def test_duration_and_convexity_are_positive_and_ordered():
    d = duration_convexity(face=1000, coupon_rate=0.05, frequency=2, maturity_years=10, market_yield=0.05)
    assert 0 < d["modified_duration"] < d["macaulay_duration"] * 1.01
    assert d["macaulay_duration"] > 7  # a 10y 5% bond ~ 7-8y duration
    assert d["convexity"] > 0


# ── Credit spread + rating ───────────────────────────────────────────────────


def test_rating_spread_map_is_monotone():
    assert rating_implied_spread("AAA") < rating_implied_spread("BBB") < rating_implied_spread("B")


def test_credit_spread_valuation_uses_rating_when_no_spread():
    v = credit_spread_valuation(
        face=1000, coupon_rate=0.05, frequency=2, maturity_years=5, benchmark_yield=0.03, rating="BB"
    )
    assert v["all_in_yield"] == pytest.approx(0.03 + rating_implied_spread("BB"))
    assert v["fair_value"] > 0


def test_credit_spread_rejects_missing_inputs():
    with pytest.raises(EngineInputError):
        credit_spread_valuation(face=1000, coupon_rate=0.05, frequency=2, maturity_years=5, benchmark_yield=0.03)


# ── Term loan ────────────────────────────────────────────────────────────────


def test_amortizing_term_loan_worth_less_than_bullet_when_yield_above_coupon():
    amort = term_loan_fair_value(principal=1000, coupon_rate=0.05, frequency=4, maturity_years=5, market_yield=0.09)
    bullet = term_loan_fair_value(
        principal=1000, coupon_rate=0.05, frequency=4, maturity_years=5, market_yield=0.09, amortizing=False
    )
    assert amort["structure"] == "amortizing"
    # Earlier principal return means less exposure to the discount → closer to par.
    assert amort["fair_value"] > bullet["fair_value"]


# ── Convertible (Tsiveriotis-Fernandes) ──────────────────────────────────────


def test_convertible_is_worth_at_least_conversion_parity_and_debt_floor():
    v = convertible_note(
        face=1000,
        coupon_rate=0.04,
        frequency=2,
        maturity_years=5,
        conversion_ratio=20,  # converts into 20 shares
        stock_price=40,  # parity = 800
        volatility=0.4,
        risk_free_rate=0.03,
        credit_spread=0.02,
        steps=150,
    )
    assert v["fair_value"] >= v["parity"] - 1e-6
    assert v["fair_value"] >= v["straight_debt_value"] - 1e-6
    assert v["option_value"] >= 0


def test_convertible_deep_in_the_money_tracks_parity():
    v = convertible_note(
        face=1000,
        coupon_rate=0.04,
        frequency=2,
        maturity_years=3,
        conversion_ratio=20,
        stock_price=200,  # parity = 4000, far above redemption
        volatility=0.4,
        risk_free_rate=0.03,
        credit_spread=0.02,
        steps=150,
    )
    assert v["fair_value"] == pytest.approx(v["parity"], rel=0.05)


def test_higher_credit_spread_lowers_a_debt_like_convertible():
    base = dict(
        face=1000, coupon_rate=0.04, frequency=2, maturity_years=5,
        conversion_ratio=10, stock_price=40, volatility=0.3, risk_free_rate=0.03, steps=150,
    )
    tight = convertible_note(**base, credit_spread=0.01)
    wide = convertible_note(**base, credit_spread=0.06)
    assert wide["fair_value"] < tight["fair_value"]


# ── SAFE ─────────────────────────────────────────────────────────────────────


def test_safe_converts_at_the_cap_when_cap_binds():
    r = safe_conversion(
        investment=100_000,
        valuation_cap=5_000_000,
        discount=0.20,
        next_round_pre_money=20_000_000,
        next_round_shares=10_000_000,
    )
    # Round price = 2.00; discount price = 1.60; cap price = 0.50 → cap binds.
    assert r["conversion_price"] == pytest.approx(0.50)
    assert r["converted_via"] == "cap"
    assert r["shares_received"] == pytest.approx(200_000)
    assert r["fair_value"] == pytest.approx(400_000)  # 200k shares × $2


def test_safe_converts_at_discount_when_no_cap():
    r = safe_conversion(
        investment=100_000,
        valuation_cap=None,
        discount=0.20,
        next_round_pre_money=20_000_000,
        next_round_shares=10_000_000,
    )
    assert r["conversion_price"] == pytest.approx(1.60)
    assert r["converted_via"] == "discount"


def test_safe_mfn_adopts_better_discount():
    base = dict(investment=100_000, valuation_cap=None, next_round_pre_money=20_000_000, next_round_shares=10_000_000)
    plain = safe_conversion(discount=0.10, **base)
    mfn = safe_conversion(discount=0.10, mfn_discount=0.30, **base)
    assert mfn["conversion_price"] < plain["conversion_price"]


# ── Dispatcher ───────────────────────────────────────────────────────────────


def test_value_instrument_dispatches_and_bond_includes_duration():
    v = value_instrument(
        "bond",
        {"face": 1000, "coupon_rate": 0.05, "frequency": 2, "maturity_years": 5, "market_yield": 0.05},
    )
    assert "modified_duration" in v and "convexity" in v
    assert v["dirty_price"] == pytest.approx(1000, abs=1e-3)


def test_value_instrument_rejects_unknown_type():
    with pytest.raises(EngineInputError):
        value_instrument("mortgage", {})
