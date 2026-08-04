"""Unit tests for the four valuation approaches."""

import math

import pytest
from app.engine.approaches import (
    EngineInputError,
    asset_value,
    income_dcf,
    market_multiples,
    opm_backsolve,
)
from app.engine.projection import MAX_FORECAST_YEARS


# ── income_dcf ───────────────────────────────────────────────────────────────

class TestIncomeDcf:
    def test_simple_dcf(self):
        result = income_dcf([100, 110, 120], discount_rate=0.10, terminal_growth=0.02)
        assert result["equity_value"] > 0
        assert result["pv_explicit"] > 0
        assert result["pv_terminal"] > 0
        assert result["enterprise_value"] == pytest.approx(
            result["pv_explicit"] + result["pv_terminal"]
        )

    def test_cash_debt_bridge(self):
        r1 = income_dcf([100], discount_rate=0.10, terminal_growth=0.02)
        r2 = income_dcf([100], discount_rate=0.10, terminal_growth=0.02, cash=50, debt=20)
        assert r2["equity_value"] == pytest.approx(r1["equity_value"] + 30)

    def test_empty_cash_flows_raises(self):
        with pytest.raises(EngineInputError, match="non-empty"):
            income_dcf([], discount_rate=0.10)

    def test_discount_rate_below_growth_raises(self):
        with pytest.raises(EngineInputError, match="exceed"):
            income_dcf([100], discount_rate=0.05, terminal_growth=0.05)

    def test_discount_rate_equals_growth_raises(self):
        with pytest.raises(EngineInputError, match="exceed"):
            income_dcf([100], discount_rate=0.05, terminal_growth=0.05)

    def test_single_period(self):
        result = income_dcf([1000], discount_rate=0.10, terminal_growth=0.02)
        # PV of explicit = 1000 / 1.1
        assert result["pv_explicit"] == pytest.approx(1000 / 1.1, rel=1e-6)


# ── market_multiples ─────────────────────────────────────────────────────────

class TestMarketMultiples:
    def test_median_selection(self):
        result = market_multiples(metric=1000, multiples=[5.0, 10.0, 15.0])
        assert result["selected_multiple"] == 10.0
        assert result["enterprise_value"] == 10000.0
        assert result["equity_value"] == 10000.0

    def test_filters_non_positive(self):
        result = market_multiples(metric=100, multiples=[-1, 0, 5.0, 10.0])
        assert result["selected_multiple"] == pytest.approx(7.5)
        assert result["multiples"] == [5.0, 10.0]

    def test_cash_debt_bridge(self):
        r = market_multiples(metric=100, multiples=[10.0], cash=50, debt=30)
        assert r["equity_value"] == pytest.approx(1000 + 50 - 30)

    def test_empty_multiples_raises(self):
        with pytest.raises(EngineInputError, match="positive multiple"):
            market_multiples(metric=100, multiples=[])

    def test_all_negative_raises(self):
        with pytest.raises(EngineInputError, match="positive multiple"):
            market_multiples(metric=100, multiples=[-1, -2])

    def test_negative_metric_raises(self):
        with pytest.raises(EngineInputError, match="positive"):
            market_multiples(metric=-100, multiples=[10.0])


# ── asset_value ──────────────────────────────────────────────────────────────

class TestAssetValue:
    def test_nav_method(self):
        result = asset_value(total_assets=1000, total_liabilities=400)
        assert result["method"] == "nav"
        assert result["equity_value"] == 600

    def test_cost_to_replicate(self):
        result = asset_value(cost_to_replicate=5000, method="cost_to_replicate")
        assert result["method"] == "cost_to_replicate"
        assert result["equity_value"] == 5000

    def test_auto_detects_cost_to_replicate(self):
        result = asset_value(cost_to_replicate=3000)
        assert result["method"] == "cost_to_replicate"

    def test_missing_nav_inputs_raises(self):
        with pytest.raises(EngineInputError, match="required for NAV"):
            asset_value(total_assets=100)

    def test_negative_cost_raises(self):
        with pytest.raises(EngineInputError, match="cost_to_replicate"):
            asset_value(cost_to_replicate=-1, method="cost_to_replicate")


