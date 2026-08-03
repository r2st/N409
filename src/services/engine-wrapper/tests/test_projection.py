"""Projection engine tests."""

import pytest
from fastapi.testclient import TestClient

from app.engine.approaches import income_dcf
from app.engine.errors import EngineInputError
from app.engine.projection import (
    project_financials,
    terminal_value_exit_multiple,
    terminal_value_gordon,
)
from app.main import app

client = TestClient(app)


def test_growth_method_fcf_math():
    out = project_financials(
        method="growth",
        years=1,
        base_revenue=1000.0,
        revenue_growth=0.10,
        cogs_pct=0.60,
        opex_pct=0.20,
        da_pct=0.05,
        capex_pct=0.05,
        nwc_pct=0.10,
        prior_nwc=100.0,  # == base 1000 · 10%
        tax_rate=0.21,
    )
    row = out["projections"][0]
    assert row["revenue"] == pytest.approx(1100.0)
    assert row["cogs"] == pytest.approx(660.0)
    assert row["opex"] == pytest.approx(220.0)
    assert row["da"] == pytest.approx(55.0)
    ebit = 1100 - 660 - 220 - 55  # 165
    assert row["ebit"] == pytest.approx(ebit)
    nopat = ebit * 0.79
    delta_nwc = 110.0 - 100.0
    fcf = nopat + 55.0 - 55.0 - delta_nwc
    assert row["fcff"] == pytest.approx(fcf, abs=0.01)
    assert out["free_cash_flows"][0] == pytest.approx(fcf, abs=0.01)


def test_growth_compounds_revenue():
    out = project_financials(
        method="growth", base_revenue=100.0, revenue_growth=[0.1, 0.2], cogs_pct=0.5
    )
    revs = [p["revenue"] for p in out["projections"]]
    assert revs == pytest.approx([110.0, 132.0])


def test_driver_method_explicit_lines():
    out = project_financials(
        method="driver",
        revenue=[1000.0, 1200.0],
        cogs=[600.0, 700.0],
        opex=[200.0, 220.0],
        da=[50.0, 60.0],
        capex=[80.0, 90.0],
        nwc=[100.0, 130.0],
        prior_nwc=100.0,
        tax_rate=0.25,
    )
    assert out["years"] == 2
    y2 = out["projections"][1]
    ebit = 1200 - 700 - 220 - 60
    assert y2["ebit"] == pytest.approx(ebit)
    assert y2["delta_nwc"] == pytest.approx(30.0)


def test_terminal_value_helpers():
    assert terminal_value_gordon(100.0, 0.12, 0.02) == pytest.approx(100 * 1.02 / 0.10)
    assert terminal_value_exit_multiple(500.0, 8.0) == 4000.0
    with pytest.raises(EngineInputError):
        terminal_value_gordon(100.0, 0.02, 0.05)  # r <= g


def test_terminal_methods_in_projection():
    g = project_financials(
        method="growth", years=3, base_revenue=1000.0, revenue_growth=0.1, cogs_pct=0.5,
        da_pct=0.05, terminal_method="gordon", discount_rate=0.15, terminal_growth=0.03,
    )
    assert g["terminal_value"] is not None and g["terminal_value"] > 0
    x = project_financials(
        method="growth", years=3, base_revenue=1000.0, revenue_growth=0.1, cogs_pct=0.5,
        da_pct=0.05, terminal_method="exit_multiple", exit_multiple=10.0, exit_metric="ebitda",
    )
    assert x["terminal_value"] == pytest.approx(x["projections"][-1]["ebitda"] * 10.0)


def test_projection_feeds_income_dcf():
    proj = project_financials(
        method="growth", years=5, base_revenue=2000.0, revenue_growth=0.15,
        cogs_pct=0.55, opex_pct=0.25, da_pct=0.05, capex_pct=0.06, nwc_pct=0.08,
    )
    dcf = income_dcf(proj["free_cash_flows"], 0.18, 0.03)
    assert dcf["enterprise_value"] > 0


def test_validation_and_endpoint():
    with pytest.raises(EngineInputError):
        project_financials(method="growth")  # missing base_revenue/growth
    with pytest.raises(EngineInputError):
        project_financials(method="bogus", revenue=[1.0])

    r = client.post(
        "/engine/v1/projection",
        json={"inputs": {"method": "growth", "years": 3, "base_revenue": 1000, "revenue_growth": 0.1, "cogs_pct": 0.6}},
    )
    assert r.status_code == 200
    assert len(r.json()["free_cash_flows"]) == 3

    bad = client.post("/engine/v1/projection", json={"inputs": {"method": "growth"}})
    assert bad.status_code == 422


# ── Forecast horizon bounds ──────────────────────────────────────────────────


def test_forecast_horizon_is_capped():
    # `{"years": 3000000, "revenue_growth": 0}` is 122 bytes and was measured at
    # nine seconds and 3.6 GB resident, before the response was serialised.
    with pytest.raises(EngineInputError) as exc:
        project_financials(method="growth", years=3_000_000, base_revenue=1e6, revenue_growth=0.0)
    assert "years must be <=" in str(exc.value)


def test_flat_growth_does_not_escape_the_cap():
    # A *positive* growth rate overflows out of a long horizon on its own around
    # year 7,300, which made the horizon look bounded when it was not. A flat or
    # negative rate compounds to nothing and runs every year asked for.
    with pytest.raises(EngineInputError):
        project_financials(method="growth", years=500_000, base_revenue=1e6, revenue_growth=-0.01)


def test_a_long_but_defensible_horizon_still_projects():
    out = project_financials(
        method="growth", years=100, base_revenue=1_000_000, revenue_growth=0.05, cogs_pct=0.4
    )
    assert len(out["free_cash_flows"]) == 100
    assert out["years"] == 100


def test_driver_method_horizon_is_capped_too():
    with pytest.raises(EngineInputError):
        project_financials(method="driver", revenue=[1.0] * 101)


def test_non_integer_years_names_the_field():
    # `[rate] * 1.5` is a bare TypeError; the caller should be told which input
    # was wrong.
    with pytest.raises(EngineInputError) as exc:
        project_financials(method="growth", years=1.5, base_revenue=1e6, revenue_growth=0.1)
    assert "years" in str(exc.value)


def test_oversized_projection_answers_422_over_http():
    from fastapi.testclient import TestClient

    from app.main import app

    res = TestClient(app).post(
        "/engine/v1/projection",
        json={"inputs": {"method": "growth", "years": 5_000_000, "base_revenue": 1e6, "revenue_growth": 0.0}},
    )
    assert res.status_code == 422
    assert "years must be <=" in res.json()["detail"]
