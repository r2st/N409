"""End-to-end compute + API contract tests."""

import pytest
from fastapi.testclient import TestClient

from app.engine.compute import compute
from app.engine.dlom import finnerty_dlom
from app.main import app

client = TestClient(app)

PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 0.6,
    "weight_income": 0.15,
    "weight_market": 0.25,
    "dloc": 0.1,
    "dlom_method": "finnerty",
    "exit_timeline": "2029-06-30",
}

INPUTS = {
    "valuation_date": "2026-06-30",
    "shares_outstanding_common": 7_000_000,
    "options_outstanding": 1_000_000,
    "shares_outstanding_preferred": 2_000_000,
    "liquidation_preference": 5_000_000,
    "volatility": 0.6,
    "risk_free_rate": 0.042,
    "cash": 1_500_000,
    "debt": 200_000,
    "last_round_post_money": 20_000_000,
    "income": {"free_cash_flows": [-500_000, 250_000, 1_200_000], "discount_rate": 0.3, "terminal_growth": 0.03},
    "market": {"metric": 4_000_000, "multiples": [6.0, 4.0]},
}


def test_full_compute_shape_and_weighting():
    out = compute(PARAMS, INPUTS)
    res = out["results"]
    assert out["engine_version"] == "py-1.0.0"

    a = res["approaches"]
    assert set(a) == {"opm_backsolve", "income", "market"}  # weight_asset=0 → skipped
    expected_equity = (
        0.6 * a["opm_backsolve"]["equity_value"]
        + 0.15 * a["income"]["equity_value"]
        + 0.25 * a["market"]["equity_value"]
    )
    assert res["equity_value"] == pytest.approx(expected_equity, abs=0.01)

    # T = 3 years exactly (2026-06-30 → 2029-06-30 = 1096 days / 365.25)
    assert res["assumptions"]["time_to_exit_years"] == pytest.approx(3.0, abs=0.01)

    # DLOM matches the Finnerty model at (σ=0.6, T≈3)
    assert res["discounts"]["dlom"] == pytest.approx(
        finnerty_dlom(0.6, res["assumptions"]["time_to_exit_years"]), abs=1e-4
    )

    # FMV consistency: common equity × (1−dloc)(1−dlom) / FD common
    fd = res["fully_diluted_common"]
    assert fd == 8_000_000
    expected_fmv = res["common_equity_value"] * 0.9 * (1 - res["discounts"]["dlom"]) / fd
    assert res["fmv_per_share"] == pytest.approx(expected_fmv, abs=1e-3)
    assert 0 < res["fmv_per_share"] < a["opm_backsolve"]["equity_value"] / fd


def test_opm_allocation_below_preference_is_option_value():
    # Equity barely above the preference: common keeps only option value.
    params = {**PARAMS, "weight_opm": 1.0, "weight_income": 0.0, "weight_market": 0.0}
    inputs = {**INPUTS, "last_round_post_money": 5_500_000}
    res = compute(params, inputs)["results"]
    assert res["allocation"]["method"] == "opm_single_breakpoint"
    assert res["allocation"]["upside_after_preference"] < 5_500_000
    assert res["fmv_per_share"] > 0


def test_no_preferred_means_full_allocation():
    params = {**PARAMS, "dlom_method": None, "dloc": 0}
    inputs = {
        **INPUTS,
        "shares_outstanding_preferred": 0,
        "liquidation_preference": 0,
        "options_outstanding": 0,
    }
    res = compute(params, inputs)["results"]
    assert res["allocation"]["method"] == "as_converted"
    assert res["common_equity_value"] == pytest.approx(res["equity_value"])
    # fmv_per_share is rounded to 4dp by the engine
    assert res["fmv_per_share"] == pytest.approx(res["equity_value"] / 7_000_000, abs=1e-3)


def test_qualitative_dlom_and_chaffee():
    q = compute({**PARAMS, "dlom_method": "qualitative", "dlom_qualitative": 0.25}, INPUTS)["results"]
    assert q["discounts"]["dlom"] == 0.25
    c = compute({**PARAMS, "dlom_method": "chaffee"}, INPUTS)["results"]
    f = compute({**PARAMS, "dlom_method": "finnerty"}, INPUTS)["results"]
    assert c["discounts"]["dlom"] > f["discounts"]["dlom"]


def test_missing_weights_and_inputs_are_422_through_api():
    r = client.post("/engine/v1/compute", json={"params": {}, "inputs": {}})
    assert r.status_code == 422
    assert "weights" in r.json()["detail"]

    r = client.post("/engine/v1/compute", json={"params": PARAMS, "inputs": {}})
    assert r.status_code == 422
    assert "last_round_post_money" in r.json()["detail"]

    no_vol = {**INPUTS}
    del no_vol["volatility"]
    r = client.post("/engine/v1/compute", json={"params": PARAMS, "inputs": no_vol})
    assert r.status_code == 422
    assert "volatility" in r.json()["detail"]


def test_bad_weight_sum_is_422():
    bad = {**PARAMS, "weight_opm": 0.7}
    with pytest.raises(Exception) as exc:
        compute(bad, INPUTS)
    assert "sum to 1.0" in str(exc.value)


def test_compute_via_api_matches_direct_call():
    r = client.post("/engine/v1/compute", json={"params": PARAMS, "inputs": INPUTS})
    assert r.status_code == 200
    assert r.json()["results"]["fmv_per_share"] == compute(PARAMS, INPUTS)["results"]["fmv_per_share"]


def test_engine_health_contract():
    r = client.get("/engine/v1/health")
    assert r.status_code == 200
    body = r.json()
    assert body["contract"] == "engine/v1"
    assert body["engine_version"] == "py-1.0.0"
