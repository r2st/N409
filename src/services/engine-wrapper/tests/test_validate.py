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
    # Zero, and not merely as a convenience. Three quarters of this payload's
    # weight sits on the backsolve and the market approach, both of which
    # already produce a marketable *minority* value — a backsolve inverts the
    # price a minority investor paid, and guideline public company multiples
    # are struck on minority trading prices. A DLOC on top of that discounts a
    # second time for a control the value never included, and the pre-flight
    # now says so (`_warn_level_of_value`). The fixture for "a payload with
    # nothing wrong with it" has to be a payload with nothing wrong with it.
    "dloc": 0.0,
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


def _pwerm_payload(scenarios):
    params = {**GOOD_PARAMS, "allocation_method": "pwerm"}
    inputs = {
        **GOOD_INPUTS,
        "share_classes": [{"name": "Common", "kind": "common", "shares": 7_000_000}],
        "pwerm": {"scenarios": scenarios, "discount_rate": 0.2},
    }
    return params, inputs


def test_pwerm_probabilities_that_miss_one_are_fatal_not_a_warning():
    """`allocate_pwerm` refuses them — it does not normalise, as this once said."""
    params, inputs = _pwerm_payload(
        [
            {"probability": 0.5, "equity_value": 50_000_000, "time_to_exit_years": 3},
            {"probability": 0.3, "equity_value": 10_000_000, "time_to_exit_years": 3},
        ]
    )
    errors, warnings = split_issues(validate_payload(params, inputs))
    assert "probabilities_sum" in codes(errors)
    assert "probabilities_sum" not in codes(warnings)
    with pytest.raises(EngineInputError):
        compute(params, inputs)


def test_probabilities_summing_to_zero_are_reported_at_all():
    """The `total > 0` guard skipped the whole check for an all-zero set."""
    params, inputs = _pwerm_payload([{"probability": 0.0, "equity_value": 50_000_000}])
    errors, _ = split_issues(validate_payload(params, inputs))
    assert "probabilities_sum" in codes(errors)
    with pytest.raises(EngineInputError):
        compute(params, inputs)


def test_a_probability_already_named_is_not_also_counted_into_the_sum():
    """One missing probability is one error, not that plus a bogus total."""
    params, inputs = _pwerm_payload(
        [
            {"probability": 1.0, "equity_value": 50_000_000},
            {"equity_value": 10_000_000},
        ]
    )
    errors, _ = split_issues(validate_payload(params, inputs))
    assert "inputs.pwerm.scenarios[1].probability" in fields(errors)
    assert "probabilities_sum" not in codes(errors)


def test_a_valid_scenario_set_still_passes_and_computes():
    params, inputs = _pwerm_payload(
        [
            {"probability": 0.6, "equity_value": 50_000_000, "time_to_exit_years": 3},
            {"probability": 0.4, "equity_value": 10_000_000, "time_to_exit_years": 4},
        ]
    )
    assert validate_payload(params, inputs) == []
    assert compute(params, inputs)["results"]["fmv_per_share"] > 0


@pytest.mark.parametrize(
    ("overrides", "field"),
    [
        ({"equity_value": -1.0}, "inputs.pwerm.scenarios[0].equity_value"),
        ({"equity_value": "lots"}, "inputs.pwerm.scenarios[0].equity_value"),
        ({"type": "spac"}, "inputs.pwerm.scenarios[0].type"),
        ({"time_to_exit_years": -2}, "inputs.pwerm.scenarios[0].time_to_exit_years"),
        ({"discount_rate": -1.5}, "inputs.pwerm.scenarios[0].discount_rate"),
    ],
)
def test_every_scenario_field_compute_refuses_is_named_by_the_preflight(overrides, field):
    params, inputs = _pwerm_payload(
        [{"probability": 1.0, "equity_value": 50_000_000, "time_to_exit_years": 3, **overrides}]
    )
    errors, _ = split_issues(validate_payload(params, inputs))
    assert field in fields(errors)
    with pytest.raises(EngineInputError):
        compute(params, inputs)


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
    # Every problem up to the bound is named, not just the first: the callers
    # that draw `detail` alone (the scenario preview) get one refusal per fix
    # otherwise, and the remedy composed around this says "the inputs it names".
    for issue in body["issues"][:3]:
        assert issue["message"] in body["detail"]


