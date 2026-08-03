"""Auto-engine wiring into /compute (auto_volatility / auto_wacc / auto_comparables)."""

import statistics

import pytest
from fastapi.testclient import TestClient

from app.engine.compute import compute
from app.main import app

client = TestClient(app)

VOL_COMPS = [
    {"ticker": "AAA", "prices": [100.0, 110.0, 105.0, 115.0, 120.0, 118.0, 125.0]},
    {"ticker": "BBB", "prices": [50.0, 55.0, 52.0, 58.0, 60.0, 59.0, 63.0]},
    {"ticker": "CCC", "prices": [200.0, 210.0, 205.0, 220.0, 224.0, 219.0, 230.0]},
]

PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 0.5,
    "weight_income": 0.25,
    "weight_market": 0.25,
    "dloc": 0.0,
    "dlom_method": "finnerty",
    "exit_timeline": "2029-06-30",
}


def _inputs(**overrides):
    base = {
        "valuation_date": "2026-06-30",
        "shares_outstanding_common": 7_000_000,
        "options_outstanding": 1_000_000,
        "shares_outstanding_preferred": 2_000_000,
        "liquidation_preference": 5_000_000,
        "risk_free_rate": 0.042,
        "cash": 1_500_000,
        "debt": 200_000,
        "last_round_post_money": 20_000_000,
        "volatility_comparables": VOL_COMPS,
        "wacc": {
            "unlevered_beta_input": 1.0,
            "risk_free_rate_override": 0.04,
            "equity_risk_premium": 0.05,
            "target_debt_to_equity": 0.0,
        },
        "income": {"free_cash_flows": [-500_000, 250_000, 1_200_000], "terminal_growth": 0.03},
        "market": {"metric": 4_000_000, "comparable_tickers": ["DDOG", "DT"], "multiple_metric": "ev_revenue"},
    }
    base.update(overrides)
    return base


def test_all_three_autopilots():
    res = compute(
        PARAMS, _inputs(), auto_volatility=True, auto_wacc=True, auto_comparables=True
    )["results"]
    auto = res["auto"]

    # Volatility estimated from comps and used in the allocation assumptions.
    rec = auto["volatility"]["recommended_volatility"]
    assert rec > 0
    assert res["assumptions"]["volatility"] == rec

    # WACC → income discount rate. Ke = 0.04 + 1·0.05 = 0.09.
    assert auto["wacc"]["wacc"] == pytest.approx(0.09)
    assert auto["wacc"]["used_manual_override"] is False

    # Comparables → market multiples (DDOG 14.2, DT 10.1 → median 12.15).
    assert auto["comparables"]["multiples"] == [14.2, 10.1]
    assert res["approaches"]["market"]["selected_multiple"] == pytest.approx(
        statistics.median([14.2, 10.1])
    )
    assert res["fmv_per_share"] > 0


def _all(**overrides):
    """All three flags on — the full-autopilot call used by the override tests."""
    return compute(
        PARAMS, _inputs(**overrides), auto_volatility=True, auto_wacc=True, auto_comparables=True
    )["results"]


def test_manual_volatility_overrides_auto():
    res = _all(volatility=0.65)
    assert res["assumptions"]["volatility"] == 0.65
    assert res["auto"]["volatility"]["method"] == "manual"


def test_manual_discount_rate_overrides_wacc():
    inp = _inputs()
    inp["income"] = {**inp["income"], "discount_rate": 0.30}
    res = compute(PARAMS, inp, auto_wacc=True, auto_volatility=True, auto_comparables=True)[
        "results"
    ]
    assert res["auto"]["wacc"]["used_manual_override"] is True
    # The manual rate (not the WACC) discounts the income approach.
    assert res["approaches"]["income"]["equity_value"] < res["approaches"]["opm_backsolve"]["equity_value"]


