"""A concluded FMV traced back to its raw inputs, one transformation at a time.

Why this file exists
--------------------
`test_reference_values.py` pins each approach's arithmetic against figures
derived by hand, and `test_compute.py` checks that the finished document is
internally consistent. Between them sits the thing neither asks: whether the
number on the front of the report is *the number those inputs produce* once it
has been through weighting, allocation, two discounts and a share count — with
every rounding, default and reused value that chain applies on the way.

So this file re-derives one engagement end to end, in the test, from the raw
inputs. The primitives below are written from the closed forms rather than
imported, because a re-derivation that calls `app.engine.bs` proves only that
the engine agrees with itself — which is the blind spot the whole exercise is
about. `test_bs.py` and `test_dlom_reference_values.py` pin those two
implementations against their own independent references; this file pins the
*chain* that joins them.

What a failure here means
-------------------------
Some transformation between an input and the conclusion has moved. That is
either a regression or a methodology change, and either way the derivation in
the docstring above the failing assertion is what has to be re-argued — not the
expected number quietly updated to whatever the engine now says.

Rounding
--------
`docs/engine-rounding-policy.md` states which rounding sites are load-bearing
(their output feeds later arithmetic) and which are presentational. The tests
in `TestRoundingPolicy` are that document made executable: the concluded FMV
computed with every intermediate at full precision must agree with the engine's
to within half the last reported place.
"""

import ast
import copy
import math
import pathlib

import pytest

from app.engine.compute import DEFAULT_RISK_FREE_RATE, DEFAULT_TIME_TO_EXIT_YEARS, compute
from app.engine.sensitivity import sensitivity
from app.engine.validate import validate_payload

# ── Independent primitives ──────────────────────────────────────────────────
#
# Black-Scholes and the Chaffee put, from the closed forms. Nothing here imports
# from `app.engine`; that is the point.


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _bs_call(s: float, k: float, t: float, r: float, sigma: float) -> float:
    """European call, spot `s`, strike `k`. The OPM's allocation primitive."""
    if t <= 0 or sigma <= 0:
        return max(s - k, 0.0)
    vol = sigma * math.sqrt(t)
    d1 = (math.log(s / k) + (r + 0.5 * sigma * sigma) * t) / vol
    d2 = d1 - vol
    return s * _norm_cdf(d1) - k * math.exp(-r * t) * _norm_cdf(d2)


def _chaffee(sigma: float, t: float, r: float) -> float:
    """Chaffee: an at-the-money European put over the holding period, on a unit
    share. Put-call parity off the call above, at S = K = 1."""
    call = _bs_call(1.0, 1.0, t, r, sigma)
    return call - 1.0 + math.exp(-r * t)


# ── The traced engagement ───────────────────────────────────────────────────
#
# All four approaches carry weight, so the weighting step has four terms to get
# wrong rather than one. The cap table is the aggregate single-breakpoint shape
# (preferred behind one preference, a pool folded into fully-diluted common),
# which is the branch whose per-share figure a reader can check by dividing.
#
# The dates are chosen so the horizon is exactly four years: 2026-06-30 to
# 2030-06-30 is 1,461 days and 1461 / 365.25 = 4.0, with no remainder to carry
# into the option pricing.

PARAMS = {
    "allocation_method": "opm",
    "weight_asset": 0.10,
    "weight_opm": 0.30,
    "weight_income": 0.40,
    "weight_market": 0.20,
    "dloc": 0.05,
    "dlom_method": "chaffee",
    "exit_timeline": "2030-06-30",
}

INPUTS = {
    "valuation_date": "2026-06-30",
    "shares_outstanding_common": 8_000_000,
    "options_outstanding": 2_000_000,
    "shares_outstanding_preferred": 4_000_000,
    "liquidation_preference": 10_000_000,
    "volatility": 0.65,
    "risk_free_rate": 0.04,
    "cash": 500_000.0,
    "debt": 200_000.0,
    "last_round_post_money": 20_000_000.0,
    "income": {
        "free_cash_flows": [1_000_000.0, 2_000_000.0, 3_000_000.0],
        "discount_rate": 0.25,
        "terminal_growth": 0.05,
    },
    "market": {"multiples": [4.0, 6.0, 8.0], "metric": 2_000_000.0},
    "asset": {"total_assets": 9_000_000.0, "total_liabilities": 3_000_000.0},
}

# Every figure the chain passes through, derived below and asserted against the
# engine one step at a time.
T = 4.0
R = 0.04
SIGMA = 0.65
INCOME_EQUITY = 11_980_000.0
MARKET_EQUITY = 12_300_000.0
ASSET_EQUITY = 6_000_000.0
OPM_EQUITY = 20_000_000.0
WEIGHTED_EQUITY = 13_852_000.0
FULLY_DILUTED_COMMON = 10_000_000.0


@pytest.fixture(scope="module")
def traced():
    return compute(PARAMS, INPUTS, trace=True)


@pytest.fixture(scope="module")
def results(traced):
    return traced["results"]


def _step(traced, key):
    return next(s for s in traced["trace"] if s["key"] == key)