# ── opm_backsolve ────────────────────────────────────────────────────────────

class TestOpmBacksolve:
    def test_post_money_passthrough(self):
        result = opm_backsolve(last_round_post_money=10_000_000)
        assert result["method"] == "post_money"
        assert result["equity_value"] == 10_000_000

    def test_missing_post_money_raises(self):
        with pytest.raises(EngineInputError, match="positive"):
            opm_backsolve(last_round_post_money=None)

    def test_zero_post_money_raises(self):
        with pytest.raises(EngineInputError, match="positive"):
            opm_backsolve(last_round_post_money=0)

    def test_backsolve_single(self):
        result = opm_backsolve(
            last_round_post_money=10_000_000,
            last_round_pps=10.0,
            preferred_shares=500_000,
            liquidation_preference=2_000_000,
            common_shares=1_000_000,
            t=3.0,
            r=0.04,
            sigma=0.5,
        )
        assert result["method"] == "backsolve_single"
        assert result["equity_value"] > 0
        assert result["solved_pps"] == pytest.approx(10.0, rel=0.01)

    def test_backsolve_falls_to_post_money_without_model(self):
        # No t/r/sigma → no backsolve → fallback to post_money
        result = opm_backsolve(
            last_round_post_money=5_000_000,
            last_round_pps=10.0,
            preferred_shares=500_000,
            liquidation_preference=2_000_000,
            common_shares=1_000_000,
        )
        assert result["method"] == "post_money"


# ── income_dcf: the explicit forecast horizon ────────────────────────────────


class TestIncomeDcfHorizon:
    """A DCF's horizon is the exponent on every discount factor it builds.

    `projection.py` already refuses a horizon past MAX_FORECAST_YEARS when it
    *generates* the flows; a caller handing them over directly bypassed that,
    and Python's float `**` raises OverflowError rather than saturating to inf.
    A plausible 30% rate over a few thousand "years" — 20 KB of JSON, inside
    every request cap — therefore came back as an unhandled 500.
    """

    def test_horizon_at_the_limit_is_accepted(self):
        result = income_dcf([100.0] * MAX_FORECAST_YEARS, discount_rate=0.30, terminal_growth=0.02)
        assert result["equity_value"] > 0
        assert math.isfinite(result["pv_explicit"])
        assert math.isfinite(result["pv_terminal"])

    def test_horizon_past_the_limit_is_refused(self):
        with pytest.raises(EngineInputError, match="at most"):
            income_dcf([100.0] * (MAX_FORECAST_YEARS + 1), discount_rate=0.30)

    def test_the_overflowing_horizon_is_an_input_error_not_a_crash(self):
        # 4,000 years at 25% overflowed a float and raised OverflowError.
        with pytest.raises(EngineInputError):
            income_dcf([100.0] * 4_000, discount_rate=0.25)

    def test_compound_factor_guards_a_rate_that_cannot_compound(self):
        # Reachable only by calling the approach directly (validate refuses a
        # non-positive rate), but the factor must still be an input error.
        with pytest.raises(EngineInputError, match="greater than -1"):
            income_dcf([100.0, 110.0], discount_rate=-1.0, terminal_growth=-2.0)

    def test_discounting_is_unchanged_by_the_compound_factor_rewrite(self):
        flows = [100.0, 250.0, -40.0, 900.0]
        r, g = 0.18, 0.03
        result = income_dcf(flows, discount_rate=r, terminal_growth=g)
        expected_pv = sum(f / (1.0 + r) ** (i + 1) for i, f in enumerate(flows))
        expected_tv = flows[-1] * (1.0 + g) / (r - g) / (1.0 + r) ** len(flows)
        assert result["pv_explicit"] == pytest.approx(expected_pv, rel=1e-12)
        assert result["pv_terminal"] == pytest.approx(expected_tv, rel=1e-12)
