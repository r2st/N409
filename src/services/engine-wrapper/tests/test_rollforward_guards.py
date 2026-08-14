"""Roll-forward guards — a prior result the engine did not write.

The distinguishing thing about this module's inputs is where they come from: not
a form, but a *stored prior valuation*, read back months later. So the guards
here are not about typos, they are about a blob that may have been hand-edited,
partially migrated, or written by an older engine version. Every one of them has
to produce a 400 naming the field rather than an exception escaping as a 500 —
`prior_results.equity_value` arriving as the string "10000000" is not a server
fault.

The accretion-rate fallback chain is covered end to end for the same reason: it
decides the number when the caller states no rate, and its last two rungs
(the prior *inputs* discount rate, then the 20% default) were unexecuted, so
nothing pinned which rate a roll-forward actually used.
"""

import pytest

from app.engine.errors import EngineInputError
from app.engine.rollforward import DEFAULT_ANNUAL_ACCRETION, _extract_revenue, roll_forward

BASE = {"results": {"equity_value": 10_000_000.0}}
DATES = {"prior_valuation_date": "2025-01-01", "new_valuation_date": "2026-01-01"}


# ── Dates ────────────────────────────────────────────────────────────────────


def test_a_date_object_is_accepted_as_well_as_an_iso_string():
    from datetime import date

    out = roll_forward(
        BASE,
        prior_valuation_date=date(2025, 1, 1),
        new_valuation_date=date(2026, 1, 1),
        annual_accretion=0.0,
    )
    assert out["prior_valuation_date"] == "2025-01-01"
    assert out["new_valuation_date"] == "2026-01-01"


def test_an_unparseable_date_names_the_field_it_came_from():
    with pytest.raises(EngineInputError, match="prior_valuation_date must be an ISO date"):
        roll_forward(BASE, prior_valuation_date="last July", new_valuation_date="2026-01-01")
    with pytest.raises(EngineInputError, match="new_valuation_date must be an ISO date"):
        roll_forward(BASE, prior_valuation_date="2025-01-01", new_valuation_date="2026-13-01")
    with pytest.raises(EngineInputError, match="new_valuation_date must be an ISO date"):
        roll_forward(BASE, prior_valuation_date="2025-01-01", new_valuation_date=None)


def test_a_datetime_string_is_truncated_to_its_date():
    out = roll_forward(
        BASE,
        prior_valuation_date="2025-01-01T00:00:00Z",
        new_valuation_date="2026-01-01T12:30:00Z",
        annual_accretion=0.0,
    )
    assert out["prior_valuation_date"] == "2025-01-01"


# ── The prior result envelope ────────────────────────────────────────────────


def test_the_prior_result_must_be_an_object():
    with pytest.raises(EngineInputError, match="prior_results must be an object"):
        roll_forward([{"equity_value": 1.0}], **DATES)


def test_a_prior_envelope_whose_results_are_not_an_object_is_refused():
    with pytest.raises(EngineInputError, match="prior_results.results must be an object"):
        roll_forward({"results": "10000000"}, **DATES)


def test_a_bare_results_dict_is_accepted_without_the_envelope():
    out = roll_forward({"equity_value": 5_000_000.0}, **DATES, annual_accretion=0.0)
    assert out["prior_equity_value"] == 5_000_000.0


def test_a_non_numeric_prior_equity_value_is_a_400_not_a_500():
    with pytest.raises(EngineInputError, match="prior_results.equity_value must be a number"):
        roll_forward({"results": {"equity_value": "ten million"}}, **DATES)


def test_a_missing_or_non_positive_prior_equity_value_is_refused():
    for bad in (None, 0.0, -1.0):
        with pytest.raises(EngineInputError, match=r"prior_results.equity_value \(positive\)"):
            roll_forward({"results": {"equity_value": bad}}, **DATES)


def test_a_non_finite_prior_equity_value_is_refused():
    # NaN defeats the `<= 0` guard below it, so it has to die here.
    with pytest.raises(EngineInputError, match="prior_results.equity_value must be finite"):
        roll_forward({"results": {"equity_value": float("nan")}}, **DATES)


# ── The accretion-rate fallback chain ────────────────────────────────────────


def test_an_explicit_rate_wins_over_everything_stored():
    out = roll_forward(
        {"results": {"equity_value": 1_000_000.0, "approaches": {"income": {"discount_rate": 0.4}}}},
        **DATES,
        annual_accretion=0.10,
    )
    assert out["annual_accretion"] == 0.10


