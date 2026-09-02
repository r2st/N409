"""Live market-feed client tests — stub providers, no network access."""

import threading
import time

import pytest
from fastapi.testclient import TestClient

from app.engine.market_feed import (
    FETCH_TIMEOUT_ENV,
    FETCH_TIMEOUT_S,
    MULTIPLES_BUDGET_ENV,
    MULTIPLES_BUDGET_S,
    MarketFeedClient,
    fetch_timeout_seconds,
    multiples_budget_seconds,
)
from app.engine.market_universe import set_client
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


@pytest.fixture()
def route_provider():
    """Install a stub behind the route's shared client, and take it out again.

    The endpoint reads the process-wide client, so a test that swaps one in and
    walks away leaves every later test talking to its stub. Yields the provider
    so call counts stay assertable.
    """

    def install(provider=None):
        stub = provider if provider is not None else StubProvider()
        set_client(MarketFeedClient(provider=stub))
        return stub

    yield install
    set_client(None)


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
    assert "no market-data provider" in out["warning"]
    assert out["beta"] == 1.3  # LLM-estimated fallback surfaced


def test_provider_error_falls_back():
    c = MarketFeedClient(provider=BoomProvider())
    out = c.get_historical_prices("DDOG", "2026-01-01", "2026-02-01", fallback={"prices": []})
    assert out["source"] == "fallback"
    assert "network down" in out["warning"]


class EmptyPricesProvider:
    """yfinance for a symbol it does not carry: an empty frame, not an error."""

    def __init__(self):
        self.calls = 0

    def prices(self, ticker, start, end):
        self.calls += 1
        return []


def test_an_empty_price_series_is_a_fallback_not_an_observation():
    """`Ticker("NOTREAL").history(...)` returns nothing and raises nothing, so a
    delisted ticker used to come back as `source: "yfinance"` with `prices: []`
    — a 200 labelled observed, with nothing observed in it. That label is what
    the valuation service counts as `outcome="observed"` and what
    `routes/asc718.ts` then contradicted four lines later by returning its own
    `source: 'fallback'`."""
    c = MarketFeedClient(provider=EmptyPricesProvider())
    out = c.get_historical_prices("NOTREAL", "2026-01-01", "2026-02-01")
    assert out["source"] == "fallback"
    assert "NOTREAL" in out["warning"]
    assert "2026-01-01" in out["warning"] and "2026-02-01" in out["warning"]


def test_an_empty_price_series_reaches_the_log(caplog):
    """The fallback log line is the only record this tier emits about a feed
    that is not answering, and this branch went straight past it."""
    c = MarketFeedClient(provider=EmptyPricesProvider())
    with caplog.at_level("WARNING"):
        c.get_historical_prices("NOTREAL", "2026-01-01", "2026-02-01")
    events = [r for r in caplog.records if getattr(r, "event", None) == "market_feed_fallback"]
    assert len(events) == 1
    assert events[0].ticker == "NOTREAL"
    assert events[0].feed_kind == "prices"


def test_an_empty_price_series_is_not_memoised():
    """Every other fallback branch is uncached, and a ticker the source did not
    carry this minute may be one it carries next week."""
    stub = EmptyPricesProvider()
    c = MarketFeedClient(provider=stub)
    c.get_historical_prices("NOTREAL", "2026-01-01", "2026-02-01")
    c.get_historical_prices("NOTREAL", "2026-01-01", "2026-02-01")
    assert stub.calls == 2


def test_the_callers_own_figures_still_ride_the_fallback():
    c = MarketFeedClient(provider=EmptyPricesProvider())
    out = c.get_historical_prices(
        "NOTREAL", "2026-01-01", "2026-02-01", fallback={"prices": [{"date": "x"}]}
    )
    assert out["source"] == "fallback"
    assert out["prices"] == [{"date": "x"}]


def test_the_callers_figures_cannot_relabel_themselves_as_observed():
    """`fallback` carries estimates, not this module's verdict on itself.

    It was spread over the payload rather than under it, so a caller sending
    `{"source": "yfinance"}` got a 200 saying its own numbers had been observed
    at the provider, with the warning that says otherwise erased. Every reader
    of that label believes it: R382 made `source` what
    `market_feed_answers_total` classifies on, so the series an alert on a dead
    market feed is written against would have counted this as a live answer,
    and the three Node routes would have put the numbers into a valuation as
    live comparable data.
    """
    c = MarketFeedClient(provider=EmptyPricesProvider())
    out = c.get_historical_prices(
        "NOTREAL",
        "2026-01-01",
        "2026-02-01",
        fallback={"source": "yfinance", "warning": None, "prices": [{"date": "x"}]},
    )
    assert out["source"] == "fallback"
    assert out["warning"] and "NOTREAL" in out["warning"]
    # The figures themselves still ride out — that is what `fallback` is for.
    assert out["prices"] == [{"date": "x"}]


