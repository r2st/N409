"""Hand-derived reference values for the valuation approaches and the full compute chain.

Every other test in this directory checks the engine against *itself*: that the
weighted equity value equals the weighted sum of the approach figures the same
run produced, that the FMV equals `common_equity × (1−dloc)(1−dlom) / FD` using
the discounts the same run selected, that value is conserved across the
waterfall. Those are the right tests for the properties they state, and they
share one blind spot — they are all satisfied by an engine whose arithmetic has
silently moved. Change the DCF's discounting and
`test_full_compute_shape_and_weighting` still passes: the income approach
returns a different number and the weighted sum it is compared against is built
from that same different number.

So this file states the numbers themselves. Every expected figure below is
derived by hand in the comment above it, from inputs picked so the arithmetic
closes exactly in binary floating point — powers of 1.25, medians of three, and
cash flows that divide cleanly. A failure here means the engine's answer for a
known input has changed, which is either a regression or a deliberate
methodology change that has to be argued for and re-derived rather than
absorbed.

The edge cases in the second half are the ones a 409A engine meets on real
engagements and gets wrong quietly: a pre-revenue company with no metric to
strike a multiple against, a declining forecast, a discount rate close enough to
the terminal growth rate to make the perpetuity explode, and a company whose
forecast never turns positive.
"""

import pytest

from app.engine.approaches import asset_value, income_dcf, market_multiples
from app.engine.compute import compute
from app.engine.errors import EngineInputError

# ── The reference engagement ────────────────────────────────────────────────
#
# Chosen so every intermediate is exact: 1.25 and its powers are exact binary
# fractions, so each discount factor and each quotient below is representable
# without rounding. That is what lets these be equalities rather than
# tolerances, and it is why the rate is 25% rather than something prettier.

FCF = [1_000_000.0, 2_000_000.0, 3_000_000.0]
DISCOUNT_RATE = 0.25
TERMINAL_GROWTH = 0.05
CASH = 500_000.0
DEBT = 200_000.0


class TestIncomeApproach:
    """DCF: PV of the explicit forecast, plus a Gordon perpetuity."""

    def test_present_value_of_the_explicit_forecast(self):
        # Discount factors are (1.25)^1, ^2, ^3 = 1.25, 1.5625, 1.953125.
        #   1,000,000 / 1.25       =   800,000
        #   2,000,000 / 1.5625     = 1,280,000
        #   3,000,000 / 1.953125   = 1,536,000
        #                            ─────────
        #                            3,616,000
        out = income_dcf(FCF, DISCOUNT_RATE, TERMINAL_GROWTH)
        assert out["pv_explicit"] == pytest.approx(3_616_000.0, abs=0.01)

    def test_gordon_terminal_value(self):
        # FCF_N·(1+g) / (r−g) = 3,000,000 × 1.05 / 0.20
        #                     = 3,150,000 / 0.20 = 15,750,000
        out = income_dcf(FCF, DISCOUNT_RATE, TERMINAL_GROWTH)
        assert out["terminal_value"] == pytest.approx(15_750_000.0, abs=0.01)

        # Discounted at the final explicit factor, (1.25)^3 = 1.953125:
        #   15,750,000 / 1.953125 = 8,064,000
        assert out["pv_terminal"] == pytest.approx(8_064_000.0, abs=0.01)

    def test_enterprise_and_equity_value(self):
        # enterprise = 3,616,000 + 8,064,000 = 11,680,000
        # equity     = enterprise + cash − debt
        #            = 11,680,000 + 500,000 − 200,000 = 11,980,000
        out = income_dcf(FCF, DISCOUNT_RATE, TERMINAL_GROWTH, cash=CASH, debt=DEBT)
        assert out["enterprise_value"] == pytest.approx(11_680_000.0, abs=0.01)
        assert out["equity_value"] == pytest.approx(11_980_000.0, abs=0.01)

    def test_mid_year_convention_lifts_present_value_by_exactly_one_half_year(self):
        """The 8–12% the docstring promises, stated as the closed form it is.

        Every explicit factor becomes (1+r)^(n−½) — the end-of-year factor over
        (1+r)^½ — and the Gordon terminal value shares the final explicit
        factor, so *both* halves of the enterprise value scale by the same
        √1.25. Not an approximation: it is one multiplication applied to the
        whole figure, which is why it can be asserted exactly rather than as a
        range.
        """
        end = income_dcf(FCF, DISCOUNT_RATE, TERMINAL_GROWTH)
        mid = income_dcf(FCF, DISCOUNT_RATE, TERMINAL_GROWTH, mid_year_convention=True)

        assert mid["enterprise_value"] == pytest.approx(
            end["enterprise_value"] * 1.25**0.5, rel=1e-12
        )
        # 11,680,000 × 1.1180339887… = 13,058,636.99
        assert mid["enterprise_value"] == pytest.approx(13_058_636.99, abs=0.01)
        # And the convention is on the result, not only the request — the report
        # and next year's roll-forward cannot tell an 11.8% move from a
        # different forecast unless it is recorded.
        assert mid["mid_year_convention"] is True
        assert end["mid_year_convention"] is False


