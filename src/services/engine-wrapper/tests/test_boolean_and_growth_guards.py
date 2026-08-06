"""A `true` is not a `1`, and an unusable terminal growth is not a zero.

Two halves of one defect. JSON lets a boolean sit wherever a number belongs,
and `float(True)` is `1.0`, so every numeric input on the engine used to accept
`true` and value the company as though the analyst had typed a 1. The
pre-flight validator had always refused bools (`validate._finite` returns None
for them), which masked most of it — `/compute` validates first, so a bool
share count was answered 422.

`terminal_growth` was the hole in that mask: `_check_income` read *anything*
unusable as 0.0 and reported nothing, so `terminal_growth: true` cleared
validation with `ok: true` and then reached `income_dcf` as a 100% perpetual
growth rate. The response was a 200 with a fair market value three times the
correct one, no error and no warning — the single worst shape a valuation
engine can fail in, because nothing on the result says to look.

These tests pin both layers: the validator names the field, and `compute`
refuses the bool on its own rather than trusting a caller to have pre-flighted.
"""

import math

import pytest
from fastapi.testclient import TestClient

from app.engine.compute import compute
from app.engine.errors import EngineInputError
from app.engine.validate import ERROR, split_issues, validate_payload
from app.main import app

PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 0.0,
    "weight_income": 1.0,
    "weight_market": 0.0,
    "allocation_method": "opm",
}
INPUTS = {
    "shares_outstanding_common": 10_000_000,
    "income": {"free_cash_flows": [1_000_000.0], "discount_rate": 1.5},
}


def _with_growth(value):
    inputs = dict(INPUTS)
    inputs["income"] = {**INPUTS["income"], "terminal_growth": value}
    return inputs


def _errors(params, inputs):
    errors, _ = split_issues(validate_payload(params, inputs))
    return errors


# ── the regression itself ─────────────────────────────────────────────────────


def test_a_boolean_terminal_growth_no_longer_computes_a_wrong_valuation():
    """The reported defect: `true` was read as 100% growth, silently.

    Pinned against the correct answer rather than against a constant, so the
    test says what went wrong: these two payloads must not both compute, and
    before the fix they did — at 0.0667 and 0.2000 per share.
    """
    zero_growth = compute(PARAMS, _with_growth(0.0))["results"]["fmv_per_share"]

    assert _errors(PARAMS, _with_growth(True)), "a boolean terminal growth must be refused"
    with pytest.raises(EngineInputError):
        compute(PARAMS, _with_growth(True))

    # And the honest payload still works, at the value it always had.
    assert zero_growth == pytest.approx(0.0667, abs=1e-4)


def test_the_endpoint_answers_422_and_names_the_field():
    """What the analyst actually sees: a field path, not a wrong number."""
    client = TestClient(app)
    response = client.post(
        "/engine/v1/compute",
        json={"params": PARAMS, "inputs": _with_growth(True)},
    )
    assert response.status_code == 422
    body = response.json()
    assert any(i["field"] == "inputs.income.terminal_growth" for i in body["issues"])
    assert any(i["code"] == "not_a_number" for i in body["issues"])


# ── validate and compute agree, which is this module's whole contract ─────────


@pytest.mark.parametrize(
    "bad",
    [True, False, float("nan"), float("inf"), "abc", "2%", [0.02], {"rate": 0.02}],
    ids=["true", "false", "nan", "inf", "text", "percent-string", "list", "object"],
)
def test_an_unusable_terminal_growth_is_refused_by_both_layers(bad):
    """Neither layer may clear what the other refuses.

    Previously the validator passed every one of these as 0.0 while `compute`
    raised on all but the bools — so the caller was told the inputs were good
    and then handed an error for using them.
    """
    errors = _errors(PARAMS, _with_growth(bad))
    assert [e.field for e in errors] == ["inputs.income.terminal_growth"]
    assert errors[0].severity == ERROR
    assert errors[0].hint, "an error on a rate should say what a good one looks like"

    with pytest.raises(EngineInputError):
        compute(PARAMS, _with_growth(bad))


@pytest.mark.parametrize("good", [0.0, 0.02, -0.01, 0.049])
def test_a_real_growth_rate_still_passes_both_layers(good):
    assert _errors(PARAMS, _with_growth(good)) == []
    assert math.isfinite(compute(PARAMS, _with_growth(good))["results"]["fmv_per_share"])


def test_an_absent_terminal_growth_still_means_a_zero_growth_perpetuity():
    """Absent is the one case that legitimately defaults — don't over-correct."""
    assert _errors(PARAMS, INPUTS) == []
    assert compute(PARAMS, INPUTS)["results"]["fmv_per_share"] == pytest.approx(
        compute(PARAMS, _with_growth(0.0))["results"]["fmv_per_share"]
    )


def test_an_explicit_null_terminal_growth_is_absent_not_unusable():
    """`{"terminal_growth": null}` is what a form with an empty field sends."""
    assert _errors(PARAMS, _with_growth(None)) == []
    assert compute(PARAMS, _with_growth(None))["results"]["fmv_per_share"] > 0


# ── the second layer, on the fields the validator already guards ─────────────
#
# These reach `compute` today only because a caller can skip the pre-flight
# (`/sensitivity` does). They are the reason the guard belongs in `_num` and
# not only in the validator.


@pytest.mark.parametrize(
    "field",
    [
        "shares_outstanding_common",
        "shares_outstanding_preferred",
        "liquidation_preference",
        "options_outstanding",
        "volatility",
        "risk_free_rate",
        "last_round_post_money",
    ],
)
def test_compute_refuses_a_boolean_on_any_numeric_input(field):
    params = {**PARAMS, "weight_opm": 1.0, "weight_income": 0.0}
    inputs = {
        "shares_outstanding_common": 10_000_000,
        "shares_outstanding_preferred": 4_000_000,
        "liquidation_preference": 20_000_000,
        "last_round_post_money": 50_000_000,
        "volatility": 0.6,
        "risk_free_rate": 0.04,
        field: True,
    }
    with pytest.raises(EngineInputError) as excinfo:
        compute(params, inputs)
    # The message has to say *why*, or "must be a number" about a `true` reads
    # as a bug in the engine rather than a bad field.
    assert "true/false" in str(excinfo.value)


def test_the_boolean_message_names_the_offending_field():
    with pytest.raises(EngineInputError) as excinfo:
        compute(PARAMS, {**INPUTS, "shares_outstanding_common": True})
    assert "shares_outstanding_common" in str(excinfo.value)


def test_zero_and_one_are_still_ordinary_numbers():
    """The guard is about the *type*, not about the values 0 and 1."""
    inputs = {**INPUTS, "shares_outstanding_common": 1}
    assert compute(PARAMS, inputs)["results"]["fully_diluted_common"] == 1.0