class TestIncomeApproachTrace:
    """Leg one: three cash flows and a perpetuity, back to the raw forecast."""

    def test_the_explicit_forecast_discounts_at_the_stated_rate(self, results):
        # (1.25)^1, ^2, ^3 = 1.25, 1.5625, 1.953125 — all exact in binary, so
        # this is an equality rather than a tolerance.
        #   1,000,000 / 1.25       =   800,000
        #   2,000,000 / 1.5625     = 1,280,000
        #   3,000,000 / 1.953125   = 1,536,000  →  3,616,000
        assert results["approaches"]["income"]["pv_explicit"] == 3_616_000.0

    def test_the_terminal_value_capitalises_the_final_flow(self, results):
        # 3,000,000 × 1.05 / (0.25 − 0.05) = 3,150,000 / 0.20 = 15,750,000
        income = results["approaches"]["income"]
        assert income["terminal_value"] == 15_750_000.0
        # Discounted at the final explicit factor: 15,750,000 / 1.953125
        assert income["pv_terminal"] == 8_064_000.0

    def test_the_bridge_from_enterprise_to_equity_is_plus_cash_less_debt(self, results):
        income = results["approaches"]["income"]
        assert income["enterprise_value"] == 3_616_000.0 + 8_064_000.0
        assert income["equity_value"] == income["enterprise_value"] + 500_000.0 - 200_000.0
        assert income["equity_value"] == INCOME_EQUITY

    def test_the_rate_that_discounted_the_flows_travels_with_them(self, results):
        """Not the rate on the request — the one the arithmetic used.

        They differ on the `auto_wacc` path, where the built-up WACC is written
        into the inputs before the DCF runs. A reader checking the discounting
        needs the rate that was applied.
        """
        income = results["approaches"]["income"]
        assert income["discount_rate"] == 0.25
        assert income["forecast_years"] == 3
        assert income["mid_year_convention"] is False
        assert income["terminal_method"] == "gordon"


class TestMarketApproachTrace:
    """Leg two: which multiple was selected, out of what, against what metric."""

    def test_the_selected_multiple_is_the_median_of_the_supplied_set(self, results):
        market = results["approaches"]["market"]
        assert market["multiples"] == [4.0, 6.0, 8.0]
        assert market["selected_multiple"] == 6.0

    def test_the_enterprise_value_is_that_multiple_times_the_subject_metric(self, results):
        market = results["approaches"]["market"]
        assert market["metric"] == 2_000_000.0
        assert market["enterprise_value"] == 6.0 * 2_000_000.0

    def test_the_same_bridge_carries_it_to_equity(self, results):
        market = results["approaches"]["market"]
        assert market["equity_value"] == 12_000_000.0 + 500_000.0 - 200_000.0
        assert market["equity_value"] == MARKET_EQUITY

    def test_the_horizon_the_multiple_was_struck_over_is_recorded(self, results):
        """An 8.0× says nothing about whether it came off trailing or forward
        revenue, and pairing a forward multiple with a trailing metric
        understates a growing company by its whole growth rate."""
        assert results["approaches"]["market"]["horizon"] == "ltm"


class TestWeightedConclusion:
    """The four legs into one equity value, term by term."""

    def test_each_contribution_is_the_approach_times_its_weight(self, traced):
        terms = {t["approach"]: t for t in _step(traced, "weighting")["inputs"]["terms"]}
        assert terms["asset"]["contribution"] == ASSET_EQUITY * 0.10
        assert terms["opm_backsolve"]["contribution"] == OPM_EQUITY * 0.30
        assert terms["income"]["contribution"] == INCOME_EQUITY * 0.40
        assert terms["market"]["contribution"] == MARKET_EQUITY * 0.20

    def test_the_equity_value_is_those_four_contributions_and_nothing_else(self, results):
        #     600,000  (asset  6.00M × 0.10)
        #   6,000,000  (OPM   20.00M × 0.30)
        #   4,792,000  (income 11.98M × 0.40)
        #   2,460,000  (market 12.30M × 0.20)
        #  ──────────
        #  13,852,000
        assert results["equity_value"] == pytest.approx(WEIGHTED_EQUITY, abs=0.01)

    def test_the_weights_on_the_result_are_the_ones_that_were_applied(self, results):
        applied = {name: a["weight"] for name, a in results["approaches"].items()}
        assert applied == {"asset": 0.10, "opm_backsolve": 0.30, "income": 0.40, "market": 0.20}
        assert sum(applied.values()) == pytest.approx(1.0, abs=1e-9)


class TestAllocationTrace:
    """Equity value to common, through the single-breakpoint OPM."""

    def test_the_horizon_is_the_gap_between_the_two_dates(self, results):
        # 2026-06-30 → 2030-06-30 is 1,461 days; 1461 / 365.25 = 4.0
        assert results["assumptions"]["time_to_exit_years"] == T

    def test_the_upside_over_the_preference_is_a_call_struck_at_it(self, results):
        """Independently priced: a call on the whole equity, struck at the
        aggregate liquidation preference. Everything above the strike is what
        common and preferred then share."""
        expected = _bs_call(WEIGHTED_EQUITY, 10_000_000.0, T, R, SIGMA)
        assert results["allocation"]["breakpoint"] == 10_000_000.0
        assert results["allocation"]["upside_after_preference"] == pytest.approx(expected, rel=1e-12)

    def test_common_takes_its_fully_diluted_share_of_that_upside(self, results):
        # 10,000,000 fully-diluted common against 4,000,000 preferred = 5/7.
        assert results["allocation"]["common_fraction"] == pytest.approx(10 / 14, rel=1e-12)
        upside = _bs_call(WEIGHTED_EQUITY, 10_000_000.0, T, R, SIGMA)
        assert results["common_equity_value"] == pytest.approx(upside * (10 / 14), abs=0.01)

    def test_the_share_count_the_per_share_figure_is_over_is_named(self, results):
        """A reader who divides the two reported figures has to land on the
        reported per-share, and the only thing that makes that checkable is the
        count being stated alongside the word for which count it is."""
        assert results["fully_diluted_common"] == FULLY_DILUTED_COMMON
        assert results["fully_diluted_basis"] == "common_plus_options"
        assert FULLY_DILUTED_COMMON == 8_000_000 + 2_000_000


