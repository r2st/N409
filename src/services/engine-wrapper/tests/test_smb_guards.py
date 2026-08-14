"""SMB input guards — the refusals, and the two nested input blobs.

`test_smb.py` covers the arithmetic. This file covers what the module does with
input it cannot use. Two things here are worth more than the usual guard test:

**The nested blobs.** `sde_inputs` and `cap_rate_inputs` are splatted into their
helpers with `**`, so a stray key is a `TypeError` about an unexpected keyword
argument rather than anything a caller could act on. Both are caught and
restated; both of those catches were unexecuted.

**The overflow guards.** `_finite` exists because SDE arithmetic on absurd
inputs overflows to `inf`, and `inf` passes every downstream range check —
the conclusion then serialises as `Infinity`, which is not valid JSON. Each
call site is checked with a magnitude that actually overflows.
"""

import pytest

from app.engine.errors import EngineInputError
from app.engine.smb import buildup_cap_rate, sde_normalization, smb_valuation

HUGE = 1e308  # doubling this overflows a float64


# ── _num ─────────────────────────────────────────────────────────────────────


def test_a_non_numeric_figure_is_refused_by_name():
    with pytest.raises(EngineInputError, match="sde.pretax_income must be a number"):
        sde_normalization(pretax_income="two hundred thousand")
    with pytest.raises(EngineInputError, match="sde.pretax_income must be a number"):
        sde_normalization(pretax_income=None)
    with pytest.raises(EngineInputError, match="sde.owner_compensation must be a number"):
        sde_normalization(pretax_income=1.0, owner_compensation=[150_000])


def test_a_non_finite_figure_is_refused():
    with pytest.raises(EngineInputError, match="sde.pretax_income must be finite"):
        sde_normalization(pretax_income=float("nan"))
    with pytest.raises(EngineInputError, match="sde.interest_expense must be finite"):
        sde_normalization(pretax_income=1.0, interest_expense=float("inf"))


def test_an_addback_below_its_floor_is_refused():
    # A negative add-back is a subtraction wearing the wrong label; the
    # deduction fields are where a reduction belongs.
    with pytest.raises(EngineInputError, match=r"sde.owner_compensation must be >= 0"):
        sde_normalization(pretax_income=100.0, owner_compensation=-1.0)
    with pytest.raises(EngineInputError, match=r"sde.one_time_income must be >= 0"):
        sde_normalization(pretax_income=100.0, one_time_income=-1.0)


def test_a_rate_above_its_ceiling_is_refused():
    # 1.0 is 100%; anything above it is a percent typed as a whole number.
    with pytest.raises(EngineInputError, match=r"cap.equity_risk_premium must be <= 1"):
        buildup_cap_rate(risk_free_rate=0.04, equity_risk_premium=6.0)
    with pytest.raises(EngineInputError, match=r"cap.long_term_growth must be <= 1"):
        buildup_cap_rate(risk_free_rate=0.04, equity_risk_premium=0.06, long_term_growth=3.0)
    with pytest.raises(EngineInputError, match=r"cap.long_term_growth must be >= -1"):
        buildup_cap_rate(risk_free_rate=0.04, equity_risk_premium=0.06, long_term_growth=-2.0)


# ── _finite: the overflow guards ─────────────────────────────────────────────


def test_an_sde_that_overflows_is_refused_rather_than_returned_as_inf():
    with pytest.raises(EngineInputError, match="sde.sde overflowed"):
        sde_normalization(pretax_income=HUGE, owner_compensation=HUGE)


def test_a_capitalized_value_that_overflows_is_refused():
    with pytest.raises(EngineInputError, match="smb.capitalized_value overflowed"):
        smb_valuation(
            sde=HUGE,
            cap_rate_inputs={"risk_free_rate": 0.0, "equity_risk_premium": 1e-300},
        )


def test_an_sde_multiple_value_that_overflows_is_refused():
    with pytest.raises(EngineInputError, match="smb.sde_multiple_value overflowed"):
        smb_valuation(sde=HUGE, sde_multiple=100.0)


def test_a_revenue_multiple_value_that_overflows_is_refused():
    with pytest.raises(EngineInputError, match="smb.revenue_multiple_value overflowed"):
        smb_valuation(sde=1.0, annual_revenue=HUGE, revenue_multiple=100.0)


# ── The nested input blobs ───────────────────────────────────────────────────


def test_sde_inputs_must_be_an_object():
    with pytest.raises(EngineInputError, match="smb.sde_inputs must be an object"):
        smb_valuation(sde_inputs=[{"pretax_income": 100.0}], sde_multiple=3.0)


