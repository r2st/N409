"""The two methodology choices the DCF could not previously express.

**Mid-year convention.** End-of-year discounting assumes every dollar of a
year's cash flow lands on 31 December. It does not, and the standard 409A
correction is to discount year n at n - 0.5. The engine had no way to say so,
which understated every income approach by (1+r)^0.5 - 1 — 8% at a 17%
discount rate, 12% at 25%.

**Exit-multiple terminal value.** `projection.project_financials` has always
been able to *build* one (`terminal_method="exit_multiple"`), and `income_dcf`
could only ever capitalise the final flow into a Gordon perpetuity — so the
terminal value the projection computed was discarded and a different one
substituted. The two answer different questions and a DCF is normally shown
both ways.
"""

import math

import pytest

from app.engine.approaches import income_dcf
from app.engine.compute import compute
from app.engine.errors import EngineInputError
from app.engine.projection import project_financials, terminal_value_exit_multiple
from app.engine.validate import ERROR, WARNING, validate_payload

FCF = [1_000_000.0, 1_200_000.0, 1_450_000.0, 1_700_000.0, 2_000_000.0]
RATE = 0.17
GROWTH = 0.03


# ── mid-year convention ──────────────────────────────────────────────────────


class TestMidYearConvention:
    def test_it_is_off_by_default(self):
        """Turning it on silently would move every stored valuation by 8-12%."""
        assert income_dcf(FCF, RATE, GROWTH)["mid_year_convention"] is False

    def test_the_explicit_period_is_discounted_at_n_minus_a_half(self):
        """Checked against the arithmetic written out longhand, not against the
        engine's own factors — the point is the exponent, so it has to come
        from somewhere other than the code under test."""
        got = income_dcf(FCF, RATE, GROWTH, mid_year_convention=True)
        expected = sum(cf / (1 + RATE) ** (n + 0.5) for n, cf in enumerate(FCF))
        assert got["pv_explicit"] == pytest.approx(expected)

    def test_end_of_year_still_discounts_at_n(self):
        got = income_dcf(FCF, RATE, GROWTH)
        expected = sum(cf / (1 + RATE) ** (n + 1) for n, cf in enumerate(FCF))
        assert got["pv_explicit"] == pytest.approx(expected)

    def test_the_gordon_terminal_value_shares_the_stub(self):
        """Not an approximation: if the perpetuity's own flows arrive mid-year
        its value at the horizon is (1+r)^0.5 times the textbook Gordon figure,
        so dividing that by (1+r)^N is dividing the textbook figure by
        (1+r)^(N-0.5)."""
        got = income_dcf(FCF, RATE, GROWTH, mid_year_convention=True)
        tv = FCF[-1] * (1 + GROWTH) / (RATE - GROWTH)
        assert got["pv_terminal"] == pytest.approx(tv / (1 + RATE) ** (len(FCF) - 0.5))

    def test_it_lifts_present_value_by_the_half_year_factor(self):
        """The whole of the correction, and nothing else: every flow and the
        perpetuity behind them move by exactly one common factor, so the ratio
        of the two enterprise values is (1+r)^0.5."""
        end = income_dcf(FCF, RATE, GROWTH)["enterprise_value"]
        mid = income_dcf(FCF, RATE, GROWTH, mid_year_convention=True)["enterprise_value"]
        assert mid / end == pytest.approx(math.sqrt(1 + RATE))

    @pytest.mark.parametrize("rate,expected", [(0.17, 0.0817), (0.25, 0.1180), (0.40, 0.1832)])
    def test_the_understatement_is_material_across_the_band(self, rate, expected):
        """The audit's claim, checked at three points in the 409A discount-rate
        band rather than asserted once."""
        end = income_dcf(FCF, rate, 0.02)["enterprise_value"]
        mid = income_dcf(FCF, rate, 0.02, mid_year_convention=True)["enterprise_value"]
        assert (mid - end) / end == pytest.approx(expected, abs=5e-4)

    def test_the_convention_travels_on_the_result(self):
        """A stored valuation is re-read by the report and by next year's
        roll-forward, and neither can tell an 8% difference in present value
        from a different forecast unless the convention is recorded."""
        assert income_dcf(FCF, RATE, GROWTH, mid_year_convention=True)["mid_year_convention"] is True

    def test_the_bridge_to_equity_is_unchanged(self):
        """Cash and debt are balances at the valuation date; they are not
        discounted and the convention must not touch them."""
        got = income_dcf(FCF, RATE, GROWTH, cash=500_000, debt=200_000, mid_year_convention=True)
        assert got["equity_value"] == pytest.approx(got["enterprise_value"] + 500_000 - 200_000)


