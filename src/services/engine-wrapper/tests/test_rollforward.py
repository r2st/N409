"""Roll-forward / calibration engine tests."""

import pytest
from fastapi.testclient import TestClient

from app.engine.errors import EngineInputError
from app.engine.rollforward import roll_forward
from app.main import app

client = TestClient(app)

PRIOR = {"results": {"equity_value": 10_000_000.0, "approaches": {"income": {"discount_rate": 0.2}}}}


def test_time_accretion():
    out = roll_forward(
        PRIOR,
        prior_valuation_date="2025-07-20",
        new_valuation_date="2026-07-20",
        annual_accretion=0.20,
    )
    # ~1 year at 20% → ~12M (365/365.25 exponent).
    assert out["rolled_equity_value"] == pytest.approx(10_000_000 * 1.20**(365 / 365.25), rel=1e-4)
    assert out["pre_populated_inputs"]["last_round_post_money"] == out["rolled_equity_value"]
    assert out["pre_populated_inputs"]["valuation_date"] == "2026-07-20"


def test_default_accretion_uses_prior_discount_rate():
    out = roll_forward(
        PRIOR, prior_valuation_date="2025-07-20", new_valuation_date="2026-07-20"
    )
    assert out["annual_accretion"] == pytest.approx(0.20)  # from prior income discount_rate


def test_new_round_overrides_time_decay():
    out = roll_forward(
        PRIOR,
        prior_valuation_date="2025-01-01",
        new_valuation_date="2026-01-01",
        new_round_post_money=25_000_000.0,
    )
    assert out["rolled_equity_value"] == 25_000_000.0
    assert any(c["field"] == "new_round" and c["material"] for c in out["material_changes"])
    assert out["requires_full_revaluation"] is True


def test_value_adjustments_apply_in_order():
    out = roll_forward(
        PRIOR,
        prior_valuation_date="2026-01-01",
        new_valuation_date="2026-01-01",  # no time gap
        annual_accretion=0.0,
        value_adjustments=[{"label": "down round markdown", "pct": -0.30}],
    )
    assert out["rolled_equity_value"] == pytest.approx(7_000_000.0)


def test_material_change_detection():
    out = roll_forward(
        PRIOR,
        prior_valuation_date="2026-01-01",
        new_valuation_date="2026-04-01",
        annual_accretion=0.1,
        prior_inputs={"revenue": 1_000_000, "shares_outstanding_common": 7_000_000},
        updated_inputs={"revenue": 1_500_000, "shares_outstanding_common": 8_000_000},
    )
    fields = {c["field"]: c for c in out["material_changes"]}
    assert fields["revenue"]["material"] is True
    assert fields["revenue"]["delta_pct"] == pytest.approx(0.5)
    assert fields["shares_outstanding_common"]["material"] is True


def test_immaterial_revenue_move_flagged_nonmaterial():
    out = roll_forward(
        PRIOR,
        prior_valuation_date="2026-01-01",
        new_valuation_date="2026-02-01",
        annual_accretion=0.1,
        prior_inputs={"revenue": 1_000_000},
        updated_inputs={"revenue": 1_050_000},  # +5% < 20% threshold
    )
    rev = next(c for c in out["material_changes"] if c["field"] == "revenue")
    assert rev["material"] is False
    assert out["requires_full_revaluation"] is False


def test_validation_and_endpoint():
    with pytest.raises(EngineInputError):
        roll_forward(PRIOR, prior_valuation_date="2026-06-01", new_valuation_date="2026-01-01")
    with pytest.raises(EngineInputError):
        roll_forward({"results": {"equity_value": 0}}, prior_valuation_date="2025-01-01", new_valuation_date="2026-01-01")

    r = client.post(
        "/engine/v1/rollforward",
        json={
            "prior_results": PRIOR,
            "prior_valuation_date": "2025-07-20",
            "new_valuation_date": "2026-07-20",
            "annual_accretion": 0.2,
        },
    )
    assert r.status_code == 200
    assert r.json()["rolled_equity_value"] > 10_000_000

    bad = client.post(
        "/engine/v1/rollforward",
        json={"prior_results": {"results": {"equity_value": 0}}, "prior_valuation_date": "2025-01-01", "new_valuation_date": "2026-01-01"},
    )
    assert bad.status_code == 422


