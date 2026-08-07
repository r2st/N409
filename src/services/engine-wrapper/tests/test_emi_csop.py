"""EMI / CSOP engine unit tests (features: EMI Valuation, CSOP Valuation)."""

import pytest

from app.engine.errors import EngineInputError
from app.engine.emi_csop import (
    CSOP_INDIVIDUAL_LIMIT,
    EMI_COMPANY_LIMIT,
    EMI_INDIVIDUAL_LIMIT,
    csop_grant_check,
    emi_csop_valuation,
    emi_qualification,
    share_values,
)


# ── UMV / AMV ────────────────────────────────────────────────────────────────


def test_umv_amv_chain():
    out = share_values(
        equity_value=10_000_000.0,
        total_shares=1_000_000.0,
        minority_discount=0.10,
        restriction_discount=0.20,
    )
    assert out["pro_rata_per_share"] == pytest.approx(10.0)
    assert out["umv_per_share"] == pytest.approx(9.0)
    assert out["amv_per_share"] == pytest.approx(7.20)


def test_no_restrictions_amv_equals_umv():
    out = share_values(equity_value=1_000_000.0, total_shares=100_000.0)
    assert out["umv_per_share"] == out["amv_per_share"] == pytest.approx(10.0)


def test_zero_shares_rejected():
    with pytest.raises(EngineInputError, match="must be positive"):
        share_values(equity_value=1.0, total_shares=0.0)


def test_discount_of_one_rejected():
    with pytest.raises(EngineInputError, match="restriction_discount"):
        share_values(equity_value=1.0, total_shares=1.0, restriction_discount=1.0)


# ── EMI qualification ────────────────────────────────────────────────────────


def _emi(**overrides) -> dict:
    kwargs = dict(
        gross_assets=5_000_000.0,
        employee_count=40,
        umv_per_share=2.0,
        options_granted=50_000.0,
        individual_prior_grants_umv=0.0,
        company_unexercised_umv=500_000.0,
    )
    kwargs.update(overrides)
    return kwargs


def test_emi_clean_grant_qualifies():
    out = emi_qualification(**_emi())
    assert out["qualifies"] is True
    assert out["failed_checks"] == []
    assert out["grant_umv"] == pytest.approx(100_000.0)


def test_emi_gross_assets_over_30m_fails():
    out = emi_qualification(**_emi(gross_assets=31_000_000.0))
    assert out["failed_checks"] == ["gross_assets"]


def test_emi_250_employees_fails_249_passes():
    assert emi_qualification(**_emi(employee_count=250))["failed_checks"] == ["employee_count"]
    assert emi_qualification(**_emi(employee_count=249))["qualifies"] is True


def test_emi_individual_limit_counts_prior_grants():
    out = emi_qualification(**_emi(individual_prior_grants_umv=200_000.0))
    # 200k prior + 100k this grant = 300k > 250k.
    assert out["individual_total_umv"] == pytest.approx(300_000.0)
    assert out["failed_checks"] == ["individual_limit"]
    # Exactly at the limit passes.
    at_limit = emi_qualification(**_emi(individual_prior_grants_umv=EMI_INDIVIDUAL_LIMIT - 100_000.0))
    assert at_limit["qualifies"] is True


def test_emi_company_limit():
    out = emi_qualification(**_emi(company_unexercised_umv=EMI_COMPANY_LIMIT - 50_000.0))
    assert out["failed_checks"] == ["company_limit"]


def test_emi_boolean_conditions():
    out = emi_qualification(
        **_emi(is_independent=False, has_qualifying_trade=False, works_25_hours_or_75_pct=False)
    )
    assert set(out["failed_checks"]) == {
        "company_independence",
        "qualifying_trade",
        "working_time",
    }


# ── CSOP ─────────────────────────────────────────────────────────────────────


def test_csop_clean_grant_qualifies():
    out = csop_grant_check(umv_per_share=2.0, options_granted=25_000.0, exercise_price=2.0)
    assert out["grant_umv"] == pytest.approx(50_000.0)
    assert out["qualifies"] is True


def test_csop_individual_limit():
    out = csop_grant_check(umv_per_share=2.0, options_granted=35_000.0, exercise_price=2.0)
    assert out["individual_total_umv"] == pytest.approx(70_000.0)
    assert out["failed_checks"] == ["individual_limit"]
    at_limit = csop_grant_check(
        umv_per_share=2.0,
        options_granted=(CSOP_INDIVIDUAL_LIMIT / 2.0),
        exercise_price=2.0,
    )
    assert at_limit["qualifies"] is True


def test_csop_discounted_exercise_price_fails():
    out = csop_grant_check(umv_per_share=2.0, options_granted=10_000.0, exercise_price=1.5)
    assert out["failed_checks"] == ["exercise_price_not_below_umv"]


# ── Combined entry point ─────────────────────────────────────────────────────


def test_emi_valuation_uses_concluded_umv_for_checks():
    out = emi_csop_valuation(
        "emi",
        {
            "equity_value": 10_000_000.0,
            "total_shares": 1_000_000.0,
            "minority_discount": 0.10,
            "restriction_discount": 0.20,
            "gross_assets": 5_000_000.0,
            "employee_count": 40,
            "options_granted": 20_000.0,
        },
    )
    # Checks ran at the concluded UMV (9.00), not pro-rata (10.00).
    assert out["qualification"]["grant_umv"] == pytest.approx(180_000.0)
    assert out["qualification"]["qualifies"] is True


def test_csop_valuation_flags_discounted_strike():
    out = emi_csop_valuation(
        "csop",
        {
            "equity_value": 1_000_000.0,
            "total_shares": 100_000.0,
            "options_granted": 1_000.0,
            "exercise_price": 5.0,  # UMV is 10.00
        },
    )
    assert out["qualification"]["failed_checks"] == ["exercise_price_not_below_umv"]


def test_unknown_scheme_rejected():
    with pytest.raises(EngineInputError, match="'emi' or 'csop'"):
        emi_csop_valuation("saye", {})


def test_unexpected_param_is_input_error():
    with pytest.raises(EngineInputError, match="invalid params for emi"):
        emi_csop_valuation(
            "emi",
            {
                "equity_value": 1_000_000.0,
                "total_shares": 100_000.0,
                "gross_assets": 1.0,
                "employee_count": 1,
                "options_granted": 1.0,
                "bogus": True,
            },
        )
