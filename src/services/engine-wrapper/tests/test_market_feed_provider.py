"""The yfinance-backed provider itself, and the feed client's edge payloads.

`test_market_feed.py` exercises `MarketFeedClient` against stub providers, which
is the right shape for the caching and fallback logic but leaves the one piece
that actually talks to the library — `YFinanceProvider`, and the
`default_provider()` that decides whether it exists at all — never executed. The
optional dependency is what makes that awkward: the module is written so the
service installs and runs without it, so a test that imports it for real is
testing the environment rather than the code.

So the library is a stub injected into `sys.modules`. That exercises the row
translation, the `.info` projection and the ImportError path deterministically,
on a machine with yfinance and on one without.
"""

import sys

import pytest

from app.engine.market_feed import (
    NO_PROVIDER_REASON,
    MarketFeedClient,
    YFinanceProvider,
    _drop_non_finite,
    _safe_float,
    default_provider,
    resolve_default_provider,
)


# ── A stand-in for the yfinance package ──────────────────────────────────────


class _Row(dict):
    """A pandas row is subscriptable by column label; a dict is enough."""


class _Index:
    """A pandas DatetimeIndex entry: has `.date()`."""

    def __init__(self, iso):
        self._iso = iso

    def date(self):
        return self._iso


class _History:
    def __init__(self, rows):
        self._rows = rows

    def iterrows(self):
        return iter(self._rows)


class _FakeTicker:
    def __init__(self, symbol, history_rows, info):
        self.symbol = symbol
        self._history_rows = history_rows
        self._info = info
        self.history_kwargs = None

    def history(self, **kwargs):
        self.history_kwargs = kwargs
        _FakeYFinance.last_history_kwargs = kwargs
        return _History(self._history_rows)

    @property
    def info(self):
        return dict(self._info)


class _FakeYFinance:
    """Module-shaped stub: exposes `Ticker`, like the real package."""

    last_history_kwargs: dict | None = None
    history_rows: list = []
    info_payload: dict = {}

    @classmethod
    def Ticker(cls, symbol):  # noqa: N802 - mirrors the library's spelling
        return _FakeTicker(symbol, cls.history_rows, cls.info_payload)


@pytest.fixture()
def fake_yfinance(monkeypatch):
    """Install the stub as `yfinance` for the duration of one test."""
    _FakeYFinance.last_history_kwargs = None
    _FakeYFinance.history_rows = [
        (_Index("2026-01-02"), _Row({"Open": 1.0, "High": 2.0, "Low": 0.9, "Close": 1.5})),
        (_Index("2026-01-03"), _Row({"Open": 1.5, "High": 2.5, "Low": 1.4, "Close": 2.0})),
    ]
    _FakeYFinance.info_payload = {
        "trailingPE": 20.0,
        "forwardPE": 18.0,
        "priceToSalesTrailing12Months": 5.0,
        "priceToBook": 3.0,
        "enterpriseToEbitda": 15.0,
        "enterpriseToRevenue": 6.0,
        "marketCap": 1e9,
        "totalRevenue": 2e8,
        "ebitda": 5e7,
        "totalDebt": 1e7,
        "totalCash": 3e7,
        "beta": 1.1,
    }
    monkeypatch.setitem(sys.modules, "yfinance", _FakeYFinance)
    return _FakeYFinance


# ── YFinanceProvider ─────────────────────────────────────────────────────────


def test_provider_translates_history_rows_to_plain_dicts(fake_yfinance):
    rows = YFinanceProvider().prices("DDOG", "2026-01-01", "2026-02-01")

    assert rows == [
        {"date": "2026-01-02", "open": 1.0, "high": 2.0, "low": 0.9, "close": 1.5},
        {"date": "2026-01-03", "open": 1.5, "high": 2.5, "low": 1.4, "close": 2.0},
    ]
    # Adjusted closes: a split or dividend must not read as a price move.
    assert fake_yfinance.last_history_kwargs["auto_adjust"] is True
    assert fake_yfinance.last_history_kwargs["start"] == "2026-01-01"
    assert fake_yfinance.last_history_kwargs["end"] == "2026-02-01"


