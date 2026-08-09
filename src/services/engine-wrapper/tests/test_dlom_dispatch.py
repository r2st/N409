"""The new DLOM methods through `compute` and `validate_payload`.

`test_dlom_models.py` tests the models in isolation. What is tested here is
the wiring: that selecting a method actually reaches the result, that the
model's working travels with it, and that the pre-flight agrees with the
engine about which payloads are legal. The wiring is where this feature could
plausibly be half-done — `_resolve_discounts` grew a fourth return value that
four separate allocation paths each have to thread through.
"""

import pytest

from app.engine.compute import compute
from app.engine.dlom import ghaidarov_dlom, longstaff_dlom, restricted_stock_dlom
from app.engine.errors import EngineInputError
from app.engine.validate import ERROR, WARNING, validate_payload

BASE_PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 1.0,
    "weight_income": 0.0,
    "weight_market": 0.0,
    "dloc": 0.1,
    "exit_timeline": "2029-06-30",
    "allocation_method": "opm",
}

BASE_INPUTS = {
    "valuation_date": "2026-06-30",
    "shares_outstanding_common": 7_000_000,
    "options_outstanding": 1_000_000,
    "shares_outstanding_preferred": 2_000_000,
    "liquidation_preference": 5_000_000,
    "volatility": 0.6,
    "risk_free_rate": 0.042,
    "last_round_post_money": 20_000_000,
}


def run(**param_overrides):
    return compute({**BASE_PARAMS, **param_overrides}, dict(BASE_INPUTS))["results"]


def codes(issues, severity=None):
    return {i.code for i in issues if severity is None or i.severity == severity}


class TestMethodReachesTheResult:
    @pytest.mark.parametrize(
        "method", ["chaffee", "finnerty", "ghaidarov", "longstaff", "restricted_stock"]
    )
    def test_each_method_is_recorded_on_the_result(self, method):
        d = run(dlom_method=method)["discounts"]
        assert d["dlom_method"] == method
        assert 0 <= d["dlom"] < 1

    def test_ghaidarov_matches_the_model(self):
        res = run(dlom_method="ghaidarov")
        t = res["assumptions"]["time_to_exit_years"]
        assert res["discounts"]["dlom"] == pytest.approx(ghaidarov_dlom(0.6, t), abs=1e-4)

    def test_longstaff_matches_the_model(self):
        res = run(dlom_method="longstaff")
        t = res["assumptions"]["time_to_exit_years"]
        assert res["discounts"]["dlom"] == pytest.approx(longstaff_dlom(0.6, t), abs=1e-4)

    def test_the_methods_actually_disagree(self):
        """If two methods returned the same discount the wiring could be
        selecting the wrong one and nothing above would notice."""
        got = {m: run(dlom_method=m)["discounts"]["dlom"] for m in
               ("chaffee", "finnerty", "ghaidarov", "longstaff", "restricted_stock")}
        assert len(set(got.values())) == len(got)

    def test_a_larger_dlom_lowers_the_share_price(self):
        finnerty = run(dlom_method="finnerty")
        longstaff = run(dlom_method="longstaff")
        assert longstaff["discounts"]["dlom"] > finnerty["discounts"]["dlom"]
        assert longstaff["fmv_per_share"] < finnerty["fmv_per_share"]