def test_a_financials_answer_with_missing_fields_is_still_an_observation():
    """Only the price series is asked this question. A provider that carries
    EBITDA for one issuer and not the next is ordinary, and calling that a
    market-data outage would make the counter useless."""

    class SparseProvider:
        def financials(self, ticker):
            return {"market_cap": None, "beta": None}

    out = MarketFeedClient(provider=SparseProvider()).get_company_financials("DDOG")
    assert out["source"] == "yfinance"


def test_unknown_metric_falls_back():
    c = MarketFeedClient(provider=StubProvider())
    out = c.get_company_multiples(["DDOG"], metrics=["bogus"])
    assert out["source"] == "fallback"


def test_a_fallback_says_so_in_the_log_not_only_in_the_payload(caplog):
    """A market-data outage has to be visible to somebody who is not an analyst.

    R305, methodology M11. Every failure this module can have becomes a 200
    carrying ``source: "fallback"`` — which is the right answer to give a
    valuation, and was until now the only record that anything had gone wrong.
    The HTTP layer sees a success, the Node caller drops the payload into a
    per-ticker "unavailable" list, and that list is read by an analyst on a
    screen. Nothing at any tier logged, so yfinance being unreachable looked
    exactly like a peer set of tickers nobody carries prices for.
    """
    c = MarketFeedClient(provider=BoomProvider())
    with caplog.at_level("WARNING", logger="market_feed"):
        out = c.get_historical_prices("DDOG", "2026-01-01", "2026-02-01")

    assert out["source"] == "fallback"
    records = [r for r in caplog.records if getattr(r, "event", None) == "market_feed_fallback"]
    assert len(records) == 1
    # The two labels that separate one dead ticker from a dead source, and the
    # provider's own words — which belong here rather than only on a screen.
    # `detail` because the formatter's allowlist names it and redacts it; a
    # key it does not name is dropped in silence.
    assert records[0].feed_kind == "prices"
    assert records[0].ticker == "DDOG"
    assert "network down" in records[0].detail


def test_a_missing_provider_is_logged_too(caplog):
    """The other branch, and the one a misbuilt image reaches on every call.

    ``yfinance`` is a declared requirement, so a deployment with no provider is
    broken rather than configured that way — and it degrades every volatility
    estimate and every comparables refresh on the box, silently.
    """
    c = MarketFeedClient(provider=None)
    with caplog.at_level("WARNING", logger="market_feed"):
        c.get_company_financials("DDOG", fallback={"beta": 1.3})

    records = [r for r in caplog.records if getattr(r, "event", None) == "market_feed_fallback"]
    assert len(records) == 1
    assert records[0].feed_kind == "financials"
    assert records[0].ticker == "DDOG"
    assert "no market-data provider" in records[0].detail


def test_a_served_answer_logs_nothing():
    """The vacuity guard: a client that logged on every call would be noise.

    The rate is the diagnosis — one ticker the source does not carry has to
    look different from every ticker failing — which only holds if a healthy
    fetch is silent.
    """
    import logging

    c = MarketFeedClient(provider=StubProvider())
    seen = []
    handler = logging.Handler()
    handler.emit = seen.append
    log = logging.getLogger("market_feed")
    log.addHandler(handler)
    try:
        out = c.get_historical_prices("DDOG", "2026-01-01", "2026-02-01")
    finally:
        log.removeHandler(handler)

    assert out["source"] == "yfinance"
    assert [r for r in seen if getattr(r, "event", None) == "market_feed_fallback"] == []


def test_market_feed_endpoint_prices(route_provider):
    # Swap the shared client's provider for a stub so the route is exercised
    # without a network dependency.
    route_provider()
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


def test_market_feed_endpoint_multiples_and_financials(route_provider):
    route_provider()
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


def test_market_feed_rejects_non_string_tickers(route_provider):
    route_provider()
    # An unhashable element is the one that used to crash the memo lookup.
    unhashable = client.post("/engine/v1/market-feed", json={"kind": "multiples", "tickers": [[]]})
    assert unhashable.status_code == 422
    assert unhashable.json()["detail"][0]["loc"] == ["body", "tickers", 0]

    numeric = client.post("/engine/v1/market-feed", json={"kind": "multiples", "tickers": [1]})
    assert numeric.status_code == 422