# ── exit-multiple terminal value ─────────────────────────────────────────────


class TestExitMultipleTerminalValue:
    def test_gordon_remains_the_default(self):
        assert income_dcf(FCF, RATE, GROWTH)["terminal_method"] == "gordon"

    def test_the_terminal_value_is_the_metric_times_the_multiple(self):
        got = income_dcf(
            FCF, RATE, terminal_method="exit_multiple", exit_multiple=8.0,
            terminal_metric=3_000_000.0, terminal_metric_basis="ebitda",
        )
        assert got["terminal_value"] == pytest.approx(24_000_000.0)
        assert got["terminal_detail"]["terminal_metric_basis"] == "ebitda"

    def test_it_agrees_with_the_projection_engine(self):
        """`projection.terminal_value_exit_multiple` is the one that builds the
        figure and `income_dcf` is the one that discounts it. They were unable
        to disagree only because the DCF ignored it; now they must agree."""
        got = income_dcf(
            FCF, RATE, terminal_method="exit_multiple", exit_multiple=8.0,
            terminal_metric=3_000_000.0,
        )
        assert got["terminal_value"] == terminal_value_exit_multiple(3_000_000.0, 8.0)

    def test_a_sale_at_the_horizon_takes_the_full_period(self):
        """Even under the mid-year convention. An exit is a single event on the
        horizon date, not a flow spread over the final year — a stub there would
        assert that half the company was sold six months early."""
        got = income_dcf(
            FCF, RATE, terminal_method="exit_multiple", exit_multiple=8.0,
            terminal_metric=3_000_000.0, mid_year_convention=True,
        )
        assert got["pv_terminal"] == pytest.approx(24_000_000.0 / (1 + RATE) ** len(FCF))

    def test_the_explicit_flows_still_take_the_stub(self):
        """The two halves are discounted differently on purpose, so this pins
        that the exit-multiple branch did not also disable the convention."""
        got = income_dcf(
            FCF, RATE, terminal_method="exit_multiple", exit_multiple=8.0,
            terminal_metric=3_000_000.0, mid_year_convention=True,
        )
        assert got["pv_explicit"] == pytest.approx(
            sum(cf / (1 + RATE) ** (n + 0.5) for n, cf in enumerate(FCF))
        )

    def test_terminal_growth_is_irrelevant_to_it(self):
        """An exit multiple capitalises nothing, so the perpetual growth rate
        cannot reach the answer."""
        a = income_dcf(FCF, RATE, 0.0, terminal_method="exit_multiple", exit_multiple=8.0)
        b = income_dcf(FCF, RATE, 0.04, terminal_method="exit_multiple", exit_multiple=8.0)
        assert a["enterprise_value"] == b["enterprise_value"]

    def test_a_rate_below_the_growth_rate_is_accepted_here(self):
        """The r > g inequality is a property of the Gordon perpetuity. Applying
        it to an exit-multiple run would refuse a payload with nothing wrong
        with it."""
        got = income_dcf(FCF, 0.02, 0.05, terminal_method="exit_multiple", exit_multiple=8.0)
        assert got["enterprise_value"] > 0

    def test_gordon_still_refuses_it(self):
        with pytest.raises(EngineInputError, match="must exceed terminal_growth"):
            income_dcf(FCF, 0.02, 0.05)

    def test_the_multiple_is_required(self):
        with pytest.raises(EngineInputError, match="exit_multiple is required"):
            income_dcf(FCF, RATE, terminal_method="exit_multiple")

    def test_an_unknown_terminal_method_is_refused(self):
        with pytest.raises(EngineInputError, match="terminal_method"):
            income_dcf(FCF, RATE, terminal_method="h_model")

    def test_a_non_positive_metric_is_refused(self):
        """A negative denominator makes a multiple meaningless rather than
        small — the same objection `market_multiples` already raises."""
        with pytest.raises(EngineInputError, match="terminal_metric must be positive"):
            income_dcf(
                FCF, RATE, terminal_method="exit_multiple", exit_multiple=8.0,
                terminal_metric=-500_000.0,
            )

    def test_a_negative_final_flow_is_caught_through_the_fallback(self):
        """With no explicit metric the final free cash flow is the denominator,
        so a loss-making terminal year has to fail the same check."""
        with pytest.raises(EngineInputError, match="terminal_metric must be positive"):
            income_dcf([1_000.0, -2_000.0], RATE, terminal_method="exit_multiple", exit_multiple=8.0)

    def test_the_implied_denominator_is_named(self):
        """A multiple whose denominator is not named is a multiple nobody can
        check, so the fallback labels itself rather than passing as an EBITDA
        multiple."""
        got = income_dcf(FCF, RATE, terminal_method="exit_multiple", exit_multiple=8.0)
        assert got["terminal_detail"]["terminal_metric_basis"] == "fcff"
        assert got["terminal_detail"]["terminal_metric"] == FCF[-1]