def test_provider_handles_an_index_without_a_date_method(fake_yfinance):
    # Not every index yfinance returns is a DatetimeIndex — a plain-string one
    # has to survive rather than raise AttributeError mid-series.
    fake_yfinance.history_rows = [
        ("2026-01-02", _Row({"Open": 1.0, "High": 2.0, "Low": 0.9, "Close": 1.5}))
    ]
    rows = YFinanceProvider().prices("DDOG", "2026-01-01", "2026-02-01")
    assert rows[0]["date"] == "2026-01-02"


def test_provider_info_is_a_plain_dict_copy(fake_yfinance):
    info = YFinanceProvider().info("DDOG")
    assert info["trailingPE"] == 20.0
    info["trailingPE"] = 0.0  # mutating the copy must not touch the source
    assert YFinanceProvider().info("DDOG")["trailingPE"] == 20.0


def test_provider_financials_projects_the_six_fields(fake_yfinance):
    out = YFinanceProvider().financials("DDOG")
    assert out == {
        "market_cap": 1e9,
        "total_revenue": 2e8,
        "ebitda": 5e7,
        "total_debt": 1e7,
        "total_cash": 3e7,
        "beta": 1.1,
    }


def test_provider_financials_reports_absent_fields_as_none(fake_yfinance):
    fake_yfinance.info_payload = {"marketCap": 1e9}
    out = YFinanceProvider().financials("DDOG")
    assert out["market_cap"] == 1e9
    assert out["ebitda"] is None
    assert out["beta"] is None


# ── default_provider ─────────────────────────────────────────────────────────


def test_default_provider_returns_the_live_provider_when_importable(fake_yfinance):
    assert isinstance(default_provider(), YFinanceProvider)


def test_default_provider_is_none_when_the_library_is_absent(monkeypatch):
    # `sys.modules[name] = None` is how CPython records "this import fails",
    # so this reproduces an install without the optional `market` extra.
    monkeypatch.setitem(sys.modules, "yfinance", None)
    assert default_provider() is None


# ── Why there is no provider (R368, M5) ──────────────────────────────────────
#
# `default_provider` answered every one of these with `None`, and `_cached`
# then told the log and the analyst "yfinance not installed" about all of them.
# Three of the four are misbuilt boxes where the package is present, and the
# exception that said which was discarded before anything could read it.


def test_an_absent_library_names_the_module_that_is_missing(monkeypatch, caplog):
    monkeypatch.setitem(sys.modules, "yfinance", None)
    with caplog.at_level("WARNING", logger="market_feed"):
        provider, reason = resolve_default_provider()
    assert provider is None
    assert "could not be imported" in reason
    events = [r for r in caplog.records if getattr(r, "event", None) == "market_feed_provider_unavailable"]
    assert len(events) == 1
    assert events[0].detail == reason


def test_a_transitive_dependency_is_named_rather_than_yfinance(monkeypatch):
    """The commonest misbuild that is *not* an absent yfinance.

    yfinance imports pandas and numpy at module scope. With one of those gone
    the `ImportError` names it, not yfinance — and a message reading "yfinance
    not installed" sends the operator to look for a package that is sitting
    right there.
    """

    def _raise(*_a, **_k):
        raise ImportError("No module named 'pandas'")

    monkeypatch.setattr("builtins.__import__", _raise)
    provider, reason = resolve_default_provider()
    assert provider is None
    assert "pandas" in reason