def test_market_feed_bounds_the_ticker_list(route_provider):
    stub = route_provider()
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


def test_market_feed_bounds_the_metrics_list(route_provider):
    route_provider()
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


# ── Cache lifetime ───────────────────────────────────────────────────────────
# main.py holds one client for the life of the service, and the memo had
# neither an expiry nor a size bound. `get_company_multiples` keys on
# ("multiples", ticker, date) and its callers pass no date, so the first fetch
# of a ticker was replayed to every valuation for as long as the process lived
# — labelled `source: "yfinance"`, i.e. a report quoting a month-old multiple
# as observed market data. Nothing was ever evicted either, so every distinct
# (ticker, start, end) triple retained a price series for good.


class FakeClock:
    """A monotonic clock the test advances by hand."""

    def __init__(self):
        self.t = 1_000.0

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


def test_cached_entry_expires_and_is_refetched():
    clock = FakeClock()
    stub = StubProvider()
    c = MarketFeedClient(provider=stub, ttl_seconds=900.0, clock=clock)

    c.get_company_multiples(["DDOG"])
    clock.advance(899.0)
    c.get_company_multiples(["DDOG"])
    assert stub.calls["info"] == 1  # still inside the window

    clock.advance(2.0)
    c.get_company_multiples(["DDOG"])
    assert stub.calls["info"] == 2  # past it — the live source is consulted again


def test_expired_entry_does_not_linger_in_the_map():
    clock = FakeClock()
    c = MarketFeedClient(provider=StubProvider(), ttl_seconds=10.0, clock=clock)
    c.get_historical_prices("DDOG", "2026-01-01", "2026-02-01")
    assert len(c.cache) == 1
    clock.advance(11.0)
    c.get_historical_prices("DDOG", "2026-01-01", "2026-02-01")
    assert len(c.cache) == 1  # replaced, not accumulated


def test_cache_is_bounded_and_evicts_the_oldest():
    stub = StubProvider()
    c = MarketFeedClient(provider=stub, max_entries=3)
    for day in range(10):
        c.get_historical_prices("DDOG", f"2026-01-{day + 1:02d}", "2026-02-01")
    assert len(c.cache) == 3
    assert stub.calls["prices"] == 10

    # The three most recent windows are the ones retained.
    for day in (7, 8, 9):
        c.get_historical_prices("DDOG", f"2026-01-{day + 1:02d}", "2026-02-01")
    assert stub.calls["prices"] == 10
    # …and the oldest is gone, so asking again costs a fetch.
    c.get_historical_prices("DDOG", "2026-01-01", "2026-02-01")
    assert stub.calls["prices"] == 11


def test_a_read_refreshes_recency_but_not_expiry():
    clock = FakeClock()
    stub = StubProvider()
    c = MarketFeedClient(provider=stub, ttl_seconds=100.0, max_entries=2, clock=clock)
    c.get_company_financials("A")
    c.get_company_financials("B")
    clock.advance(50.0)
    c.get_company_financials("A")  # cache hit; must not extend A's life
    c.get_company_financials("C")  # evicts the oldest
    assert stub.calls["financials"] == 3

    clock.advance(51.0)
    c.get_company_financials("A")
    assert stub.calls["financials"] == 4  # A aged out on its original clock


def test_a_failed_fetch_is_not_cached():
    # The fallback path must stay out of the memo, or one blip is served for a
    # full TTL. BoomProvider raises every time; each call must reach it.
    c = MarketFeedClient(provider=BoomProvider())
    for _ in range(3):
        out = c.get_company_financials("DDOG")
        assert out["source"] == "fallback"
    assert c.cache == {}


# ── The fetch that never returns (R308, methodology M5) ──────────────────────
#
# Every other failure in this module arrives as an exception and is answered
# with a fallback. A hang arrives as nothing at all: `yfinance` is `requests`
# underneath with no timeout, so a black-holed socket holds the FastAPI
# threadpool slot the handler is running on, forever, and the Node caller's own
# 8-12s deadline turns that into one stranded thread per retry.


class HangingProvider:
    """A provider whose fetch does not come back until it is told to."""

    def __init__(self):
        self.released = threading.Event()
        self.entered = threading.Event()
        self.calls = 0

    def financials(self, ticker):
        self.calls += 1
        self.entered.set()
        self.released.wait(10.0)
        return {"market_cap": 1e9}

    def info(self, ticker):
        return self.financials(ticker)

    def prices(self, ticker, start, end):
        self.financials(ticker)
        return []


