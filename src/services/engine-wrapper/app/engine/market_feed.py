"""Live market-data feed — real comparable-company data with graceful fallback.

Complements the curated static reference set in ``market_data.py`` (which
verifies AI-proposed tickers offline). This module fetches *live* guideline-
public-company data — historical prices, financials, trading multiples, market
cap — to feed the volatility, WACC and market-multiple engines from real
figures when a network source is available.

Design principles (features.md — market data integration):

- **Optional provider.** ``yfinance`` is imported lazily. If it is not
  installed or not reachable, the client still works: every method returns a
  fallback payload instead of raising, so the pipeline never hard-fails on a
  missing data source. This keeps the whole service installable and testable
  without the network dependency.
- **Caching.** Results are memoized by (method, args) so repeated engine passes
  in a single valuation don't re-hit the API. The cache is an injectable
  dict-like object, so a shared/persistent store can be swapped in.
- **Fallback with warning flag.** When the source is unavailable or errors, the
  caller-supplied fallback (typically LLM-estimated values) is returned with
  ``source == "fallback"`` and a human-readable ``warning`` so downstream code
  and the UI can flag that the numbers are estimates, not observed market data.

The provider is an injectable object implementing ``prices``, ``financials``
and ``info``; the default is the yfinance-backed one, and tests inject a stub.
"""

from __future__ import annotations

import math
import time
from collections.abc import Mapping

__all__ = ["MarketFeedClient", "YFinanceProvider", "default_provider", "UNSET"]

# Multiples we know how to read off a yfinance ``info`` dict.
_INFO_MULTIPLE_KEYS = {
    "pe": "trailingPE",
    "forward_pe": "forwardPE",
    "ps": "priceToSalesTrailing12Months",
    "pb": "priceToBook",
    "ev_ebitda": "enterpriseToEbitda",
    "ev_revenue": "enterpriseToRevenue",
}


class _Unset:
    """Sentinel so ``MarketFeedClient()`` resolves the live provider while
    ``MarketFeedClient(provider=None)`` explicitly forces the fallback path."""

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return "<UNSET>"


UNSET = _Unset()


class YFinanceProvider:
    """Live provider backed by the ``yfinance`` package (imported lazily)."""

    def __init__(self) -> None:
        import yfinance  # type: ignore  # noqa: F401  (optional dep; raises ImportError if unavailable)

        self._yf = yfinance

    def prices(self, ticker: str, start: str, end: str) -> list[dict]:
        hist = self._yf.Ticker(ticker).history(start=start, end=end, auto_adjust=True)
        rows: list[dict] = []
        for idx, row in hist.iterrows():
            rows.append(
                {
                    "date": str(idx.date()) if hasattr(idx, "date") else str(idx),
                    "open": float(row["Open"]),
                    "high": float(row["High"]),
                    "low": float(row["Low"]),
                    "close": float(row["Close"]),
                }
            )
        return rows

    def info(self, ticker: str) -> dict:
        return dict(self._yf.Ticker(ticker).info)

    def financials(self, ticker: str) -> dict:
        info = dict(self._yf.Ticker(ticker).info)
        return {
            "market_cap": info.get("marketCap"),
            "total_revenue": info.get("totalRevenue"),
            "ebitda": info.get("ebitda"),
            "total_debt": info.get("totalDebt"),
            "total_cash": info.get("totalCash"),
            "beta": info.get("beta"),
        }


def default_provider():
    """The yfinance provider if the library is importable, else None."""
    try:
        return YFinanceProvider()
    except Exception:
        return None


# How long a memoized fetch stays usable, and how many are kept.
#
# The memo is there so repeated engine passes within one valuation don't re-hit
# the API — a horizon of minutes, not of process lifetime. It had neither bound
# before, and `main.py` holds a single client for the life of the service, so
# both ends went wrong. An entry never expired: `get_company_multiples` keys on
# ("multiples", ticker, date) and the callers pass no date, so the first fetch
# of a ticker was served to every valuation for as long as the process lived,
# labelled `source: "yfinance"` — a report built next month quoting last
# month's multiples as observed market data. And an entry was never evicted:
# every distinct (ticker, start, end) triple retained a whole price series, so
# the resident set only grew.
#
# Fifteen minutes is well past a single valuation run and well inside a trading
# session. 256 entries covers a busy queue of runs at a few hundred KB.
CACHE_TTL_SECONDS = 900.0
CACHE_MAX_ENTRIES = 256