def test_an_import_that_raises_something_other_than_import_error_says_so(monkeypatch, caplog):
    """A partial `pip install --upgrade` leaves numpy and pandas disagreeing
    about their C ABI, and the import raises `ValueError` out of the extension
    rather than `ImportError`. The bare `except Exception` that used to be here
    turned that into the same four words as an absent package.
    """

    def _raise(name, *_a, **_k):
        if name == "yfinance":
            raise ValueError("numpy.dtype size changed, may indicate binary incompatibility")
        return _real_import(name, *_a, **_k)

    _real_import = __import__
    monkeypatch.setattr("builtins.__import__", _raise)
    with caplog.at_level("WARNING", logger="market_feed"):
        provider, reason = resolve_default_provider()
    assert provider is None
    assert "ValueError" in reason
    assert "binary incompatibility" in reason
    assert [r for r in caplog.records if getattr(r, "event", None) == "market_feed_provider_unavailable"]


def test_the_reason_reaches_the_payload_the_analyst_reads(monkeypatch):
    """The whole point of carrying it: the fallback `warning` is rendered on a
    comparables screen, and it is where an operator first sees this at all.
    """

    def _raise(name, *_a, **_k):
        if name == "yfinance":
            raise ValueError("numpy.dtype size changed")
        return _real_import(name, *_a, **_k)

    _real_import = __import__
    monkeypatch.setattr("builtins.__import__", _raise)
    out = MarketFeedClient().get_company_financials("DDOG", fallback={"beta": 1.3})
    assert out["source"] == "fallback"
    assert "numpy.dtype size changed" in out["warning"]


def test_a_live_provider_carries_no_reason(fake_yfinance):
    # Vacuity guard: the assertions above would all pass against a resolver
    # that never returns a provider.
    provider, reason = resolve_default_provider()
    assert isinstance(provider, YFinanceProvider)
    assert reason == ""


def test_an_explicit_opt_out_is_not_reported_as_a_failure(fake_yfinance, caplog):
    """`MarketFeedClient(provider=None)` is a caller saying "no live source",
    which is how the whole test tree runs. It has no exception behind it, so it
    must neither quote one nor log.
    """
    with caplog.at_level("WARNING", logger="market_feed"):
        c = MarketFeedClient(provider=None)
    assert c.no_provider_reason == NO_PROVIDER_REASON
    assert "yfinance" not in c.no_provider_reason
    assert not [
        r for r in caplog.records if getattr(r, "event", None) == "market_feed_provider_unavailable"
    ]


def test_client_resolves_the_default_provider_when_none_is_passed(fake_yfinance):
    # `MarketFeedClient()` — no argument at all — must reach for the live
    # source; `MarketFeedClient(provider=None)` is the explicit opt-out, and
    # the sentinel exists to keep those two apart.
    assert isinstance(MarketFeedClient().provider, YFinanceProvider)
    assert MarketFeedClient(provider=None).provider is None


def test_client_end_to_end_over_the_stub_library(fake_yfinance):
    c = MarketFeedClient()
    prices = c.get_historical_prices("DDOG", "2026-01-01", "2026-02-01")
    assert prices["source"] == "yfinance"
    assert len(prices["prices"]) == 2

    fins = c.get_company_financials("DDOG")
    assert fins["market_cap"] == 1e9

    mult = c.get_company_multiples(["DDOG"], metrics=["pe"])
    assert mult["median"]["pe"] == 20.0


# ── Fallback payload shapes ──────────────────────────────────────────────────


def test_a_scalar_fallback_is_reported_under_estimated():
    # A Mapping fallback is merged into the payload; anything else is a single
    # estimated figure, and has to be labelled rather than dropped.
    c = MarketFeedClient(provider=None)
    out = c.get_company_financials("DDOG", fallback=1.35)
    assert out["source"] == "fallback"
    assert out["estimated"] == 1.35


def test_a_none_fallback_leaves_only_the_warning():
    c = MarketFeedClient(provider=None)
    out = c.get_company_financials("DDOG")
    assert set(out) == {"source", "warning"}


# ── Multiples across a partly-live ticker list ───────────────────────────────


