"""A compounding factor that cannot be built is a bad input, not a 500.

`(1 + rate) ** periods` fails in two ways the bare operator does not report as
an input problem: a base <= 0 yields a complex number that dies frames later in
`round()`/`max()`, and an overflow raises OverflowError instead of returning
inf. Both used to escape the routes' `except EngineInputError` and surface as an
unhandled 500. These pin every call site on 422.
"""

import pytest
from fastapi.testclient import TestClient

from app.engine.compounding import compound_factor
from app.engine.errors import EngineInputError
from app.engine.fund_valuation import lp_waterfall, roll_forward_mark
from app.engine.pwerm import allocate_pwerm
from app.engine.rollforward import roll_forward
from app.main import app

client = TestClient(app)

CAP_TABLE = [{"name": "Common", "kind": "common", "shares": 1_000_000}]


# ── The helper itself ────────────────────────────────────────────────────────


def test_compound_factor_matches_the_operator_in_the_normal_range():
    assert compound_factor(0.25, 3.0, "rate") == pytest.approx(1.25**3)
    assert compound_factor(-0.5, 2.0, "rate") == pytest.approx(0.25)
    assert compound_factor(0.0, 0.0, "rate") == 1.0


def test_compound_factor_rejects_a_base_at_or_below_zero():
    # `(-1.0) ** 0.5` is complex, not an error — it has to be caught here.
    with pytest.raises(EngineInputError, match="greater than -1"):
        compound_factor(-2.0, 0.5, "accretion_rate")
    with pytest.raises(EngineInputError, match="greater than -1"):
        compound_factor(-1.0, 3.0, "accretion_rate")


def test_compound_factor_rejects_an_overflowing_rate():
    with pytest.raises(EngineInputError, match="too large to compound"):
        compound_factor(1e200, 3.0, "discount_rate")


def test_compound_factor_message_names_the_offending_field():
    with pytest.raises(EngineInputError, match="preferred_return_rate"):
        compound_factor(1e300, 2.0, "preferred_return_rate")


def test_compound_factor_rejects_non_finite_arguments():
    with pytest.raises(EngineInputError, match="finite"):
        compound_factor(float("nan"), 1.0, "rate")
    with pytest.raises(EngineInputError, match="finite"):
        compound_factor(0.1, float("inf"), "rate")


# ── PWERM discount factor ────────────────────────────────────────────────────


def test_pwerm_rejects_an_overflowing_discount_rate():
    scenarios = [
        {"probability": 1.0, "equity_value": 1_000_000, "time_to_exit_years": 3, "discount_rate": 1e300}
    ]
    with pytest.raises(EngineInputError, match="discount_rate"):
        allocate_pwerm(scenarios, CAP_TABLE, default_discount_rate=0.25)


def test_api_pwerm_overflowing_discount_rate_is_422_not_500():
    inputs = {
        "shares_outstanding_common": 1_000_000,
        "share_classes": CAP_TABLE,
        "pwerm": {
            "scenarios": [
                {
                    "probability": 1.0,
                    "equity_value": 1_000_000,
                    "time_to_exit_years": 3,
                    "discount_rate": 1e300,
                }
            ]
        },
    }
    resp = client.post(
        "/engine/v1/compute",
        json={"params": {"allocation_method": "pwerm", "dloc": 0.0, "dlom": 0.0}, "inputs": inputs},
    )
    assert resp.status_code == 422, resp.text
    assert "discount_rate" in resp.json()["detail"]


# ── Fund roll-forward mark ───────────────────────────────────────────────────


def test_fund_roll_forward_rejects_a_rate_below_minus_one():
    with pytest.raises(EngineInputError, match="greater than -1"):
        roll_forward_mark(
            prior_fair_value=100.0, method="accretion", accretion_rate=-2.0, periods=0.5
        )


def test_fund_roll_forward_rejects_an_overflowing_rate():
    with pytest.raises(EngineInputError, match="too large to compound"):
        roll_forward_mark(
            prior_fair_value=100.0, method="accretion", accretion_rate=1e200, periods=3
        )


def test_api_fund_rollforward_complex_factor_is_422_not_500():
    resp = client.post(
        "/engine/v1/fund-rollforward",
        json={
            "prior_fair_value": 100.0,
            "method": "accretion",
            "accretion_rate": -2.0,
            "periods": 0.5,
        },
    )
    assert resp.status_code == 422, resp.text
    assert "accretion_rate" in resp.json()["detail"]


def test_fund_roll_forward_still_accretes_normally():
    out = roll_forward_mark(
        prior_fair_value=100.0, method="accretion", accretion_rate=0.1, periods=2
    )
    assert out["new_fair_value"] == pytest.approx(121.0)


# ── LP waterfall preferred return ────────────────────────────────────────────


def test_lp_waterfall_rejects_an_overflowing_preferred_return():
    with pytest.raises(EngineInputError, match="preferred_return_rate"):
        lp_waterfall(
            committed_capital=1e6,
            contributed_capital=1e6,
            distributable=1e6,
            preferred_return_rate=1e200,
            years=3,
        )


def test_api_fund_waterfall_overflowing_pref_is_422_not_500():
    resp = client.post(
        "/engine/v1/fund-waterfall",
        json={
            "committed_capital": 1_000_000,
            "contributed_capital": 1_000_000,
            "distributable": 1_000_000,
            "preferred_return_rate": 1e200,
            "years": 3,
        },
    )
    assert resp.status_code == 422, resp.text


# ── Valuation roll-forward accretion ─────────────────────────────────────────


# A one-year gap cannot overflow on its own — no finite rate raised to ~1 does.
# It takes a long gap and a rate that is a percentage where a fraction belongs,
# which is exactly the pairing a mistyped roll-forward produces.
def test_roll_forward_rejects_an_overflowing_accretion():
    with pytest.raises(EngineInputError, match="annual_accretion"):
        roll_forward(
            {"results": {"equity_value": 10_000_000.0}},
            prior_valuation_date="1900-01-01",
            new_valuation_date="2026-07-20",
            annual_accretion=2500.0,
        )


def test_api_roll_forward_overflowing_accretion_is_422_not_500():
    resp = client.post(
        "/engine/v1/rollforward",
        json={
            "prior_results": {"results": {"equity_value": 10_000_000.0}},
            "prior_valuation_date": "1900-01-01",
            "new_valuation_date": "2026-07-20",
            "annual_accretion": 2500.0,
        },
    )
    assert resp.status_code == 422, resp.text
    assert "annual_accretion" in resp.json()["detail"]


def test_roll_forward_still_accretes_over_a_long_gap():
    out = roll_forward(
        {"results": {"equity_value": 1_000_000.0}},
        prior_valuation_date="2016-07-20",
        new_valuation_date="2026-07-20",
        annual_accretion=0.10,
    )
    assert out["rolled_equity_value"] == pytest.approx(1_000_000 * 1.10**10, rel=1e-3)
