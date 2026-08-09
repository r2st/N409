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
