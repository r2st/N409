"""Financial anomaly detection.

Two properties are under test throughout, and the second matters more than the
first: every detector must fire on the error it exists for, and **no detector
may fire on an ordinary company**. A warning an analyst learns to dismiss is
worse than no warning, because it buries the ones that matter — so most of this
file is about staying quiet.
"""

import pytest

from app.engine.anomalies import (
    Anomaly,
    detect_anomalies,
)
from app.engine.validate import WARNING, validate_payload

# A perfectly ordinary venture-backed company: 3.3x forward growth, negative
# EBITDA, a normal option pool, a lumpy but plausible forecast.
ORDINARY = {
    "valuation_date": "2026-06-30",
    "shares_outstanding_common": 7_000_000,
    "shares_outstanding_preferred": 2_000_000,
    "options_outstanding": 1_500_000,
    "liquidation_preference": 5_000_000,
    "last_round_post_money": 20_000_000,
    "cash": 4_000_000,
    "debt": 200_000,
    "revenue_ltm": 3_000_000,
    "revenue_ntm": 10_000_000,
    "ebitda_ltm": -2_000_000,
    "ebitda_ntm": -1_000_000,
    "volatility": 0.6,
    "risk_free_rate": 0.042,
    "income": {
        "free_cash_flows": [-2_000_000, -500_000, 1_500_000, 4_000_000],
        "discount_rate": 0.3,
        "terminal_growth": 0.03,
    },
}


def codes(inputs: dict) -> set[str]:
    return {a.code for a in detect_anomalies(inputs)}


def with_inputs(**over) -> dict:
    return {**ORDINARY, **over}


class TestQuietOnOrdinaryData:
    def test_an_ordinary_company_trips_nothing(self):
        assert detect_anomalies(ORDINARY) == []

    def test_a_profitable_company_trips_nothing(self):
        assert detect_anomalies(with_inputs(ebitda_ltm=900_000, ebitda_ntm=2_000_000)) == []

    def test_a_heavily_lossmaking_company_trips_nothing(self):
        # A 3x loss on revenue is a normal seed-stage picture.
        assert codes(with_inputs(ebitda_ltm=-9_000_000)) == set()

    def test_a_flat_company_trips_nothing(self):
        assert codes(with_inputs(revenue_ntm=3_100_000)) == set()

    def test_a_shrinking_company_trips_nothing(self):
        # Declining revenue is a valuation input, not an extraction error.
        assert codes(with_inputs(revenue_ntm=1_800_000)) == set()

    def test_a_break_even_company_trips_nothing(self):
        assert codes(with_inputs(ebitda_ltm=0.0, ebitda_ntm=0.0)) == set()

    def test_high_but_real_growth_trips_nothing(self):
        # 15x is inside the band on purpose: it happens, and a detector that
        # fires here is one an analyst stops reading.
        assert codes(with_inputs(revenue_ltm=200_000, revenue_ntm=3_000_000)) == set()

    def test_empty_and_junk_payloads_are_silent(self):
        assert detect_anomalies({}) == []
        assert detect_anomalies(None) == []
        assert detect_anomalies("nope") == []
        assert detect_anomalies([1, 2, 3]) == []


class TestGrowth:
    def test_implausible_growth_is_flagged(self):
        assert "implausible_growth" in codes(with_inputs(revenue_ltm=100_000, revenue_ntm=5_000_000))

    def test_a_thousandfold_reads_as_units_not_growth(self):
        """The remedy differs: this is not 'check the forecast', it is 'check
        the units', so it gets its own code."""
        found = codes(with_inputs(revenue_ltm=4_000, revenue_ntm=4_000_000))
        assert "unit_mismatch" in found
        assert "implausible_growth" not in found

    def test_a_thousandfold_drop_is_flagged_too(self):
        assert "unit_mismatch" in codes(with_inputs(revenue_ltm=4_000_000, revenue_ntm=4_000))

    def test_the_message_names_both_figures(self):
        """A relationship problem is only checkable if both sides are quoted."""
        found = detect_anomalies(with_inputs(revenue_ltm=4_000, revenue_ntm=4_000_000))
        message = next(a.message for a in found if a.code == "unit_mismatch")
        assert "4,000" in message and "4,000,000" in message

    def test_ebitda_growth_is_checked_on_the_same_terms(self):
        assert "implausible_growth" in codes(
            with_inputs(ebitda_ltm=50_000, ebitda_ntm=5_000_000)
        )

    def test_negative_horizons_are_skipped(self):
        # A sign change between the horizons is not a growth multiple.
        assert "implausible_growth" not in codes(
            with_inputs(ebitda_ltm=-100.0, ebitda_ntm=5_000_000)
        )

    def test_a_missing_horizon_is_not_an_anomaly(self):
        assert codes(with_inputs(revenue_ntm=None)) == set()