def test_the_detail_counts_the_problems_it_could_not_name():
    # Five errors at once: three named, and the count is of the two left over
    # rather than of the total, so a reader does not have to subtract.
    res = client.post(
        "/engine/v1/compute",
        json={
            "params": {"dlom": "x", "dloc": "y", "risk_free_rate": "z"},
            "inputs": {"volatility": "w", "time_to_liquidity_years": "v"},
        },
    )
    assert res.status_code == 422
    body = res.json()
    detail = body["detail"]
    named = [i["message"] for i in body["issues"] if i["message"] in detail]
    assert len(named) == 3
    hidden = len(body["issues"]) - 3
    assert hidden > 0
    plural = "s" if hidden > 1 else ""
    assert detail.endswith(f"(and {hidden} more input problem{plural})")


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
    "patch",
    [
        # Zero is a real answer — "no option pool", "no preferred stock at all".
        {"options_outstanding": 0},
        {"shares_outstanding_preferred": 0, "liquidation_preference": 0},
    ],
    ids=["no_option_pool", "no_preferred_stock"],
)
def test_zero_stays_legal_when_the_cap_table_still_says_something_coherent(patch):
    errors, _ = split_issues(validate_payload(GOOD_PARAMS, {**GOOD_INPUTS, **patch}))
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


# ── A preference stack with nobody holding it ────────────────────────────────
#
# The mirror image of the sign typo above, and reachable by omission rather than
# by typo: `shares_outstanding_preferred` is optional on the analyst form and on
# the extraction schema, while the liquidation preference is the figure typed
# first because it is the one on the term sheet. Every aggregate allocation
# branch guards on `preferred_shares > 0 and liquidation_preference > 0`, so
# leaving the count out did not produce a wrong-looking number — it dropped the
# entire preference stack and handed common the whole equity value, as a clean
# 200 with no error and no warning.

_ORPHAN_PREFERENCE = {"shares_outstanding_preferred": 0}
_NO_PREFERRED_COUNT = {k: v for k, v in GOOD_INPUTS.items() if k != "shares_outstanding_preferred"}


@pytest.mark.parametrize(
    "inputs",
    [{**GOOD_INPUTS, **_ORPHAN_PREFERENCE}, _NO_PREFERRED_COUNT],
    ids=["explicit_zero", "field_omitted"],
)
def test_a_preference_with_no_preferred_shares_is_named_by_the_preflight(inputs):
    errors, _ = split_issues(validate_payload(GOOD_PARAMS, inputs))
    assert "inputs.shares_outstanding_preferred" in fields(errors)
    assert "required" in codes(errors)


@pytest.mark.parametrize(
    "inputs",
    [{**GOOD_INPUTS, **_ORPHAN_PREFERENCE}, _NO_PREFERRED_COUNT],
    ids=["explicit_zero", "field_omitted"],
)
@pytest.mark.parametrize("allocation_method", ["opm", "cvm"])
def test_compute_refuses_the_same_payload_on_both_aggregate_paths(inputs, allocation_method):
    params = {**GOOD_PARAMS, "allocation_method": allocation_method}
    with pytest.raises(EngineInputError, match="shares_outstanding_preferred"):
        compute(params, inputs)


def test_the_dropped_preference_stack_used_to_overstate_the_fmv_and_is_now_a_422():
    """The behaviour this replaces, measured — and the response the caller now gets."""
    baseline = compute(GOOD_PARAMS, GOOD_INPUTS)["results"]
    assert baseline["allocation"]["method"] == "opm_single_breakpoint"

    res = client.post(
        "/engine/v1/compute",
        json={"params": GOOD_PARAMS, "inputs": {**GOOD_INPUTS, **_ORPHAN_PREFERENCE}},
    )
    assert res.status_code == 422
    assert "inputs.shares_outstanding_preferred" in {i["field"] for i in res.json()["issues"]}


def test_clearing_the_preference_as_well_is_the_supported_way_to_say_no_preferred():
    """The other half of the fix: the coherent payload still runs, and says so."""
    inputs = {**GOOD_INPUTS, "shares_outstanding_preferred": 0, "liquidation_preference": 0}
    assert split_issues(validate_payload(GOOD_PARAMS, inputs))[0] == []
    results = compute(GOOD_PARAMS, inputs)["results"]
    assert results["allocation"]["method"] == "as_converted"
    assert results["allocation"]["common_fraction"] == 1.0
    # Common taking everything is *correct* here, and was the silently wrong
    # answer for the payload above — the difference is that this one says there
    # is no preference, rather than naming one and then dropping it.
    assert results["fmv_per_share"] > baseline_fmv()


def baseline_fmv() -> float:
    return compute(GOOD_PARAMS, GOOD_INPUTS)["results"]["fmv_per_share"]


def test_the_cap_table_waterfall_is_unaffected_because_it_never_reads_the_scalars():
    """`share_classes` carries a preference per class; these two are not consulted."""
    inputs = {
        **GOOD_INPUTS,
        **_ORPHAN_PREFERENCE,
        "share_classes": [
            {"name": "Common", "kind": "common", "shares": 7_000_000},
            {
                "name": "Series A",
                "kind": "preferred",
                "shares": 2_000_000,
                "preference": 5_000_000,
                "seniority": 1,
            },
        ],
    }
    errors, _ = split_issues(validate_payload(GOOD_PARAMS, inputs))
    assert "inputs.shares_outstanding_preferred" not in fields(errors)
    assert compute(GOOD_PARAMS, inputs)["results"]["allocation"]["method"] == "opm_waterfall"