class TestTheTwoMethodsDisagree:
    def test_they_are_different_answers_to_different_questions(self):
        """Not a refinement of one another — Gordon says what the business is
        worth held forever, the exit multiple what a buyer pays at the horizon."""
        gordon = income_dcf(FCF, RATE, GROWTH)["enterprise_value"]
        exit_mult = income_dcf(
            FCF, RATE, GROWTH, terminal_method="exit_multiple", exit_multiple=8.0,
            terminal_metric=3_000_000.0,
        )["enterprise_value"]
        assert gordon != pytest.approx(exit_mult)

    def test_a_projection_feeds_either_one(self):
        """End to end: the projection builds the flows and a terminal EBITDA,
        and the DCF values the horizon both ways off the same forecast."""
        projected = project_financials(
            method="growth", years=5, base_revenue=10_000_000, revenue_growth=0.30,
            cogs_pct=0.30, opex_pct=0.45, da_pct=0.04, capex_pct=0.05, nwc_pct=0.10,
            terminal_method="exit_multiple", exit_multiple=9.0, exit_metric="ebitda",
        )
        flows = projected["free_cash_flows"]
        terminal_ebitda = projected["projections"][-1]["ebitda"]
        got = income_dcf(
            flows, RATE, terminal_method="exit_multiple", exit_multiple=9.0,
            terminal_metric=terminal_ebitda, terminal_metric_basis="ebitda",
            mid_year_convention=True,
        )
        assert got["terminal_value"] == pytest.approx(projected["terminal_value"], rel=1e-9)
        assert got["enterprise_value"] > 0


# ── through /compute ─────────────────────────────────────────────────────────

PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 0.0,
    "weight_income": 1.0,
    "weight_market": 0.0,
    "exit_timeline": "2030-06-30",
    "allocation_method": "opm",
}

INPUTS = {
    "valuation_date": "2026-06-30",
    "shares_outstanding_common": 10_000_000,
    "risk_free_rate": 0.042,
    "income": {"free_cash_flows": FCF, "discount_rate": RATE, "terminal_growth": GROWTH},
}


def _income(**income_overrides):
    inputs = {**INPUTS, "income": {**INPUTS["income"], **income_overrides}}
    return compute(PARAMS, inputs)["results"]["approaches"]["income"]


class TestThroughCompute:
    def test_the_convention_reaches_the_engine(self):
        assert _income(mid_year_convention=True)["mid_year_convention"] is True
        assert _income()["mid_year_convention"] is False

    def test_it_moves_the_concluded_value(self):
        assert _income(mid_year_convention=True)["equity_value"] > _income()["equity_value"]

    def test_the_exit_multiple_reaches_the_engine(self):
        got = _income(
            terminal_method="exit_multiple", exit_multiple=8.0, terminal_metric=3_000_000,
            terminal_metric_basis="ebitda",
        )
        assert got["terminal_method"] == "exit_multiple"
        assert got["terminal_value"] == pytest.approx(24_000_000.0)

    def test_a_truthy_non_boolean_convention_is_refused(self):
        """A form that stringifies its checkboxes must not be read as a silent
        yes — the switch is worth 8-12% of the income approach."""
        with pytest.raises(EngineInputError, match="must be true or false"):
            _income(mid_year_convention="true")

    def test_a_numeric_one_is_refused_too(self):
        with pytest.raises(EngineInputError, match="must be true or false"):
            _income(mid_year_convention=1)