class TestDiscountTrace:
    """The last step, and the one most often argued about."""

    def test_the_marketability_discount_is_the_model_the_result_names(self, results):
        expected = _chaffee(SIGMA, T, R)
        assert results["discounts"]["dlom_method"] == "chaffee"
        assert results["discounts"]["dlom"] == pytest.approx(expected, abs=5e-5)

    def test_the_discount_applied_is_the_discount_reported(self, traced, results):
        """Not a given: the concluded DLOM is rounded before it is used, and a
        result that reported the unrounded figure beside a conclusion computed
        from the rounded one would be unreproducible by anyone checking it."""
        applied = _step(traced, "discounts")["inputs"]["dlom"]
        assert applied == results["discounts"]["dlom"]

    def test_the_two_discounts_compound_rather_than_add(self, results):
        """(1 − 0.05)(1 − dlom), not 1 − (0.05 + dlom). At a 35% DLOM the two
        readings differ by 1.75 points of value, in the company's favour."""
        dloc, dlom = results["discounts"]["dloc"], results["discounts"]["dlom"]
        marketable = results["common_equity_value"] / results["fully_diluted_common"]
        assert results["fmv_per_share"] == pytest.approx(
            marketable * (1 - dloc) * (1 - dlom), abs=5e-5
        )
        assert results["fmv_per_share"] != pytest.approx(
            marketable * (1 - dloc - dlom), abs=5e-5
        )

    def test_the_order_the_two_are_applied_in_cannot_matter(self, traced):
        """Multiplication commutes, so this is a statement about the code rather
        than the algebra: neither discount may be applied to a base the other
        has already moved in some way that is not a plain product."""
        step = _step(traced, "discounts")
        marketable = step["inputs"]["marketable_common_per_share"]
        dloc, dlom = step["inputs"]["dloc"], step["inputs"]["dlom"]
        assert step["outputs"]["fmv_per_share"] == pytest.approx(
            marketable * (1 - dlom) * (1 - dloc), rel=1e-12
        )
        assert step["outputs"]["combined_discount"] == pytest.approx(
            1 - (1 - dloc) * (1 - dlom), rel=1e-12
        )


class TestEndToEndFidelity:
    """The conclusion, in one expression, from the raw inputs.

    Every intermediate above, composed. If this passes and the steps above pass,
    there is no transformation in the chain that the trace does not account for.
    """

    def test_the_concluded_fmv_is_what_the_inputs_produce(self, results):
        pv_explicit = sum(f / 1.25 ** (i + 1) for i, f in enumerate([1e6, 2e6, 3e6]))
        pv_terminal = (3e6 * 1.05 / 0.20) / 1.25**3
        income = pv_explicit + pv_terminal + 500_000.0 - 200_000.0
        market = 6.0 * 2_000_000.0 + 500_000.0 - 200_000.0
        asset = 9_000_000.0 - 3_000_000.0
        opm = 20_000_000.0

        equity = 0.10 * asset + 0.30 * opm + 0.40 * income + 0.20 * market
        upside = _bs_call(equity, 10_000_000.0, T, R, SIGMA)
        common_per_share = upside * (10_000_000.0 / 14_000_000.0) / 10_000_000.0
        dlom = round(_chaffee(SIGMA, T, R), 4)
        fmv = common_per_share * (1 - 0.05) * (1 - dlom)

        assert results["fmv_per_share"] == pytest.approx(round(fmv, 4), abs=1e-4)

    def test_no_step_of_the_chain_is_missing_from_the_trace(self, traced):
        """The trace is what a reviewer disagrees with the conclusion through,
        so a transformation the document performs and the trace omits is a step
        nobody can challenge."""
        keys = [s["key"] for s in traced["trace"]]
        assert keys == [
            "approach.asset",
            "approach.opm_backsolve",
            "approach.income",
            "approach.market",
            "weighting",
            "allocation",
            "discounts",
        ]
        assert all(s["status"] == "computed" for s in traced["trace"])


# ── Rounding ────────────────────────────────────────────────────────────────