class TestMarketApproach:
    """Guideline public companies: the median multiple on the subject's metric."""

    def test_median_multiple_and_equity_value(self):
        # median(5.0, 7.0, 6.0) = 6.0 — the median, not the mean (6.0 here too;
        # the fourth multiple below is what tells them apart).
        # enterprise = 6.0 × 4,000,000 = 24,000,000
        # equity     = 24,000,000 + 500,000 − 200,000 = 24,300,000
        out = market_multiples(4_000_000.0, [5.0, 7.0, 6.0], cash=CASH, debt=DEBT)
        assert out["selected_multiple"] == 6.0
        assert out["enterprise_value"] == pytest.approx(24_000_000.0, abs=0.01)
        assert out["equity_value"] == pytest.approx(24_300_000.0, abs=0.01)

    def test_the_selected_multiple_is_the_median_not_the_mean(self):
        """A skewed peer set is where the two part company.

        median(4, 5, 6, 21) = 5.5; mean = 9.0. A guideline set with one runaway
        comparable is the ordinary case, not a contrived one, and an engine that
        quietly averaged would value this company 64% higher.
        """
        out = market_multiples(1_000_000.0, [4.0, 5.0, 6.0, 21.0])
        assert out["selected_multiple"] == 5.5
        assert out["enterprise_value"] == pytest.approx(5_500_000.0, abs=0.01)


class TestAssetApproach:
    def test_net_asset_value(self):
        # 9,000,000 − 3,000,000 = 6,000,000
        out = asset_value(total_assets=9_000_000.0, total_liabilities=3_000_000.0)
        assert out["method"] == "nav"
        assert out["equity_value"] == pytest.approx(6_000_000.0, abs=0.01)

    def test_cost_to_replicate_is_taken_as_given(self):
        out = asset_value(cost_to_replicate=2_750_000.0)
        assert out["method"] == "cost_to_replicate"
        assert out["equity_value"] == pytest.approx(2_750_000.0, abs=0.01)


# ── The whole chain, on one hand-checkable engagement ───────────────────────

REFERENCE_PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 0.0,
    "weight_income": 1.0,
    "weight_market": 0.0,
    "dloc": 0.10,
    # Qualitative rather than a model, so the discount is an input and the whole
    # conclusion stays hand-derivable. The Finnerty and Chaffee models have their
    # own reference values in test_dlom_reference_values.py.
    "dlom_method": "qualitative",
    "dlom": 0.20,
    "exit_timeline": "2029-06-30",
}