def test_manual_multiples_override_comparables():
    inp = _inputs()
    inp["market"] = {**inp["market"], "multiples": [5.0]}
    res = compute(PARAMS, inp, auto_comparables=True, auto_volatility=True, auto_wacc=True)[
        "results"
    ]
    assert res["auto"]["comparables"]["used_manual_override"] is True
    assert res["approaches"]["market"]["selected_multiple"] == 5.0


def test_flags_off_is_unchanged_and_no_auto_key():
    # Backward compatibility: with the flags off the autopilot never runs, so a
    # fully manual inputs set behaves exactly as before (no "auto" block).
    manual = _inputs(
        volatility=0.6,
        income={"free_cash_flows": [-500_000, 250_000, 1_200_000], "discount_rate": 0.25, "terminal_growth": 0.03},
        market={"metric": 4_000_000, "multiples": [6.0, 4.0]},
    )
    res = compute(PARAMS, manual)["results"]
    assert "auto" not in res
    assert res["assumptions"]["volatility"] == 0.6
    assert res["approaches"]["market"]["selected_multiple"] == statistics.median([6.0, 4.0])


def test_unknown_wacc_key_is_422():
    inp = _inputs()
    inp["wacc"] = {"bogus": 1}
    with pytest.raises(Exception) as exc:
        compute(PARAMS, inp, auto_wacc=True)
    assert "unknown wacc" in str(exc.value)


def test_compute_endpoint_with_flags():
    r = client.post(
        "/engine/v1/compute",
        json={
            "params": PARAMS,
            "inputs": _inputs(),
            "auto_volatility": True,
            "auto_wacc": True,
            "auto_comparables": True,
        },
    )
    assert r.status_code == 200
    res = r.json()["results"]
    assert res["auto"]["wacc"]["wacc"] == pytest.approx(0.09)
    assert res["fmv_per_share"] > 0


def test_auto_wacc_accepts_a_treasury_curve_the_way_json_delivers_it():
    # `inputs.wacc.treasury_curve` arrives through a JSON body, so its
    # maturities are strings. This whole call used to die inside the curve
    # interpolation on a float-vs-str comparison — a bare TypeError, which
    # /compute (catching only EngineInputError) returned as a 500.
    inputs = _inputs(
        wacc={
            "unlevered_beta_input": 1.0,
            "equity_risk_premium": 0.05,
            "treasury_curve": {"1": 0.04, "10": 0.05},
            "forecast_horizon_years": 5.5,
        }
    )
    res = compute(PARAMS, inputs, auto_volatility=True, auto_wacc=True, auto_comparables=True)["results"]
    # 5.5y sits halfway along a straight 1y→10y line: (0.04 + 0.05) / 2.
    assert res["auto"]["wacc"]["capm"]["risk_free_rate"] == pytest.approx(0.045)
    assert res["auto"]["wacc"]["wacc"] > 0
    assert res["fmv_per_share"] > 0


def test_auto_wacc_reports_a_malformed_curve_as_an_input_error_not_a_500():
    inputs = _inputs(wacc={"unlevered_beta_input": 1.0, "treasury_curve": []})
    res = client.post(
        "/engine/v1/compute",
        json={"params": PARAMS, "inputs": inputs, "auto_volatility": True, "auto_wacc": True, "auto_comparables": True},
    )
    assert res.status_code == 422
    assert "treasury_curve" in res.json()["detail"]


def test_auto_wacc_blames_the_wacc_inputs_not_the_discount_rate_when_it_overflows():
    # An overflowing build-up used to reach `income.discount_rate` as inf and be
    # rejected as *that* field being bad — naming an input the caller never sent.
    inputs = _inputs(
        wacc={
            "unlevered_beta_input": 1.0,
            "risk_free_rate_override": 0.04,
            "equity_risk_premium": 1e308,
            "target_debt_to_equity": 1e300,
        }
    )
    res = client.post(
        "/engine/v1/compute",
        json={"params": PARAMS, "inputs": inputs, "auto_volatility": True, "auto_wacc": True, "auto_comparables": True},
    )
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert "cost of equity" in detail
    assert "discount_rate" not in detail