class TestModelWorkingTravels:
    def test_longstaff_discloses_it_is_an_upper_bound(self):
        detail = run(dlom_method="longstaff")["discounts"]["dlom_detail"]
        assert detail["is_upper_bound"] is True
        assert detail["bound_multiple"] > 0

    def test_restricted_stock_carries_its_study_set(self):
        """A study-based number without its set is not reviewable — set
        selection is the whole objection to the method."""
        detail = run(dlom_method="restricted_stock")["discounts"]["dlom_detail"]
        assert detail["study_count"] >= 1
        assert [r["study"] for r in detail["studies"]]
        assert "straddles_rule_144_amendment" in detail

    @pytest.mark.parametrize("method", ["chaffee", "finnerty", "ghaidarov"])
    def test_option_models_carry_the_inputs_they_were_struck_on(self, method):
        """A bare percentage is not a reviewable marketability discount.

        The model is arithmetic nobody disputes; the volatility and the holding
        period *are* the argument, so the report has to be able to print them
        beside the answer. Previously only longstaff and restricted_stock
        reported any working and the three option models reported none, which
        left the DLOM exhibit unable to show a derivation for the two methods
        (Chaffee, Finnerty) that valuations actually conclude on.
        """
        detail = run(dlom_method=method)["discounts"]["dlom_detail"]
        assert detail["method"] == method
        assert detail["volatility"] == pytest.approx(0.6)
        assert detail["time_to_liquidity_years"] > 0
        assert detail["formula"]

    def test_only_chaffee_reports_a_risk_free_rate(self):
        """Listing the rate against a model whose closed form does not use it
        would imply a dependence that is not there."""
        assert "risk_free_rate" in run(dlom_method="chaffee")["discounts"]["dlom_detail"]
        for method in ("finnerty", "ghaidarov"):
            assert "risk_free_rate" not in run(dlom_method=method)["discounts"]["dlom_detail"]

    def test_the_detail_discount_matches_the_concluded_one(self):
        """The working and the answer come from one call, so they cannot differ
        — asserted because a re-derivation in the report is exactly what this
        block exists to make unnecessary."""
        for method in ("chaffee", "finnerty", "ghaidarov"):
            res = run(dlom_method=method)["discounts"]
            assert res["dlom_detail"]["dlom"] == pytest.approx(res["dlom"], abs=5e-5)

    def test_qualitative_says_it_is_a_judgement(self):
        detail = run(dlom_method="qualitative", dlom_qualitative=0.2)["discounts"]["dlom_detail"]
        assert detail["method"] == "qualitative"
        assert detail["dlom"] == pytest.approx(0.2)
        assert "judgement" in detail["basis"]

    @pytest.mark.parametrize(
        "allocation_method,extra_inputs",
        [
            ("opm", {}),
            ("cvm", {}),
            (
                "pwerm",
                {
                    "pwerm": {
                        "scenarios": [
                            {"type": "ipo", "probability": 0.4, "equity_value": 50_000_000,
                             "time_to_exit_years": 3},
                            {"type": "acquisition", "probability": 0.6,
                             "equity_value": 20_000_000, "time_to_exit_years": 2},
                        ]
                    },
                    "share_classes": [
                        {
                            "name": "Series A",
                            "kind": "preferred",
                            "shares": 2_000_000,
                            "preference": 5_000_000,
                            "seniority": 1,
                        },
                        {"name": "Common", "kind": "common", "shares": 7_000_000},
                    ],
                },
            ),
        ],
    )
    def test_every_allocation_path_reports_the_detail(self, allocation_method, extra_inputs):
        """`_resolve_discounts` gained a fourth return that each path threads
        through separately. A path that dropped it would lose the study set
        from the report exhibit while still producing a plausible number."""
        out = compute(
            {**BASE_PARAMS, "allocation_method": allocation_method,
             "dlom_method": "restricted_stock"},
            {**BASE_INPUTS, **extra_inputs},
        )
        detail = out["results"]["discounts"]["dlom_detail"]
        assert detail["method"] == "restricted_stock"
        assert detail["study_count"] >= 1


