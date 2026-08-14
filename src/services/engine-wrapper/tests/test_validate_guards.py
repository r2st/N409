"""Pre-flight validation: the malformed-shape branches, one at a time.

`test_validate.py` covers what a working analyst gets wrong — a weight that
sums to 0.9, a missing discount rate, an exit date before the measurement date.
This file covers the other half: what arrives when a *caller* is wrong. A
hand-built API payload, a partner integration, a params row edited by something
that does not know the schema, an AI agent that returned a string where the
column wants a list.

The distinction matters because the two halves fail differently. An analyst's
mistake is caught by the number looking wrong. A caller's mistake is a shape the
validator has no branch for, and the failure mode is not a bad error message —
it is `validate_payload` reporting no problem at all and `compute` raising a
bare TypeError three layers down, which reaches the operator as a 500 with no
field path. Every test here pins a branch that turns one of those into a named
error against a named field.

`validate_payload` never raises. That is the contract these tests lean on
hardest: every payload below is junk, and every assertion is about what was
*reported*.
"""

from app.engine.validate import ERROR, split_issues, validate_payload

from test_validate import GOOD_INPUTS, GOOD_PARAMS, codes, fields


def errors_for(params=None, inputs=None, **kw):
    """The blocking issues for a payload, with the good fixture as the base."""
    merged_params = {**GOOD_PARAMS, **(params or {})}
    merged_inputs = {**GOOD_INPUTS, **(inputs or {})}
    errors, _ = split_issues(validate_payload(merged_params, merged_inputs, **kw))
    return errors


def warnings_for(params=None, inputs=None, **kw):
    merged_params = {**GOOD_PARAMS, **(params or {})}
    merged_inputs = {**GOOD_INPUTS, **(inputs or {})}
    _, warnings = split_issues(validate_payload(merged_params, merged_inputs, **kw))
    return warnings


# ── the DLOM blend: the shape an editor makes easy to get wrong ───────────────


def test_dlom_methods_must_be_a_list():
    """A string is the shape a form posts when the multi-select is left alone."""
    errors = errors_for({"dlom_methods": "chaffee", "dlom": None})
    assert "invalid_shape" in codes(errors)
    assert "params.dlom_methods" in fields(errors)


def test_an_empty_dlom_blend_is_rejected_rather_than_ignored():
    # An empty list is not "no blend requested" — it is a blend with nothing in
    # it, and silently falling back to the single-method path would conclude on
    # a discount the analyst did not choose.
    errors = errors_for({"dlom_methods": [], "dlom": None})
    assert "invalid_shape" in codes(errors)


def test_a_one_method_blend_is_pushed_back_to_dlom_method():
    errors = errors_for({"dlom_methods": [{"method": "chaffee", "weight": 1.0}], "dlom": None})
    assert "invalid_shape" in codes(errors)
    assert any("at least two methods" in i.message for i in errors)


def test_dlom_method_and_dlom_methods_together_are_a_conflict():
    errors = errors_for(
        {
            "dlom_method": "chaffee",
            "dlom_methods": [
                {"method": "chaffee", "weight": 0.5},
                {"method": "finnerty", "weight": 0.5},
            ],
            "dlom": None,
        }
    )
    assert "conflicting" in codes(errors)


def test_a_non_object_blend_entry_is_named_by_index():
    errors = errors_for(
        {
            "dlom_methods": ["chaffee", {"method": "finnerty", "weight": 1.0}],
            "dlom": None,
        }
    )
    assert "params.dlom_methods[0]" in fields(errors)


def test_an_unknown_blend_method_names_what_is_available():
    errors = errors_for(
        {
            "dlom_methods": [
                {"method": "black_scholes", "weight": 0.5},
                {"method": "chaffee", "weight": 0.5},
            ],
            "dlom": None,
        }
    )
    assert "out_of_range" in codes(errors)
    assert any("chaffee" in i.message for i in errors), "the error should list the real methods"