def test_a_hanging_fetch_is_abandoned_rather_than_waited_on():
    provider = HangingProvider()
    c = MarketFeedClient(provider=provider, fetch_timeout_s=0.1)
    try:
        out = c.get_company_financials("DDOG")
        assert out["source"] == "fallback"
        assert "abandoned" in out["warning"]
        # Not folded into the ordinary fetch-failure wording: the provider did
        # not refuse us, we stopped waiting, and the fallback rate is read by
        # whoever has to tell those two apart.
        assert "did not answer" in out["warning"]
    finally:
        provider.released.set()


def test_an_abandoned_fetch_leaves_nothing_in_the_memo():
    # Same rule as a failed one: a blip must not be served for a whole TTL, and
    # a straggler that eventually succeeds writes its own entry.
    provider = HangingProvider()
    c = MarketFeedClient(provider=provider, fetch_timeout_s=0.1)
    try:
        c.get_company_financials("DDOG")
        assert c.cache == {}
    finally:
        provider.released.set()


def test_stranded_fetches_are_capped_and_the_next_one_is_refused_at_once():
    from app.engine import market_feed as mf

    provider = HangingProvider()
    c = MarketFeedClient(provider=provider, fetch_timeout_s=0.05)
    try:
        # Fill every slot with a fetch that will not return. Distinct tickers so
        # the memo cannot answer any of them.
        for i in range(mf.MAX_INFLIGHT_FETCHES):
            assert c.get_company_financials(f"T{i}")["source"] == "fallback"
        assert provider.calls == mf.MAX_INFLIGHT_FETCHES

        # The next one is refused rather than queued — queueing would give back
        # the wait the deadline just took away.
        started = time.monotonic()
        out = c.get_company_financials("OVERFLOW")
        assert out["source"] == "fallback"
        assert "already in flight" in out["warning"]
        assert time.monotonic() - started < 0.05
        assert provider.calls == mf.MAX_INFLIGHT_FETCHES  # never reached the provider
    finally:
        provider.released.set()
        # The slots come back when the stragglers do.
        for _ in range(200):
            if mf._inflight._value == mf.MAX_INFLIGHT_FETCHES:
                break
            time.sleep(0.01)
        assert mf._inflight._value == mf.MAX_INFLIGHT_FETCHES


def test_a_provider_error_still_reads_as_a_failure_not_an_abandonment():
    # The bound runs the fetch on another thread; an exception raised there has
    # to arrive on this one, or every provider error becomes a timeout.
    c = MarketFeedClient(provider=BoomProvider(), fetch_timeout_s=5.0)
    out = c.get_company_financials("DDOG")
    assert out["source"] == "fallback"
    assert "fetch failed" in out["warning"]


def test_the_ceiling_can_be_turned_off():
    # An operator running a deliberately slow local source, per `limits.py`'s
    # own convention that 0 disables rather than refuses everything.
    provider = HangingProvider()
    c = MarketFeedClient(provider=provider, fetch_timeout_s=0)
    done = threading.Event()

    def call():
        c.get_company_financials("DDOG")
        done.set()

    threading.Thread(target=call, daemon=True).start()
    assert provider.entered.wait(2.0)
    assert not done.wait(0.2)  # still waiting, because nothing bounds it
    provider.released.set()
    assert done.wait(2.0)


def test_a_misconfigured_ceiling_falls_back_on_the_default(monkeypatch, caplog):
    monkeypatch.setenv(FETCH_TIMEOUT_ENV, "soon")
    with caplog.at_level("WARNING"):
        assert fetch_timeout_seconds() == FETCH_TIMEOUT_S
    assert any("MARKET_FEED_FETCH_TIMEOUT_S" in r.getMessage() for r in caplog.records)
    monkeypatch.setenv(FETCH_TIMEOUT_ENV, "-1")
    assert fetch_timeout_seconds() == FETCH_TIMEOUT_S
    monkeypatch.setenv(FETCH_TIMEOUT_ENV, "2.5")
    assert fetch_timeout_seconds() == 2.5


# ── The fan-out that multiplied the ceiling (R314, methodology M8) ────────────
#
# `FETCH_TIMEOUT_S` bounds one fetch. `get_company_multiples` makes one per
# ticker, in sequence, and `MAX_TICKERS` is 50 — so the bound multiplied and the
# request as a whole was still unbounded at 50 x 15s. See `MULTIPLES_BUDGET_S`.


