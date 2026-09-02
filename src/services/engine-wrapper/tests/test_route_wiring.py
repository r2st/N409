"""Routes whose request fields reach the engine only by keyword.

Each of these routes unpacks a Pydantic model into an engine call by name. The
literal at the call site is the only thing tying a request field to the
argument it prices, so a rename on either side type-checks, imports and starts
clean — and fails on the first request. The engine functions themselves are
covered by their own suites; what is asserted here is the wiring, and the
mapping of the errors they raise onto a status code.
"""

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


# ── happy paths: the request reaches the engine with its fields intact ────────


def test_fund_calibrate_passes_all_seven_fields():
    body = {
        "round_price_per_share": 8.0,
        "total_equity_value": 100_000_000,
        "strike": 40_000_000,
        "time_to_exit_years": 4.0,
        "risk_free_rate": 0.04,
        "preferred_shares": 2_000_000,
        "fully_diluted_shares": 10_000_000,
    }
    res = client.post("/engine/v1/fund-calibrate", json=body)
    assert res.status_code == 200
    assert 0.01 < res.json()["implied_volatility"] < 5.0


def test_fund_calibrate_maps_an_engine_refusal_to_422():
    body = {
        "round_price_per_share": 10.0,
        "total_equity_value": 1e8,
        "strike": 4e7,
        "time_to_exit_years": 0.0,  # no time for the option to be worth anything
        "risk_free_rate": 0.04,
        "preferred_shares": 2e6,
        "fully_diluted_shares": 1e7,
    }
    assert client.post("/engine/v1/fund-calibrate", json=body).status_code == 422


def test_debt_valuation_passes_the_params_dict():
    res = client.post(
        "/engine/v1/debt-valuation",
        json={
            "instrument_type": "bond",
            "params": {
                "face": 1000,
                "coupon_rate": 0.05,
                "frequency": 2,
                "maturity_years": 5,
                "market_yield": 0.05,
            },
        },
    )
    assert res.status_code == 200
    assert res.json()["dirty_price"] == pytest.approx(1000, abs=1e-3)


def test_debt_rating_spread_upcases_the_rating_it_answers_with():
    res = client.post("/engine/v1/debt-rating-spread", json={"rating": "bbb"})
    assert res.status_code == 200
    body = res.json()
    assert body["rating"] == "BBB"
    assert body["spread"] > 0


def test_debt_rating_spread_maps_an_unknown_rating_to_422():
    assert client.post("/engine/v1/debt-rating-spread", json={"rating": "AAAA"}).status_code == 422


def test_emi_csop_passes_the_scheme_and_its_params():
    res = client.post(
        "/engine/v1/emi-csop",
        json={
            "scheme": "csop",
            "params": {
                "equity_value": 1_000_000.0,
                "total_shares": 100_000.0,
                "options_granted": 1_000.0,
                "exercise_price": 5.0,  # UMV is 10.00
            },
        },
    )
    assert res.status_code == 200
    assert res.json()["qualification"]["failed_checks"] == ["exercise_price_not_below_umv"]


# ── the dict-shaped bodies, where a bad key is a TypeError rather than ours ───


def test_projection_answers_an_unknown_assumption_with_422():
    # `project_financials(**inputs)` raises TypeError for a key it has no
    # parameter for. That is a request problem, not a server one, so it must
    # not surface as the 500 an unhandled TypeError would give.
    res = client.post(
        "/engine/v1/projection",
        json={"inputs": {"method": "growth", "years": 2, "base_revenue": 1000.0, "grwoth": 0.1}},
    )
    assert res.status_code == 422
    assert "invalid projection inputs" in res.json()["detail"]


def test_emi_csop_answers_a_missing_param_with_422():
    # `equity_value` and `total_shares` are required with no default, so the
    # omission a caller is most likely to make reached `share_values` as a bare
    # TypeError — outside the guard, which wrapped only the qualification half —
    # and came back a 500 with a stack trace in the log.
    res = client.post("/engine/v1/emi-csop", json={"scheme": "emi", "params": {}})
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert "invalid params for emi" in detail
    assert "equity_value" in detail and "total_shares" in detail


def test_emi_csop_answers_an_unknown_qualification_param_with_422():
    res = client.post(
        "/engine/v1/emi-csop",
        json={
            "scheme": "emi",
            "params": {"equity_value": 1e6, "total_shares": 100.0, "optoins_granted": 1.0},
        },
    )
    assert res.status_code == 422
    assert "invalid params for emi" in res.json()["detail"]


def test_debt_valuation_answers_a_missing_param_with_422():
    res = client.post(
        "/engine/v1/debt-valuation",
        json={"instrument_type": "bond", "params": {"face": 1000}},
    )
    assert res.status_code == 422
    detail = res.json()["detail"]
    # Named for the instrument the caller asked for, not for `yield_dcf`, and
    # it lists both what is missing and what a bond takes.
    assert detail.startswith("invalid params for bond:")
    assert "missing required inputs" in detail
    for field in ("coupon_rate", "frequency", "maturity_years", "market_yield"):
        assert field in detail
    assert "Accepted inputs:" in detail and "settlement_fraction" in detail


# ── market-feed: the per-kind required fields, checked before any fetch ───────


def test_market_feed_financials_needs_a_ticker():
    res = client.post("/engine/v1/market-feed", json={"kind": "financials"})
    assert res.status_code == 422
    assert res.json()["detail"] == "financials needs ticker"


def test_market_feed_multiples_needs_tickers():
    res = client.post("/engine/v1/market-feed", json={"kind": "multiples"})
    assert res.status_code == 422
    assert res.json()["detail"] == "multiples needs tickers"


def test_market_feed_prices_needs_the_whole_window():
    res = client.post("/engine/v1/market-feed", json={"kind": "prices", "ticker": "AAPL"})
    assert res.status_code == 422
    assert res.json()["detail"] == "prices needs ticker, start, end"