def test_pwerm_is_unaffected_too():
    """PWERM allocates from `share_classes` alone; the scalars are not in its model."""
    params = {**GOOD_PARAMS, "allocation_method": "pwerm"}
    inputs = {
        **GOOD_INPUTS,
        **_ORPHAN_PREFERENCE,
        "share_classes": [
            {"name": "Common", "kind": "common", "shares": 7_000_000},
            {
                "name": "Series A",
                "kind": "preferred",
                "shares": 2_000_000,
                "preference": 5_000_000,
                "seniority": 1,
            },
        ],
        "pwerm": {
            "discount_rate": 0.2,
            "scenarios": [
                {"probability": 0.6, "equity_value": 40_000_000, "time_to_exit_years": 3},
                {"probability": 0.4, "equity_value": 8_000_000, "time_to_exit_years": 2},
            ],
        },
    }
    errors, _ = split_issues(validate_payload(params, inputs))
    assert "inputs.shares_outstanding_preferred" not in fields(errors)
    assert compute(params, inputs)["results"]["fmv_per_share"] > 0


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


# ── the pre-flight and the engine agree on the cap table ──────────────────────


WATERFALL_INPUTS = {
    **GOOD_INPUTS,
    "share_classes": [
        {"name": "Common", "kind": "common", "shares": 7_000_000},
        {"name": "Series A", "kind": "preferred", "shares": 2_000_000, "preference": 5_000_000},
        {"name": "Pool", "kind": "option", "shares": 1_000_000, "strike": 0.5},
    ],
}


def test_a_well_formed_cap_table_raises_nothing():
    assert validate_payload(GOOD_PARAMS, WATERFALL_INPUTS) == []
    assert compute(GOOD_PARAMS, WATERFALL_INPUTS)["results"]["fmv_per_share"] > 0


class _Absent:
    """Sentinel: this key is *removed* rather than set to something bad."""

    def __repr__(self):  # pragma: no cover - readable parametrize ids only
        return "<absent>"


_ABSENT = _Absent()


def _with_class(index, patch):
    """WATERFALL_INPUTS with one class patched — or replaced by `None`."""
    classes = [dict(c) for c in WATERFALL_INPUTS["share_classes"]]
    if patch is None:
        classes[index] = None
        return {**WATERFALL_INPUTS, "share_classes": classes}
    for key, value in patch.items():
        if value is _ABSENT:
            classes[index].pop(key, None)
        else:
            classes[index][key] = value
    return {**WATERFALL_INPUTS, "share_classes": classes}


@pytest.mark.parametrize(
    ("index", "patch", "field"),
    [
        (1, {"preference": -1}, "inputs.share_classes[1].preference"),
        (1, {"preference": _ABSENT}, "inputs.share_classes[1].preference"),
        (1, {"seniority": 0}, "inputs.share_classes[1].seniority"),
        (1, {"seniority": 1.5}, "inputs.share_classes[1].seniority"),
        (1, {"conversion_ratio": 0}, "inputs.share_classes[1].conversion_ratio"),
        (1, {"conversion_ratio": "two"}, "inputs.share_classes[1].conversion_ratio"),
        (2, {"strike": _ABSENT}, "inputs.share_classes[2].strike"),
        (2, {"strike": 0}, "inputs.share_classes[2].strike"),
        (0, {"shares": 0}, "inputs.share_classes[0].shares"),
        (0, {"shares": "7,000,000"}, "inputs.share_classes[0].shares"),
        (0, {"name": "  "}, "inputs.share_classes[0].name"),
        (0, {"kind": "preference"}, "inputs.share_classes[0].kind"),
        (0, None, "inputs.share_classes[0]"),
    ],
)
def test_every_cap_table_problem_compute_refuses_is_named_by_the_preflight(index, patch, field):
    """The normaliser is fail-fast and message-only; this is the addressable half."""
    inputs = _with_class(index, patch)
    errors, _ = split_issues(validate_payload(GOOD_PARAMS, inputs))
    assert field in fields(errors)
    with pytest.raises(EngineInputError):
        compute(GOOD_PARAMS, inputs)


def test_a_duplicate_class_name_is_named_on_the_second_one():
    classes = [dict(c) for c in WATERFALL_INPUTS["share_classes"]]
    classes[1]["name"] = "Common"
    inputs = {**WATERFALL_INPUTS, "share_classes": classes}
    errors, _ = split_issues(validate_payload(GOOD_PARAMS, inputs))
    assert "duplicate" in codes(errors)
    assert "inputs.share_classes[1].name" in fields(errors)
    with pytest.raises(EngineInputError):
        compute(GOOD_PARAMS, inputs)


