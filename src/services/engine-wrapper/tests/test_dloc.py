"""The discount for lack of control, derived rather than typed.

Until this module existed `dloc` was a number an analyst entered, applied
as-is, and reported with no derivation behind it — while the DLOM beside it had
four option models, two study families and a weighting scheme. These tests pin
the three things that asymmetry was hiding.

  1. The inversion. A control premium and a control discount are the same fact
     from opposite sides, and the conversion is not symmetric.
  2. The synergy deduction. An observed acquisition premium is not the value of
     control; it also contains what that buyer expected to do with the target.
  3. The level of value. A DLOC steps control → marketable minority, so it is
     only meaningful against a value that arrived at a control level — and the
     approach that usually carries most of a 409A's weight does not.
"""

import pytest

from app.engine.compute import compute
from app.engine.dloc import (
    CONTROL_PREMIUM_STUDIES,
    DEFAULT_CONTROL_PREMIUM_SET,
    LEVEL_OF_VALUE_BY_APPROACH,
    control_premium_dloc,
    control_premium_from_dloc,
    dloc_from_control_premium,
    level_of_value_detail,
    minority_basis_share,
    resolve_dloc,
    studies_dloc,
)
from app.engine.errors import EngineInputError
from app.engine.validate import split_issues, validate_payload

# ── the inversion ─────────────────────────────────────────────────────────────


def test_a_premium_is_not_the_discount_of_the_same_size():
    """The single most common arithmetic slip in this corner of a valuation.

    A 25% premium over a minority price is a 20% discount from the control
    price. Subtracting the premium instead overstates the discount by a fifth
    of itself, and on a per-share figure that is the gap between two defensible
    conclusions.
    """
    assert dloc_from_control_premium(0.25) == pytest.approx(0.20)
    assert dloc_from_control_premium(0.40) == pytest.approx(0.2857142857)
    assert dloc_from_control_premium(0.0) == 0.0


def test_the_inversion_round_trips():
    for premium in (0.05, 0.25, 0.33, 0.9, 2.0):
        assert control_premium_from_dloc(dloc_from_control_premium(premium)) == pytest.approx(premium)


def test_a_negative_premium_is_refused():
    # A discount paid for control is a finding about that transaction, not
    # evidence for a DLOC, and the inversion would read it as a premium.
    with pytest.raises(EngineInputError):
        dloc_from_control_premium(-0.1)


# ── the synergy deduction ─────────────────────────────────────────────────────


def test_synergies_are_removed_before_the_inversion_not_after():
    """Order matters, because the inversion is not linear.

    Removing 40% of a 40% premium leaves 24%, which inverts to 19.35%. Removing
    40% of the *discount* implied by the whole premium would leave 17.14% — a
    different answer to a different question, and the wrong one: the synergy
    judgement is about what the buyer paid, which is a premium.
    """
    out = control_premium_dloc(0.40, synergy_share=0.4)
    assert out["observed_control_premium"] == pytest.approx(0.40)
    assert out["control_premium_applied"] == pytest.approx(0.24)
    assert out["dloc"] == pytest.approx(0.193548, abs=1e-6)


def test_both_premiums_are_reported():
    # The deduction is a judgement. A report stating only the adjusted figure
    # has relabelled somebody's estimate as an observation.
    out = control_premium_dloc(0.40, synergy_share=0.4)
    assert "synergy_share" in out and "synergy_note" in out
    assert out["synergy_share"] == pytest.approx(0.4)


def test_no_synergy_share_leaves_the_premium_whole_and_says_nothing():
    out = control_premium_dloc(0.40)
    assert out["control_premium_applied"] == pytest.approx(0.40)
    # Absent rather than zero: "not adjusted" and "adjusted by nothing" are
    # different claims about the analysis, and only one of them was made.
    assert "synergy_share" not in out
    assert "synergy_note" not in out


def test_a_synergy_share_of_one_or_more_is_refused():
    # All of the premium being synergy means control is worth nothing, which is
    # a conclusion about the transaction rather than an adjustment to it.
    with pytest.raises(EngineInputError):
        control_premium_dloc(0.40, synergy_share=1.0)


# ── the study blend ───────────────────────────────────────────────────────────