class TestMargin:
    def test_ebitda_above_revenue_is_impossible(self):
        assert "impossible_margin" in codes(
            with_inputs(revenue_ltm=1_000_000, ebitda_ltm=1_500_000)
        )

    def test_a_100_percent_margin_is_not_flagged(self):
        # The bound is where an honest figure becomes hard to construct, not
        # where an uncommon one begins.
        assert "impossible_margin" not in codes(
            with_inputs(revenue_ltm=1_000_000, ebitda_ltm=1_000_000)
        )

    def test_a_loss_far_above_revenue_is_flagged(self):
        assert "implausible_loss" in codes(
            with_inputs(revenue_ltm=100_000, ebitda_ltm=-2_000_000)
        )

    def test_both_horizons_are_checked(self):
        found = detect_anomalies(
            with_inputs(revenue_ntm=1_000_000, ebitda_ntm=3_000_000)
        )
        assert any(a.field == "inputs.ebitda_ntm" for a in found)

    def test_zero_revenue_is_skipped_rather_than_dividing(self):
        assert codes(with_inputs(revenue_ltm=0.0, ebitda_ltm=-500_000)) == set()


class TestScale:
    def test_revenue_and_post_money_differing_by_a_thousand(self):
        """Catches the units error when only one revenue horizon exists, so
        the growth check has nothing to compare against."""
        found = codes(
            {
                "revenue_ltm": 8_000,
                "last_round_post_money": 20_000_000,
            }
        )
        assert "scale_mismatch" in found

    def test_an_ordinary_revenue_multiple_is_not_a_mismatch(self):
        # 20M post-money on 3M revenue is 6.7x — entirely normal.
        assert "scale_mismatch" not in codes(ORDINARY)

    def test_cash_above_post_money_is_flagged(self):
        assert "cash_exceeds_post_money" in codes(with_inputs(cash=25_000_000))

    def test_cash_below_post_money_is_not(self):
        assert "cash_exceeds_post_money" not in codes(ORDINARY)


class TestForecast:
    def test_a_flat_series_is_flagged(self):
        assert "flat_forecast" in codes(
            with_inputs(income={"free_cash_flows": [500_000] * 5})
        )

    def test_a_two_period_series_that_varies_is_not(self):
        assert "flat_forecast" not in codes(
            with_inputs(income={"free_cash_flows": [100_000, 200_000]})
        )

    def test_a_single_period_series_is_skipped(self):
        assert codes(with_inputs(income={"free_cash_flows": [500_000]})) == set()

    def test_an_alternating_series_is_flagged(self):
        assert "alternating_forecast" in codes(
            with_inputs(income={"free_cash_flows": [1, -1, 1, -1, 1, -1, 1]})
        )

    def test_one_crossing_from_loss_to_profit_is_normal(self):
        """The shape of nearly every venture forecast."""
        assert "alternating_forecast" not in codes(
            with_inputs(income={"free_cash_flows": [-2_000_000, -500_000, 1_000_000, 3_000_000]})
        )

    def test_zeros_do_not_count_as_sign_changes(self):
        assert "alternating_forecast" not in codes(
            with_inputs(income={"free_cash_flows": [-100, 0, 0, 100, 200]})
        )

    def test_an_interior_outlier_is_flagged(self):
        assert "outlier_forecast_period" in codes(
            with_inputs(income={"free_cash_flows": [1_000, 900_000_000, 2_000, 3_000]})
        )

    def test_a_large_terminal_year_is_not_an_outlier(self):
        """A big final period is the shape of a forecast, not a typo."""
        assert "outlier_forecast_period" not in codes(
            with_inputs(income={"free_cash_flows": [1_000, 2_000, 3_000, 900_000_000]})
        )

    def test_repeated_values_do_not_break_the_outlier_scale(self):
        # Excluded by position rather than by value: two periods may hold the
        # same figure, and dropping every occurrence would compare the peak
        # against a scale it had been removed from.
        assert "outlier_forecast_period" not in codes(
            with_inputs(income={"free_cash_flows": [5_000, 5_000, 5_000, 6_000]})
        )

    def test_a_non_dict_income_block_is_skipped(self):
        assert codes(with_inputs(income="projections")) == set()

    def test_non_numeric_entries_are_dropped_not_reported(self):
        # validate._check_income already owns that complaint; saying it twice
        # trains people to skim.
        assert codes(with_inputs(income={"free_cash_flows": ["n/a", None, 100, 200]})) == set()