# ── Non-finite / out-of-range guards ─────────────────────────────────────────
# Every figure below is multiplied or added into the rolling equity value, so a
# NaN that slips past validation defeats the `<= 0` range guards downstream
# (`NaN <= 0` is False) and reaches the client as a 200 whose money fields are
# `null`. An accretion rate at or below -100% was worse still: `(1 + rate) **
# years` returns a *complex* number, which crashed `round()` as a 500.

BASE_ROLL = {
    "prior_results": PRIOR,
    "prior_valuation_date": "2025-01-01",
    "new_valuation_date": "2026-01-01",
}


def _post_raw(body: str):
    """POST a raw JSON body — `NaN`/`Infinity` are Python-JSON literals that
    `json.dumps` will not emit but `json.loads` (and therefore Starlette) accepts."""
    return client.post(
        "/engine/v1/rollforward", content=body, headers={"content-type": "application/json"}
    )


@pytest.mark.parametrize("rate", [-1.0, -1.5, -10.0])
def test_accretion_at_or_below_minus_100pct_is_rejected(rate):
    with pytest.raises(EngineInputError, match="greater than -1"):
        roll_forward(
            PRIOR,
            prior_valuation_date="2025-01-01",
            new_valuation_date="2026-01-01",
            annual_accretion=rate,
        )


def test_accretion_below_minus_100pct_is_a_400_not_a_500():
    # Regression: this produced a complex `factor`, and `round(complex)` raised
    # TypeError out of the handler as an opaque 500.
    r = client.post("/engine/v1/rollforward", json={**BASE_ROLL, "annual_accretion": -1.5})
    assert r.status_code == 422


def test_accretion_just_above_minus_100pct_still_computes():
    out = roll_forward(
        PRIOR,
        prior_valuation_date="2025-01-01",
        new_valuation_date="2026-01-01",
        annual_accretion=-0.99,
    )
    assert 0 < out["rolled_equity_value"] < 10_000_000


@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
def test_non_finite_accretion_is_rejected(literal):
    with pytest.raises(EngineInputError, match="annual_accretion must be finite"):
        roll_forward(
            PRIOR,
            prior_valuation_date="2025-01-01",
            new_valuation_date="2026-01-01",
            annual_accretion=float(literal.replace("Infinity", "inf")),
        )
    r = _post_raw(
        '{"prior_results": {"results": {"equity_value": 10000000}},'
        ' "prior_valuation_date": "2025-01-01", "new_valuation_date": "2026-01-01",'
        f' "annual_accretion": {literal}}}'
    )
    assert r.status_code == 422
    assert "finite" in r.text


def test_non_finite_prior_equity_is_rejected():
    with pytest.raises(EngineInputError, match="prior_results.equity_value must be finite"):
        roll_forward(
            {"results": {"equity_value": float("nan")}},
            prior_valuation_date="2025-01-01",
            new_valuation_date="2026-01-01",
        )
    r = _post_raw(
        '{"prior_results": {"results": {"equity_value": NaN}},'
        ' "prior_valuation_date": "2025-01-01", "new_valuation_date": "2026-01-01"}'
    )
    assert r.status_code == 422


def test_non_finite_new_round_post_money_is_rejected():
    with pytest.raises(EngineInputError, match="new_round_post_money must be finite"):
        roll_forward(
            PRIOR,
            prior_valuation_date="2025-01-01",
            new_valuation_date="2026-01-01",
            new_round_post_money=float("nan"),
        )


@pytest.mark.parametrize("field", ["pct", "amount"])
@pytest.mark.parametrize("bad", [float("nan"), float("inf")])
def test_non_finite_value_adjustment_is_rejected(field, bad):
    with pytest.raises(EngineInputError, match="must be finite"):
        roll_forward(
            PRIOR,
            prior_valuation_date="2025-01-01",
            new_valuation_date="2026-01-01",
            value_adjustments=[{"label": "down round", field: bad}],
        )


def test_overflow_to_infinity_is_rejected_not_serialised_as_null():
    # Each input is finite; only the product overflows.
    with pytest.raises(EngineInputError, match="not finite"):
        roll_forward(
            {"results": {"equity_value": 1e308}},
            prior_valuation_date="2025-01-01",
            new_valuation_date="2026-01-01",
            annual_accretion=0.0,
            value_adjustments=[{"label": "blow up", "pct": 1e308}],
        )


def test_corrupt_prior_discount_rate_names_the_field():
    # Falls back to reading the accretion rate off the prior result; a corrupt
    # one should be a 400 naming the field, not a ValueError escaping as a 500.
    with pytest.raises(EngineInputError, match="prior_results.approaches.income.discount_rate"):
        roll_forward(
            {"results": {"equity_value": 1e6, "approaches": {"income": {"discount_rate": "wat"}}}},
            prior_valuation_date="2025-01-01",
            new_valuation_date="2026-01-01",
        )