REFERENCE_INPUTS = {
    "valuation_date": "2026-06-30",
    "shares_outstanding_common": 8_000_000,
    "options_outstanding": 2_000_000,
    # No preferred, so the allocation is the whole equity to common and the
    # conclusion can be checked without also re-deriving the OPM.
    "shares_outstanding_preferred": 0,
    "liquidation_preference": 0,
    "volatility": 0.6,
    "risk_free_rate": 0.04,
    "cash": CASH,
    "debt": DEBT,
    "income": {
        "free_cash_flows": FCF,
        "discount_rate": DISCOUNT_RATE,
        "terminal_growth": TERMINAL_GROWTH,
    },
}


class TestFullComputeChain:
    def test_concluded_fmv_per_share_for_a_known_engagement(self):
        """One arithmetic chain, end to end, every step stated.

        This is the number that goes on the front of the report and into the
        board resolution, so it is the one worth pinning to a figure derived
        outside the engine:

            equity        = 11,980,000            (income approach, weight 1.0)
            common equity = 11,980,000            (no preferred to come off)
            FD common     =  8,000,000 + 2,000,000 = 10,000,000
            after DLOC    = 11,980,000 × 0.90     = 10,782,000
            after DLOM    = 10,782,000 × 0.80     =  8,625,600
            FMV/share     =  8,625,600 / 10,000,000 = 0.86256 → 0.8626
        """
        res = compute(REFERENCE_PARAMS, REFERENCE_INPUTS)["results"]

        assert res["equity_value"] == pytest.approx(11_980_000.0, abs=0.01)
        assert res["common_equity_value"] == pytest.approx(11_980_000.0, abs=0.01)
        assert res["fully_diluted_common"] == 10_000_000
        assert res["discounts"]["dloc"] == 0.10
        assert res["discounts"]["dlom"] == 0.20
        assert res["fmv_per_share"] == pytest.approx(0.8626, abs=1e-4)

    def test_the_discounts_apply_in_series_not_in_sum(self):
        """(1−0.10)(1−0.20) = 0.72, not 1 − 0.30 = 0.70.

        A 2.8% difference in the concluded value, in the company's favour, and
        invisible in any test that reads the discounts back out of the same
        result document that applied them.
        """
        res = compute(REFERENCE_PARAMS, REFERENCE_INPUTS)["results"]
        combined = res["fmv_per_share"] * res["fully_diluted_common"] / res["common_equity_value"]
        assert combined == pytest.approx(0.72, abs=1e-4)
        assert combined != pytest.approx(0.70, abs=1e-4)


# ── Edge cases ─────────────────────────────────────────────────────────────


class TestZeroRevenue:
    """The pre-revenue company, which is most of what a 409A engine values."""

    def test_a_multiple_cannot_be_struck_against_no_revenue(self):
        """Refused, rather than returning zero.

        Zero revenue times any multiple is zero, and a zero enterprise value
        that flowed into the weighting would drag the concluded FMV toward zero
        while looking like a computed figure. The company is not worth nothing;
        the market approach simply does not apply to it, and the caller has to
        be told that rather than handed a number.
        """
        with pytest.raises(EngineInputError, match="metric must be positive"):
            market_multiples(0.0, [6.0, 8.0])

    def test_a_pre_revenue_forecast_still_values_through_the_income_approach(self):
        """Burn now, cash flow later — the shape every early-stage forecast has.

            -500,000 / 1.40    = -357,142.857…
            -250,000 / 1.96    = -127,551.020…
           1,000,000 / 2.744   =  364,431.487…
                                 ───────────
            pv_explicit        =  -120,262.390…

            TV  = 1,000,000 × 1.03 / (0.40 − 0.03) = 2,783,783.783…
            PV  = 2,783,783.783… / 2.744           = 1,014,498.463…

            enterprise = 894,236.07;  equity = +2,000,000 cash = 2,894,236.07
        """
        out = income_dcf(
            [-500_000.0, -250_000.0, 1_000_000.0],
            0.40,
            0.03,
            cash=2_000_000.0,
        )
        assert out["pv_explicit"] == pytest.approx(-120_262.39, abs=0.01)
        assert out["pv_terminal"] == pytest.approx(1_014_498.46, abs=0.01)
        assert out["enterprise_value"] == pytest.approx(894_236.07, abs=0.01)
        assert out["equity_value"] == pytest.approx(2_894_236.07, abs=0.01)