class TestThePreFlightAgrees:
    """The validator's contract is that it clears exactly what compute accepts."""

    def _issues(self, **income_overrides):
        inputs = {**INPUTS, "income": {**INPUTS["income"], **income_overrides}}
        return validate_payload(PARAMS, inputs)

    def test_a_mid_year_payload_is_clean(self):
        assert self._issues(mid_year_convention=True) == []

    def test_an_unknown_terminal_method_is_an_error(self):
        issues = self._issues(terminal_method="h_model")
        assert any(
            i.field == "inputs.income.terminal_method" and i.severity == ERROR for i in issues
        )

    def test_a_missing_exit_multiple_is_an_error(self):
        issues = self._issues(terminal_method="exit_multiple")
        assert any(
            i.field == "inputs.income.exit_multiple" and i.severity == ERROR for i in issues
        )

    def test_an_exit_multiple_run_is_not_asked_for_r_above_g(self):
        """The mismatch this guards: the engine accepts r <= g on an exit
        multiple, so a pre-flight that refused it would block a legal payload."""
        issues = self._issues(
            terminal_method="exit_multiple", exit_multiple=8.0, terminal_metric=3_000_000,
            discount_rate=0.02, terminal_growth=0.05,
        )
        assert not any(i.code == "rate_below_growth" for i in issues)

    def test_gordon_is_still_asked_for_it(self):
        issues = self._issues(discount_rate=0.02, terminal_growth=0.05)
        assert any(i.code == "rate_below_growth" and i.severity == ERROR for i in issues)

    def test_an_unnamed_denominator_is_flagged(self):
        issues = self._issues(terminal_method="exit_multiple", exit_multiple=8.0)
        assert any(
            i.code == "implied_terminal_metric" and i.severity == WARNING for i in issues
        )

    def test_a_named_denominator_is_not(self):
        issues = self._issues(
            terminal_method="exit_multiple", exit_multiple=8.0, terminal_metric=3_000_000,
        )
        assert not any(i.code == "implied_terminal_metric" for i in issues)

    def test_a_non_boolean_convention_is_an_error(self):
        issues = self._issues(mid_year_convention="true")
        assert any(
            i.field == "inputs.income.mid_year_convention" and i.severity == ERROR
            for i in issues
        )


# ── the rate itself, on the result ───────────────────────────────────────────


class TestTheRateIsRecorded:
    """The assumption a DCF is challenged on first, where the report can read it.

    The result carried `mid_year_convention` and `terminal_method` for the
    stated reason that a stored valuation is re-read by the report service —
    and not the rate those conventions qualify. So the report could reach the
    discount rate only by reading the *request*, which is what was asked for
    rather than what ran; on the `auto_wacc` path `compute._resolve_auto`
    rewrites the request before this function sees it, so the document a reader
    inspects has been edited by the calculation it is meant to evidence.
    """

    def test_the_result_states_the_rate_that_discounted_the_flows(self):
        assert income_dcf(FCF, RATE, GROWTH)["discount_rate"] == pytest.approx(RATE)

    def test_the_result_states_the_length_of_the_explicit_forecast(self):
        assert income_dcf(FCF, RATE, GROWTH)["forecast_years"] == len(FCF)
        assert income_dcf(FCF[:3], RATE, GROWTH)["forecast_years"] == 3

    def test_both_are_recorded_whichever_terminal_method_ran(self):
        # The exit-multiple path builds a different `terminal_detail` and takes
        # a different discount factor for the terminal value; neither changes
        # what the explicit flows were discounted at.
        got = income_dcf(FCF, RATE, terminal_method="exit_multiple", exit_multiple=8.0)
        assert got["discount_rate"] == pytest.approx(RATE)
        assert got["forecast_years"] == len(FCF)

    def test_the_recorded_rate_is_the_one_the_wacc_build_up_produced(self):
        """`auto_wacc` writes its build-up into the request, and the result has
        to agree with it — this is the path where reading the request and
        reading the result could have diverged."""
        inputs = {
            **INPUTS,
            # No `discount_rate`: the build-up only fills one that is absent.
            "income": {"free_cash_flows": FCF, "terminal_growth": GROWTH},
            "wacc": {
                "unlevered_beta_input": 1.2,
                "equity_risk_premium": 0.055,
                "risk_free_rate_override": 0.042,
                "size_premium_override": 0.03,
                "company_specific_premium": 0.05,
            },
        }
        out = compute(PARAMS, inputs, auto_wacc=True)
        built = out["results"]["auto"]["wacc"]["wacc"]
        assert out["results"]["approaches"]["income"]["discount_rate"] == pytest.approx(built)