class _PartialProvider:
    """Live for some tickers, broken for others — the realistic failure."""

    def __init__(self, broken=("DT",)):
        self.broken = set(broken)

    def info(self, ticker):
        if ticker in self.broken:
            raise RuntimeError(f"no data for {ticker}")
        return {"enterpriseToRevenue": 6.0, "trailingPE": 20.0}

    def prices(self, ticker, start, end):
        raise RuntimeError("not used")

    def financials(self, ticker):
        raise RuntimeError("not used")


def test_a_broken_ticker_is_reported_beside_the_live_ones():
    c = MarketFeedClient(provider=_PartialProvider(broken=("DT",)))
    out = c.get_company_multiples(["DDOG", "DT"], metrics=["ev_revenue"])

    assert out["source"] == "yfinance"  # DDOG came back, so the call stands
    assert out["companies"]["DDOG"]["ev_revenue"] == 6.0
    assert "no data for DT" in out["companies"]["DT"]["warning"]
    assert out["median"]["ev_revenue"] == 6.0  # DT contributes nothing


def test_every_ticker_broken_falls_back_wholesale():
    c = MarketFeedClient(provider=_PartialProvider(broken=("DDOG", "DT")))
    out = c.get_company_multiples(["DDOG", "DT"], fallback={"ev_revenue": 5.5})

    assert out["source"] == "fallback"
    assert "no live multiples available" in out["warning"]
    assert out["ev_revenue"] == 5.5


def test_an_empty_ticker_list_falls_back_rather_than_reporting_an_empty_median():
    # No tickers means no live data, which is the fallback condition — not a
    # 200 carrying an empty `median` that reads as "no multiples exist".
    c = MarketFeedClient(provider=_PartialProvider(broken=()))
    out = c.get_company_multiples([])
    assert out["source"] == "fallback"


# ── get_company_info ─────────────────────────────────────────────────────────


def test_company_info_passes_the_fallback_entry_straight_through():
    c = MarketFeedClient(provider=None)
    out = c.get_company_info("DDOG", fallback={"marketCap": 1e9})
    assert out["source"] == "fallback"
    assert out["marketCap"] == 1e9
    assert "ticker" not in out  # it is the fallback payload, not a live shape


def test_company_info_returns_the_whole_info_dict(fake_yfinance):
    out = MarketFeedClient().get_company_info("DDOG")
    assert out["ticker"] == "DDOG"
    assert out["info"]["marketCap"] == 1e9


def test_company_info_and_multiples_share_one_fetch(fake_yfinance):
    calls = []

    class Counting:
        def info(self, ticker):
            calls.append(ticker)
            return {"trailingPE": 20.0, "marketCap": 1e9}

        def prices(self, ticker, start, end):
            raise RuntimeError("not used")

        def financials(self, ticker):
            raise RuntimeError("not used")

    c = MarketFeedClient(provider=Counting())
    c.get_company_info("DDOG")
    c.get_company_multiples(["DDOG"], metrics=["pe"])
    assert calls == ["DDOG"]  # the universe refresh does not pay a second time


# ── Coercion helpers ─────────────────────────────────────────────────────────


def test_safe_float_rejects_what_cannot_be_a_multiple():
    assert _safe_float(None) is None
    assert _safe_float("n/a") is None  # ValueError
    assert _safe_float(object()) is None  # TypeError
    assert _safe_float(float("nan")) is None
    assert _safe_float(float("inf")) is None
    assert _safe_float("12.5") == 12.5  # a numeric string is still a number
    assert _safe_float(7) == 7.0


def test_drop_non_finite_accepts_a_non_mapping_pair_sequence():
    # Providers are injectable, so `financials` may return anything dict() can
    # build from. It must not raise on the way to the caller.
    assert _drop_non_finite([("beta", 1.1), ("ebitda", 5e7)]) == {"beta": 1.1, "ebitda": 5e7}


def test_drop_non_finite_leaves_non_numeric_fields_alone():
    out = _drop_non_finite({"beta": float("nan"), "currency": "USD", "shares": 10})
    assert out == {"beta": None, "currency": "USD", "shares": 10}