class TestRoundingPolicy:
    """`docs/engine-rounding-policy.md`, made executable.

    The policy has two halves. *Presentational* rounding happens on the way out
    and nothing reads it back — the concluded FMV at four decimals, dollar
    figures at two. *Load-bearing* rounding produces a value that later
    arithmetic consumes, and there the question is not whether it rounds but
    whether the rounding can reach the conclusion.
    """

    def test_the_conclusion_is_reproducible_from_the_figures_beside_it(self, results):
        """The property that actually matters, and the reason the concluded
        DLOM is quantised *before* it is applied rather than after.

        A reviewer with the result document multiplies the reported per-share by
        the reported discounts and must land on the reported conclusion. Applying
        an unrounded model DLOM and reporting a rounded one would break that at
        the fifth decimal — invisible on a $0.60 share, and worth a quarter of a
        cent on a $50 one.
        """
        marketable = results["common_equity_value"] / results["fully_diluted_common"]
        dloc, dlom = results["discounts"]["dloc"], results["discounts"]["dlom"]
        assert round(marketable * (1 - dloc) * (1 - dlom), 4) == results["fmv_per_share"]

    def test_the_model_detail_holds_the_unquantised_figure_the_conclusion_came_from(
        self, results
    ):
        """`discounts.dlom` is the concluded discount — quantised, and the one
        the arithmetic used. `dlom_detail.dlom` is what the model returned before
        that. They agree to the concluded figure's own precision, and a reviewer
        reading the detail has to be able to see that it is the wider of the two
        rather than a second, disagreeing conclusion.
        """
        concluded = results["discounts"]["dlom"]
        model = results["discounts"]["dlom_detail"]["dlom"]
        assert model == pytest.approx(concluded, abs=5e-5)
        assert round(model, 4) == concluded

    def test_full_precision_throughout_lands_on_the_same_conclusion(self, results):
        """Rounding once at the end against rounding at each step.

        Every load-bearing site in this path — the allocation's per-share at six
        decimals, the concluded DLOM at four — is re-run here at full precision.
        The two conclusions must agree to the last place the engine reports,
        which is what "the intermediate rounding does not compound" means.
        """
        equity = 0.10 * ASSET_EQUITY + 0.30 * OPM_EQUITY + 0.40 * INCOME_EQUITY + 0.20 * MARKET_EQUITY
        upside = _bs_call(equity, 10_000_000.0, T, R, SIGMA)
        exact = (
            upside * (10 / 14) / FULLY_DILUTED_COMMON * (1 - 0.05) * (1 - _chaffee(SIGMA, T, R))
        )
        assert results["fmv_per_share"] == pytest.approx(exact, abs=5e-5)

    @pytest.mark.parametrize(
        "path,inputs_patch,params_patch",
        [
            ("opm", {}, {}),
            ("cvm", {}, {"allocation_method": "cvm"}),
        ],
    )
    def test_dollar_figures_are_reported_to_the_cent(self, path, inputs_patch, params_patch):
        """Two decimals on every currency figure, on every allocation path.

        Presentational, but it has to be *uniform* presentational: a document
        mixing a cent-rounded equity value with a full-precision common equity
        value invites a reader to treat the difference as meaningful.
        """
        res = compute({**PARAMS, **params_patch}, {**INPUTS, **inputs_patch})["results"]
        for key in ("equity_value", "common_equity_value"):
            assert round(res[key], 2) == res[key], f"{path}.{key} carries sub-cent precision"

    def test_the_per_share_conclusion_is_reported_to_four_decimals(self, results):
        assert round(results["fmv_per_share"], 4) == results["fmv_per_share"]

    def test_the_unrounded_conclusion_stays_out_of_the_persisted_document(self, traced):
        """It rides beside `results`, for the reason the trace does: `results` is
        the answer, it is diffed between runs and rendered into the report, and a
        second per-share figure inside it reads as a second conclusion."""
        assert "fmv_per_share_unrounded" in traced
        assert "fmv_per_share_unrounded" not in traced["results"]
        assert traced["fmv_per_share_unrounded"] == pytest.approx(
            traced["results"]["fmv_per_share"], abs=5e-5
        )


# ── Provenance ──────────────────────────────────────────────────────────────