class TestStudySelectionThroughParams:
    def test_selected_studies_are_honoured(self):
        res = run(dlom_method="restricted_stock", dlom_studies=["Gelman", "Johnson"])
        assert res["discounts"]["dlom"] == pytest.approx(
            restricted_stock_dlom(selected=["Gelman", "Johnson"])["dlom"]
        )

    def test_statistic_is_honoured(self):
        names = ["Gelman", "Johnson", "Silber"]
        med = run(dlom_method="restricted_stock", dlom_studies=names, dlom_statistic="median")
        avg = run(dlom_method="restricted_stock", dlom_studies=names, dlom_statistic="mean")
        assert med["discounts"]["dlom"] != avg["discounts"]["dlom"]

    def test_a_firm_table_replaces_the_builtins(self):
        res = run(
            dlom_method="restricted_stock",
            dlom_study_table=[
                {"study": "Firm 2022", "discount": 0.16, "period_start": 2018},
                {"study": "Firm 2024", "discount": 0.20, "period_start": 2021},
            ],
        )
        assert res["discounts"]["dlom"] == pytest.approx(0.18)

    def test_unknown_study_is_an_engine_input_error(self):
        with pytest.raises(EngineInputError, match="unknown restricted-stock studies"):
            run(dlom_method="restricted_stock", dlom_studies=["No Such Study"])


class TestVolatilityRequirement:
    @pytest.mark.parametrize("method", ["chaffee", "finnerty", "ghaidarov", "longstaff"])
    def test_model_methods_require_a_volatility(self, method):
        params = {**BASE_PARAMS, "dlom_method": method, "weight_opm": 0.0, "weight_income": 1.0,
                  "allocation_method": "cvm"}
        inputs = {k: v for k, v in BASE_INPUTS.items() if k != "volatility"}
        inputs["income"] = {
            "free_cash_flows": [1_000_000, 1_500_000],
            "discount_rate": 0.25,
            "terminal_growth": 0.03,
        }
        inputs.pop("liquidation_preference", None)
        with pytest.raises(EngineInputError, match="volatility"):
            compute(params, inputs)

    def test_restricted_stock_does_not(self):
        """It is a lookup, not a model. Requiring a volatility for it would
        reject a valuation that has no need of one."""
        params = {**BASE_PARAMS, "dlom_method": "restricted_stock", "weight_opm": 0.0,
                  "weight_income": 1.0, "allocation_method": "cvm"}
        inputs = {k: v for k, v in BASE_INPUTS.items() if k != "volatility"}
        inputs["income"] = {
            "free_cash_flows": [1_000_000, 1_500_000],
            "discount_rate": 0.25,
            "terminal_growth": 0.03,
        }
        inputs.pop("liquidation_preference", None)
        assert compute(params, inputs)["results"]["discounts"]["dlom"] > 0


class TestPreFlightAgreesWithTheEngine:
    def test_a_valid_restricted_stock_payload_is_clean(self):
        issues = validate_payload(
            {**BASE_PARAMS, "dlom_method": "restricted_stock", "dlom_studies": ["Gelman"]},
            dict(BASE_INPUTS),
        )
        assert codes(issues, ERROR) == set()

    def test_unknown_study_is_caught_before_dispatch(self):
        """The engine raises a 422 on this; catching it in the pre-flight is
        what lets the params editor refuse the set at save time."""
        issues = validate_payload(
            {**BASE_PARAMS, "dlom_method": "restricted_stock", "dlom_studies": ["No Such Study"]},
            dict(BASE_INPUTS),
        )
        assert "unknown_study" in codes(issues, ERROR)

    def test_straddling_set_warns_rather_than_blocks(self):
        issues = validate_payload(
            {
                **BASE_PARAMS,
                "dlom_method": "restricted_stock",
                "dlom_studies": [
                    "Columbia Financial Advisors (pre-amendment)",
                    "Columbia Financial Advisors (post-amendment)",
                ],
            },
            dict(BASE_INPUTS),
        )
        assert "mixed_regime" in codes(issues, WARNING)
        assert codes(issues, ERROR) == set()

    def test_bad_statistic_is_an_error(self):
        issues = validate_payload(
            {**BASE_PARAMS, "dlom_method": "restricted_stock", "dlom_statistic": "mode"},
            dict(BASE_INPUTS),
        )
        assert "out_of_range" in codes(issues, ERROR)

    def test_empty_selection_is_an_error(self):
        issues = validate_payload(
            {**BASE_PARAMS, "dlom_method": "restricted_stock", "dlom_studies": []},
            dict(BASE_INPUTS),
        )
        assert "invalid_shape" in codes(issues, ERROR)

    def test_selection_is_checked_against_a_supplied_table(self):
        """A firm table replaces the built-ins, so 'Gelman' is unknown once
        one is supplied — the pre-flight has to check against theirs."""
        issues = validate_payload(
            {
                **BASE_PARAMS,
                "dlom_method": "restricted_stock",
                "dlom_study_table": [{"study": "Firm 2024", "discount": 0.2}],
                "dlom_studies": ["Gelman"],
            },
            dict(BASE_INPUTS),
        )
        assert "unknown_study" in codes(issues, ERROR)

    @pytest.mark.parametrize("method", ["ghaidarov", "longstaff"])
    def test_new_model_methods_require_volatility_in_preflight(self, method):
        inputs = {k: v for k, v in BASE_INPUTS.items() if k != "volatility"}
        issues = validate_payload({**BASE_PARAMS, "dlom_method": method}, inputs)
        assert any("volatility" in i.field for i in issues if i.severity == ERROR)