def test_a_method_weighted_twice_is_a_duplicate_not_a_sum():
    """Two rows for one method is an editing slip, not an intent to add them."""
    errors = errors_for(
        {
            "dlom_methods": [
                {"method": "chaffee", "weight": 0.5},
                {"method": "chaffee", "weight": 0.5},
            ],
            "dlom": None,
        }
    )
    assert "duplicate" in codes(errors)


def test_a_non_numeric_blend_weight_is_named():
    errors = errors_for(
        {
            "dlom_methods": [
                {"method": "chaffee", "weight": "half"},
                {"method": "finnerty", "weight": 0.5},
            ],
            "dlom": None,
        }
    )
    assert "not_a_number" in codes(errors)
    assert "params.dlom_methods[0].weight" in fields(errors)


def test_a_blend_weight_outside_zero_to_one_is_out_of_range():
    errors = errors_for(
        {
            "dlom_methods": [
                {"method": "chaffee", "weight": 1.5},
                {"method": "finnerty", "weight": -0.5},
            ],
            "dlom": None,
        }
    )
    assert "out_of_range" in codes(errors)
    assert {"params.dlom_methods[0].weight", "params.dlom_methods[1].weight"} <= fields(errors)


def test_a_qualitative_leg_needs_the_analysts_own_figure():
    # Nothing derives a qualitative discount, so a blend that weights one and
    # supplies no number has no value to blend.
    errors = errors_for(
        {
            "dlom_methods": [
                {"method": "qualitative", "weight": 0.5},
                {"method": "chaffee", "weight": 0.5},
            ],
            "dlom": None,
        }
    )
    assert "required" in codes(errors)
    assert "params.dlom_qualitative" in fields(errors)


def test_blend_weights_that_miss_one_are_reported_not_normalised():
    """The weights are deliberately not normalised — see compute._blended_dlom."""
    errors = errors_for(
        {
            "dlom_methods": [
                {"method": "chaffee", "weight": 0.45},
                {"method": "finnerty", "weight": 0.45},
            ],
            "dlom": None,
        }
    )
    assert "weights_sum" in codes(errors)


def test_a_zero_weighted_method_is_a_warning_and_not_an_error():
    # An appraiser who computed Longstaff to show it as an upper bound and
    # weighted it to nothing is documenting the bound, not making a mistake.
    params = {
        "dlom_methods": [
            {"method": "chaffee", "weight": 1.0},
            {"method": "longstaff", "weight": 0.0},
        ],
        "dlom": None,
    }
    assert "zero_weight" not in codes(errors_for(params))
    assert "zero_weight" in codes(warnings_for(params))


# ── control-premium studies (DLOC) ────────────────────────────────────────────


def test_an_empty_dloc_study_table_is_rejected():
    errors = errors_for({"dloc_method": "studies", "dloc_study_table": []})
    assert "invalid_shape" in codes(errors)
    assert "params.dloc_study_table" in fields(errors)


def test_a_dloc_study_row_without_a_name_is_named_by_index():
    errors = errors_for(
        {
            "dloc_method": "studies",
            "dloc_study_table": [{"premium": 0.3}, {"study": "Firm 2024", "premium": 0.25}],
        }
    )
    assert "params.dloc_study_table[0].study" in fields(errors)


def test_a_dloc_study_row_needs_a_non_negative_premium():
    errors = errors_for(
        {
            "dloc_method": "studies",
            "dloc_study_table": [{"study": "Firm 2024", "premium": -0.1}],
        }
    )
    assert "out_of_range" in codes(errors)
    assert "params.dloc_study_table[0].premium" in fields(errors)


def test_an_empty_dloc_studies_selection_is_rejected():
    errors = errors_for({"dloc_method": "studies", "dloc_studies": []})
    assert "invalid_shape" in codes(errors)