class TestNegativeGrowth:
    """A business the forecast says is shrinking."""

    def test_a_negative_terminal_growth_rate_shrinks_the_perpetuity(self):
        # TV = 3,000,000 × (1 − 0.05) / (0.25 + 0.05)
        #    = 2,850,000 / 0.30 = 9,500,000
        # PV = 9,500,000 / 1.953125 = 4,864,000
        # enterprise = 3,616,000 + 4,864,000 = 8,480,000
        #
        # Against the +5% case's 11,680,000: a ten-point swing in the terminal
        # growth rate is 27% of the enterprise value, which is why the sign of
        # `g` is worth a test of its own.
        out = income_dcf(FCF, 0.25, -0.05)
        assert out["terminal_value"] == pytest.approx(9_500_000.0, abs=0.01)
        assert out["pv_terminal"] == pytest.approx(4_864_000.0, abs=0.01)
        assert out["enterprise_value"] == pytest.approx(8_480_000.0, abs=0.01)

    def test_a_forecast_that_never_turns_positive_is_refused_not_concluded(self):
        """A negative equity value is not a cheap share, it is a broken model.

        The arithmetic is happy to produce one — the flows are negative, so the
        perpetuity is too — and the failure downstream would be a *negative FMV
        per share* on a report. Refused at the weighting step, naming the
        figure, so the analyst re-cuts the forecast instead of publishing it.
        """
        approach = income_dcf([-500_000.0, -400_000.0, -300_000.0], 0.40, 0.03)
        assert approach["equity_value"] < 0

        with pytest.raises(EngineInputError, match="not positive"):
            compute(
                REFERENCE_PARAMS,
                {
                    **REFERENCE_INPUTS,
                    "income": {
                        "free_cash_flows": [-500_000.0, -400_000.0, -300_000.0],
                        "discount_rate": 0.40,
                        "terminal_growth": 0.03,
                    },
                },
            )


