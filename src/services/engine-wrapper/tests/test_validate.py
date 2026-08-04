"""Pre-flight validation: every problem at once, with a field path.

The contract the API and the valuation service rely on: `validate_payload`
never raises, reports *all* problems rather than the first, agrees with
`compute` on what is fatal, and separates blocking errors from review
warnings.
"""

import pytest
from fastapi.testclient import TestClient

from app.engine.compute import compute
from app.engine.errors import EngineInputError
from app.engine.validate import ERROR, WARNING, split_issues, validate_payload
from app.main import app

GOOD_PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 0.5,
    "weight_income": 0.25,
    "weight_market": 0.25,
    "dloc": 0.10,
    "dlom": 0.25,
    "exit_timeline": "2029-06-30",
    "allocation_method": "opm",
}
GOOD_INPUTS = {
    "valuation_date": "2026-06-30",
    "shares_outstanding_common": 7_000_000,
    "options_outstanding": 1_000_000,
    "shares_outstanding_preferred": 2_000_000,
    "liquidation_preference": 5_000_000,
    "volatility": 0.6,
    "risk_free_rate": 0.042,
    "last_round_post_money": 20_000_000,
    "income": {
        "free_cash_flows": [1_000_000, 1_500_000, 2_200_000],
        "discount_rate": 0.25,
        "terminal_growth": 0.03,
    },
    "market": {"metric": 4_000_000, "multiples": [5.0, 6.5, 7.1]},
}


def codes(issues, severity=None):
    return {i.code for i in issues if severity is None or i.severity == severity}


def fields(issues):
    return {i.field for i in issues}


# ── the happy path ────────────────────────────────────────────────────────────


def test_a_complete_payload_has_no_issues():
    assert validate_payload(GOOD_PARAMS, GOOD_INPUTS) == []


def test_the_validated_payload_actually_computes():
    """Pins validation to reality: clean payload in, real FMV out."""
    result = compute(GOOD_PARAMS, GOOD_INPUTS)
    assert result["results"]["fmv_per_share"] > 0


def test_validation_never_raises_on_junk():
    issues = validate_payload({"weight_asset": "banana"}, {"income": "not a dict"})
    assert any(i.severity == ERROR for i in issues)


# ── collecting every problem, not just the first ──────────────────────────────


def test_reports_every_missing_input_in_one_pass():
    params = {**GOOD_PARAMS, "weight_asset": 0.25, "weight_opm": 0.25}
    inputs = {k: v for k, v in GOOD_INPUTS.items() if k not in ("income", "market")}
    del inputs["shares_outstanding_common"]

    errors, _ = split_issues(validate_payload(params, inputs))

    # asset, income (x2), market (x2) and the share count — compute would have
    # raised on the first of these and hidden the rest.
    assert {
        "inputs.asset.total_assets",
        "inputs.asset.total_liabilities",
        "inputs.income.free_cash_flows",
        "inputs.income.discount_rate",
        "inputs.market.multiples",
        "inputs.market.metric",
        "inputs.shares_outstanding_common",
    } <= fields(errors)


def test_only_weighted_approaches_are_checked():
    """A zero-weighted approach's missing inputs are not errors — compute skips it."""
    params = {**GOOD_PARAMS, "weight_opm": 1.0, "weight_income": 0.0, "weight_market": 0.0}
    inputs = {k: v for k, v in GOOD_INPUTS.items() if k not in ("income", "market")}
    assert validate_payload(params, inputs) == []


# ── weights ───────────────────────────────────────────────────────────────────


def test_unset_weights_are_an_error():
    errors, _ = split_issues(validate_payload({}, GOOD_INPUTS))
    assert "weights_unset" in codes(errors)


def test_weights_must_sum_to_one():
    params = {**GOOD_PARAMS, "weight_market": 0.5}
    errors, _ = split_issues(validate_payload(params, GOOD_INPUTS))
    assert "weights_sum" in codes(errors)
    with pytest.raises(EngineInputError):
        compute(params, GOOD_INPUTS)


def test_a_weight_outside_zero_to_one_is_an_error():
    params = {**GOOD_PARAMS, "weight_opm": 1.5, "weight_income": -0.5}
    errors, _ = split_issues(validate_payload(params, GOOD_INPUTS))
    assert "out_of_range" in codes(errors)
    assert "params.weight_opm" in fields(errors)


# ── per-approach input checks ─────────────────────────────────────────────────


def test_discount_rate_below_terminal_growth_is_fatal():
    inputs = {
        **GOOD_INPUTS,
        "income": {"free_cash_flows": [1.0], "discount_rate": 0.02, "terminal_growth": 0.03},
    }
    errors, _ = split_issues(validate_payload(GOOD_PARAMS, inputs))
    assert "rate_below_growth" in codes(errors)
    with pytest.raises(EngineInputError):
        compute(GOOD_PARAMS, inputs)