def test_an_unknown_dloc_study_lists_the_available_ones():
    errors = errors_for({"dloc_method": "studies", "dloc_studies": ["Made Up 2031"]})
    assert "unknown_study" in codes(errors)
    assert any("US public targets" in (i.hint or "") for i in errors)


def test_a_firm_supplied_table_is_what_the_selection_is_checked_against():
    """The alternative is rejecting a firm's own study names for not being ours."""
    params = {
        "dloc_method": "studies",
        "dloc_study_table": [{"study": "Firm robotics 2025", "premium": 0.28}],
        "dloc_studies": ["Firm robotics 2025"],
    }
    assert "unknown_study" not in codes(errors_for(params))
    # ...and the built-in name is now the unknown one, because the table replaced
    # the defaults wholesale rather than adding to them.
    swapped = {**params, "dloc_studies": ["US public targets, 2010s"]}
    assert "unknown_study" in codes(errors_for(swapped))


def test_relying_on_the_built_in_control_premiums_earns_a_warning():
    # Legal, and the first thing a reviewer asks about: decade summaries are not
    # an extraction for this company's industry.
    warnings = warnings_for({"dloc_method": "studies", "dloc": 0.15})
    assert "indicative_control_premiums" in codes(warnings)


def test_a_firm_supplied_table_retires_that_warning():
    warnings = warnings_for(
        {
            "dloc_method": "studies",
            "dloc": 0.15,
            "dloc_study_table": [{"study": "Firm robotics 2025", "premium": 0.28}],
            "dloc_studies": ["Firm robotics 2025"],
        }
    )
    assert "indicative_control_premiums" not in codes(warnings)


# ── restricted-stock and pre-IPO study sets ───────────────────────────────────


def test_dlom_statistic_must_be_median_or_mean():
    errors = errors_for({"dlom_method": "restricted_stock", "dlom_statistic": "mode"})
    assert "out_of_range" in codes(errors)
    assert "params.dlom_statistic" in fields(errors)


def test_an_empty_restricted_stock_selection_is_rejected():
    errors = errors_for({"dlom_method": "restricted_stock", "dlom_studies": []})
    assert "invalid_shape" in codes(errors)


def test_an_unknown_restricted_stock_study_lists_the_available_ones():
    errors = errors_for({"dlom_method": "restricted_stock", "dlom_studies": ["Enron 2001"]})
    assert "unknown_study" in codes(errors)
    assert any("Gelman" in (i.hint or "") for i in errors)


def test_a_caller_supplied_restricted_stock_table_replaces_the_built_ins():
    params = {
        "dlom_method": "restricted_stock",
        "dlom_study_table": [{"study": "Firm 2025", "discount": 0.18}],
        "dlom_studies": ["Firm 2025"],
    }
    assert "unknown_study" not in codes(errors_for(params))


def test_studies_straddling_the_1997_amendment_warn_about_the_regime():
    # Rule 144 cut the holding period from two years to one. Discounts either
    # side describe different securities, and blending them produces a figure
    # for a regime that never existed.
    #
    # The two Columbia studies are the textbook straddle — one either side of
    # the amendment — and they are the pair that a period comparison keyed on
    # `period_end` gets wrong, because the pre-amendment window closes *in*
    # 1997. `is_post_amendment` is what the check reads instead.
    straddle = {
        "dlom_method": "restricted_stock",
        "dlom_studies": [
            "Columbia Financial Advisors (pre-amendment)",
            "Columbia Financial Advisors (post-amendment)",
        ],
    }
    assert "unknown_study" not in codes(errors_for(straddle)), "both names must be real studies"
    assert "mixed_regime" in codes(warnings_for(straddle))


def test_one_side_of_the_amendment_alone_does_not_warn():
    one_regime = {
        "dlom_method": "restricted_stock",
        "dlom_studies": ["Gelman", "Moroney", "Maher"],
    }
    assert "unknown_study" not in codes(errors_for(one_regime))
    assert "mixed_regime" not in codes(warnings_for(one_regime))