def test_the_blend_happens_on_the_premium_scale_and_inverts_once():
    """Inverting each row and averaging the discounts is a different number.

    The mean of 1−1/(1+p) is not 1−1/(1+mean p), and the gap grows with the
    spread of the set. There is no reason to accept an error that varies with
    how wide somebody's study selection happens to be.
    """
    table = [
        {"study": "narrow", "premium": 0.15},
        {"study": "wide", "premium": 0.90},
    ]
    out = studies_dloc(selected=["narrow", "wide"], studies=table, statistic="mean")
    blended_premium = (0.15 + 0.90) / 2
    assert out["dloc"] == pytest.approx(dloc_from_control_premium(blended_premium), rel=1e-6)

    per_row_mean = (dloc_from_control_premium(0.15) + dloc_from_control_premium(0.90)) / 2
    assert out["dloc"] != pytest.approx(per_row_mean, rel=1e-3)


def test_the_default_set_is_the_recent_decades():
    out = studies_dloc()
    assert [row["study"] for row in out["studies"]] == list(DEFAULT_CONTROL_PREMIUM_SET)
    # And it carries the flag that says these are the engine's own summaries.
    assert out["indicative_table"] is True


def test_a_firm_supplied_table_is_not_flagged_as_indicative():
    out = studies_dloc(
        selected=["FactSet, SIC 7372, 2019-2024"],
        studies=[{"study": "FactSet, SIC 7372, 2019-2024", "premium": 0.28}],
    )
    assert out["indicative_table"] is False
    assert out["dloc"] == pytest.approx(dloc_from_control_premium(0.28))


def test_a_thin_set_says_so():
    out = studies_dloc(selected=[CONTROL_PREMIUM_STUDIES[0]["study"]])
    assert out["thin_study_set"] is True
    assert out["study_count"] == 1


def test_an_unknown_study_names_what_is_available():
    with pytest.raises(EngineInputError) as exc:
        studies_dloc(selected=["Not A Study"])
    assert "Not A Study" in str(exc.value)


def test_the_set_travels_with_the_answer():
    # Set selection is the whole objection to a study-based discount, so a
    # number without its set is not reviewable.
    out = studies_dloc()
    assert out["study_count"] == len(out["studies"])
    assert out["low"] <= out["high"]


# ── the level of value ────────────────────────────────────────────────────────


def test_every_approach_is_classified():
    # A new approach reaching the weighting without a level of value would make
    # the double-count check silently under-report.
    assert set(LEVEL_OF_VALUE_BY_APPROACH) == {"asset", "income", "market", "opm_backsolve"}


def test_the_backsolve_and_the_market_approach_are_minority_bases():
    """Not a matter of opinion.

    A backsolve inverts the price a preferred investor paid for a minority
    stake. Guideline public company multiples are struck on trading prices, and
    a trading price is what a minority holder pays for a share they cannot use
    to direct anything. Neither figure contains a control element to discount.
    """
    assert LEVEL_OF_VALUE_BY_APPROACH["opm_backsolve"] == "minority"
    assert LEVEL_OF_VALUE_BY_APPROACH["market"] == "minority"
    assert LEVEL_OF_VALUE_BY_APPROACH["income"] == "control"
    assert LEVEL_OF_VALUE_BY_APPROACH["asset"] == "control"


def test_the_minority_share_is_of_the_weight_actually_used():
    share = minority_basis_share(
        {"asset": 0.0, "opm_backsolve": 0.5, "income": 0.25, "market": 0.25}
    )
    assert share == pytest.approx(0.75)


def test_zero_weighted_approaches_do_not_dilute_the_share():
    # A nil-weighted approach contributed nothing to the equity value, so
    # counting it in the denominator would understate the double count.
    assert minority_basis_share({"opm_backsolve": 1.0, "income": 0.0}) == pytest.approx(1.0)


def test_no_weights_means_no_judgement():
    # The PWERM path derives equity value from its own exit scenarios. A guess
    # about its level of value would be worse than silence.
    assert minority_basis_share(None) is None
    assert minority_basis_share({}) is None
    assert level_of_value_detail(0.1, None) is None


def test_a_zero_discount_cannot_double_count():
    assert level_of_value_detail(0.0, {"opm_backsolve": 1.0}) is None