def _no_volatility_payload():
    """A payload whose only possible use for a volatility is the DLOM.

    All the weight on the income approach and a CVM allocation, so neither the
    backsolve nor a Black-Scholes waterfall needs one. Without that, the run
    fails on the allocation before it reaches the discount and the test proves
    nothing about the DLOM guard.
    """
    params = {
        **BASE_PARAMS,
        "weight_opm": 0.0,
        "weight_income": 1.0,
        "allocation_method": "cvm",
    }
    inputs = {k: v for k, v in BASE_INPUTS.items() if k != "volatility"}
    inputs["income"] = {
        "free_cash_flows": [1_000_000, 1_500_000],
        "discount_rate": 0.25,
        "terminal_growth": 0.03,
    }
    inputs.pop("liquidation_preference", None)
    return params, inputs


class TestWeightedBlend:
    """Several methods, weighted into one discount.

    A marketability discount is the one figure in a 409A with no single
    defensible derivation: the option models price the cost of being unable to
    sell from the subject's own volatility and holding period, the studies
    report what the market paid for restricted shares, and the standard
    appraisal answer is to weight them rather than declare one correct. The
    engine could only pick one, so an appraiser wanting a 50/50 had to compute
    it by hand and enter the result as `qualitative` — recording their
    arithmetic as judgement, and leaving the report unable to say where the
    number came from.
    """

    BLEND = [
        {"method": "finnerty", "weight": 0.5},
        {"method": "restricted_stock", "weight": 0.5},
    ]

    def test_the_concluded_discount_is_the_weighted_average(self):
        res = run(dlom_methods=self.BLEND)
        d = res["discounts"]
        legs = {c["method"]: c for c in d["dlom_detail"]["components"]}
        expected = sum(c["dlom"] * c["weight"] for c in legs.values())
        assert d["dlom"] == pytest.approx(round(expected, 4), abs=1e-9)
        assert d["dlom_method"] == "weighted"

    def test_each_leg_agrees_with_a_single_method_run_of_it(self):
        """The property that makes a blend reviewable: a leg is the same
        arithmetic the single-method path would have produced, so the two
        cannot drift. Asserted against `run`, not against a second call to the
        model, because it is the *dispatch* that could disagree."""
        blended = {
            c["method"]: c["dlom"]
            for c in run(dlom_methods=self.BLEND)["discounts"]["dlom_detail"]["components"]
        }
        for method, leg in blended.items():
            alone = run(dlom_method=method)["discounts"]["dlom"]
            assert leg == pytest.approx(alone, abs=1e-4), method

    def test_each_leg_keeps_its_own_working(self):
        # A weighted average is checked by reading the legs, so a component
        # without its inputs is a number a reviewer has to take on trust.
        legs = {
            c["method"]: c for c in run(dlom_methods=self.BLEND)["discounts"]["dlom_detail"]["components"]
        }
        assert legs["finnerty"]["detail"]["volatility"] == 0.6
        assert legs["finnerty"]["detail"]["time_to_liquidity_years"] > 0
        assert legs["restricted_stock"]["detail"]["studies"]
        # And the weighted contribution, so the table adds up on the page.
        assert legs["finnerty"]["weighted"] == pytest.approx(
            legs["finnerty"]["dlom"] * 0.5, abs=1e-6
        )

    def test_a_leg_reads_its_own_inputs(self):
        """A blend is a choice about weighting, not a different set of inputs:
        a restricted_stock leg still honours the selected study set."""
        res = run(
            dlom_methods=self.BLEND,
            dlom_studies=["Gelman", "Moroney"],
            dlom_statistic="mean",
        )
        leg = next(
            c for c in res["discounts"]["dlom_detail"]["components"]
            if c["method"] == "restricted_stock"
        )
        assert leg["dlom"] == pytest.approx(restricted_stock_dlom(["Gelman", "Moroney"], statistic="mean")["dlom"], abs=1e-6)

    def test_weights_are_not_normalised(self):
        """Weights totalling 0.9 are a mistake in somebody's spreadsheet, not
        an instruction to scale up by a ninth. Rescaling them would conclude on
        a discount nobody chose — the same rule the approach weights follow."""
        with pytest.raises(EngineInputError, match="sum to 1"):
            run(dlom_methods=[
                {"method": "finnerty", "weight": 0.5},
                {"method": "restricted_stock", "weight": 0.4},
            ])

    def test_a_zero_weighted_leg_is_computed_but_contributes_nothing(self):
        """An appraiser who computed Longstaff to show it as an upper bound and
        weighted it to nothing is documenting the bound, not concluding on it —
        so the leg has to appear with its figure and add zero."""
        res = run(dlom_methods=[
            {"method": "finnerty", "weight": 1.0},
            {"method": "longstaff", "weight": 0.0},
        ])
        d = res["discounts"]
        legs = {c["method"]: c for c in d["dlom_detail"]["components"]}
        assert legs["longstaff"]["dlom"] > 0
        assert legs["longstaff"]["weighted"] == 0.0
        assert d["dlom"] == pytest.approx(run(dlom_method="finnerty")["discounts"]["dlom"], abs=1e-4)

    def test_both_forms_together_is_an_error(self):
        with pytest.raises(EngineInputError, match="not both"):
            run(dlom_method="finnerty", dlom_methods=self.BLEND)

    def test_a_blend_of_one_is_refused(self):
        with pytest.raises(EngineInputError, match="at least 2 methods"):
            run(dlom_methods=[{"method": "finnerty", "weight": 1.0}])

    def test_a_repeated_method_is_refused(self):
        # Two weights on one number; whichever the engine dropped would be the
        # one the analyst meant.
        with pytest.raises(EngineInputError, match="twice"):
            run(dlom_methods=[
                {"method": "finnerty", "weight": 0.5},
                {"method": "finnerty", "weight": 0.5},
            ])

    @pytest.mark.parametrize("bad", [
        [{"method": "nope", "weight": 1.0}, {"method": "finnerty", "weight": 0.0}],
        [{"method": "finnerty", "weight": "half"}, {"method": "longstaff", "weight": 0.5}],
        [{"method": "finnerty", "weight": 1.5}, {"method": "longstaff", "weight": -0.5}],
        [{"method": "finnerty", "weight": 0.5}, "longstaff"],
    ])
    def test_malformed_rows_are_refused(self, bad):
        with pytest.raises(EngineInputError):
            run(dlom_methods=bad)

    def test_a_model_leg_still_requires_a_volatility(self):
        """The check that a blend could have slipped past. Every guard asked
        `dlom_method in MODEL_DLOM_METHODS`, which sees nothing in a blend — and
        `finnerty_dlom` answers 0.0 for sigma <= 0 rather than raising, so the
        run would have concluded on a discount with its Finnerty leg silently
        contributing nothing."""
        params, inputs = _no_volatility_payload()
        with pytest.raises(EngineInputError, match="volatility"):
            compute({**params, "dlom_methods": self.BLEND}, inputs)

    def test_a_blend_with_no_model_leg_needs_no_volatility(self):
        params, inputs = _no_volatility_payload()
        res = compute(
            {
                **params,
                "dlom_qualitative": 0.2,
                "dlom_methods": [
                    {"method": "restricted_stock", "weight": 0.6},
                    {"method": "qualitative", "weight": 0.4},
                ],
            },
            inputs,
        )["results"]
        assert res["discounts"]["dlom"] == pytest.approx(0.13 * 0.6 + 0.2 * 0.4, abs=1e-4)