# ── dates ─────────────────────────────────────────────────────────────────────


def test_an_unparseable_valuation_date_is_named():
    errors = errors_for(inputs={"valuation_date": "30/06/2026"})
    assert "invalid_date" in codes(errors)
    assert "inputs.valuation_date" in fields(errors)


def test_an_unparseable_exit_timeline_is_named():
    errors = errors_for({"exit_timeline": "sometime in 2029"})
    assert "invalid_date" in codes(errors)
    assert "params.exit_timeline" in fields(errors)


def test_a_time_to_exit_outside_the_usual_band_warns():
    warnings = warnings_for({"exit_timeline": "2060-06-30"})
    assert "outside_band" in codes(warnings)


def test_an_exit_on_or_before_the_valuation_date_warns():
    warnings = warnings_for({"exit_timeline": "2026-01-01"})
    assert "exit_in_past" in codes(warnings)


def test_an_explicit_time_to_exit_overrides_the_exit_date():
    """`time_to_exit_years` wins, so a bad exit_timeline is not re-derived from it."""
    warnings = warnings_for(
        {"exit_timeline": "2060-06-30"}, {"time_to_exit_years": 3.0}
    )
    assert "outside_band" not in codes(warnings)


# ── PWERM scenarios ───────────────────────────────────────────────────────────


PWERM_PARAMS = {**GOOD_PARAMS, "allocation_method": "pwerm"}


def pwerm_errors(scenarios, **extra):
    inputs = {
        **GOOD_INPUTS,
        "share_classes": [
            {"name": "Common", "shares": 7_000_000, "kind": "common"},
        ],
        "pwerm": {"scenarios": scenarios, **extra},
    }
    errors, _ = split_issues(validate_payload(PWERM_PARAMS, inputs))
    return errors


def test_pwerm_needs_scenarios():
    errors = pwerm_errors([])
    assert "required" in codes(errors)
    assert "inputs.pwerm.scenarios" in fields(errors)


def test_a_non_object_scenario_is_named_by_index():
    errors = pwerm_errors(["ipo at 100m"])
    assert "inputs.pwerm.scenarios[0]" in fields(errors)


def test_a_negative_scenario_probability_is_rejected():
    errors = pwerm_errors(
        [
            {"probability": -0.2, "equity_value": 100_000_000},
            {"probability": 1.2, "equity_value": 10_000_000},
        ]
    )
    assert "out_of_range" in codes(errors)
    assert "inputs.pwerm.scenarios[0].probability" in fields(errors)


def test_a_scenario_needs_an_equity_or_enterprise_value():
    errors = pwerm_errors([{"probability": 1.0, "type": "ipo"}])
    assert "required" in codes(errors)
    assert "inputs.pwerm.scenarios[0].equity_value" in fields(errors)


def test_a_non_numeric_scenario_equity_value_is_named():
    errors = pwerm_errors([{"probability": 1.0, "equity_value": "a hundred million"}])
    assert "not_a_number" in codes(errors)
    assert "inputs.pwerm.scenarios[0].equity_value" in fields(errors)


def test_a_negative_scenario_equity_value_is_rejected():
    # A liquidation bottoms out at zero; equity holders are not liable beyond
    # their investment, so a negative exit is an input error and not a scenario.
    errors = pwerm_errors([{"probability": 1.0, "equity_value": -5_000_000}])
    assert "out_of_range" in codes(errors)


def test_a_non_numeric_scenario_enterprise_value_is_named():
    errors = pwerm_errors([{"probability": 1.0, "enterprise_value": "big"}])
    assert "not_a_number" in codes(errors)
    assert "inputs.pwerm.scenarios[0].enterprise_value" in fields(errors)


def test_an_unknown_scenario_type_lists_the_known_ones():
    errors = pwerm_errors([{"probability": 1.0, "equity_value": 1e8, "type": "spac"}])
    assert "out_of_range" in codes(errors)
    assert "inputs.pwerm.scenarios[0].type" in fields(errors)


