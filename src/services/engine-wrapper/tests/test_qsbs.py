"""QSBS eligibility engine unit tests (feature: QSBS Attestation Letter)."""

import pytest

from app.engine.errors import EngineInputError
from app.engine.qsbs import (
    GROSS_ASSET_LIMIT,
    exclusion_percentage,
    qsbs_eligibility,
)
from datetime import date


def _base(**overrides) -> dict:
    kwargs = dict(
        entity_type="c_corp",
        is_domestic=True,
        gross_assets_before_issuance=8_000_000,
        gross_assets_after_issuance=12_000_000,
        industry="software",
        active_business_asset_pct=0.95,
        acquired_at_original_issue=True,
        acquisition_date="2018-03-15",
        assessment_date="2024-06-30",
        aggregate_basis=2_000_000,
    )
    kwargs.update(overrides)
    return kwargs


# ── Happy path ───────────────────────────────────────────────────────────────


def test_clean_startup_is_eligible_with_full_exclusion():
    out = qsbs_eligibility(**_base())
    assert out["eligible"] is True
    assert out["exclusion_available_now"] is True
    assert out["failed_tests"] == []
    assert out["exclusion_percentage"] == 1.0
    # cap = max($10M, 10 × $2M) = $20M
    assert out["gain_exclusion_cap"] == pytest.approx(20_000_000)


def test_ten_million_floor_wins_over_small_basis():
    out = qsbs_eligibility(**_base(aggregate_basis=100_000))
    assert out["gain_exclusion_cap"] == pytest.approx(10_000_000)


def test_prior_exclusions_erode_the_lifetime_cap_but_not_ten_x_basis():
    out = qsbs_eligibility(**_base(aggregate_basis=100_000, prior_1202_exclusions=4_000_000))
    assert out["cap_components"]["lifetime_remaining"] == pytest.approx(6_000_000)
    assert out["gain_exclusion_cap"] == pytest.approx(6_000_000)
    # Prior exclusions above the floor: cap falls back to 10× basis.
    out2 = qsbs_eligibility(**_base(aggregate_basis=2_000_000, prior_1202_exclusions=12_000_000))
    assert out2["gain_exclusion_cap"] == pytest.approx(20_000_000)


# ── Individual tests fail independently ──────────────────────────────────────


def test_s_corp_fails_entity_test_only():
    out = qsbs_eligibility(**_base(entity_type="s_corp"))
    assert out["eligible"] is False
    assert out["failed_tests"] == ["c_corporation"]
    assert out["exclusion_percentage"] == 0.0
    assert out["gain_exclusion_cap"] == 0.0


def test_foreign_c_corp_fails_entity_test():
    out = qsbs_eligibility(**_base(is_domestic=False))
    assert "c_corporation" in out["failed_tests"]


def test_gross_assets_over_50m_after_issuance_fail():
    out = qsbs_eligibility(**_base(gross_assets_after_issuance=GROSS_ASSET_LIMIT + 1))
    assert out["failed_tests"] == ["gross_asset_test"]


def test_gross_assets_at_exactly_50m_pass():
    out = qsbs_eligibility(**_base(gross_assets_after_issuance=GROSS_ASSET_LIMIT))
    assert out["eligible"] is True


def test_excluded_industry_fails_qualified_trade():
    out = qsbs_eligibility(**_base(industry="Financial Services"))
    assert out["failed_tests"] == ["qualified_trade_or_business"]


def test_active_business_below_80_pct_fails():
    out = qsbs_eligibility(**_base(active_business_asset_pct=0.60))
    assert out["failed_tests"] == ["active_business_test"]


def test_secondary_acquisition_fails_original_issuance():
    out = qsbs_eligibility(**_base(acquired_at_original_issue=False))
    assert out["failed_tests"] == ["original_issuance"]


def test_redemptions_fail_their_own_test():
    out = qsbs_eligibility(**_base(redemptions_within_window=True))
    assert out["failed_tests"] == ["no_disqualifying_redemptions"]


def test_multiple_failures_all_reported():
    out = qsbs_eligibility(**_base(entity_type="llc", industry="law", active_business_asset_pct=0.1))
    assert set(out["failed_tests"]) == {
        "c_corporation",
        "qualified_trade_or_business",
        "active_business_test",
    }


# ── Holding period ───────────────────────────────────────────────────────────


def test_under_five_years_is_eligible_but_no_exclusion_yet():
    out = qsbs_eligibility(**_base(acquisition_date="2021-01-01", assessment_date="2024-06-30"))
    assert out["eligible"] is True
    assert out["exclusion_available_now"] is False
    assert out["holding_period"]["met"] is False
    assert out["holding_period"]["five_year_date"] == "2026-01-01"


def test_exactly_five_years_is_not_more_than_five():
    out = qsbs_eligibility(**_base(acquisition_date="2019-06-30", assessment_date="2024-06-30"))
    assert out["holding_period"]["met"] is False


def test_leap_day_acquisition_five_year_date_rolls_to_march_first():
    out = qsbs_eligibility(**_base(acquisition_date="2020-02-29", assessment_date="2024-06-30"))
    assert out["holding_period"]["five_year_date"] == "2025-03-01"


# ── Exclusion percentage by acquisition date ─────────────────────────────────


def test_exclusion_percentage_tiers():
    assert exclusion_percentage(date(2008, 1, 1)) == 0.50
    assert exclusion_percentage(date(2009, 2, 18)) == 0.75
    assert exclusion_percentage(date(2010, 9, 27)) == 0.75
    assert exclusion_percentage(date(2010, 9, 28)) == 1.0
    assert exclusion_percentage(date(2024, 1, 1)) == 1.0


def test_pre_2009_acquisition_reports_50_pct():
    out = qsbs_eligibility(**_base(acquisition_date="2008-05-01", assessment_date="2024-06-30"))
    assert out["exclusion_percentage"] == 0.50


# ── Input validation ─────────────────────────────────────────────────────────


def test_assessment_before_acquisition_rejected():
    with pytest.raises(EngineInputError, match="precedes"):
        qsbs_eligibility(**_base(acquisition_date="2024-01-01", assessment_date="2020-01-01"))


def test_bad_date_rejected():
    with pytest.raises(EngineInputError, match="ISO date"):
        qsbs_eligibility(**_base(acquisition_date="15/03/2018"))


def test_active_pct_above_one_rejected():
    with pytest.raises(EngineInputError, match="fraction"):
        qsbs_eligibility(**_base(active_business_asset_pct=95))


def test_negative_gross_assets_rejected():
    with pytest.raises(EngineInputError, match=">= 0"):
        qsbs_eligibility(**_base(gross_assets_before_issuance=-1))


def test_non_numeric_basis_rejected():
    with pytest.raises(EngineInputError, match="must be a number"):
        qsbs_eligibility(**_base(aggregate_basis="a lot"))
