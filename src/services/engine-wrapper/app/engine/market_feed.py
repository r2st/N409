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


class MarketFeedClient:
    """Caching live market-data client with fallback-on-error semantics."""

    def __init__(self, provider=UNSET, cache: dict | None = None) -> None:
        self.provider = default_provider() if provider is UNSET else provider
        self.cache: dict = cache if cache is not None else {}

    # ── internals ─────────────────────────────────────────────────────────────
    def _fallback(self, reason: str, fallback) -> dict:
        payload: dict = {"source": "fallback", "warning": reason}
        if isinstance(fallback, Mapping):
            payload.update(dict(fallback))
        elif fallback is not None:
            payload["estimated"] = fallback
        return payload

    def _cached(self, key: tuple, produce, fallback):
        if key in self.cache:
            return self.cache[key]
        if self.provider is None:
            return self._fallback(
                "no market-data provider available (yfinance not installed)", fallback
            )
        try:
            result = produce(self.provider)
        except Exception as exc:  # network/parse/library errors → fallback, never raise
            return self._fallback(f"market-data fetch failed: {exc}", fallback)
        self.cache[key] = result
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
            return {"source": "yfinance", "ticker": ticker, **p.financials(ticker)}

        return self._cached(key, produce, fallback)

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
            entry = self._cached(
                ("multiples", ticker, date),
                lambda p, tk=ticker: {"source": "yfinance", "info": p.info(tk)},
                None,
            )
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


def _safe_float(value):
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    n = len(ordered)
    mid = n // 2
    if n % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0