def test_a_non_numeric_scenario_time_to_exit_is_named():
    errors = pwerm_errors(
        [{"probability": 1.0, "equity_value": 1e8, "time_to_exit_years": "three"}]
    )
    assert "not_a_number" in codes(errors)
    assert "inputs.pwerm.scenarios[0].time_to_exit_years" in fields(errors)


def test_a_negative_scenario_time_to_exit_is_rejected():
    errors = pwerm_errors([{"probability": 1.0, "equity_value": 1e8, "time_to_exit_years": -1}])
    assert "out_of_range" in codes(errors)


def test_a_non_numeric_scenario_discount_rate_is_named():
    errors = pwerm_errors([{"probability": 1.0, "equity_value": 1e8, "discount_rate": "high"}])
    assert "not_a_number" in codes(errors)
    assert "inputs.pwerm.scenarios[0].discount_rate" in fields(errors)


def test_a_discount_rate_at_or_below_minus_one_is_rejected():
    """Discounting by -100% divides by zero."""
    errors = pwerm_errors([{"probability": 1.0, "equity_value": 1e8, "discount_rate": -1.0}])
    assert "out_of_range" in codes(errors)


# ── hybrid ────────────────────────────────────────────────────────────────────


def test_hybrid_needs_an_object_of_weights():
    inputs = {
        **GOOD_INPUTS,
        "share_classes": [{"name": "Common", "shares": 7_000_000, "kind": "common"}],
        "hybrid": "half and half",
        "pwerm": {"scenarios": [{"probability": 1.0, "equity_value": 1e8}]},
    }
    errors, _ = split_issues(
        validate_payload({**GOOD_PARAMS, "allocation_method": "hybrid"}, inputs)
    )
    assert "invalid_shape" in codes(errors)
    assert "inputs.hybrid" in fields(errors)


# ── allocation method ─────────────────────────────────────────────────────────


def test_an_unknown_allocation_method_lists_the_known_ones():
    errors = errors_for({"allocation_method": "monte_python"})
    assert "unknown_method" in codes(errors)
    assert any("opm" in i.message for i in errors)


def test_an_unknown_allocation_method_still_validates_the_rest_as_opm():
    """The run falls back to OPM, so the OPM inputs are still checked."""
    inputs = {k: v for k, v in GOOD_INPUTS.items() if k != "volatility"}
    errors, _ = split_issues(validate_payload({**GOOD_PARAMS, "allocation_method": "x"}, inputs))
    assert "inputs.volatility" in fields(errors)


# ── per-approach recalculation against a prior run ────────────────────────────


def test_reusing_an_approach_needs_a_prior_equity_value():
    errors, _ = split_issues(
        validate_payload(
            GOOD_PARAMS,
            GOOD_INPUTS,
            recompute=["income"],
            prior_approaches={"market": {}, "opm_backsolve": {"equity_value": 2e7}},
        )
    )
    assert "prior_approaches.market.equity_value" in fields(errors)


def test_a_reused_approach_with_a_prior_value_is_accepted():
    issues = validate_payload(
        GOOD_PARAMS,
        GOOD_INPUTS,
        recompute=["income"],
        prior_approaches={
            "market": {"equity_value": 1.8e7},
            "opm_backsolve": {"equity_value": 2e7},
        },
    )
    assert [i for i in issues if i.severity == ERROR] == []


# ── non-numeric where a number is required ────────────────────────────────────
#
# A string that looks like a number is what a CSV import, a form post and a
# JSON payload built by hand all produce. `_finite` refuses it; these pin that
# the refusal is reported against the field rather than raised.


def test_a_non_numeric_required_input_is_named_not_reported_as_missing():
    """"banana" is present, so "required" would be the wrong error for it."""
    errors = errors_for(inputs={"shares_outstanding_common": "banana"})
    assert "not_a_number" in codes(errors)
    assert "required" not in codes(errors)