def test_cost_to_replicate_method_asks_for_its_own_field():
    params = {**GOOD_PARAMS, "weight_asset": 0.5, "weight_opm": 0.0, "asset_method": "cost_to_replicate"}
    errors, _ = split_issues(validate_payload(params, GOOD_INPUTS))
    assert "inputs.asset.cost_to_replicate" in fields(errors)


def test_opm_accepts_a_backsolve_anchor_instead_of_post_money():
    inputs = {k: v for k, v in GOOD_INPUTS.items() if k != "last_round_post_money"}
    errors, _ = split_issues(validate_payload(GOOD_PARAMS, inputs))
    assert "inputs.last_round_post_money" in fields(errors)

    with_pps = {**inputs, "last_round_price_per_share": 2.5}
    errors, _ = split_issues(validate_payload(GOOD_PARAMS, with_pps))
    assert "inputs.last_round_post_money" not in fields(errors)


def test_volatility_is_required_when_the_allocation_needs_it():
    inputs = {k: v for k, v in GOOD_INPUTS.items() if k != "volatility"}
    errors, _ = split_issues(validate_payload(GOOD_PARAMS, inputs))
    assert "inputs.volatility" in fields(errors)


def test_pwerm_does_not_need_volatility_for_its_deterministic_waterfall():
    """Only the OPM-style allocations price a call; PWERM walks the waterfall."""
    params = {**GOOD_PARAMS, "allocation_method": "pwerm", "dlom_method": None}
    inputs = {
        k: v for k, v in GOOD_INPUTS.items() if k not in ("volatility", "liquidation_preference")
    }
    inputs["share_classes"] = [{"name": "Common", "kind": "common", "shares": 7_000_000}]
    inputs["pwerm"] = {
        "scenarios": [{"probability": 1.0, "equity_value": 40_000_000, "time_to_exit_years": 3}],
        "discount_rate": 0.2,
    }
    errors, _ = split_issues(validate_payload(params, inputs))
    assert "inputs.volatility" not in fields(errors)


def test_autopilot_inputs_are_not_reported_as_missing():
    """auto_* flags mean the estimators fill these in during compute."""
    inputs = {k: v for k, v in GOOD_INPUTS.items() if k != "volatility"}
    inputs["income"] = {"free_cash_flows": [1.0, 2.0], "terminal_growth": 0.03}
    inputs["market"] = {"metric": 4_000_000}

    errors, _ = split_issues(validate_payload(GOOD_PARAMS, inputs))
    assert {
        "inputs.volatility",
        "inputs.income.discount_rate",
        "inputs.market.multiples",
    } <= fields(errors)

    errors, _ = split_issues(
        validate_payload(
            GOOD_PARAMS, inputs, auto_volatility=True, auto_wacc=True, auto_comparables=True
        )
    )
    assert errors == []


def test_volatility_is_optional_without_a_preference_stack_or_model_dlom():
    inputs = {
        k: v
        for k, v in GOOD_INPUTS.items()
        if k not in ("volatility", "liquidation_preference", "shares_outstanding_preferred")
    }
    assert validate_payload(GOOD_PARAMS, inputs) == []


# ── warnings: legal, but a reviewer should look ───────────────────────────────


def test_a_high_dlom_warns_without_blocking():
    params = {**GOOD_PARAMS, "dlom": 0.6}
    errors, warnings = split_issues(validate_payload(params, GOOD_INPUTS))
    assert errors == []
    assert "high_discount" in codes(warnings)
    # …and the payload still computes.
    assert compute(params, GOOD_INPUTS)["results"]["fmv_per_share"] > 0


def test_a_single_comparable_multiple_warns():
    inputs = {**GOOD_INPUTS, "market": {"metric": 4_000_000, "multiples": [6.0]}}
    _, warnings = split_issues(validate_payload(GOOD_PARAMS, inputs))
    assert "thin_comparables" in codes(warnings)


def test_volatility_outside_the_usual_band_warns():
    _, warnings = split_issues(validate_payload(GOOD_PARAMS, {**GOOD_INPUTS, "volatility": 3.0}))
    assert "outside_band" in codes(warnings)
    assert "inputs.volatility" in fields(warnings)


def test_preferred_without_a_liquidation_preference_warns():
    inputs = {**GOOD_INPUTS, "liquidation_preference": 0}
    _, warnings = split_issues(validate_payload(GOOD_PARAMS, inputs))
    assert "no_preference" in codes(warnings)