def test_a_discount_on_a_wholly_minority_basis_is_flagged():
    detail = level_of_value_detail(0.1, {"opm_backsolve": 1.0})
    assert detail is not None
    assert detail["minority_basis_weight"] == pytest.approx(1.0)
    assert detail["double_counts_minority"] is True
    assert "discounts a second time" in detail["note"]


def test_a_control_weighted_run_is_not_flagged():
    detail = level_of_value_detail(0.1, {"income": 0.8, "opm_backsolve": 0.2})
    assert detail is not None
    assert detail["double_counts_minority"] is False
    assert "note" not in detail


# ── dispatch ──────────────────────────────────────────────────────────────────


def test_an_absent_method_still_reads_the_stated_figure():
    """The fallback is permanent, not transitional.

    Every valuation stored before this module existed replays through it, and a
    recalculation of an engagement concluded last year must not change its
    number because the engine grew a method vocabulary since.
    """
    dloc, method, _ = resolve_dloc({"dloc": 0.12})
    assert dloc == pytest.approx(0.12)
    assert method is None


def test_an_unknown_method_is_refused_rather_than_ignored():
    with pytest.raises(EngineInputError):
        resolve_dloc({"dloc_method": "mergerstat"})


def test_the_control_premium_method_needs_a_premium():
    with pytest.raises(EngineInputError) as exc:
        resolve_dloc({"dloc_method": "control_premium"})
    assert "control_premium" in str(exc.value)


def test_a_qualitative_dloc_states_the_premium_it_implies():
    # So a reviewer can check the judgement against the study range without
    # doing the inversion themselves.
    _, _, detail = resolve_dloc({"dloc_method": "qualitative", "dloc": 0.20})
    assert detail["implied_control_premium"] == pytest.approx(0.25)
    assert "judgement" in detail["basis"]


def test_the_level_of_value_rides_on_a_derived_discount():
    _, _, detail = resolve_dloc(
        {"dloc_method": "control_premium", "control_premium": 0.30},
        {"opm_backsolve": 1.0},
    )
    assert detail["method"] == "control_premium"
    assert detail["double_counts_minority"] is True


# ── through compute ───────────────────────────────────────────────────────────

PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 0.0,
    "weight_income": 1.0,
    "weight_market": 0.0,
    "dlom": 0.25,
    "allocation_method": "opm",
}
INPUTS = {
    "valuation_date": "2026-06-30",
    "shares_outstanding_common": 7_000_000,
    "options_outstanding": 1_000_000,
    "shares_outstanding_preferred": 2_000_000,
    "liquidation_preference": 5_000_000,
    "volatility": 0.6,
    "risk_free_rate": 0.042,
    "income": {
        "free_cash_flows": [1_000_000, 1_500_000, 2_200_000],
        "discount_rate": 0.25,
        "terminal_growth": 0.03,
    },
}


def test_compute_derives_the_discount_and_records_the_derivation():
    out = compute({**PARAMS, "dloc_method": "control_premium", "control_premium": 0.25}, INPUTS)
    discounts = out["results"]["discounts"]
    assert discounts["dloc"] == pytest.approx(0.20)
    assert discounts["dloc_method"] == "control_premium"
    assert discounts["dloc_detail"]["observed_control_premium"] == pytest.approx(0.25)


def test_a_stated_dloc_reports_no_method_at_all():
    # Absent rather than null, so a consumer does not have to distinguish "no
    # method" from "method recorded as none".
    discounts = compute({**PARAMS, "dloc": 0.1}, INPUTS)["results"]["discounts"]
    assert discounts["dloc"] == pytest.approx(0.1)
    assert "dloc_method" not in discounts


def test_the_derived_discount_reaches_the_per_share_figure():
    derived = compute({**PARAMS, "dloc_method": "control_premium", "control_premium": 0.25}, INPUTS)
    stated = compute({**PARAMS, "dloc": 0.20}, INPUTS)
    assert derived["results"]["fmv_per_share"] == pytest.approx(stated["results"]["fmv_per_share"])


def test_the_trace_carries_the_dloc_derivation():
    out = compute(
        {**PARAMS, "dloc_method": "control_premium", "control_premium": 0.25},
        INPUTS,
        trace=True,
    )
    step = next(s for s in out["trace"] if s["key"] == "discounts")
    assert step["inputs"]["dloc_method"] == "control_premium"
    assert step["inputs"]["dloc_detail"]["formula"].startswith("DLOC = 1 −")


