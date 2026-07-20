"""ASC 820 fund-holdings valuation unit tests (feature: ASC 820 Fund Holdings)."""

import pytest

from app.engine.errors import EngineInputError
from app.engine.fund_valuation import (
    calibrate_implied_volatility,
    classify_level,
    compute_nav,
    fund_valuation,
    lp_waterfall,
    mark_position,
    roll_forward_mark,
)


# ── ASC 820 leveling ─────────────────────────────────────────────────────────


def test_classify_level_maps_method_to_hierarchy():
    assert classify_level("market") == 1
    assert classify_level("last_round") == 2
    assert classify_level("calibrated_opm") == 3
    assert classify_level("cost") == 3
    assert classify_level("cost", has_quote=True) == 1


# ── Position marks ───────────────────────────────────────────────────────────


def test_mark_market_position_is_quantity_times_quote():
    m = mark_position(
        {"name": "PublicCo", "method": "market", "quantity": 1000, "quoted_price": 12.5, "cost_basis": 8000}
    )
    assert m["fair_value"] == pytest.approx(12500.0)
    assert m["level"] == 1
    assert m["unrealized_gain"] == pytest.approx(4500.0)


def test_mark_last_round_position_is_level_2():
    m = mark_position(
        {"name": "SeriesB", "method": "last_round", "quantity": 500, "round_price_per_share": 20, "cost_basis": 5000}
    )
    assert m["fair_value"] == pytest.approx(10000.0)
    assert m["level"] == 2


def test_mark_calibrated_opm_is_level_3():
    m = mark_position({"name": "Startup", "method": "calibrated_opm", "model_value": 42000, "cost_basis": 30000})
    assert m["fair_value"] == pytest.approx(42000.0)
    assert m["level"] == 3


def test_mark_rejects_unknown_method():
    with pytest.raises(EngineInputError):
        mark_position({"name": "X", "method": "wishful"})


def test_mark_requires_name():
    with pytest.raises(EngineInputError):
        mark_position({"method": "cost"})


# ── NAV ──────────────────────────────────────────────────────────────────────


def test_compute_nav_rolls_up_and_breaks_down_by_level():
    nav = compute_nav(
        [
            {"name": "A", "method": "market", "quantity": 100, "quoted_price": 10, "cost_basis": 500},
            {"name": "B", "method": "last_round", "quantity": 100, "round_price_per_share": 5, "cost_basis": 300},
            {"name": "C", "method": "calibrated_opm", "model_value": 2000, "cost_basis": 1000},
        ],
        liabilities=400,
    )
    assert nav["gross_asset_value"] == pytest.approx(1000 + 500 + 2000)
    assert nav["net_asset_value"] == pytest.approx(3500 - 400)
    assert nav["level_breakdown"]["level_1"] == pytest.approx(1000)
    assert nav["level_breakdown"]["level_2"] == pytest.approx(500)
    assert nav["level_breakdown"]["level_3"] == pytest.approx(2000)
    assert nav["total_unrealized_gain"] == pytest.approx(3500 - 1800)


def test_compute_nav_rejects_empty():
    with pytest.raises(EngineInputError):
        compute_nav([])


# ── Calibration to last round ────────────────────────────────────────────────


def test_calibrate_reproduces_the_round_price():
    res = calibrate_implied_volatility(
        round_price_per_share=8.0,
        total_equity_value=100_000_000,
        strike=40_000_000,
        time_to_exit_years=4.0,
        risk_free_rate=0.04,
        preferred_shares=2_000_000,
        fully_diluted_shares=10_000_000,
    )
    assert 0.01 < res["implied_volatility"] < 5.0
    # The calibrated equity call, scaled to the class fraction, reproduces the
    # target class value (price × preferred shares) = 16,000,000.
    frac = 2_000_000 / 10_000_000
    assert res["calibrated_equity_call"] * frac == pytest.approx(res["target_class_value"], rel=1e-3)
    assert res["target_class_value"] == pytest.approx(16_000_000)