class TestAssumptionProvenance:
    """Which reported assumptions are inputs, and which the engine chose.

    Two of them are not required, so either can be a figure no analyst ever
    typed — and both drive the Black-Scholes allocation and any model DLOM.
    """

    def test_a_supplied_rate_is_labelled_as_supplied(self, results):
        assert results["assumptions"]["risk_free_rate"] == 0.04
        assert results["assumptions"]["risk_free_rate_basis"] == "input"

    def test_a_horizon_read_off_the_exit_date_says_so(self, results):
        assert results["assumptions"]["time_to_exit_basis"] == "exit_timeline"

    def test_an_explicit_override_outranks_the_exit_date(self):
        res = compute(PARAMS, {**INPUTS, "time_to_exit_years": 2.5})["results"]
        assert res["assumptions"]["time_to_exit_years"] == 2.5
        assert res["assumptions"]["time_to_exit_basis"] == "input_override"

    def test_a_substituted_rate_and_horizon_are_both_named_as_substitutes(self):
        """The report prints `assumptions` as the valuation's stated basis. With
        neither field supplied the engine picks both, and without the label the
        substitutes are indistinguishable from choices somebody made."""
        bare = {k: v for k, v in INPUTS.items() if k != "risk_free_rate"}
        res = compute({k: v for k, v in PARAMS.items() if k != "exit_timeline"}, bare)["results"]
        assert res["assumptions"]["risk_free_rate"] == DEFAULT_RISK_FREE_RATE
        assert res["assumptions"]["risk_free_rate_basis"] == "engine_default"
        assert res["assumptions"]["time_to_exit_years"] == DEFAULT_TIME_TO_EXIT_YEARS
        assert res["assumptions"]["time_to_exit_basis"] == "engine_default"

    def test_preflight_says_so_too_rather_than_passing_in_silence(self):
        """`_check_dates` used to return early when neither field was set, and
        the risk-free band check skipped an absent rate — so the payload cleared
        validation and the substitution happened afterwards, unannounced."""
        bare = {k: v for k, v in INPUTS.items() if k != "risk_free_rate"}
        issues = validate_payload({k: v for k, v in PARAMS.items() if k != "exit_timeline"}, bare)
        defaults = {i.field for i in issues if i.code == "engine_default"}
        assert defaults == {"inputs.risk_free_rate", "params.exit_timeline"}
        assert all(i.severity == "warning" for i in issues if i.code == "engine_default")

    def test_a_supplied_payload_draws_no_default_warning(self):
        issues = validate_payload(PARAMS, INPUTS)
        assert [i for i in issues if i.code == "engine_default"] == []

    def test_a_risk_free_rate_of_zero_is_a_rate_and_not_a_missing_one(self):
        """`_num(...) or DEFAULT_RISK_FREE_RATE` read a supplied 0.0 as absent
        and discounted at 4% instead, while `assumptions.risk_free_rate`
        reported the 4% — so nothing anywhere said the input had been discarded.

        Zero is where the euro area, Switzerland and Japan sat for years, and
        where the front of the USD curve sat through 2020-21. `validate`'s
        `RISK_FREE_BAND` starts at 0.0 and passes it without a warning, so the
        two layers disagreed about the same number.
        """
        zero = compute(PARAMS, {**INPUTS, "risk_free_rate": 0.0})["results"]
        four = compute(PARAMS, {**INPUTS, "risk_free_rate": 0.04})["results"]
        assert zero["assumptions"]["risk_free_rate"] == 0.0
        assert zero["assumptions"]["risk_free_rate_basis"] == "input"
        assert zero["fmv_per_share"] != four["fmv_per_share"]
        # And it is the rate the option models actually saw, not just a label:
        # the whole upside is a call priced at r, so a zero rate is worth less.
        assert zero["allocation"]["upside_after_preference"] == pytest.approx(
            _bs_call(WEIGHTED_EQUITY, 10_000_000.0, T, 0.0, SIGMA), rel=1e-12
        )
        assert zero["fmv_per_share"] < four["fmv_per_share"]

    def test_the_horizon_default_is_worth_arguing_about(self):
        """Why the label is not cosmetic: across the band a 409A would accept,
        the substituted horizon is a materially different conclusion."""
        span = {}
        for years in (1.0, 3.0, 7.0):
            res = compute(PARAMS, {**INPUTS, "time_to_exit_years": years})["results"]
            span[years] = res["fmv_per_share"]
        assert span[7.0] > span[3.0] > span[1.0]
        assert span[7.0] / span[1.0] > 1.05


# ── Reproducibility ─────────────────────────────────────────────────────────


class TestReproducibility:
    """Same inputs, same document — on every allocation path, every time."""

    CAP_TABLE = [
        {"name": "Series A", "kind": "preferred", "shares": 4_000_000, "preference": 10_000_000},
        {"name": "Common", "kind": "common", "shares": 8_000_000},
        {"name": "Options", "kind": "option", "shares": 2_000_000, "strike": 0.50},
    ]
    SCENARIOS = [
        {"name": "IPO", "type": "ipo", "probability": 0.3, "equity_value": 80_000_000.0,
         "time_to_exit_years": 4.0, "discount_rate": 0.25},
        {"name": "Sale", "type": "acquisition", "probability": 0.5, "equity_value": 30_000_000.0,
         "time_to_exit_years": 3.0, "discount_rate": 0.22},
        {"name": "Wind-down", "type": "dissolution", "probability": 0.2, "equity_value": 5_000_000.0,
         "time_to_exit_years": 2.0, "discount_rate": 0.20},
    ]

    def _payload(self, method):
        params = {**PARAMS, "allocation_method": method}
        inputs = copy.deepcopy(INPUTS)
        if method in ("pwerm", "hybrid", "monte_carlo"):
            inputs["share_classes"] = copy.deepcopy(self.CAP_TABLE)
            inputs["pwerm"] = {"scenarios": copy.deepcopy(self.SCENARIOS)}
        return params, inputs

    @pytest.mark.parametrize("method", ["opm", "cvm", "pwerm", "hybrid", "monte_carlo"])
    def test_five_runs_produce_one_document(self, method):
        """Not a tautology for two of these. Monte Carlo draws from an RNG and
        the hybrid blends a simulated leg, so a seed left to the clock — or a
        dict iteration order leaking into an accumulation — would show up here
        and nowhere else. A 409A that cannot be re-run to the same number is not
        a valuation anybody can defend."""
        params, inputs = self._payload(method)
        first = compute(params, copy.deepcopy(inputs))["results"]
        for _ in range(4):
            assert compute(params, copy.deepcopy(inputs))["results"] == first

    def test_the_simulation_reports_the_seed_it_drew_on(self):
        params, inputs = self._payload("monte_carlo")
        res = compute(params, inputs)["results"]
        assert isinstance(res["allocation"]["seed"], int)

    def test_a_different_seed_is_a_different_run_and_says_so(self):
        params, inputs = self._payload("monte_carlo")
        inputs["monte_carlo"] = {"seed": 12345}
        res = compute(params, inputs)["results"]
        assert res["allocation"]["seed"] == 12345

    def test_asking_for_a_trace_cannot_move_the_conclusion(self):
        """`Trace.record` deep-copies what it is handed and returns nothing to
        the arithmetic, so the traced and untraced documents are the same."""
        for method in ("opm", "cvm", "pwerm", "hybrid", "monte_carlo"):
            params, inputs = self._payload(method)
            plain = compute(params, copy.deepcopy(inputs))["results"]
            with_trace = compute(params, copy.deepcopy(inputs), trace=True)["results"]
            assert plain == with_trace, method