# ── pre-flight ────────────────────────────────────────────────────────────────

VALIDATE_PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 0.5,
    "weight_income": 0.25,
    "weight_market": 0.25,
    "dlom": 0.25,
    "exit_timeline": "2029-06-30",
    "allocation_method": "opm",
}
VALIDATE_INPUTS = {
    **INPUTS,
    "last_round_post_money": 20_000_000,
    "market": {"metric": 4_000_000, "multiples": [5.0, 6.5, 7.1]},
}


def codes(issues, severity=None):
    return {i.code for i in issues if severity is None or i.severity == severity}


def test_the_pre_flight_warns_when_a_dloc_lands_on_a_minority_basis():
    """The finding that changes a number rather than a disclosure.

    Three quarters of this payload's weight is on the backsolve and the market
    approach. A 10% DLOC on top of that takes 10% off a value that was never at
    a control level, and nothing about the result looks wrong — it is a
    plausible per-share figure that is simply too low.
    """
    issues = validate_payload({**VALIDATE_PARAMS, "dloc": 0.10}, VALIDATE_INPUTS)
    errors, warnings = split_issues(issues)
    assert errors == []
    assert "dloc_on_minority_basis" in codes(warnings)


def test_no_warning_when_the_discount_is_concluded_at_zero():
    issues = validate_payload({**VALIDATE_PARAMS, "dloc": 0.0}, VALIDATE_INPUTS)
    assert "dloc_on_minority_basis" not in codes(issues)


def test_no_warning_when_the_value_arrived_at_a_control_level():
    control = {
        **VALIDATE_PARAMS,
        "weight_opm": 0.0,
        "weight_income": 1.0,
        "weight_market": 0.0,
        "dloc": 0.10,
    }
    assert "dloc_on_minority_basis" not in codes(validate_payload(control, VALIDATE_INPUTS))


def test_the_pre_flight_states_the_discount_a_premium_implies():
    issues = validate_payload(
        {
            **VALIDATE_PARAMS,
            "weight_opm": 0.0,
            "weight_income": 1.0,
            "weight_market": 0.0,
            "dloc_method": "control_premium",
            "control_premium": 0.25,
        },
        VALIDATE_INPUTS,
    )
    warned = next(i for i in issues if i.code == "control_premium_inverted")
    assert "20.0%" in warned.message


def test_the_pre_flight_flags_a_conclusion_on_the_built_in_table():
    """These rows are decade summaries, not an extraction for this company.

    They exist so a valuation can conclude, not to settle what the premium is —
    and the dispersion across industries is wider than the dispersion across
    decades, so an appraiser with the subscription data should be using it.
    """
    issues = validate_payload(
        {
            **VALIDATE_PARAMS,
            "weight_opm": 0.0,
            "weight_income": 1.0,
            "weight_market": 0.0,
            "dloc_method": "studies",
        },
        VALIDATE_INPUTS,
    )
    assert "indicative_control_premiums" in codes(issues)


def test_a_firm_supplied_premium_table_is_not_flagged():
    issues = validate_payload(
        {
            **VALIDATE_PARAMS,
            "weight_opm": 0.0,
            "weight_income": 1.0,
            "weight_market": 0.0,
            "dloc_method": "studies",
            "dloc_study_table": [{"study": "FactSet SIC 7372", "premium": 0.28}],
            "dloc_studies": ["FactSet SIC 7372"],
        },
        VALIDATE_INPUTS,
    )
    errors, _ = split_issues(issues)
    assert errors == []
    assert "indicative_control_premiums" not in codes(issues)


def test_an_unknown_method_is_a_blocking_error_at_save_time():
    errors, _ = split_issues(
        validate_payload({**VALIDATE_PARAMS, "dloc_method": "mergerstat"}, VALIDATE_INPUTS)
    )
    assert "invalid_choice" in {e.code for e in errors}


def test_a_missing_premium_is_caught_before_the_calculation_runs():
    errors, _ = split_issues(
        validate_payload({**VALIDATE_PARAMS, "dloc_method": "control_premium"}, VALIDATE_INPUTS)
    )
    assert "params.control_premium" in {e.field for e in errors}
