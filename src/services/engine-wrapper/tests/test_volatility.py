"""Volatility estimation engine tests."""

import math
import statistics

import pytest
from fastapi.testclient import TestClient

from app.engine.errors import EngineInputError
from app.engine.volatility import (
    estimate_volatility,
    ewma_volatility,
    historical_volatility,
    parkinson_volatility,
)
from app.main import app

client = TestClient(app)

PRICES = [100.0, 110.0, 105.0, 115.0, 120.0, 118.0, 125.0]


def _log_returns(prices):
    return [math.log(prices[i] / prices[i - 1]) for i in range(1, len(prices))]


def test_historical_matches_annualized_stdev():
    daily = statistics.stdev(_log_returns(PRICES))
    assert historical_volatility(PRICES, periods_per_year=1) == pytest.approx(daily)
    assert historical_volatility(PRICES) == pytest.approx(daily * math.sqrt(252))


def test_constant_ratio_series_has_zero_vol():
    steady = [100.0 * (1.05**i) for i in range(6)]  # constant log return
    assert historical_volatility(steady) == pytest.approx(0.0, abs=1e-9)


def test_ewma_weights_recent_returns():
    # A vol spike at the end should push EWMA above the equal-weighted estimate.
    calm = [100.0, 101.0, 100.5, 101.2, 100.8]
    spiked = calm + [130.0]
    assert ewma_volatility(spiked) > ewma_volatility(calm)
    with pytest.raises(EngineInputError):
        ewma_volatility(PRICES, lambda_=1.5)


def test_parkinson_uses_high_low_range():
    highs = [102.0, 111.0, 107.0]
    lows = [99.0, 104.0, 103.0]
    factor = 1.0 / (4.0 * math.log(2.0))
    daily_var = factor * statistics.fmean([math.log(h / low) ** 2 for h, low in zip(highs, lows)])
    assert parkinson_volatility(highs, lows) == pytest.approx(math.sqrt(daily_var) * math.sqrt(252))
    with pytest.raises(EngineInputError):
        parkinson_volatility([100.0], [100.0, 101.0])  # mismatched lengths


def test_estimate_aggregates_and_grades_confidence():
    comps = [
        {"ticker": "AAA", "prices": PRICES},
        {"ticker": "BBB", "prices": [50.0, 55.0, 52.0, 58.0, 60.0, 59.0, 63.0]},
        {"ticker": "CCC", "prices": [10.0, 10.5, 10.2, 10.8, 11.0, 10.9, 11.3]},
        {"ticker": "DDD", "prices": [200.0, 210.0, 205.0, 220.0, 224.0, 219.0, 230.0]},
        {"ticker": "EEE", "prices": [80.0, 84.0, 82.0, 88.0, 90.0, 89.0, 93.0]},
    ]
    out = estimate_volatility(comps, method="historical")
    vols = [c["volatility"] for c in out["companies"]]
    assert out["company_count"] == 5
    assert out["median_volatility"] == pytest.approx(statistics.median(vols), abs=1e-3)
    assert out["recommended_volatility"] == out["median_volatility"]
    assert out["confidence"] in ("high", "medium", "low")
    assert out["min_volatility"] <= out["median_volatility"] <= out["max_volatility"]


def test_manual_override_wins():
    out = estimate_volatility(
        [{"ticker": "AAA", "prices": PRICES}], method="historical", manual_override=0.55
    )
    assert out["method"] == "manual"
    assert out["recommended_volatility"] == 0.55
    assert out["confidence"] == "manual"
    # Override works even with no comparables at all.
    bare = estimate_volatility([], manual_override=0.7)
    assert bare["recommended_volatility"] == 0.7


def test_parkinson_requires_high_low_series():
    with pytest.raises(EngineInputError):
        estimate_volatility([{"ticker": "AAA", "prices": PRICES}], method="parkinson")


def test_bad_method_and_empty_comps():
    with pytest.raises(EngineInputError):
        estimate_volatility([{"prices": PRICES}], method="garch")
    with pytest.raises(EngineInputError):
        estimate_volatility([])


def test_volatility_endpoint():
    r = client.post(
        "/engine/v1/volatility",
        json={"comparables": [{"ticker": "AAA", "prices": PRICES}], "method": "historical"},
    )
    assert r.status_code == 200
    assert r.json()["recommended_volatility"] > 0

    bad = client.post("/engine/v1/volatility", json={"comparables": [], "method": "historical"})
    assert bad.status_code == 422