def test_the_prior_income_discount_rate_is_used_when_no_rate_is_stated():
    out = roll_forward(
        {"results": {"equity_value": 1_000_000.0, "approaches": {"income": {"discount_rate": 0.35}}}},
        **DATES,
    )
    assert out["annual_accretion"] == 0.35


def test_a_corrupt_stored_discount_rate_is_a_400_naming_where_it_was_read():
    with pytest.raises(
        EngineInputError, match="prior_results.approaches.income.discount_rate must be a number"
    ):
        roll_forward(
            {"results": {"equity_value": 1e6, "approaches": {"income": {"discount_rate": "20%"}}}},
            **DATES,
        )


def test_the_prior_inputs_discount_rate_is_the_next_rung_down():
    # No income approach in the stored *result*, but the stored *inputs* have
    # the rate the analyst entered. Better evidence than the flat default.
    out = roll_forward(
        {"results": {"equity_value": 1_000_000.0}},
        **DATES,
        prior_inputs={"income": {"discount_rate": 0.28}},
    )
    assert out["annual_accretion"] == 0.28


def test_the_default_accretion_applies_when_no_rate_can_be_found_anywhere():
    out = roll_forward({"results": {"equity_value": 1_000_000.0}}, **DATES)
    assert out["annual_accretion"] == DEFAULT_ANNUAL_ACCRETION


def test_a_zero_stored_rate_falls_through_to_the_default():
    # A stored 0.0 is indistinguishable from "no rate recorded" — the prior
    # engine wrote a zero where it had nothing — so it does not pin the roll
    # forward at no appreciation.
    out = roll_forward(
        {"results": {"equity_value": 1_000_000.0}},
        **DATES,
        prior_inputs={"income": {"discount_rate": 0.0}},
    )
    assert out["annual_accretion"] == DEFAULT_ANNUAL_ACCRETION


def test_a_stated_zero_rate_is_honoured():
    # Stated by the caller, though, it is a decision: hold the value flat.
    out = roll_forward({"results": {"equity_value": 1e6}}, **DATES, annual_accretion=0.0)
    assert out["annual_accretion"] == 0.0
    assert out["rolled_equity_value"] == 1_000_000.0


def test_a_rate_at_or_below_minus_one_hundred_percent_is_refused():
    # `(1 + rate) ** years` with a negative base and a fractional exponent
    # returns a *complex* number in Python, which then dies inside round().
    with pytest.raises(EngineInputError, match="must be greater than -1"):
        roll_forward(BASE, **DATES, annual_accretion=-1.0)
    with pytest.raises(EngineInputError, match="must be greater than -1"):
        roll_forward(BASE, **DATES, annual_accretion=-1.5)


def test_prior_inputs_that_are_not_an_object_do_not_break_the_rate_lookup():
    out = roll_forward({"equity_value": 1e6, "approaches": None}, **DATES, prior_inputs=None)
    assert out["annual_accretion"] == DEFAULT_ANNUAL_ACCRETION


# ── A new priced round ───────────────────────────────────────────────────────


def test_a_new_round_must_be_positive():
    for bad in (0.0, -1.0):
        with pytest.raises(EngineInputError, match="new_round_post_money must be positive"):
            roll_forward(BASE, **DATES, new_round_post_money=bad)


def test_a_non_numeric_new_round_is_refused_by_name():
    with pytest.raises(EngineInputError, match="new_round_post_money must be a number"):
        roll_forward(BASE, **DATES, new_round_post_money="20M")


def test_a_new_round_supersedes_the_time_decay_anchor():
    out = roll_forward(BASE, **DATES, new_round_post_money=25_000_000.0)
    assert out["rolled_equity_value"] == 25_000_000.0
    assert out["annual_accretion"] == 0.0
    assert [s["step"] for s in out["calibration_steps"]] == [
        "prior_equity_value",
        "new_round_post_money",
    ]
    assert any(c["field"] == "new_round" and c["material"] for c in out["material_changes"])


# ── Value adjustments ────────────────────────────────────────────────────────


def test_each_adjustment_must_be_an_object():
    with pytest.raises(EngineInputError, match="each value_adjustment must be an object"):
        roll_forward(BASE, **DATES, annual_accretion=0.0, value_adjustments=["-20%"])


def test_an_adjustment_needs_a_pct_or_an_amount():
    with pytest.raises(EngineInputError, match="'secondary' needs pct or amount"):
        roll_forward(
            BASE, **DATES, annual_accretion=0.0, value_adjustments=[{"label": "secondary"}]
        )