# ── Sensitivity ─────────────────────────────────────────────────────────────


class TestSensitivityFidelity:
    """A sensitivity table is a ratio of two conclusions, and a ratio inherits
    the quantum of whatever it divides."""

    # A heavy preference stack over a large common base: the ordinary early-stage
    # shape, and one whose common share is worth well under a cent.
    CHEAP_PARAMS = {
        "allocation_method": "opm",
        "weight_asset": 0.0, "weight_opm": 1.0, "weight_income": 0.0, "weight_market": 0.0,
        "dloc": 0.05, "dlom_method": "qualitative", "dlom": 0.35,
        "exit_timeline": "2029-06-30",
    }
    CHEAP_INPUTS = {
        "valuation_date": "2026-06-30",
        "shares_outstanding_common": 90_000_000,
        "options_outstanding": 10_000_000,
        "shares_outstanding_preferred": 50_000_000,
        "liquidation_preference": 250_000_000,
        "volatility": 0.55,
        "risk_free_rate": 0.04,
        "last_round_post_money": 40_000_000.0,
    }

    def _exact(self, volatility):
        """The conclusion at full precision, rebuilt from the document.

        Deliberately not `fmv_per_share_unrounded`: that field is half the fix
        being tested, and an oracle that reads it would agree with the engine by
        construction. Common equity is cent-precise over a share count in the
        millions, so this reconstruction is accurate to ~1e-8 — two orders
        finer than the tolerance below, and four finer than the quantum the bug
        was made of.
        """
        res = compute(self.CHEAP_PARAMS, {**self.CHEAP_INPUTS, "volatility": volatility})["results"]
        marketable = res["common_equity_value"] / res["fully_diluted_common"]
        discounts = res["discounts"]
        return marketable * (1 - discounts["dloc"]) * (1 - discounts["dlom"])

    def test_the_base_case_really_is_a_sub_cent_share(self):
        res = compute(self.CHEAP_PARAMS, self.CHEAP_INPUTS)["results"]
        assert res["fmv_per_share"] < 0.01

    def test_every_delta_is_the_ratio_of_the_two_unrounded_conclusions(self):
        """Derived from `results.fmv_per_share`, these were the ratio of two
        figures quantised at 1e-4 — a 2% step on a half-cent share, published to
        six decimals. The swept point at +85.65% was reported as +83.67%.
        """
        out = sensitivity(
            self.CHEAP_PARAMS, self.CHEAP_INPUTS, parameters=["volatility"], span=0.20, steps=7
        )
        base = self._exact(self.CHEAP_INPUTS["volatility"])
        points = out["one_way"][0]["points"]
        assert len(points) == 7
        for point in points:
            expected = self._exact(point["value"]) / base - 1
            assert point["delta_from_base"] == pytest.approx(expected, abs=1e-6)

    def test_the_cell_still_shows_the_conclusion_at_its_reported_precision(self):
        """The delta is computed at full precision; the FMV in the cell is the
        conclusion, and stays at the four decimals every other surface prints."""
        out = sensitivity(
            self.CHEAP_PARAMS, self.CHEAP_INPUTS, parameters=["volatility"], span=0.20, steps=3
        )
        for point in out["one_way"][0]["points"]:
            assert round(point["fmv_per_share"], 4) == point["fmv_per_share"]
        assert round(out["base"]["fmv_per_share"], 4) == out["base"]["fmv_per_share"]

    def test_the_base_point_of_the_sweep_is_exactly_zero(self):
        """It falls out of dividing a figure by itself — but only if the
        numerator and the denominator are the *same* figure. Mixing a rounded
        numerator with an unrounded base put a non-zero delta on the base case.
        """
        out = sensitivity(
            self.CHEAP_PARAMS, self.CHEAP_INPUTS, parameters=["volatility"], span=0.20, steps=5
        )
        points = out["one_way"][0]["points"]
        middle = points[len(points) // 2]
        assert middle["value"] == pytest.approx(self.CHEAP_INPUTS["volatility"], abs=1e-9)
        assert middle["delta_from_base"] == 0.0

    # ── The same sweep, over a cap table ────────────────────────────────────
    #
    # `CHEAP_INPUTS` above has no `share_classes`, so every test in this class
    # so far runs the aggregate OPM branch — where `common_per_share` is an
    # unrounded common equity divided by an unrounded share count, and the only
    # quantum in the chain was the 1e-4 on `results.fmv_per_share` that
    # `fmv_per_share_unrounded` removed.
    #
    # The breakpoint branch had a second one. `waterfall.allocate_waterfall`
    # rounded its `common_per_share` to six places, `compute._opm_allocate`
    # read that rounded figure, and the product it returned as
    # `fmv_per_share_unrounded` therefore carried a 5e-7 per-share quantum —
    # 6e-5 of a sub-cent conclusion, on a ratio published to 1e-6. Every
    # engagement with a real cap table takes this branch.
    CHEAP_CAP_TABLE = [
        {"name": "Common", "kind": "common", "shares": 90_000_000},
        {"name": "Options", "kind": "option", "shares": 10_000_000, "strike": 0.05},
        {
            "name": "Series A",
            "kind": "preferred",
            "shares": 50_000_000,
            "preference": 250_000_000,
            "seniority": 1,
            "participating": False,
        },
    ]

    def _cap_table_inputs(self, **over):
        return {**self.CHEAP_INPUTS, "share_classes": copy.deepcopy(self.CHEAP_CAP_TABLE), **over}

    def _exact_over_the_cap_table(self, volatility):
        """The conclusion at full precision, rebuilt from the document.

        Same reconstruction as `_exact`, and accurate for the same reason:
        `common_equity_value` is cent-precise over 90,000,000 shares, so the
        rebuilt per-share is good to ~5e-11 — four orders finer than the
        quantum this test is about.
        """
        res = compute(self.CHEAP_PARAMS, self._cap_table_inputs(volatility=volatility))["results"]
        marketable = res["common_equity_value"] / res["fully_diluted_common"]
        discounts = res["discounts"]
        return marketable * (1 - discounts["dloc"]) * (1 - discounts["dlom"])

    def test_the_cap_table_case_really_is_the_waterfall_branch_and_sub_cent(self):
        out = compute(self.CHEAP_PARAMS, self._cap_table_inputs())
        assert out["results"]["allocation"]["method"] == "opm_waterfall"
        assert out["results"]["fmv_per_share"] < 0.01

    def test_every_delta_over_a_cap_table_is_the_ratio_of_two_exact_conclusions(self):
        """The swept point at −75.1277% was published as −75.1244%.

        Not the 2% the rounded conclusion cost — two orders less — but wrong in
        the fourth decimal of a figure reported to six, and wrong for the same
        reason: an intermediate rounding that stopped being presentational the
        moment `sensitivity` started dividing what it fed.
        """
        inputs = self._cap_table_inputs()
        out = sensitivity(
            self.CHEAP_PARAMS, inputs, parameters=["volatility"], span=0.20, steps=7
        )
        base = self._exact_over_the_cap_table(inputs["volatility"])
        points = out["one_way"][0]["points"]
        assert len(points) == 7
        for point in points:
            expected = self._exact_over_the_cap_table(point["value"]) / base - 1
            assert point["delta_from_base"] == pytest.approx(expected, abs=1e-6)

    def test_the_conclusion_itself_is_unchanged_by_any_of_this(self):
        """The FMV is reported to four places and the quantum removed was 5e-7,
        so the concluded figure must not move. A fix to a ratio that moves an
        opinion is not a fix to a ratio."""
        res = compute(self.CHEAP_PARAMS, self._cap_table_inputs())["results"]
        assert res["fmv_per_share"] == round(res["fmv_per_share"], 4)
        assert res["fmv_per_share"] == pytest.approx(
            self._exact_over_the_cap_table(self.CHEAP_INPUTS["volatility"]), abs=5e-5
        )

    def test_a_two_way_table_divides_the_same_way(self):
        out = sensitivity(
            self.CHEAP_PARAMS,
            self.CHEAP_INPUTS,
            parameters=["volatility"],
            two_way=[["volatility", "time_to_exit"]],
            span=0.10,
            steps=3,
        )
        table = out["two_way"][0]
        centre = table["rows"][1][1]
        assert centre["delta_from_base"] == pytest.approx(0.0, abs=1e-9)


# ── The policy, against the source it describes ─────────────────────────────

ENGINE_DIR = pathlib.Path(__file__).resolve().parents[1] / "app" / "engine"
POLICY_DOC = (
    pathlib.Path(__file__).resolve().parents[4] / "docs" / "engine-rounding-policy.md"
)

#: What each kind of figure is rounded to, from `docs/engine-rounding-policy.md`.
#: The census below reads the *source* for these keys and holds it to the table,
#: which is what stops a sixth allocation path from quietly reporting a
#: per-share at the conclusion's own precision — where the quantum is no longer
#: two orders finer than the figure it feeds, and the intermediate rounding
#: starts reaching the conclusion.
DECLARED_PRECISION = {
    # `common_per_share` is deliberately absent: it is the one per-share figure
    # the conclusion is struck from, so it is not rounded at all. The census
    # below enforces that directly rather than through a declared precision.
    "per_share": 6,
    "fmv_per_share": 4,
    "recommended_volatility": 4,
}

#: Two modules name a ``common_per_share`` that is only ever read, and both do
#: it in a *nested* dict rather than in the allocation response itself:
#: ``hybrid.blend_hybrid`` copies one per leg (the blend the FMV is struck from
#: is its own top-level figure, a weighted mean of the two unrounded legs), and
#: ``monte_carlo`` reports one per simulated scenario. The census below is
#: therefore scoped to the dict a function *returns*, which is the allocation
#: response and the only one the conclusion reads.

#: Where a module means something else by one of those names.
#:
#: `pwerm` calls its per-class figure `fmv_per_share` — the same key `compute`
#: uses for the conclusion, at a different precision, meaning a different thing.
#: It is a *class's* probability-weighted present value per share, one row of
#: `allocation.classes`, and it is an intermediate: the conclusion is struck
#: from `common_per_share` and then discounted. A consumer grepping the name
#: finds both, so the collision is recorded here and in the policy document
#: rather than left for whoever hits it.
_PRECISION_OVERRIDES = {
    ("pwerm.py", "fmv_per_share"): 6,
}


def _rounded_returned_keys(path: pathlib.Path):
    """``"key": round(expr, n)`` in a dict a function *returns*, as (key, n).

    Scoped to the returned dict itself — not a dict nested inside it — because
    that dict is the allocation response, and a figure one level down is a row
    of a schedule that nothing computes on.
    """
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if not isinstance(node, ast.Return) or not isinstance(node.value, ast.Dict):
            continue
        for key, value in zip(node.value.keys, node.value.values):
            if not isinstance(key, ast.Constant) or not isinstance(key.value, str):
                continue
            if (
                isinstance(value, ast.Call)
                and getattr(value.func, "id", None) == "round"
                and len(value.args) == 2
                and isinstance(value.args[1], ast.Constant)
            ):
                yield key.value, value.args[1].value


def _dict_keys(path: pathlib.Path):
    """Every literal string key of every dict literal in a module."""
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict):
            continue
        for key in node.keys:
            if isinstance(key, ast.Constant) and isinstance(key.value, str):
                yield key.value


