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


# ── Provider NaN handling ────────────────────────────────────────────────────
# `yfinance`'s `.info` is pandas-backed, so a metric the provider does not have
# for a ticker arrives as `nan`, not as an absent key. NaN passes every check
# meant to stop it — `float(nan)` succeeds and `isinstance(nan, float)` is True
# — so before `_safe_float` excluded it, one comp missing one multiple pulled
# the median for *every* comp to NaN and the endpoint answered 200 with null.

NAN = float("nan")


class NanInfoProvider:
    """A ticker whose enterpriseToRevenue is missing, pandas-style."""

    def __init__(self, missing_for=("DT",)):
        self.missing_for = set(missing_for)

    def prices(self, ticker, start, end):
        return [{"date": "2026-01-02", "open": 1.0, "high": 2.0, "low": 0.9, "close": 1.5}]

    def info(self, ticker):
        return {
            "enterpriseToRevenue": NAN if ticker in self.missing_for else 6.0,
            "enterpriseToEbitda": 15.0,
            "trailingPE": 20.0,
            "forwardPE": 18.0,
            "priceToSalesTrailing12Months": 5.0,
            "priceToBook": 3.0,
        }

    def financials(self, ticker):
        return {"market_cap": 1e9, "total_revenue": 2e8, "ebitda": 5e7, "beta": NAN}


def test_one_missing_multiple_does_not_poison_the_median():
    c = MarketFeedClient(provider=NanInfoProvider(missing_for=("DT",)))
    out = c.get_company_multiples(["DDOG", "DT", "NET"], metrics=["ev_revenue", "ev_ebitda"])

    # DDOG and NET both report 6.0; DT has no data. The median is theirs alone.
    assert out["median"]["ev_revenue"] == 6.0
    assert out["median"]["ev_ebitda"] == 15.0


def test_a_missing_multiple_is_reported_as_absent_not_as_nan():
    c = MarketFeedClient(provider=NanInfoProvider(missing_for=("DT",)))
    out = c.get_company_multiples(["DDOG", "DT"], metrics=["ev_revenue"])

    assert out["companies"]["DT"]["ev_revenue"] is None
    assert out["companies"]["DDOG"]["ev_revenue"] == 6.0


def test_every_ticker_missing_a_metric_omits_it_from_the_median():
    c = MarketFeedClient(provider=NanInfoProvider(missing_for=("DDOG", "DT")))
    out = c.get_company_multiples(["DDOG", "DT"], metrics=["ev_revenue", "ev_ebitda"])

    # No usable ev_revenue anywhere — omitted rather than reported as null.
    assert "ev_revenue" not in out["median"]
    assert out["median"]["ev_ebitda"] == 15.0


def test_nan_financials_are_dropped_rather_than_returned():
    c = MarketFeedClient(provider=NanInfoProvider())
    out = c.get_company_financials("DDOG")
    assert out["beta"] is None


def test_no_median_is_ever_nan_over_http():
    """The property the guard exists to protect, at the boundary."""
    import json
    import math as _math

    c = MarketFeedClient(provider=NanInfoProvider(missing_for=("DT",)))
    out = c.get_company_multiples(["DDOG", "DT"], metrics=["ev_revenue", "ev_ebitda"])
    for metric, value in out["median"].items():
        assert _math.isfinite(value), f"median[{metric}] is {value!r}"
    # And the payload is serialisable as strict JSON — NaN is not valid JSON.
    json.dumps(out, allow_nan=False)


# ── Request shape ────────────────────────────────────────────────────────────
# `tickers`/`metrics` used to be bare `list`s, which accept any element. The
# feed client memoizes on ("multiples", ticker, date), so a non-hashable
# element reached `key in self.cache` and took the request down with a 500 —
# a malformed body answered as a server fault. They are typed and bounded now,
# so the shape is rejected before any of that runs.


def test_market_feed_rejects_non_string_tickers():
    import app.main as main

    main._market_feed = MarketFeedClient(provider=StubProvider())
    # An unhashable element is the one that used to crash the memo lookup.
    unhashable = client.post("/engine/v1/market-feed", json={"kind": "multiples", "tickers": [[]]})
    assert unhashable.status_code == 422
    assert unhashable.json()["detail"][0]["loc"] == ["body", "tickers", 0]

    numeric = client.post("/engine/v1/market-feed", json={"kind": "multiples", "tickers": [1]})
    assert numeric.status_code == 422


def test_market_feed_bounds_the_ticker_list():
    import app.main as main

    stub = StubProvider()
    main._market_feed = MarketFeedClient(provider=stub)
    over = client.post(
        "/engine/v1/market-feed", json={"kind": "multiples", "tickers": ["DDOG"] * 51}
    )
    assert over.status_code == 422
    # Refused before the client ran, so nothing was fetched.
    assert stub.calls["info"] == 0

    at_limit = client.post(
        "/engine/v1/market-feed", json={"kind": "multiples", "tickers": ["DDOG"] * 50}
    )
    assert at_limit.status_code == 200


def test_market_feed_bounds_the_metrics_list():
    import app.main as main

    main._market_feed = MarketFeedClient(provider=StubProvider())
    over = client.post(
        "/engine/v1/market-feed",
        json={"kind": "multiples", "tickers": ["DDOG"], "metrics": ["pe"] * 33},
    )
    assert over.status_code == 422

    ok = client.post(
        "/engine/v1/market-feed",
        json={"kind": "multiples", "tickers": ["DDOG"], "metrics": ["pe"]},
    )
    assert ok.status_code == 200
    assert ok.json()["metrics"] == ["pe"]
