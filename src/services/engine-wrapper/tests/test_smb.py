"""SMB valuation engine unit tests (feature: SMB Fair Market Value report)."""

import pytest

from app.engine.errors import EngineInputError
from app.engine.smb import buildup_cap_rate, sde_normalization, smb_valuation


# ── SDE normalization ────────────────────────────────────────────────────────


def test_sde_adds_back_owner_items():
    out = sde_normalization(
        pretax_income=200_000.0,
        owner_compensation=150_000.0,
        interest_expense=10_000.0,
        depreciation_amortization=25_000.0,
        one_time_expenses=15_000.0,
        discretionary_expenses=20_000.0,
    )
    assert out["sde"] == pytest.approx(420_000.0)


def test_sde_deducts_one_time_income_and_replacement_wage():
    out = sde_normalization(
        pretax_income=200_000.0,
        owner_compensation=150_000.0,
        one_time_income=30_000.0,
        fair_market_replacement_wage=80_000.0,
    )
    assert out["sde"] == pytest.approx(240_000.0)


def test_sde_can_be_negative():
    out = sde_normalization(pretax_income=-50_000.0, owner_compensation=20_000.0)
    assert out["sde"] == pytest.approx(-30_000.0)


def test_sde_negative_addback_rejected():
    with pytest.raises(EngineInputError, match="owner_compensation"):
        sde_normalization(pretax_income=1.0, owner_compensation=-5.0)


# ── Cap rate build-up ────────────────────────────────────────────────────────


def test_buildup_cap_rate_manual():
    out = buildup_cap_rate(
        risk_free_rate=0.04,
        equity_risk_premium=0.06,
        size_premium=0.05,
        company_specific_premium=0.05,
        long_term_growth=0.03,
    )
    assert out["discount_rate"] == pytest.approx(0.20)
    assert out["cap_rate"] == pytest.approx(0.17)


def test_growth_at_discount_rate_rejected():
    with pytest.raises(EngineInputError, match="must be positive"):
        buildup_cap_rate(risk_free_rate=0.04, equity_risk_premium=0.06, long_term_growth=0.10)


# ── Weighted valuation ───────────────────────────────────────────────────────


def _inputs(**overrides) -> dict:
    kwargs = dict(
        sde=400_000.0,
        annual_revenue=2_000_000.0,
        cap_rate_inputs={
            "risk_free_rate": 0.04,
            "equity_risk_premium": 0.06,
            "size_premium": 0.05,
            "company_specific_premium": 0.05,
            "long_term_growth": 0.0,
        },
        sde_multiple=2.8,
        revenue_multiple=0.6,
    )
    kwargs.update(overrides)
    return kwargs


def test_all_three_methods_equal_weighted_by_default():
    out = smb_valuation(**_inputs())
    cap_value = 400_000.0 / 0.20
    sde_value = 400_000.0 * 2.8
    rev_value = 2_000_000.0 * 0.6
    assert out["methods"]["capitalization_of_earnings"]["equity_value"] == pytest.approx(cap_value)
    assert out["methods"]["sde_multiple"]["equity_value"] == pytest.approx(sde_value)
    assert out["methods"]["revenue_multiple"]["equity_value"] == pytest.approx(rev_value)
    assert out["equity_value"] == pytest.approx((cap_value + sde_value + rev_value) / 3)
    assert sum(out["weights"].values()) == pytest.approx(1.0)


def test_explicit_weights_renormalize():
    out = smb_valuation(**_inputs(weights={"sde_multiple": 3.0, "capitalization_of_earnings": 1.0}))
    assert out["weights"]["sde_multiple"] == pytest.approx(0.75)
    assert out["weights"]["revenue_multiple"] == 0.0
    expected = 0.75 * (400_000.0 * 2.8) + 0.25 * (400_000.0 / 0.20)
    assert out["equity_value"] == pytest.approx(expected)


def test_sde_inputs_flow_through_normalization():
    out = smb_valuation(
        sde_inputs={"pretax_income": 200_000.0, "owner_compensation": 200_000.0},
        sde_multiple=2.5,
    )
    assert out["sde_normalization"]["sde"] == pytest.approx(400_000.0)
    assert out["equity_value"] == pytest.approx(1_000_000.0)


def test_weight_for_method_that_did_not_run_rejected():
    with pytest.raises(EngineInputError, match="did not run"):
        smb_valuation(sde=400_000.0, sde_multiple=2.5, weights={"revenue_multiple": 1.0})


def test_no_methods_rejected():
    with pytest.raises(EngineInputError, match="no SMB method"):
        smb_valuation(sde=400_000.0)


def test_both_sde_and_sde_inputs_rejected():
    with pytest.raises(EngineInputError, match="not both"):
        smb_valuation(sde=1.0, sde_inputs={"pretax_income": 1.0}, sde_multiple=2.0)


def test_neither_sde_nor_inputs_rejected():
    with pytest.raises(EngineInputError, match="needs sde"):
        smb_valuation(sde_multiple=2.0)


def test_negative_sde_blocks_earnings_methods_but_not_revenue():
    with pytest.raises(EngineInputError, match="positive"):
        smb_valuation(sde=-10_000.0, sde_multiple=2.5)
    out = smb_valuation(sde=-10_000.0, annual_revenue=1_000_000.0, revenue_multiple=0.5)
    assert out["equity_value"] == pytest.approx(500_000.0)


def test_revenue_multiple_without_revenue_rejected():
    with pytest.raises(EngineInputError, match="annual_revenue"):
        smb_valuation(sde=400_000.0, revenue_multiple=0.5)


def test_zero_weights_rejected():
    with pytest.raises(EngineInputError, match="positive"):
        smb_valuation(**_inputs(weights={"sde_multiple": 0.0}))