def test_a_non_numeric_free_cash_flow_is_named_by_index():
    errors = errors_for(
        inputs={"income": {**GOOD_INPUTS["income"], "free_cash_flows": [1e6, "1.5m", 2e6]}}
    )
    assert "not_a_number" in codes(errors)
    assert "inputs.income.free_cash_flows[1]" in fields(errors)


def test_a_non_numeric_optional_cap_table_figure_is_named():
    """The three figures whose sign silently removes the preference stack."""
    for field in ("options_outstanding", "shares_outstanding_preferred", "liquidation_preference"):
        errors = errors_for(inputs={field: "a lot"})
        assert "not_a_number" in codes(errors), field
        assert f"inputs.{field}" in fields(errors)


def test_a_negative_share_count_is_rejected_rather_than_silently_ignored():
    # A mistyped minus sign does not produce a wrong-looking number: every
    # allocation path guards the preference with `> 0`, so it takes the whole
    # preference stack out of the model and falls through to as-converted. The
    # result is a clean-looking overstatement with no error attached to it.
    errors = errors_for(inputs={"shares_outstanding_preferred": -2_000_000})
    assert "out_of_range" in codes(errors)
    assert "inputs.shares_outstanding_preferred" in fields(errors)


def test_share_classes_must_be_a_list():
    errors = errors_for(inputs={"share_classes": {"Common": 7_000_000}})
    assert "invalid_shape" in codes(errors)
    assert "inputs.share_classes" in fields(errors)


def test_a_non_numeric_participation_cap_is_named():
    errors = errors_for(
        inputs={
            "share_classes": [
                {"name": "Common", "shares": 7_000_000, "kind": "common"},
                {
                    "name": "Series A",
                    "shares": 2_000_000,
                    "kind": "preferred",
                    "liquidation_preference": 5_000_000,
                    "participating": True,
                    "participation_cap": "2x",
                },
            ]
        }
    )
    assert "not_a_number" in codes(errors)
    assert any(i.field.endswith(".participation_cap") for i in errors)


# ── the discounts themselves ──────────────────────────────────────────────────


def test_a_non_numeric_dloc_is_named():
    errors = errors_for({"dloc": "fifteen percent"})
    assert "not_a_number" in codes(errors)
    assert "params.dloc" in fields(errors)


def test_a_dloc_of_one_or_more_is_out_of_range():
    """A 100% discount is a zero valuation, not a discount."""
    errors = errors_for({"dloc": 1.0})
    assert "out_of_range" in codes(errors)


def test_an_unusually_large_dloc_warns_rather_than_blocks():
    warnings = warnings_for({"dloc": 0.5, "weight_opm": 0.0, "weight_income": 0.75})
    assert "high_discount" in codes(warnings)


def test_a_non_numeric_dlom_is_named():
    errors = errors_for({"dlom": "a quarter", "dlom_method": "qualitative"})
    assert "not_a_number" in codes(errors)
    assert "params.dlom" in fields(errors)


def test_a_non_numeric_qualitative_dlom_is_named_against_its_own_field():
    errors = errors_for({"dlom_qualitative": "a quarter", "dlom_method": "qualitative"})
    assert "not_a_number" in codes(errors)
    # Named against the field the figure was actually read from, not the other.
    assert "params.dlom_qualitative" in fields(errors)
    assert "params.dlom" not in fields(errors)


def test_a_dlom_of_one_or_more_is_out_of_range():
    errors = errors_for({"dlom": 1.2})
    assert "out_of_range" in codes(errors)
    assert "params.dlom" in fields(errors)


def test_a_non_numeric_stated_dlom_is_named_on_the_default_path():
    """No `dlom_method` at all: `dlom` is applied as a stated figure."""
    errors = errors_for({"dlom": "a quarter"})
    assert "not_a_number" in codes(errors)
    assert "params.dlom" in fields(errors)