class TestCapitalStructure:
    def test_preference_above_post_money_is_flagged(self):
        assert "preference_exceeds_post_money" in codes(
            with_inputs(liquidation_preference=25_000_000)
        )

    def test_an_ordinary_preference_is_not(self):
        assert "preference_exceeds_post_money" not in codes(ORDINARY)

    def test_more_options_than_common_is_flagged(self):
        assert "options_exceed_common" in codes(
            with_inputs(shares_outstanding_common=1_000_000, options_outstanding=9_000_000)
        )

    def test_a_normal_pool_is_not(self):
        assert "options_exceed_common" not in codes(ORDINARY)

    def test_share_counts_in_different_units_are_flagged(self):
        assert "share_count_mismatch" in codes(
            with_inputs(shares_outstanding_common=7_000, shares_outstanding_preferred=9_000_000)
        )

    def test_an_ordinary_preferred_ratio_is_not(self):
        assert "share_count_mismatch" not in codes(ORDINARY)


class TestFindingShape:
    def test_every_finding_carries_a_field_and_a_hint(self):
        found = detect_anomalies(
            with_inputs(
                revenue_ltm=1_000,
                revenue_ntm=1_000_000,
                ebitda_ltm=5_000_000,
                cash=99_000_000,
            )
        )
        assert found
        for anomaly in found:
            assert anomaly.field.startswith("inputs.")
            assert anomaly.message and anomaly.hint
            assert anomaly.code

    def test_findings_compare_by_value(self):
        a = Anomaly("c", "inputs.x", "m", "h")
        assert a == Anomaly("c", "inputs.x", "m", "h")
        assert a != Anomaly("c", "inputs.y", "m", "h")


class TestThroughThePreFlight:
    """`validate_payload` emits anomalies through its own collector."""

    PARAMS = {
        "weight_asset": 0.0,
        "weight_opm": 1.0,
        "weight_income": 0.0,
        "weight_market": 0.0,
        "dloc": 0.1,
        "dlom": 0.25,
        "exit_timeline": "2029-06-30",
        "allocation_method": "opm",
    }

    def test_anomalies_reach_the_pre_flight_as_warnings(self):
        issues = validate_payload(
            self.PARAMS, with_inputs(revenue_ltm=1_000_000, ebitda_ltm=5_000_000)
        )
        margin = [i for i in issues if i.code == "impossible_margin"]
        assert margin and margin[0].severity == WARNING

    def test_an_anomaly_never_blocks_the_run(self):
        """Every value is individually legal — an analyst who has checked the
        source must be able to run anyway."""
        issues = validate_payload(
            self.PARAMS, with_inputs(revenue_ltm=1_000_000, ebitda_ltm=5_000_000)
        )
        assert [i for i in issues if i.severity != WARNING] == []

    def test_an_ordinary_payload_gains_no_warnings_from_this(self):
        issues = validate_payload(self.PARAMS, ORDINARY)
        assert [i for i in issues if i.code == "impossible_margin"] == []

    @pytest.mark.parametrize("payload", [{}, {"income": None}, {"revenue_ltm": "n/a"}])
    def test_the_pre_flight_never_raises_on_junk(self, payload):
        validate_payload(self.PARAMS, payload)