class TestBlendPreFlight:
    """The pre-flight agrees with the engine about which blends are legal.

    Every problem the engine raises on is reachable only after the calculation
    is dispatched. The weights-summing case is the one with no safe recovery:
    they are deliberately not normalised, so a blend totalling 90% concludes a
    tenth low rather than on the analyst's figures scaled up.
    """

    def preflight(self, **overrides):
        return validate_payload({**BASE_PARAMS, **overrides}, dict(BASE_INPUTS))

    def test_weights_not_summing_to_one_is_an_error(self):
        issues = self.preflight(dlom_methods=[
            {"method": "finnerty", "weight": 0.5},
            {"method": "restricted_stock", "weight": 0.4},
        ])
        assert "weights_sum" in codes(issues, ERROR)

    def test_a_valid_blend_is_clean(self):
        issues = self.preflight(dlom_methods=[
            {"method": "finnerty", "weight": 0.5},
            {"method": "restricted_stock", "weight": 0.5},
        ])
        assert codes(issues, ERROR) == set()

    def test_both_forms_together_is_an_error(self):
        issues = self.preflight(
            dlom_method="finnerty",
            dlom_methods=[
                {"method": "finnerty", "weight": 0.5},
                {"method": "restricted_stock", "weight": 0.5},
            ],
        )
        assert "conflicting" in codes(issues, ERROR)

    def test_an_unknown_method_is_named(self):
        issues = self.preflight(dlom_methods=[
            {"method": "montecarlo_dlom", "weight": 0.5},
            {"method": "finnerty", "weight": 0.5},
        ])
        assert "out_of_range" in codes(issues, ERROR)

    def test_a_zero_weighted_leg_warns_rather_than_fails(self):
        issues = self.preflight(dlom_methods=[
            {"method": "finnerty", "weight": 1.0},
            {"method": "longstaff", "weight": 0.0},
        ])
        assert codes(issues, ERROR) == set()
        assert "zero_weight" in codes(issues, WARNING)

    def test_a_study_leg_still_has_its_set_checked(self):
        issues = self.preflight(
            dlom_methods=[
                {"method": "restricted_stock", "weight": 0.5},
                {"method": "finnerty", "weight": 0.5},
            ],
            dlom_studies=["Nonesuch Partners"],
        )
        assert "unknown_study" in codes(issues, ERROR)

    def test_a_qualitative_leg_needs_its_own_figure(self):
        issues = self.preflight(dlom_methods=[
            {"method": "qualitative", "weight": 0.5},
            {"method": "finnerty", "weight": 0.5},
        ])
        assert "required" in codes(issues, ERROR)

    def test_a_model_leg_requires_volatility_in_preflight(self):
        params, inputs = _no_volatility_payload()
        issues = validate_payload(
            {**params, "dlom_methods": [
                {"method": "finnerty", "weight": 0.5},
                {"method": "restricted_stock", "weight": 0.5},
            ]},
            inputs,
        )
        assert any("volatility" in i.field for i in issues if i.severity == ERROR)