def _rounded_dict_keys(path: pathlib.Path):
    """Every ``"key": round(expr, n)`` in a module, as (key, n)."""
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict):
            continue
        for key, value in zip(node.keys, node.values):
            if not isinstance(key, ast.Constant) or not isinstance(key.value, str):
                continue
            call = value
            # `min(max(round(x, n), lo), hi)` — the clamped discounts.
            while isinstance(call, ast.Call) and getattr(call.func, "id", None) in ("min", "max"):
                call = call.args[0]
            # `round(x, n) if cond else fallback` — the guarded per-share sites.
            if isinstance(call, ast.IfExp):
                call = call.body
            if (
                isinstance(call, ast.Call)
                and getattr(call.func, "id", None) == "round"
                and len(call.args) == 2
                and isinstance(call.args[1], ast.Constant)
            ):
                yield key.value, call.args[1].value


class TestRoundingPolicyCensus:
    """`docs/engine-rounding-policy.md` holds the engine to a table; this holds
    the table to the engine."""

    def test_the_policy_document_is_where_the_tests_say_it_is(self):
        assert POLICY_DOC.exists(), f"{POLICY_DOC} is referenced by this file and by compute.py"

    @pytest.mark.parametrize("module", sorted(p.name for p in ENGINE_DIR.glob("*.py")))
    def test_every_rounded_figure_matches_its_declared_precision(self, module):
        """A per-share figure rounded to four decimals somewhere in the middle of
        the chain is the whole failure mode this document exists to name: at four
        places the quantum is the conclusion's own, so it no longer disappears
        into it."""
        for key, places in _rounded_dict_keys(ENGINE_DIR / module):
            declared = _PRECISION_OVERRIDES.get((module, key), DECLARED_PRECISION.get(key))
            if declared is None:
                continue
            assert places == declared, (
                f"{module} rounds {key!r} to {places} places; "
                f"docs/engine-rounding-policy.md declares {declared}. "
                "Change one or the other, deliberately."
            )

    def test_no_allocation_path_rounds_the_per_share_the_conclusion_uses(self):
        """The inverse of the census this replaces, and for a reason.

        The old form collected every module that *rounded* a
        `common_per_share` and required the policy document to name each one.
        It was satisfied the moment the rounding was removed — the surviving
        match was `hybrid`'s display copy, `hybrid` is named in the document,
        and a guard whose founding case no longer exists passes by having
        nothing left to ask. The property actually worth holding is the one the
        removal established: no allocation path rounds the figure the FMV is
        struck from, so a sixth path cannot quietly reintroduce the quantum
        that `fmv_per_share_unrounded` exists to keep out of a ratio.
        """
        offenders = {
            module.name: places
            for module in ENGINE_DIR.glob("*.py")
            for key, places in _rounded_returned_keys(module)
            if key == "common_per_share"
        }
        assert not offenders, (
            f"{sorted(offenders)} round a common_per_share the FMV is computed from. "
            "That figure feeds `fmv_per_share_unrounded`, which "
            "docs/engine-rounding-policy.md tells a consumer computing a ratio to "
            "divide — a ratio inherits the quantum scaled by 1/FMV, which is 6e-5 on "
            "a sub-cent common share. Leave it exact; round the display copies."
        )

    def test_the_document_names_every_module_that_allocates_to_common(self):
        """The load-bearing table still has to list every allocation path.

        Scanned off the modules that *emit* a `common_per_share` rather than
        the ones that round it, so removing a rounding cannot empty the scan.
        """
        allocators = {
            module.name
            for module in ENGINE_DIR.glob("*.py")
            if "common_per_share" in set(_dict_keys(module))
        }
        assert len(allocators) >= 5, (
            f"only {sorted(allocators)} emit a common_per_share — the engine has five "
            "allocation paths, so the scan is reading something wrong"
        )
        text = POLICY_DOC.read_text()
        missing = {m for m in allocators if m.removesuffix(".py") not in text}
        assert not missing, (
            f"{sorted(missing)} produce a common_per_share the FMV is computed from, "
            "and are absent from the load-bearing table in "
            "docs/engine-rounding-policy.md"
        )