def test_an_unlabelled_adjustment_is_named_in_the_error_anyway():
    with pytest.raises(EngineInputError, match="'adjustment' needs pct or amount"):
        roll_forward(BASE, **DATES, annual_accretion=0.0, value_adjustments=[{}])


def test_an_amount_adjustment_shifts_the_value_absolutely():
    out = roll_forward(
        BASE,
        **DATES,
        annual_accretion=0.0,
        value_adjustments=[{"label": "impairment", "amount": -2_000_000.0}],
    )
    assert out["rolled_equity_value"] == 8_000_000.0
    assert out["calibration_steps"][-1] == {
        "step": "adjustment",
        "label": "impairment",
        "value": 8_000_000.0,
    }


def test_pct_and_amount_on_one_adjustment_apply_in_that_order():
    # The percentage scales the running value; the amount is added after.
    out = roll_forward(
        BASE,
        **DATES,
        annual_accretion=0.0,
        value_adjustments=[{"label": "down round", "pct": -0.5, "amount": 1_000_000.0}],
    )
    assert out["rolled_equity_value"] == 6_000_000.0


def test_a_non_numeric_adjustment_figure_names_its_label():
    with pytest.raises(EngineInputError, match="secondary.pct must be a number"):
        roll_forward(
            BASE,
            **DATES,
            annual_accretion=0.0,
            value_adjustments=[{"label": "secondary", "pct": "-20%"}],
        )


def test_adjustments_that_wipe_out_the_value_are_refused():
    with pytest.raises(EngineInputError, match="not positive after adjustments"):
        roll_forward(
            BASE,
            **DATES,
            annual_accretion=0.0,
            value_adjustments=[{"label": "writeoff", "amount": -10_000_000.0}],
        )


def test_adjustments_that_overflow_are_refused_before_the_sign_check():
    # `inf <= 0` is False, so finiteness has to be tested first or an overflow
    # rolls all the way out as a 200 carrying `Infinity`.
    with pytest.raises(EngineInputError, match="not finite after adjustments"):
        roll_forward(
            {"results": {"equity_value": 1e308}},
            **DATES,
            annual_accretion=0.0,
            value_adjustments=[{"label": "x", "pct": 1e10}],
        )


# ── Material-change detection ────────────────────────────────────────────────


def test_revenue_is_read_from_the_market_metric_when_there_is_no_revenue_field():
    out = roll_forward(
        BASE,
        **DATES,
        annual_accretion=0.0,
        prior_inputs={"market": {"metric": 1_000_000.0}},
        updated_inputs={"market": {"metric": 2_000_000.0}},
    )
    rev = next(c for c in out["material_changes"] if c["field"] == "revenue")
    assert rev["material"] is True
    assert rev["delta_pct"] == 1.0


def test_a_sub_threshold_revenue_move_is_reported_as_immaterial():
    out = roll_forward(
        BASE,
        **DATES,
        annual_accretion=0.0,
        prior_inputs={"revenue": 1_000_000.0},
        updated_inputs={"revenue": 1_050_000.0},
    )
    rev = next(c for c in out["material_changes"] if c["field"] == "revenue")
    assert rev["material"] is False
    assert rev["delta_pct"] == 0.05
    # Reported, but it does not force a fresh valuation on its own.
    assert out["requires_full_revaluation"] is False


def test_a_gap_beyond_the_time_threshold_is_material_on_its_own():
    # 365 days is 0.9993 years against a 365.25-day year, so a calendar year to
    # the day does *not* trip the threshold — which is the behaviour worth
    # pinning, since it is the boundary a scheduled annual re-valuation lands on.
    a_year = roll_forward(
        BASE, prior_valuation_date="2025-01-01", new_valuation_date="2026-01-01",
        annual_accretion=0.0,
    )
    assert a_year["requires_full_revaluation"] is False

    longer = roll_forward(
        BASE, prior_valuation_date="2025-01-01", new_valuation_date="2026-06-01",
        annual_accretion=0.0,
    )
    gap = next(c for c in longer["material_changes"] if c["field"] == "valuation_date")
    assert gap["material"] is True
    assert "1.41 years since prior valuation" in gap["detail"]
    assert longer["requires_full_revaluation"] is True


def test_the_time_threshold_is_caller_settable():
    out = roll_forward(
        BASE, prior_valuation_date="2025-01-01", new_valuation_date="2025-05-01",
        annual_accretion=0.0, time_materiality_years=0.25,
    )
    assert any(c["field"] == "valuation_date" for c in out["material_changes"])