def test_a_cap_table_with_no_common_class_is_refused_before_the_engine_sees_it():
    inputs = {
        **WATERFALL_INPUTS,
        "share_classes": [
            {"name": "Series A", "kind": "preferred", "shares": 2_000_000, "preference": 5_000_000}
        ],
    }
    errors, _ = split_issues(validate_payload(GOOD_PARAMS, inputs))
    assert "inputs.share_classes" in fields(errors)
    with pytest.raises(EngineInputError):
        compute(GOOD_PARAMS, inputs)


def test_the_class_count_ceiling_is_the_waterfall_s_own():
    from app.engine.waterfall import MAX_SHARE_CLASSES

    classes = [
        {"name": f"Class {i}", "kind": "common", "shares": 1_000.0} for i in range(MAX_SHARE_CLASSES + 1)
    ]
    errors, _ = split_issues(validate_payload(GOOD_PARAMS, {**GOOD_INPUTS, "share_classes": classes}))
    assert "too_many" in codes(errors)


def test_a_cap_table_reports_every_bad_class_in_one_pass():
    """The whole point: four problems, one round trip, four field paths."""
    inputs = {
        **WATERFALL_INPUTS,
        "share_classes": [
            {"name": "Common", "kind": "common", "shares": -1},
            {"name": "", "kind": "preferred", "shares": 2_000_000, "preference": 5_000_000},
            {"name": "Series B", "kind": "preferred", "shares": 1_000_000},
            {"name": "Pool", "kind": "option", "shares": 500_000},
        ],
    }
    errors, _ = split_issues(validate_payload(GOOD_PARAMS, inputs))
    assert {
        "inputs.share_classes[0].shares",
        "inputs.share_classes[1].name",
        "inputs.share_classes[2].preference",
        "inputs.share_classes[3].strike",
    } <= fields(errors)


# ── the pre-flight and the engine agree on the comparables list ───────────────


@pytest.mark.parametrize("bad", [None, "12.5x", True, float("nan")])
def test_one_unusable_multiple_fails_the_preflight_not_only_the_run(bad):
    inputs = {**GOOD_INPUTS, "market": {"metric": 4_000_000, "multiples": [8.0, bad]}}
    errors, _ = split_issues(validate_payload(GOOD_PARAMS, inputs))
    assert "inputs.market.multiples[1]" in fields(errors)
    with pytest.raises(EngineInputError):
        compute(GOOD_PARAMS, inputs)


def test_a_list_of_usable_multiples_is_still_clean():
    assert validate_payload(GOOD_PARAMS, GOOD_INPUTS) == []


def test_a_zero_multiple_is_reported_as_the_list_being_unusable_not_as_a_bad_entry():
    """0.0 is a *number*; it is the positivity check that refuses it, as before."""
    inputs = {**GOOD_INPUTS, "market": {"metric": 4_000_000, "multiples": [0.0]}}
    errors, _ = split_issues(validate_payload(GOOD_PARAMS, inputs))
    assert "not_positive" in codes(errors)
    assert "inputs.market.multiples[0]" not in fields(errors)


# ── the pre-flight and the engine agree on which asset method is running ──────


def test_a_cost_to_replicate_payload_without_the_method_param_is_not_blocked():
    """`asset_value` dispatches on the field's presence when no method is set."""
    params = {**GOOD_PARAMS, "weight_asset": 0.5, "weight_opm": 0.0, "asset_method": None}
    inputs = {**GOOD_INPUTS, "asset": {"cost_to_replicate": 3_000_000}}
    errors, _ = split_issues(validate_payload(params, inputs))
    assert errors == []
    assert compute(params, inputs)["results"]["fmv_per_share"] > 0


def test_that_fallback_still_asks_for_the_balance_sheet_when_no_cost_is_given():
    params = {**GOOD_PARAMS, "weight_asset": 0.5, "weight_opm": 0.0, "asset_method": None}
    errors, _ = split_issues(validate_payload(params, GOOD_INPUTS))
    assert {"inputs.asset.total_assets", "inputs.asset.total_liabilities"} <= fields(errors)


def test_a_negative_rebuild_cost_is_refused_by_both():
    params = {**GOOD_PARAMS, "weight_asset": 0.5, "weight_opm": 0.0, "asset_method": "cost_to_replicate"}
    inputs = {**GOOD_INPUTS, "asset": {"cost_to_replicate": -1}}
    errors, _ = split_issues(validate_payload(params, inputs))
    assert "inputs.asset.cost_to_replicate" in fields(errors)
    with pytest.raises(EngineInputError):
        compute(params, inputs)