class SlowInfoProvider:
    """A provider whose `info` costs a fixed amount of the test's fake clock."""

    def __init__(self, clock, cost=10.0):
        self.clock = clock
        self.cost = cost
        self.tickers = []

    def info(self, ticker):
        self.tickers.append(ticker)
        self.clock.advance(self.cost)
        return {"enterpriseToEbitda": 15.0, "enterpriseToRevenue": 7.0}

    def prices(self, ticker, start, end):
        return []

    def financials(self, ticker):
        return {}


def test_the_multiples_fan_out_stops_when_the_request_budget_is_spent():
    clock = FakeClock()
    provider = SlowInfoProvider(clock, cost=10.0)
    c = MarketFeedClient(
        provider=provider, clock=clock, fetch_timeout_s=0, multiples_budget_s=25.0
    )
    out = c.get_company_multiples(["A", "B", "C", "D", "E"], ["ev_ebitda"])

    # Three fetches: the third starts at t+20 with 5s of budget left, and the
    # fourth finds none. Without the budget all five would have been dialled.
    assert provider.tickers == ["A", "B", "C"]
    assert out["source"] == "yfinance"
    assert out["companies"]["A"]["ev_ebitda"] == 15.0
    # The ones past the budget are reported the same way a ticker the source
    # does not carry is — a warning, not a missing key and not a hard failure.
    assert "budget" in out["companies"]["D"]["warning"]
    assert "budget" in out["companies"]["E"]["warning"]
    # The median is struck over what was actually observed.
    assert out["median"]["ev_ebitda"] == 15.0


def test_a_ticker_already_in_the_memo_is_answered_after_the_budget_is_spent():
    # The budget bounds *fetching*, not answering: a cached entry costs nothing,
    # and refusing it would make the response worse for no saving at all.
    clock = FakeClock()
    provider = SlowInfoProvider(clock, cost=10.0)
    c = MarketFeedClient(
        provider=provider, clock=clock, ttl_seconds=900.0, fetch_timeout_s=0, multiples_budget_s=25.0
    )
    c.get_company_multiples(["E"], ["ev_ebitda"])  # warms the memo for E
    provider.tickers.clear()

    out = c.get_company_multiples(["A", "B", "C", "D", "E"], ["ev_ebitda"])
    assert provider.tickers == ["A", "B", "C"]
    assert out["companies"]["E"]["ev_ebitda"] == 15.0
    assert "warning" in out["companies"]["D"]


def test_the_last_admitted_fetch_cannot_overrun_the_budget():
    # Gating alone would let a fetch admitted with 1s left run the full
    # per-fetch ceiling, which is the overshoot the budget exists to remove.
    provider = HangingProvider()
    c = MarketFeedClient(provider=provider, fetch_timeout_s=30.0, multiples_budget_s=0.2)
    try:
        started = time.monotonic()
        out = c.get_company_multiples(["DDOG"], ["ev_ebitda"])
        elapsed = time.monotonic() - started
        assert elapsed < 5.0, f"clamped to the budget, not the 30s per-fetch ceiling ({elapsed}s)"
        assert out["source"] == "fallback"
    finally:
        provider.released.set()


def test_the_budget_can_be_turned_off():
    clock = FakeClock()
    provider = SlowInfoProvider(clock, cost=10.0)
    c = MarketFeedClient(provider=provider, clock=clock, fetch_timeout_s=0, multiples_budget_s=0)
    c.get_company_multiples(["A", "B", "C", "D", "E"], ["ev_ebitda"])
    assert provider.tickers == ["A", "B", "C", "D", "E"]


def test_a_misconfigured_budget_falls_back_on_the_default(monkeypatch, caplog):
    monkeypatch.setenv(MULTIPLES_BUDGET_ENV, "later")
    with caplog.at_level("WARNING"):
        assert multiples_budget_seconds() == MULTIPLES_BUDGET_S
    assert any("MARKET_FEED_MULTIPLES_BUDGET_S" in r.getMessage() for r in caplog.records)
    monkeypatch.setenv(MULTIPLES_BUDGET_ENV, "-1")
    assert multiples_budget_seconds() == MULTIPLES_BUDGET_S
    monkeypatch.setenv(MULTIPLES_BUDGET_ENV, "4")
    assert multiples_budget_seconds() == 4.0


def test_the_budget_is_shorter_than_the_callers_patience_times_the_ticker_cap():
    # The number that matters is not the budget on its own but the budget
    # against `MAX_TICKERS` — the product is what used to bound this request.
    from app.engine.market_data import MAX_TICKERS

    assert MULTIPLES_BUDGET_S < FETCH_TIMEOUT_S * MAX_TICKERS