def test_all_negative_cash_flows_warn():
    inputs = {
        **GOOD_INPUTS,
        "income": {"free_cash_flows": [-1.0, -2.0], "discount_rate": 0.25, "terminal_growth": 0.0},
    }
    _, warnings = split_issues(validate_payload(GOOD_PARAMS, inputs))
    assert "all_negative_fcf" in codes(warnings)


def test_an_exit_date_before_the_valuation_date_warns():
    params = {**GOOD_PARAMS, "exit_timeline": "2025-01-01"}
    _, warnings = split_issues(validate_payload(params, GOOD_INPUTS))
    assert "exit_in_past" in codes(warnings)


def test_a_malformed_date_is_an_error():
    errors, _ = split_issues(validate_payload({**GOOD_PARAMS, "exit_timeline": "June 2029"}, GOOD_INPUTS))
    assert "invalid_date" in codes(errors)


# ── allocation methods ────────────────────────────────────────────────────────


def test_pwerm_requires_scenarios_and_a_cap_table():
    params = {**GOOD_PARAMS, "allocation_method": "pwerm"}
    errors, _ = split_issues(validate_payload(params, GOOD_INPUTS))
    assert {"inputs.pwerm.scenarios", "inputs.share_classes"} <= fields(errors)


def test_pwerm_probabilities_that_miss_one_warn():
    params = {**GOOD_PARAMS, "allocation_method": "pwerm"}
    inputs = {
        **GOOD_INPUTS,
        "share_classes": [{"name": "Common", "kind": "common", "shares": 7_000_000}],
        "pwerm": {
            "scenarios": [
                {"probability": 0.5, "equity_value": 50_000_000, "time_to_exit_years": 3},
                {"probability": 0.3, "equity_value": 10_000_000, "time_to_exit_years": 3},
            ],
            "discount_rate": 0.2,
        },
    }
    errors, warnings = split_issues(validate_payload(params, inputs))
    assert errors == []
    assert "probabilities_sum" in codes(warnings)


def test_hybrid_weights_must_sum_to_one():
    params = {**GOOD_PARAMS, "allocation_method": "hybrid"}
    inputs = {**GOOD_INPUTS, "hybrid": {"opm_weight": 0.7, "pwerm_weight": 0.7}}
    errors, _ = split_issues(validate_payload(params, inputs))
    assert "weights_sum" in codes(errors)


def test_an_unknown_allocation_method_is_an_error():
    errors, _ = split_issues(
        validate_payload({**GOOD_PARAMS, "allocation_method": "vibes"}, GOOD_INPUTS)
    )
    assert "unknown_method" in codes(errors)


# ── per-subsystem recalculation ───────────────────────────────────────────────


def test_a_reused_approach_is_checked_against_the_prior_run_not_its_inputs():
    inputs = {k: v for k, v in GOOD_INPUTS.items() if k != "income"}
    prior = {"income": {"equity_value": 12_000_000}}
    assert validate_payload(GOOD_PARAMS, inputs, recompute=["market"], prior_approaches=prior) == []

    errors, _ = split_issues(
        validate_payload(GOOD_PARAMS, inputs, recompute=["market"], prior_approaches={})
    )
    assert "inputs.income.free_cash_flows" in fields(errors)


def test_a_prior_entry_without_an_equity_value_is_an_error():
    errors, _ = split_issues(
        validate_payload(
            GOOD_PARAMS,
            GOOD_INPUTS,
            recompute=["market"],
            prior_approaches={"income": {"weight": 0.25}, "opm_backsolve": {"equity_value": 1}},
        )
    )
    assert "prior_approaches.income.equity_value" in fields(errors)


# ── the HTTP contract ─────────────────────────────────────────────────────────

client = TestClient(app)


def test_validate_endpoint_reports_ok_for_a_clean_payload():
    res = client.post("/engine/v1/validate", json={"params": GOOD_PARAMS, "inputs": GOOD_INPUTS})
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["errors"] == []
    assert body["engine_version"]


def test_validate_endpoint_returns_structured_errors():
    res = client.post("/engine/v1/validate", json={"params": {}, "inputs": {}})
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    first = body["errors"][0]
    assert set(first) == {"code", "field", "message", "severity", "hint"}
    assert first["severity"] == ERROR


def test_compute_rejects_a_bad_payload_with_issues_and_a_string_detail():
    res = client.post("/engine/v1/compute", json={"params": {}, "inputs": {}})
    assert res.status_code == 422
    body = res.json()
    # Legacy clients read `detail`; structured clients read `issues`.
    assert isinstance(body["detail"], str)
    assert len(body["issues"]) > 1
    assert "more input problem" in body["detail"]