class MarketFeedClient:
    """Caching live market-data client with fallback-on-error semantics."""

    def __init__(
        self,
        provider=UNSET,
        cache: dict | None = None,
        *,
        ttl_seconds: float = CACHE_TTL_SECONDS,
        max_entries: int = CACHE_MAX_ENTRIES,
        clock=time.monotonic,
    ) -> None:
        self.provider = default_provider() if provider is UNSET else provider
        # key → (expires_at, result). Insertion order doubles as recency, the
        # same way the Node side's TtlCache bounds itself.
        self.cache: dict = cache if cache is not None else {}
        self.ttl_seconds = ttl_seconds
        self.max_entries = max_entries
        self._clock = clock

    # ── internals ─────────────────────────────────────────────────────────────
    def _fallback(self, reason: str, fallback) -> dict:
        payload: dict = {"source": "fallback", "warning": reason}
        if isinstance(fallback, Mapping):
            payload.update(dict(fallback))
        elif fallback is not None:
            payload["estimated"] = fallback
        return payload

    def _store(self, key: tuple, result) -> None:
        self.cache.pop(key, None)  # re-insert so this key becomes the newest
        self.cache[key] = (self._clock() + self.ttl_seconds, result)
        while len(self.cache) > self.max_entries:
            oldest = next(iter(self.cache))
            del self.cache[oldest]

    def _cached(self, key: tuple, produce, fallback):
        entry = self.cache.get(key)
        if entry is not None:
            expires_at, result = entry
            if self._clock() < expires_at:
                return result
            del self.cache[key]  # stale — re-fetch below, or fall back
        if self.provider is None:
            return self._fallback(
                "no market-data provider available (yfinance not installed)", fallback
            )
        try:
            result = produce(self.provider)
        except Exception as exc:  # network/parse/library errors → fallback, never raise
            return self._fallback(f"market-data fetch failed: {exc}", fallback)
        self._store(key, result)
        return result

    # ── public API ────────────────────────────────────────────────────────────
    def get_historical_prices(self, ticker: str, start: str, end: str, *, fallback=None) -> dict:
        key = ("prices", ticker, start, end)

        def produce(p):
            return {
                "source": "yfinance",
                "ticker": ticker,
                "start": start,
                "end": end,
                "prices": p.prices(ticker, start, end),
            }

        return self._cached(key, produce, fallback)

    def get_company_financials(self, ticker: str, *, fallback=None) -> dict:
        key = ("financials", ticker)

        def produce(p):
            # Same pandas-NaN treatment the multiples get: a field the provider
            # doesn't have for this ticker comes back as `nan`, and passing it
            # on means `beta: NaN`, which is not valid JSON and reaches the
            # caller as an indistinguishable `null` anyway. Say None and mean it.
            return {
                "source": "yfinance",
                "ticker": ticker,
                **_drop_non_finite(p.financials(ticker)),
            }

        return self._cached(key, produce, fallback)

    def _info_entry(self, ticker: str, date: str | None = None, *, fallback=None) -> dict:
        """One ticker's raw provider ``info``, memoized.

        Both the multiples summary and the universe refresh read whole-``info``
        fields off the same fetch, so they share a cache key rather than each
        paying for its own round trip against the same ticker.
        """
        return self._cached(
            ("multiples", ticker, date),
            lambda p: {"source": "yfinance", "info": p.info(ticker)},
            fallback,
        )

    def get_company_info(self, ticker: str, *, date: str | None = None, fallback=None) -> dict:
        """Everything the provider reports for one ticker, or a fallback payload.

        The multiples endpoint projects ``info`` down to six ratios. The
        universe refresh needs market cap, reported revenue and growth as well,
        which are in the same dict and would otherwise cost a second fetch.
        """
        entry = self._info_entry(ticker, date, fallback=fallback)
        if entry.get("source") != "yfinance":
            return entry
        return {"source": "yfinance", "ticker": ticker, "info": entry.get("info", {})}

    def get_company_multiples(
        self,
        tickers: list[str],
        metrics: list[str] | None = None,
        date: str | None = None,
        *,
        fallback=None,
    ) -> dict:
        wanted = list(metrics) if metrics else list(_INFO_MULTIPLE_KEYS)
        unknown = [m for m in wanted if m not in _INFO_MULTIPLE_KEYS]
        if unknown:
            # Not a hard input error — surface via the fallback channel.
            return self._fallback(f"unknown multiples requested: {unknown}", fallback)

        companies: dict[str, dict] = {}
        any_live = False
        for ticker in tickers:
            entry = self._info_entry(ticker, date)
            if entry.get("source") == "yfinance":
                any_live = True
                info = entry.get("info", {})
                companies[ticker] = {
                    m: _safe_float(info.get(_INFO_MULTIPLE_KEYS[m])) for m in wanted
                }
            else:
                companies[ticker] = {"warning": entry.get("warning")}

        if not any_live:
            return self._fallback("no live multiples available for any ticker", fallback)

        # Median per metric across the tickers that returned a usable value.
        summary: dict[str, float] = {}
        for m in wanted:
            vals = [c[m] for c in companies.values() if isinstance(c.get(m), (int, float))]
            if vals:
                summary[m] = round(_median(vals), 4)
        return {
            "source": "yfinance",
            "date": date,
            "metrics": wanted,
            "companies": companies,
            "median": summary,
        }


def _drop_non_finite(mapping) -> dict:
    """Replace NaN/Inf values with None, leaving non-numeric fields untouched."""
    if not isinstance(mapping, Mapping):
        return dict(mapping)
    return {
        k: (None if isinstance(v, float) and not math.isfinite(v) else v)
        for k, v in mapping.items()
    }


def _safe_float(value):
    """Coerce a provider field to a float, or None when it isn't usable.

    NaN counts as not usable, and has to be rejected here rather than left to
    the caller. ``yfinance``'s ``.info`` is pandas-backed, so a missing metric
    routinely arrives as ``nan`` rather than as an absent key — and ``nan``
    passes every check downstream that is meant to stop it: ``float(nan)``
    succeeds, and ``isinstance(nan, float)`` is True, so it is counted as a
    ticker that returned a usable value. It then reaches ``_median``, where a
    single one does not merely null out its own ticker but drags the median
    for *every* ticker to NaN — five comps with one missing multiple report no
    multiple at all, as a 200 with `null` in it. Excluded here instead, so the
    median is taken over the comps that actually have data.
    """
    try:
        if value is None:
            return None
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    n = len(ordered)
    mid = n // 2
    if n % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0