def test_calibrate_rejects_zero_term():
    with pytest.raises(EngineInputError):
        calibrate_implied_volatility(
            round_price_per_share=10.0,
            total_equity_value=1e8,
            strike=4e7,
            time_to_exit_years=0.0,
            risk_free_rate=0.04,
            preferred_shares=2e6,
            fully_diluted_shares=1e7,
        )


# ── Roll-forward ─────────────────────────────────────────────────────────────


def test_roll_forward_index_applies_return():
    r = roll_forward_mark(prior_fair_value=1000, method="index", index_return=0.10)
    assert r["new_fair_value"] == pytest.approx(1100.0)
    assert r["change"] == pytest.approx(100.0)


def test_roll_forward_accretion_compounds():
    r = roll_forward_mark(prior_fair_value=1000, method="accretion", accretion_rate=0.08, periods=2)
    assert r["new_fair_value"] == pytest.approx(1000 * 1.08**2)


def test_roll_forward_calibration_adopts_new_value():
    r = roll_forward_mark(prior_fair_value=1000, method="calibration", new_calibrated_value=1500)
    assert r["new_fair_value"] == pytest.approx(1500.0)


def test_roll_forward_calibration_requires_value():
    with pytest.raises(EngineInputError):
        roll_forward_mark(prior_fair_value=1000, method="calibration")


# ── LP waterfall ─────────────────────────────────────────────────────────────


def test_waterfall_returns_capital_and_pref_before_carry():
    # Distribute exactly return of capital + a bit of preferred: GP gets nothing.
    w = lp_waterfall(
        committed_capital=100,
        contributed_capital=100,
        distributable=105,
        preferred_return_rate=0.08,
        years=1.0,
        carry_pct=0.20,
    )
    assert w["tiers"]["return_of_capital"] == pytest.approx(100.0)
    assert w["tiers"]["preferred_return"] == pytest.approx(5.0)
    assert w["gp_distribution"] == pytest.approx(0.0)
    assert w["lp_distribution"] == pytest.approx(105.0)


def test_waterfall_gp_gets_20pct_carry_after_catchup():
    # Contributed 100, pref 8 (1y @ 8%), distribute 200 → profit 100.
    w = lp_waterfall(
        committed_capital=100,
        contributed_capital=100,
        distributable=200,
        preferred_return_rate=0.08,
        years=1.0,
        carry_pct=0.20,
        gp_catch_up=True,
    )
    # LP: 100 ROC + 8 pref + 80% of residual; GP: catch-up + 20% residual.
    # GP total should be ~20% of profit above ROC (=100) once fully caught up.
    assert w["gp_distribution"] == pytest.approx(20.0, abs=1e-6)
    assert w["lp_distribution"] == pytest.approx(180.0, abs=1e-6)
    assert w["lp_distribution"] + w["gp_distribution"] == pytest.approx(200.0)


def test_waterfall_clawback_when_gp_overdistributed():
    w = lp_waterfall(
        committed_capital=100,
        contributed_capital=100,
        distributable=120,
        preferred_return_rate=0.0,
        years=1.0,
        carry_pct=0.20,
        gp_distributions_to_date=50,  # GP already took far more than entitled
    )
    # Total profit = 20, GP entitled = 4; GP already has 50+ → clawback owed.
    assert w["clawback_owed"] > 0


def test_waterfall_rejects_full_carry():
    with pytest.raises(EngineInputError):
        lp_waterfall(committed_capital=100, contributed_capital=100, distributable=100, carry_pct=1.0)


# ── Orchestration ────────────────────────────────────────────────────────────


def test_fund_valuation_returns_nav_and_waterfall():
    res = fund_valuation(
        {
            "positions": [
                {"name": "A", "method": "market", "quantity": 100, "quoted_price": 10, "cost_basis": 500},
            ],
            "liabilities": 100,
            "lp_terms": {"contributed_capital": 500, "distributable": 1200, "carry_pct": 0.2},
        }
    )
    assert res["nav"]["net_asset_value"] == pytest.approx(900.0)
    assert "waterfall" in res
    assert res["waterfall"]["lp_distribution"] > 0