def test_no_money_field_is_ever_null_on_a_200():
    """The property the guards above exist to protect."""
    r = client.post("/engine/v1/rollforward", json={**BASE_ROLL, "annual_accretion": 0.25})
    assert r.status_code == 200
    body = r.json()
    for field in ("prior_equity_value", "rolled_equity_value", "annual_accretion"):
        assert isinstance(body[field], (int, float)), f"{field} came back as {body[field]!r}"


# ── The pre-populated inputs must actually reproduce the rolled value ─────────
#
# `pre_populated_inputs` is documented as "ready to hand to compute". It was
# not: `compute` backsolves whenever `last_round_price_per_share` is present and
# demotes `last_round_post_money` to a starting guess, so the prior round's
# price — carried forward untouched — discarded the whole roll-forward.

_PRIOR_INPUTS = {
    "valuation_date": "2025-01-01",
    "last_round_post_money": 10_000_000.0,
    "last_round_price_per_share": 1.25,
    "last_round_class": "Series A",
    "shares_outstanding_common": 8_000_000.0,
    "shares_outstanding_preferred": 2_000_000.0,
    "liquidation_preference": 2_500_000.0,
    "volatility": 0.6,
}
_PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 1.0,
    "weight_income": 0.0,
    "weight_market": 0.0,
    "dlom": 0.2,
    "dloc": 0.0,
}


def test_stale_round_price_is_dropped_from_pre_populated_inputs():
    out = roll_forward(
        {"results": {"equity_value": 10_000_000.0}},
        prior_valuation_date="2025-01-01",
        new_valuation_date="2026-01-01",
        prior_inputs=_PRIOR_INPUTS,
        annual_accretion=0.30,
    )
    pre = out["pre_populated_inputs"]
    assert "last_round_price_per_share" not in pre
    assert "last_round_class" not in pre
    # Everything else the prior run carried is still there.
    assert pre["shares_outstanding_common"] == 8_000_000.0
    assert pre["volatility"] == 0.6


def test_compute_on_pre_populated_inputs_reproduces_the_rolled_value():
    """The property the drop exists to protect."""
    from app.engine.compute import compute

    out = roll_forward(
        {"results": {"equity_value": 10_000_000.0}},
        prior_valuation_date="2025-01-01",
        new_valuation_date="2026-01-01",
        prior_inputs=_PRIOR_INPUTS,
        annual_accretion=0.30,
    )
    rolled = out["rolled_equity_value"]
    assert rolled == pytest.approx(10_000_000 * 1.30 ** (365 / 365.25), rel=1e-4)

    results = compute(_PARAMS, out["pre_populated_inputs"])["results"]
    assert results["equity_value"] == pytest.approx(rolled)
    assert results["approaches"]["opm_backsolve"]["method"] == "post_money"


def test_a_new_round_price_in_updated_inputs_is_kept():
    # A price supplied for the *new* date is a live market observation, not a
    # stale one, so the backsolve should still calibrate to it.
    out = roll_forward(
        {"results": {"equity_value": 10_000_000.0}},
        prior_valuation_date="2025-01-01",
        new_valuation_date="2026-01-01",
        prior_inputs=_PRIOR_INPUTS,
        updated_inputs={"last_round_price_per_share": 2.10},
        new_round_post_money=20_000_000.0,
    )
    pre = out["pre_populated_inputs"]
    assert pre["last_round_price_per_share"] == 2.10
    assert pre["last_round_class"] == "Series A"  # kept alongside the live price


def test_adjustments_survive_into_the_computed_value():
    # An impairment that compute silently ignored is the sharpest form of the
    # bug: the analyst marks the company down and the FMV does not move.
    from app.engine.compute import compute

    out = roll_forward(
        {"results": {"equity_value": 10_000_000.0}},
        prior_valuation_date="2025-01-01",
        new_valuation_date="2025-01-01",
        prior_inputs=_PRIOR_INPUTS,
        annual_accretion=0.0,
        value_adjustments=[{"label": "down round mark", "pct": -0.40}],
    )
    assert out["rolled_equity_value"] == pytest.approx(6_000_000.0)
    results = compute(_PARAMS, out["pre_populated_inputs"])["results"]
    assert results["equity_value"] == pytest.approx(6_000_000.0)