class TestExtremeDiscountRates:
    def test_a_rate_equal_to_terminal_growth_is_refused(self):
        """r = g divides by zero. Named, rather than returned as an infinity."""
        with pytest.raises(EngineInputError, match="must exceed terminal_growth"):
            income_dcf(FCF, 0.05, 0.05)

    def test_a_rate_below_terminal_growth_is_refused(self):
        """r < g is a perpetuity growing faster than it is discounted.

        The closed form returns a *negative* terminal value for it, which is
        arithmetically what the formula says and economically meaningless.
        """
        with pytest.raises(EngineInputError, match="must exceed terminal_growth"):
            income_dcf(FCF, 0.03, 0.05)

    def test_a_rate_barely_above_terminal_growth_explodes_and_is_allowed_to(self):
        """The spread, not the rate, is what the terminal value is sensitive to.

        r − g = 0.0001 capitalises a single million-dollar flow into ten and a
        half billion. That is correct — it is 1.05/0.0001 — and it is the
        commonest way a DCF is quietly wrong, because both inputs look
        reasonable in isolation and neither trips a bound.

        Pinned as *allowed* deliberately. The engine's job is not to second-guess
        a spread the analyst chose; it is to compute what was asked and record
        it. What protects the conclusion is the review layer above, which reads
        the result document — so this test exists to state that the number is
        the true one, and that any future guard here must be a deliberate
        decision rather than an accident of clamping.
        """
        out = income_dcf([1_000_000.0], 0.0501, 0.05)
        # 1,000,000 × 1.05 / 0.0001 = 10,500,000,000
        assert out["terminal_value"] == pytest.approx(10_500_000_000.0, rel=1e-9)

    def test_a_very_high_discount_rate_collapses_the_forecast_toward_nothing(self):
        """95%, roughly where a seed-stage venture rate of return sits.

            1,000,000 / 1.95    = 512,820.512…
            1,000,000 / 3.8025  = 262,984.878…
            1,000,000 / 7.414875= 134,864.040…
                                  ───────────
            pv_explicit         = 910,669.431…

            TV = 1,000,000 × 1.0 / 0.95 = 1,052,631.578…
            PV = 1,052,631.578… / 7.414875 = 141,962.147…

            enterprise = 1,052,631.58 — which is C/r, the undiscounted
            perpetuity. See the identity below: that is not a coincidence of
            these inputs.
        """
        out = income_dcf([1_000_000.0, 1_000_000.0, 1_000_000.0], 0.95, 0.0)
        assert out["pv_explicit"] == pytest.approx(910_669.43, abs=0.01)
        assert out["pv_terminal"] == pytest.approx(141_962.15, abs=0.01)
        assert out["enterprise_value"] == pytest.approx(1_052_631.58, abs=0.01)

    @pytest.mark.parametrize("horizon", [1, 3, 7, 10])
    @pytest.mark.parametrize("rate", [0.95, 0.40, 0.25, 0.10])
    def test_a_flat_forecast_reconstructs_the_perpetuity_at_any_horizon(self, horizon, rate):
        """C/r, however many years of it are made explicit.

        For a level flow with zero terminal growth, the explicit period and the
        Gordon terminal value partition the same perpetuity:

            Σ(n=1..N) C/(1+r)^n  +  (C/r)/(1+r)^N
              = C/r·[1 − (1+r)^−N]  +  (C/r)·(1+r)^−N
              = C/r

        So the answer must not depend on where the forecast is cut. This is the
        sharpest available check on the discounting and the terminal value
        *together*: an off-by-one in either exponent, or a terminal value
        discounted at the wrong factor, breaks the cancellation and shows up as
        a horizon-dependent answer — while each piece on its own still looks
        plausible. It is also exactly the error the mid-year convention makes
        deliberately, which is why that path is asserted separately.
        """
        out = income_dcf([1_000_000.0] * horizon, rate, 0.0)
        assert out["enterprise_value"] == pytest.approx(1_000_000.0 / rate, rel=1e-12)


class TestVeryEarlyStage:
    def test_a_company_whose_only_asset_is_its_cash(self):
        """No forecast worth discounting; the asset approach is the whole answer.

        The premise every seed-stage NAV rests on, and the one case where the
        asset approach is not the floor but the conclusion.
        """
        out = asset_value(total_assets=1_200_000.0, total_liabilities=50_000.0)
        assert out["equity_value"] == pytest.approx(1_150_000.0, abs=0.01)

    def test_the_option_pool_dilutes_the_concluded_per_share_value(self):
        """The denominator is fully diluted, and at this stage it is mostly pool.

        8,000,000 common + 2,000,000 pool: the pool is 20% of the fully diluted
        count, so the per-share conclusion is 20% below what the common count
        alone would give. Getting this denominator wrong is the single most
        consequential arithmetic error available to a 409A engine — it moves
        every option's strike price — and it is invisible in the equity value.
        """
        res = compute(REFERENCE_PARAMS, REFERENCE_INPUTS)["results"]
        assert res["fully_diluted_common"] == 10_000_000

        no_pool = compute(
            REFERENCE_PARAMS,
            {**REFERENCE_INPUTS, "options_outstanding": 0},
        )["results"]
        assert no_pool["fully_diluted_common"] == 8_000_000
        # 0.86256 → 1.0782, exactly the 10,000,000/8,000,000 ratio.
        assert no_pool["fmv_per_share"] == pytest.approx(
            res["fmv_per_share"] * 10 / 8, rel=1e-3
        )
