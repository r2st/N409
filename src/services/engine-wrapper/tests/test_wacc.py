"""WACC / CAPM engine tests."""

import pytest
from fastapi.testclient import TestClient

from app.engine.errors import EngineInputError
from app.engine.wacc import (
    compute_wacc,
    relever_beta,
    risk_free_rate,
    size_premium,
    unlever_beta,
)
from app.main import app

client = TestClient(app)


def test_unlever_relever_are_inverse():
    bu = unlever_beta(1.6, 0.5, 0.21)
    assert relever_beta(bu, 0.5, 0.21) == pytest.approx(1.6)


def test_risk_free_interpolates_and_clamps():
    # Default curve: 2y = 0.044, 3y = 0.0425 → midpoint 2.5y = 0.04325.
    assert risk_free_rate(2.5) == pytest.approx(0.04325, abs=1e-6)
    assert risk_free_rate(0.1) == pytest.approx(0.0525)  # below shortest → clamp
    assert risk_free_rate(50) == pytest.approx(0.0470)  # beyond longest → clamp


def test_size_premium_tiers():
    assert size_premium(1e8)[0] == 0.0550  # micro
    assert size_premium(5e9)[0] == 0.0100  # mid
    assert size_premium(5e10)[0] == 0.0  # large


def test_capm_cost_of_equity_no_leverage():
    out = compute_wacc(
        unlevered_beta_input=1.0,
        target_debt_to_equity=0.0,
        risk_free_rate_override=0.04,
        equity_risk_premium=0.05,
        company_specific_premium=0.03,
    )
    # Ke = 0.04 + 1.0·0.05 + 0 + 0.03 = 0.12; no debt → WACC == Ke.
    assert out["cost_of_equity"] == pytest.approx(0.12)
    assert out["wacc"] == pytest.approx(0.12)
    assert out["weights"] == {"equity": 1.0, "debt": 0.0}


def test_wacc_blend_with_leverage():
    out = compute_wacc(
        unlevered_beta_input=1.0,
        target_debt_to_equity=1.0,
        tax_rate=0.21,
        risk_free_rate_override=0.04,
        equity_risk_premium=0.05,
        cost_of_debt=0.08,
    )
    relevered = 1.0 * (1 + 0.79 * 1.0)  # 1.79
    coe = 0.04 + relevered * 0.05
    after_tax_kd = 0.08 * 0.79
    expected = 0.5 * coe + 0.5 * after_tax_kd
    assert out["capm"]["beta_relevered"] == pytest.approx(1.79, abs=1e-4)
    assert out["after_tax_cost_of_debt"] == pytest.approx(after_tax_kd)
    assert out["wacc"] == pytest.approx(expected, abs=1e-6)


def test_comparable_betas_median_unlevered():
    comps = [
        {"ticker": "A", "beta": 1.2, "debt_to_equity": 0.0},
        {"ticker": "B", "beta": 1.6, "debt_to_equity": 0.5},
        {"ticker": "C", "beta": 2.0, "debt_to_equity": 1.0},
    ]
    out = compute_wacc(
        comparable_betas=comps,
        target_debt_to_equity=0.25,
        tax_rate=0.21,
        market_cap=1.5e8,  # micro tier
        forecast_horizon_years=5.0,
    )
    assert len(out["comparables"]) == 3
    assert out["capm"]["size_premium"] == 0.0550
    assert out["capm"]["risk_free_rate"] == pytest.approx(risk_free_rate(5.0))
    assert 0 < out["wacc"] < 1


def test_validation_errors():
    with pytest.raises(EngineInputError):
        compute_wacc(target_debt_to_equity=0.0)  # no beta source
    with pytest.raises(EngineInputError):
        compute_wacc(unlevered_beta_input=1.0, tax_rate=1.2)


def test_wacc_endpoint():
    r = client.post(
        "/engine/v1/wacc",
        json={"inputs": {"unlevered_beta_input": 1.0, "risk_free_rate_override": 0.04, "equity_risk_premium": 0.05}},
    )
    assert r.status_code == 200
    assert r.json()["cost_of_equity"] == pytest.approx(0.09)

    bad = client.post("/engine/v1/wacc", json={"inputs": {"unlevered_beta_input": 1.0, "bogus_key": 1}})
    assert bad.status_code == 422
