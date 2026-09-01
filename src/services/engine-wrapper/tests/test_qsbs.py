"""QSBS eligibility engine unit tests (feature: QSBS Attestation Letter)."""

import pytest

from app.engine.errors import EngineInputError
from app.engine.qsbs import (
    GROSS_ASSET_LIMIT,
    GROSS_ASSET_LIMIT_OBBBA,
    PER_ISSUER_CAP_FLOOR,
    PER_ISSUER_CAP_FLOOR_OBBBA,
    exclusion_percentage,
    is_obbba_stock,
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


# ── OBBBA regime (P.L. 119-21, stock acquired after 4 Jul 2025) ──────────────


def _obbba(**overrides) -> dict:
    """Base kwargs for stock issued the day after enactment."""
    return _base(acquisition_date="2025-07-05", assessment_date="2030-01-01", **overrides)


def test_enactment_day_itself_is_still_the_old_regime():
    # "acquired after the date of enactment" — the 4th is not after the 4th.
    assert is_obbba_stock(date(2025, 7, 4)) is False
    assert is_obbba_stock(date(2025, 7, 5)) is True
    out = qsbs_eligibility(**_base(acquisition_date="2025-07-04", assessment_date="2031-01-01"))
    assert out["regime"] == "pre_obbba"
    assert out["cap_components"]["lifetime_cap"] == pytest.approx(PER_ISSUER_CAP_FLOOR)


def test_obbba_stock_uses_the_seventy_five_million_asset_limit():
    # $60M is over the old limit and under the new one: the same company is
    # disqualified on 2025-07-04 stock and qualified on 2025-07-05 stock.
    over_old = dict(gross_assets_after_issuance=60_000_000)
    legacy = qsbs_eligibility(**_base(acquisition_date="2025-07-04", assessment_date="2031-01-01", **over_old))
    assert legacy["failed_tests"] == ["gross_asset_test"]
    new = qsbs_eligibility(**_obbba(**over_old))
    assert new["failed_tests"] == []
    assert "limit $75,000,000" in new["tests"]["gross_asset_test"]["detail"]


def test_obbba_gross_assets_above_seventy_five_million_still_fail():
    out = qsbs_eligibility(**_obbba(gross_assets_after_issuance=GROSS_ASSET_LIMIT_OBBBA + 1))
    assert out["failed_tests"] == ["gross_asset_test"]
    assert qsbs_eligibility(**_obbba(gross_assets_after_issuance=GROSS_ASSET_LIMIT_OBBBA))["eligible"] is True


def test_obbba_lifetime_floor_is_fifteen_million():
    out = qsbs_eligibility(**_obbba(aggregate_basis=100_000))
    assert out["cap_components"]["lifetime_cap"] == pytest.approx(PER_ISSUER_CAP_FLOOR_OBBBA)
    assert out["gain_exclusion_cap"] == pytest.approx(15_000_000)
    # 10× basis still wins when it is the larger of the two.
    bigger = qsbs_eligibility(**_obbba(aggregate_basis=4_000_000))
    assert bigger["gain_exclusion_cap"] == pytest.approx(40_000_000)


def test_obbba_tiers_by_holding_period():
    acquired = "2025-08-01"

    def pct_on(assessment: str) -> float:
        return qsbs_eligibility(**_base(acquisition_date=acquired, assessment_date=assessment))[
            "exclusion_percentage"
        ]

    assert pct_on("2028-07-31") == 0.0  # a day short of three years
    assert pct_on("2028-08-01") == 0.50  # "at least three years" — the day counts
    assert pct_on("2029-07-31") == 0.50
    assert pct_on("2029-08-01") == 0.75
    assert pct_on("2030-07-31") == 0.75
    assert pct_on("2030-08-01") == 1.0
    assert pct_on("2035-01-01") == 1.0


def test_obbba_four_year_holder_has_an_exclusion_the_old_rule_denied():
    # The change with teeth: same holder, same four years, different answer.
    kwargs = dict(acquisition_date="2025-07-05", assessment_date="2029-07-05")
    out = qsbs_eligibility(**_base(**kwargs))
    assert out["exclusion_available_now"] is True
    assert out["exclusion_percentage"] == 0.75
    assert out["holding_period"]["required_years"] == 3
    assert out["holding_period"]["threshold_date"] == "2028-07-05"

    legacy = qsbs_eligibility(**_base(acquisition_date="2021-07-05", assessment_date="2025-07-05"))
    assert legacy["exclusion_available_now"] is False
    assert legacy["exclusion_percentage"] == 0.0


def test_obbba_tier_schedule_is_reported_in_full():
    out = qsbs_eligibility(**_base(acquisition_date="2025-09-30", assessment_date="2029-01-01"))
    assert out["holding_period"]["tiers"] == [
        {"years": 3, "exclusion_percentage": 0.50, "date": "2028-09-30", "met": True},
        {"years": 4, "exclusion_percentage": 0.75, "date": "2029-09-30", "met": False},
        {"years": 5, "exclusion_percentage": 1.00, "date": "2030-09-30", "met": False},
    ]
    assert out["holding_period"]["five_year_date"] == "2030-09-30"
    assert out["maximum_exclusion_percentage"] == 1.0


def test_legacy_percentage_is_zero_until_the_holding_period_is_met():
    # The letter said "available now: no" beside "exclusion percentage 100%".
    out = qsbs_eligibility(**_base(acquisition_date="2021-01-01", assessment_date="2024-06-30"))
    assert out["exclusion_available_now"] is False
    assert out["exclusion_percentage"] == 0.0
    assert out["maximum_exclusion_percentage"] == 1.0
    assert out["holding_period"]["tiers"] == [
        {"years": 5, "exclusion_percentage": 1.0, "date": "2026-01-01", "met": False},
    ]


def test_disqualified_obbba_stock_reports_no_ceiling_either():
    out = qsbs_eligibility(**_obbba(entity_type="s_corp"))
    assert out["exclusion_percentage"] == 0.0
    assert out["maximum_exclusion_percentage"] == 0.0
    assert out["gain_exclusion_cap"] == 0.0


def test_obbba_leap_day_acquisition_rolls_only_the_tiers_that_have_no_feb_29():
    """Mar 1 in a common year, Feb 29 in a leap year — not Mar 1 in both.

    2032 is a leap year, so the fourth anniversary of a 29 February 2028
    acquisition is 29 February 2032 and not the 1st of March. Rolling it anyway
    moved a real anniversary a day into the future, and the tiered §1202(a)(4)
    test is worded "at least" and decided on the day.
    """
    out = qsbs_eligibility(**_base(acquisition_date="2028-02-29", assessment_date="2031-03-01"))
    assert [t["date"] for t in out["holding_period"]["tiers"]] == [
        "2031-03-01",
        "2032-02-29",
        "2033-03-01",
    ]
    assert out["exclusion_percentage"] == 0.50


def test_obbba_leap_day_tier_is_met_on_its_own_leap_anniversary():
    """The four-year tier, on the day it is reached.

    This concluded 50% until R335: the tier date was reported as 1 March 2032,
    so a letter written on 29 February 2032 — four years to the day — told the
    holder they had the 50% exclusion when §1202(a)(4) gives them 75%.
    """
    out = qsbs_eligibility(**_base(acquisition_date="2028-02-29", assessment_date="2032-02-29"))
    assert out["exclusion_percentage"] == 0.75
    assert out["holding_period"]["met"] is True
    tiers = {t["years"]: t["met"] for t in out["holding_period"]["tiers"]}
    assert tiers == {3: True, 4: True, 5: False}