def test_an_unexpected_sde_input_key_is_restated_as_an_input_error():
    # `**sde_inputs` turns a typo into a TypeError about keyword arguments.
    # The caller gets a 400 naming the blob instead of a 500.
    with pytest.raises(EngineInputError, match="invalid sde_inputs:"):
        smb_valuation(
            sde_inputs={"pretax_income": 100_000.0, "owner_salary": 50_000.0},
            sde_multiple=3.0,
        )


def test_sde_inputs_still_need_their_required_field():
    with pytest.raises(EngineInputError, match="invalid sde_inputs:"):
        smb_valuation(sde_inputs={}, sde_multiple=3.0)


def test_cap_rate_inputs_must_be_an_object():
    with pytest.raises(EngineInputError, match="smb.cap_rate_inputs must be an object"):
        smb_valuation(sde=100_000.0, cap_rate_inputs="0.25")


def test_an_unexpected_cap_rate_key_is_restated_as_an_input_error():
    with pytest.raises(EngineInputError, match="invalid cap_rate_inputs:"):
        smb_valuation(
            sde=100_000.0,
            cap_rate_inputs={
                "risk_free_rate": 0.04,
                "equity_risk_premium": 0.06,
                "beta": 1.2,  # not a build-up component
            },
        )


def test_capitalization_needs_a_positive_benefit_stream():
    with pytest.raises(EngineInputError, match="needs a positive benefit stream"):
        smb_valuation(
            sde=-50_000.0,
            cap_rate_inputs={"risk_free_rate": 0.04, "equity_risk_premium": 0.20},
        )


def test_the_sde_multiple_method_needs_a_positive_sde():
    with pytest.raises(EngineInputError, match="SDE multiple method needs a positive SDE"):
        smb_valuation(sde=0.0, sde_multiple=3.0)


# ── Weights ──────────────────────────────────────────────────────────────────


def test_weights_must_be_an_object():
    with pytest.raises(EngineInputError, match="smb.weights must be an object"):
        smb_valuation(sde=100_000.0, sde_multiple=3.0, weights=[1.0])


def test_a_method_omitted_from_the_weights_is_weighted_at_zero():
    # Naming one of two methods is a deliberate exclusion, not an omission to
    # be renormalized away — the analyst gave the other one no weight.
    out = smb_valuation(
        sde=100_000.0,
        annual_revenue=500_000.0,
        sde_multiple=3.0,
        revenue_multiple=1.0,
        weights={"sde_multiple": 1.0},
    )
    assert out["weights"] == {"sde_multiple": 1.0, "revenue_multiple": 0.0}
    assert out["equity_value"] == pytest.approx(300_000.0)


def test_weights_are_normalized_rather_than_required_to_sum_to_one():
    out = smb_valuation(
        sde=100_000.0,
        annual_revenue=500_000.0,
        sde_multiple=3.0,
        revenue_multiple=1.0,
        weights={"sde_multiple": 3.0, "revenue_multiple": 1.0},
    )
    assert out["weights"]["sde_multiple"] == pytest.approx(0.75)
    assert out["equity_value"] == pytest.approx(0.75 * 300_000 + 0.25 * 500_000)


def test_a_weight_for_a_method_that_could_not_run_is_refused():
    with pytest.raises(EngineInputError, match="names methods that did not run"):
        smb_valuation(
            sde=100_000.0,
            sde_multiple=3.0,
            weights={"sde_multiple": 0.5, "capitalization_of_earnings": 0.5},
        )


def test_weights_that_sum_to_zero_are_refused():
    with pytest.raises(EngineInputError, match="must sum to a positive number"):
        smb_valuation(sde=100_000.0, sde_multiple=3.0, weights={"sde_multiple": 0.0})


def test_a_negative_weight_is_refused():
    with pytest.raises(EngineInputError, match=r"smb.weights.sde_multiple must be >= 0"):
        smb_valuation(
            sde=100_000.0,
            annual_revenue=500_000.0,
            sde_multiple=3.0,
            revenue_multiple=1.0,
            weights={"sde_multiple": -1.0, "revenue_multiple": 2.0},
        )


# ── Method selection ─────────────────────────────────────────────────────────


def test_sde_and_sde_inputs_are_mutually_exclusive():
    with pytest.raises(EngineInputError, match="not both"):
        smb_valuation(sde=100_000.0, sde_inputs={"pretax_income": 100_000.0}, sde_multiple=3.0)


def test_one_of_sde_or_sde_inputs_is_required():
    with pytest.raises(EngineInputError, match="smb needs sde or sde_inputs"):
        smb_valuation(sde_multiple=3.0)


def test_no_runnable_method_names_the_three_that_exist():
    with pytest.raises(EngineInputError, match="no SMB method could run"):
        smb_valuation(sde=100_000.0)


def test_a_revenue_multiple_without_revenue_is_refused():
    with pytest.raises(EngineInputError, match="revenue_multiple needs smb.annual_revenue"):
        smb_valuation(sde=100_000.0, revenue_multiple=1.0)