def test_an_unchanged_revenue_is_not_reported_at_all():
    out = roll_forward(
        BASE,
        prior_valuation_date="2025-01-01",
        new_valuation_date="2025-06-01",
        annual_accretion=0.0,
        prior_inputs={"revenue": 1_000_000.0},
        updated_inputs={"revenue": 1_000_000.0},
    )
    assert [c["field"] for c in out["material_changes"]] == []
    assert out["requires_full_revaluation"] is False


def test_revenue_extraction_declines_a_blob_that_is_not_an_object():
    # Tested directly: an inputs blob that is not a dict cannot reach this
    # through `roll_forward`, which needs to splat it a few lines later. The
    # guard is the reason the helper is safe to reuse, so it is pinned here
    # rather than left as an unexecuted line.
    assert _extract_revenue(None) is None
    assert _extract_revenue("1000000") is None
    assert _extract_revenue([{"revenue": 1e6}]) is None


def test_inputs_that_are_not_objects_yield_no_revenue_comparison():
    out = roll_forward(
        BASE,
        **DATES,
        annual_accretion=0.0,
        prior_inputs={"market": "SaaS"},
        updated_inputs={"market": {"multiple": 6.0}},
    )
    assert not [c for c in out["material_changes"] if c["field"] == "revenue"]


def test_a_share_class_change_is_material():
    out = roll_forward(
        BASE,
        prior_valuation_date="2025-01-01",
        new_valuation_date="2025-06-01",
        annual_accretion=0.0,
        prior_inputs={"share_classes": [{"name": "Common"}]},
        updated_inputs={"share_classes": [{"name": "Common"}, {"name": "Series A"}]},
    )
    assert any(c["field"] == "share_classes" and c["material"] for c in out["material_changes"])


def test_cap_table_counts_are_compared_field_by_field():
    out = roll_forward(
        BASE,
        prior_valuation_date="2025-01-01",
        new_valuation_date="2025-06-01",
        annual_accretion=0.0,
        prior_inputs={"shares_outstanding_common": 8_000_000, "options_outstanding": 1_000_000},
        updated_inputs={"shares_outstanding_common": 9_000_000, "options_outstanding": 1_000_000},
    )
    fields = [c["field"] for c in out["material_changes"]]
    assert "shares_outstanding_common" in fields
    assert "options_outstanding" not in fields  # unchanged


# ── Pre-populated inputs ─────────────────────────────────────────────────────


def test_the_stale_round_price_is_dropped_so_the_roll_forward_is_not_thrown_away():
    # `compute` root-finds against a round price when one is present and treats
    # the post-money as a starting guess only, so carrying the prior price
    # forward would discard the accretion and re-derive off a stale market
    # observation this roll-forward has superseded.
    out = roll_forward(
        BASE,
        **DATES,
        annual_accretion=0.20,
        prior_inputs={"last_round_price_per_share": 1.25, "last_round_class": "Series A"},
    )
    pre = out["pre_populated_inputs"]
    assert "last_round_price_per_share" not in pre
    assert "last_round_class" not in pre
    assert pre["last_round_post_money"] == out["rolled_equity_value"]


def test_a_price_supplied_for_the_new_date_is_kept():
    out = roll_forward(
        BASE,
        **DATES,
        annual_accretion=0.20,
        prior_inputs={"last_round_price_per_share": 1.25, "last_round_class": "Series A"},
        updated_inputs={"last_round_price_per_share": 3.10, "last_round_class": "Series B"},
    )
    pre = out["pre_populated_inputs"]
    assert pre["last_round_price_per_share"] == 3.10
    assert pre["last_round_class"] == "Series B"


def test_updated_inputs_override_prior_inputs_in_the_pre_populated_blob():
    out = roll_forward(
        BASE,
        **DATES,
        annual_accretion=0.0,
        prior_inputs={"volatility": 0.60, "risk_free_rate": 0.04},
        updated_inputs={"volatility": 0.75},
    )
    pre = out["pre_populated_inputs"]
    assert pre["volatility"] == 0.75
    assert pre["risk_free_rate"] == 0.04
    assert pre["valuation_date"] == "2026-01-01"


def test_a_backwards_date_range_is_refused():
    with pytest.raises(EngineInputError, match="must be on or after prior_valuation_date"):
        roll_forward(BASE, prior_valuation_date="2026-01-01", new_valuation_date="2025-01-01")


def test_the_same_date_twice_rolls_nothing_forward():
    out = roll_forward(
        BASE, prior_valuation_date="2026-01-01", new_valuation_date="2026-01-01"
    )
    assert out["years_elapsed"] == 0.0
    assert out["rolled_equity_value"] == 10_000_000.0