def test_the_level_of_value_warning_is_skipped_when_there_is_no_approach_mix():
    # PWERM derives equity value from its scenarios, so there are no approach
    # weights to read a level of value off — `weights` stays None rather than
    # becoming an empty dict, and the double-discount warning has nothing to
    # measure. It must not fire on a guess.
    inputs = {
        **GOOD_INPUTS,
        "share_classes": [{"name": "Common", "shares": 7_000_000, "kind": "common"}],
        "pwerm": {"scenarios": [{"probability": 1.0, "equity_value": 1e8}]},
    }
    _, warnings = split_issues(
        validate_payload(
            {**GOOD_PARAMS, "allocation_method": "pwerm", "dloc": 0.2}, inputs
        )
    )
    assert "dloc_on_minority_basis" not in codes(warnings)


def test_the_qualitative_dlom_needs_a_figure_from_the_analyst():
    errors = errors_for({"dlom_method": "qualitative", "dlom": None})
    assert "required" in codes(errors)
    assert "params.dlom_qualitative" in fields(errors)


# ── DLOC method dispatch ──────────────────────────────────────────────────────


def test_an_unknown_dloc_method_lists_the_known_ones():
    errors = errors_for({"dloc_method": "vibes"})
    assert "invalid_choice" in codes(errors)
    assert any("control_premium" in i.message for i in errors)


def test_the_control_premium_method_needs_a_premium():
    errors = errors_for({"dloc_method": "control_premium"})
    assert "required" in codes(errors)
    assert "params.control_premium" in fields(errors)


def test_a_negative_control_premium_is_rejected():
    # A discount paid for control is a finding about that transaction, not
    # evidence for a DLOC.
    errors = errors_for({"dloc_method": "control_premium", "control_premium": -0.1})
    assert "out_of_range" in codes(errors)


def test_a_control_premium_states_the_discount_it_implies():
    """DLOC = 1 − 1/(1 + CP). 25% one way is 20% the other, and the asymmetry is
    the mistake the warning exists to prevent."""
    warnings = warnings_for({"dloc_method": "control_premium", "control_premium": 0.25})
    assert "control_premium_inverted" in codes(warnings)
    assert any("20.0%" in i.message for i in warnings)


def test_the_synergy_share_must_be_a_fraction():
    errors = errors_for(
        {"dloc_method": "control_premium", "control_premium": 0.25, "dloc_synergy_share": 1.0}
    )
    assert "out_of_range" in codes(errors)
    assert "params.dloc_synergy_share" in fields(errors)


def test_a_non_numeric_synergy_share_is_caught_by_the_same_branch():
    errors = errors_for(
        {"dloc_method": "control_premium", "control_premium": 0.25, "dloc_synergy_share": "half"}
    )
    assert "params.dloc_synergy_share" in fields(errors)


def test_the_studies_dloc_method_validates_its_statistic():
    errors = errors_for({"dloc_method": "studies", "dloc_statistic": "mode"})
    assert "invalid_choice" in codes(errors)
    assert "params.dloc_statistic" in fields(errors)


def test_the_qualitative_dloc_method_needs_a_stated_discount():
    errors = errors_for({"dloc_method": "qualitative", "dloc": None})
    assert "required" in codes(errors)
    assert "params.dloc" in fields(errors)


def test_selecting_built_in_studies_by_name_still_warns_they_are_indicative():
    warnings = warnings_for(
        {"dloc_method": "studies", "dloc": 0.15, "dloc_studies": ["US public targets, 2010s"]}
    )
    assert "indicative_control_premiums" in codes(warnings)


# ── the DCF terminal value ────────────────────────────────────────────────────


def exit_multiple_income(**over):
    return {
        "income": {
            **GOOD_INPUTS["income"],
            "terminal_method": "exit_multiple",
            **over,
        }
    }