def test_compute_returns_warnings_alongside_a_successful_result():
    params = {**GOOD_PARAMS, "dlom": 0.6}
    res = client.post("/engine/v1/compute", json={"params": params, "inputs": GOOD_INPUTS})
    assert res.status_code == 200
    body = res.json()
    assert body["results"]["fmv_per_share"] > 0
    assert [w["code"] for w in body["warnings"]] == ["high_discount"]
    assert body["warnings"][0]["severity"] == WARNING


def test_a_clean_compute_reports_no_warnings():
    res = client.post("/engine/v1/compute", json={"params": GOOD_PARAMS, "inputs": GOOD_INPUTS})
    assert res.status_code == 200
    assert res.json()["warnings"] == []


# ── The cap table's non-negative quantities ──────────────────────────────────
#
# `options_outstanding` was checked from the start; the preference stack was
# not. Every allocation branch in compute._opm_allocate, allocate_cvm and the
# aggregate backsolve guards the preference with `preferred_shares > 0 and
# liquidation_preference > 0`, so a single mistyped minus sign does not produce
# a wrong-looking number: it removes the whole preference stack from the model
# and falls through to as-converted, where common takes everything. The run
# returns 200 with no error and no warning, and the overstatement is invisible
# in the result.


@pytest.mark.parametrize(
    "field_name",
    ["options_outstanding", "shares_outstanding_preferred", "liquidation_preference"],
)
def test_a_negative_cap_table_quantity_is_an_error_not_a_silent_reinterpretation(field_name):
    issues = validate_payload(GOOD_PARAMS, {**GOOD_INPUTS, field_name: -1_000})
    errors, _ = split_issues(issues)
    assert "out_of_range" in codes(errors)
    assert f"inputs.{field_name}" in fields(errors)


@pytest.mark.parametrize(
    "field_name",
    ["options_outstanding", "shares_outstanding_preferred", "liquidation_preference"],
)
def test_zero_stays_legal_for_every_one_of_them(field_name):
    # Zero is a real answer — "no preferred outstanding", "no option pool".
    errors, _ = split_issues(validate_payload(GOOD_PARAMS, {**GOOD_INPUTS, field_name: 0}))
    assert errors == []


@pytest.mark.parametrize(
    "field_name",
    ["options_outstanding", "shares_outstanding_preferred", "liquidation_preference"],
)
def test_compute_refuses_the_same_negative_quantity_it_used_to_absorb(field_name):
    with pytest.raises(EngineInputError, match="cannot be negative"):
        compute(GOOD_PARAMS, {**GOOD_INPUTS, field_name: -1_000})


def test_the_sign_typo_that_used_to_inflate_the_concluded_fmv_is_now_a_422():
    baseline = compute(GOOD_PARAMS, GOOD_INPUTS)["results"]
    assert baseline["allocation"]["method"] == "opm_single_breakpoint"

    res = client.post(
        "/engine/v1/compute",
        json={"params": GOOD_PARAMS, "inputs": {**GOOD_INPUTS, "shares_outstanding_preferred": -2_000_000}},
    )
    assert res.status_code == 422
    body = res.json()
    assert "inputs.shares_outstanding_preferred" in {i["field"] for i in body["issues"]}


def test_the_cvm_path_refuses_a_negative_quantity_too():
    params = {**GOOD_PARAMS, "allocation_method": "cvm"}
    with pytest.raises(EngineInputError, match="cannot be negative"):
        compute(params, {**GOOD_INPUTS, "options_outstanding": -1_000})


# ── The explicit DCF forecast horizon ────────────────────────────────────────


def test_an_over_long_forecast_horizon_is_a_422_not_an_overflow_500():
    from app.engine.projection import MAX_FORECAST_YEARS

    inputs = {
        **GOOD_INPUTS,
        "income": {**GOOD_INPUTS["income"], "free_cash_flows": [100_000.0] * 4_000},
    }
    errors, _ = split_issues(validate_payload(GOOD_PARAMS, inputs))
    assert "out_of_range" in codes(errors)
    assert "inputs.income.free_cash_flows" in fields(errors)

    res = client.post("/engine/v1/compute", json={"params": GOOD_PARAMS, "inputs": inputs})
    assert res.status_code == 422
    assert str(MAX_FORECAST_YEARS) in res.json()["detail"]


def test_a_horizon_at_the_limit_still_computes():
    from app.engine.projection import MAX_FORECAST_YEARS

    inputs = {
        **GOOD_INPUTS,
        "income": {**GOOD_INPUTS["income"], "free_cash_flows": [100_000.0] * MAX_FORECAST_YEARS},
    }
    errors, _ = split_issues(validate_payload(GOOD_PARAMS, inputs))
    assert errors == []
    res = client.post("/engine/v1/compute", json={"params": GOOD_PARAMS, "inputs": inputs})
    assert res.status_code == 200
    assert res.json()["results"]["fmv_per_share"] > 0
