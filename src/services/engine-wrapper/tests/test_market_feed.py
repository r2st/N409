"""Live market-feed client tests — stub providers, no network access."""

from fastapi.testclient import TestClient

from app.engine.market_feed import MarketFeedClient
from app.main import app

client = TestClient(app)


class StubProvider:
    """Records call counts so caching can be asserted."""

    def __init__(self):
        self.calls = {"prices": 0, "info": 0, "financials": 0}

    def prices(self, ticker, start, end):
        self.calls["prices"] += 1
        return [{"date": "2026-01-02", "open": 1.0, "high": 2.0, "low": 0.9, "close": 1.5}]

    def info(self, ticker):
        self.calls["info"] += 1
        base = {"DDOG": 6.0, "DT": 8.0}.get(ticker, 7.0)
        return {
            "trailingPE": 20.0,
            "forwardPE": 18.0,
            "priceToSalesTrailing12Months": 5.0,
            "priceToBook": 3.0,
            "enterpriseToEbitda": 15.0,
            "enterpriseToRevenue": base,
        }

    def financials(self, ticker):
        self.calls["financials"] += 1
        return {"market_cap": 1e9, "total_revenue": 2e8, "ebitda": 5e7, "beta": 1.1}


class BoomProvider:
    def prices(self, *a):
        raise RuntimeError("network down")

    def info(self, *a):
        raise RuntimeError("network down")

    def financials(self, *a):
        raise RuntimeError("network down")


def test_prices_and_caching():
    stub = StubProvider()
    c = MarketFeedClient(provider=stub)
    a = c.get_historical_prices("DDOG", "2026-01-01", "2026-02-01")
    b = c.get_historical_prices("DDOG", "2026-01-01", "2026-02-01")  # cache hit
    assert a["source"] == "yfinance"
    assert a == b
    assert stub.calls["prices"] == 1  # second call served from cache


def test_financials_passthrough():
    c = MarketFeedClient(provider=StubProvider())
    out = c.get_company_financials("DDOG")
    assert out["source"] == "yfinance"
    assert out["market_cap"] == 1e9
    assert out["beta"] == 1.1


def test_multiples_median_aggregation():
    c = MarketFeedClient(provider=StubProvider())
    out = c.get_company_multiples(["DDOG", "DT"], metrics=["ev_revenue", "ev_ebitda"])
    assert out["source"] == "yfinance"
    assert out["median"]["ev_revenue"] == 7.0  # median of 6 and 8
    assert out["median"]["ev_ebitda"] == 15.0


def test_no_provider_returns_fallback():
    c = MarketFeedClient(provider=None)  # explicitly disable the live source
    out = c.get_company_financials("DDOG", fallback={"beta": 1.3})
    assert out["source"] == "fallback"
    assert "yfinance not installed" in out["warning"]
    assert out["beta"] == 1.3  # LLM-estimated fallback surfaced


def test_provider_error_falls_back():
    c = MarketFeedClient(provider=BoomProvider())
    out = c.get_historical_prices("DDOG", "2026-01-01", "2026-02-01", fallback={"prices": []})
    assert out["source"] == "fallback"
    assert "network down" in out["warning"]


def test_unknown_metric_falls_back():
    c = MarketFeedClient(provider=StubProvider())
    out = c.get_company_multiples(["DDOG"], metrics=["bogus"])
    assert out["source"] == "fallback"


def test_market_feed_endpoint_prices():
    # Swap the shared app client's provider for a stub so the route is exercised
    # without a network dependency.
    import app.main as main

    main._market_feed = MarketFeedClient(provider=StubProvider())
    r = client.post(
        "/engine/v1/market-feed",
        json={"kind": "prices", "ticker": "DDOG", "start": "2026-01-01", "end": "2026-02-01"},
    )
    assert r.status_code == 200
    assert r.json()["source"] == "yfinance"

    bad = client.post("/engine/v1/market-feed", json={"kind": "prices", "ticker": "DDOG"})
    assert bad.status_code == 422

    unknown = client.post("/engine/v1/market-feed", json={"kind": "bogus"})
    assert unknown.status_code == 422


def test_market_feed_endpoint_multiples_and_financials():
    import app.main as main

    main._market_feed = MarketFeedClient(provider=StubProvider())
    m = client.post("/engine/v1/market-feed", json={"kind": "multiples", "tickers": ["DDOG", "DT"]})
    assert m.status_code == 200
    assert m.json()["median"]["ev_revenue"] == 7.0

    f = client.post("/engine/v1/market-feed", json={"kind": "financials", "ticker": "DDOG"})
    assert f.status_code == 200
    assert f.json()["beta"] == 1.1