def test_an_exit_multiple_must_be_positive():
    errors = errors_for(inputs=exit_multiple_income(exit_multiple=0))
    assert "out_of_range" in codes(errors)
    assert "inputs.income.exit_multiple" in fields(errors)


def test_an_exit_multiple_with_no_terminal_metric_warns_about_the_denominator():
    # Legal — the engine falls back to the final free cash flow — but an EV/FCF
    # exit multiple is not what an analyst who typed "8x" meant.
    warnings = warnings_for(inputs=exit_multiple_income(exit_multiple=8.0))
    assert "implied_terminal_metric" in codes(warnings)


def test_a_non_positive_terminal_metric_is_rejected():
    errors = errors_for(
        inputs=exit_multiple_income(exit_multiple=8.0, terminal_metric=0)
    )
    assert "out_of_range" in codes(errors)
    assert "inputs.income.terminal_metric" in fields(errors)


# ── the market approach's singular/plural shorthand ───────────────────────────


def test_a_single_market_multiple_is_accepted_as_a_one_element_set():
    """`multiple` is the shorthand an overwrite writes; `multiples` is the list."""
    issues = validate_payload(
        GOOD_PARAMS, {**GOOD_INPUTS, "market": {"metric": 4_000_000, "multiple": 6.0}}
    )
    assert [i for i in issues if i.severity == ERROR] == []


# ── PWERM's scenario ceiling ──────────────────────────────────────────────────


def test_more_than_fifty_scenarios_is_refused():
    scenarios = [{"probability": 1 / 51, "equity_value": 1e8} for _ in range(51)]
    errors = pwerm_errors(scenarios)
    assert "too_many" in codes(errors)


# ── hybrid, unset ─────────────────────────────────────────────────────────────


def test_an_absent_hybrid_block_is_not_a_shape_error():
    """Only the OPM/PWERM split needs it; `None` means the default weights."""
    inputs = {
        **GOOD_INPUTS,
        "share_classes": [{"name": "Common", "shares": 7_000_000, "kind": "common"}],
        "pwerm": {"scenarios": [{"probability": 1.0, "equity_value": 1e8}]},
    }
    errors, _ = split_issues(
        validate_payload({**GOOD_PARAMS, "allocation_method": "hybrid"}, inputs)
    )
    assert "invalid_shape" not in codes(errors)


# ── the pre-IPO family ────────────────────────────────────────────────────────


def test_a_caller_supplied_pre_ipo_table_replaces_the_built_ins():
    params = {
        "dlom_method": "pre_ipo",
        "dlom_pre_ipo_table": [{"study": "Firm IPO window 2024", "discount": 0.4}],
        "dlom_pre_ipo_studies": ["Firm IPO window 2024"],
    }
    assert "unknown_study" not in codes(errors_for(params))
    # The built-in name is now unknown, since the table replaced rather than
    # extended the defaults.
    swapped = {**params, "dlom_pre_ipo_studies": ["Emory 1980-1981"]}
    assert "unknown_study" in codes(errors_for(swapped))


def test_an_empty_pre_ipo_selection_is_rejected():
    errors = errors_for({"dlom_method": "pre_ipo", "dlom_pre_ipo_studies": []})
    assert "invalid_shape" in codes(errors)
    assert "params.dlom_pre_ipo_studies" in fields(errors)


def test_the_pre_ipo_family_always_carries_its_selection_bias_caveat():
    # The sample is companies that went on to complete an IPO, so part of the
    # measured discount is the change in prospects over the period. Warned on
    # every pre-IPO run, not only on an unusual set.
    warnings = warnings_for({"dlom_method": "pre_ipo"})
    assert "pre_ipo_selection_bias" in codes(warnings)


def test_an_old_pre_ipo_window_warns_that_the_ipo_market_has_moved():
    warnings = warnings_for(
        {"dlom_method": "pre_ipo", "dlom_pre_ipo_studies": ["Emory 1980-1981"]}
    )
    assert "dated_study_window" in codes(warnings)
