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

import logging
import math
import os
import threading
import time
from collections.abc import Mapping

__all__ = [
    "MarketFeedClient",
    "YFinanceProvider",
    "default_provider",
    "fetch_timeout_seconds",
    "UNSET",
]

_log = logging.getLogger("market_feed")

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


# How long one provider fetch may hold the thread that asked for it.
#
# WHY THIS EXISTS (R308, methodology M5). Everything below this line was written
# so that a market-data failure degrades to the caller's own figures instead of
# failing a valuation — a missing provider, a network error, a parse error, an
# unknown ticker. A *hang* is the one failure that arrangement could not
# express. `yfinance` is `requests` underneath and passes no timeout, so a
# black-holed socket at Yahoo — the TCP handshake completes and nothing follows
# — never returns and never raises, and there is no `except` for that.
#
# What that costs is not one slow answer. These handlers are sync `def`s, so
# each holds a FastAPI threadpool slot for its whole duration and no client
# disconnect reclaims it (see `limits.py`, which sizes that pool deliberately
# for exactly this reason). The Node side gives up at 8-12s (`FEED_TIMEOUT_MS`
# in routes/comparables.ts and routes/volatility.ts) and *retries*, so a hung
# upstream converts one dead socket into a new held thread every few seconds
# until the pool is gone — and then the engine answers nothing at all, for
# valuations too, which is the tier's whole job. `market_universe._fetch_all`
# already bounds its fan-out for this reason; the three feed methods, reached
# straight off the route, did not.
#
# Fifteen seconds is past any healthy fetch and past the caller's own patience,
# so a bound that fires is a fetch nobody was still waiting for.
FETCH_TIMEOUT_S = 15.0
FETCH_TIMEOUT_ENV = "MARKET_FEED_FETCH_TIMEOUT_S"

# How long one *request* may spend fetching, across every ticker it names.
#
# WHY A SECOND CEILING (R314, methodology M8). `FETCH_TIMEOUT_S` bounds one
# fetch, and `get_company_multiples` makes one per ticker, sequentially, with
# `MAX_TICKERS` = 50. So the per-fetch bound multiplies: a request naming fifty
# tickers against an upstream that black-holes every socket is bounded at
# 50 x 15s = 12.5 minutes of a FastAPI threadpool slot — which is the failure
# `FETCH_TIMEOUT_S` was added to remove, one level up from where it was fixed.
# The threadpool is 40 slots (`limits.threadpool_size`), so forty such requests
# is the whole engine, for valuations too.
#
# The work is wasted long before that anyway. The Node side gives up at 8-12s
# (`FEED_TIMEOUT_MS`) and nothing reclaims the slot when it does, so every
# second past the caller's patience is spent computing an answer no one will
# read — and the sequential loop means the in-flight ceiling
# (`MAX_INFLIGHT_FETCHES`) never engages, because there is only ever one.
#
# Thirty seconds is past the caller's own deadline with room for a slow-but-
# healthy handful, and it is a *budget*: tickers still unfetched when it runs
# out are reported as unavailable, the same shape as a ticker the source does
# not carry. `market_universe._fetch_all` has bounded its fan-out this way since
# it was written; this is the same bound on the one that lacked it.
MULTIPLES_BUDGET_S = 30.0
MULTIPLES_BUDGET_ENV = "MARKET_FEED_MULTIPLES_BUDGET_S"

# The most provider fetches that may be in flight — which, on a hung upstream,
# is the number of stranded threads this module can accumulate.
#
# A deadline alone does not bound that: the thread that is waiting on the dead
# socket is still there after the deadline hands the caller a fallback, and it
# stays there until the socket does something. Without a ceiling the retries
# above mint one per attempt, which is the same exhaustion one level down.
#
# Past the ceiling a fetch is not queued, it is refused — as a fallback, like
# every other way this module fails. Queueing would reintroduce the wait the
# deadline just removed, and a caller holding a threadpool slot to wait for a
# slot to wait for a socket is worse than being told now.
MAX_INFLIGHT_FETCHES = 8

_inflight = threading.BoundedSemaphore(MAX_INFLIGHT_FETCHES)


def _seconds(name: str, raw: str | None, default: float) -> float:
    """Parse a seconds-valued ceiling; `default` for anything unusable.

    Falls back rather than raising, the same way `limits._misconfigured` does: a
    typo in a unit file must not be a service that will not boot.

    Takes the value already read rather than reading it, so that
    `os.environ.get(SOME_ENV)` stays at the two call sites. That is not a
    stylistic choice: `.env.example` is enforced by a scan for exactly that
    idiom (`shared/test/envExample.test.ts`), and a helper that reads the
    environment from a *parameter* is the refactor that has taken four
    variables out of the deployment contract's sight already.
    """
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        _log.warning(
            "%s is not a number - falling back to the default",
            name,
            extra={"event": "market_feed_config", "detail": raw},
        )
        return default
    return value if value >= 0 else default


def fetch_timeout_seconds(default: float = FETCH_TIMEOUT_S) -> float:
    """Configured per-fetch ceiling (MARKET_FEED_FETCH_TIMEOUT_S); 0 disables it."""
    return _seconds(FETCH_TIMEOUT_ENV, os.environ.get(FETCH_TIMEOUT_ENV), default)


def multiples_budget_seconds(default: float = MULTIPLES_BUDGET_S) -> float:
    """Configured whole-request fetch budget (MARKET_FEED_MULTIPLES_BUDGET_S).

    Zero disables it, which restores the unbounded fan-out and is offered for
    the same reason the per-fetch ceiling offers it: an operator debugging a
    slow provider on a box nobody else is calling.
    """
    return _seconds(MULTIPLES_BUDGET_ENV, os.environ.get(MULTIPLES_BUDGET_ENV), default)


class _FetchAbandoned(Exception):
    """A fetch that was given up on rather than one that failed.

    Its own type because the sentence differs and both end in the same
    `_fallback`: "the source did not answer in time" is an upstream that is
    unwell, "too many fetches already in flight" is this process protecting
    itself, and an operator reading the fallback rate needs to tell them apart.
    """


def _run_bounded(call, timeout_s: float):
    """Run `call` on a throwaway thread and wait at most `timeout_s` for it.

    Daemon threads rather than a `ThreadPoolExecutor`, deliberately. The whole
    point of the bound is that the thread underneath may never finish, and
    `concurrent.futures` joins its workers at interpreter exit — so a pool here
    would trade a wedged request handler for a process that will not shut down,
    which the deployment's own shutdown contract gives us seconds to do.

    A straggler is not cancelled, because a blocking socket read cannot be. It
    holds its slot until it returns, and if it returns successfully it has
    already written into the memo (see `_store`), where the next call finds it.
    """
    if timeout_s <= 0:
        return call()
    if not _inflight.acquire(blocking=False):
        raise _FetchAbandoned(
            f"too many market-data fetches already in flight (limit {MAX_INFLIGHT_FETCHES})"
        )
    box: dict = {}
    done = threading.Event()

    def run() -> None:
        try:
            box["value"] = call()
        except BaseException as exc:  # re-raised on the caller's thread below
            box["error"] = exc
        finally:
            # Released before the event so the slot is freed even for the
            # straggler nobody is waiting for any more.
            _inflight.release()
            done.set()

    threading.Thread(target=run, name="market-feed-fetch", daemon=True).start()
    if not done.wait(timeout_s):
        raise _FetchAbandoned(f"source did not answer within {timeout_s:g}s")
    if "error" in box:
        raise box["error"]
    return box["value"]


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
        fetch_timeout_s: float | None = None,
        multiples_budget_s: float | None = None,
    ) -> None:
        self.provider = default_provider() if provider is UNSET else provider
        # key → (expires_at, result). Insertion order doubles as recency, the
        # same way the Node side's TtlCache bounds itself.
        self.cache: dict = cache if cache is not None else {}
        self.ttl_seconds = ttl_seconds
        self.max_entries = max_entries
        self._clock = clock
        # Resolved once per client, not per fetch: `default_client()` holds one
        # for the life of the process, and re-reading the environment on every
        # call would make the ceiling something a fetch in flight could see
        # change under it. `None` defers to the environment; a number pins it,
        # which is what the tests pass.
        self.fetch_timeout_s = (
            fetch_timeout_seconds() if fetch_timeout_s is None else fetch_timeout_s
        )
        # Resolved once per client for the same reason, and read only by the
        # fan-out below — a single-fetch call is already bounded by the line
        # above and adding a second ceiling to it would say nothing new.
        self.multiples_budget_s = (
            multiples_budget_seconds() if multiples_budget_s is None else multiples_budget_s
        )

    # ── internals ─────────────────────────────────────────────────────────────
    def _fallback(self, reason: str, fallback, *, kind: str = "unknown", ticker=None) -> dict:
        """The caller's own figures, labelled as such — and a log line saying so.

        WHY IT LOGS (R305, methodology M11). Every failure this module can have
        is converted here into a 200 carrying ``source: "fallback"``: the
        provider missing, a network error, a parse error, a ticker the source
        does not carry. That is the right answer to give the caller — a
        valuation must not hard-fail because Yahoo is having an afternoon — but
        until this line it was also the *only* record that anything had gone
        wrong. Nothing was logged here, the HTTP layer saw a 200 and recorded a
        success, and on the Node side a fallback payload is dropped into a
        per-ticker ``excluded``/``unavailable`` list that only ever reaches the
        analyst's screen.

        So a market-data outage — yfinance unreachable, credentials expired,
        the package gone from an image — presented as: every volatility
        estimate refusing with "no comparable had usable price history", every
        comparables refresh reporting each row unavailable, and not one line in
        any log at any tier. The first question of M11 is how quickly you know;
        the answer was that somebody phones an analyst.

        `warning` rather than `info`: ``yfinance`` is a declared requirement
        (requirements.txt), so a deployment reaching the provider-absent branch
        is misbuilt rather than configured that way, and the fetch-failure
        branch is an upstream that is down. Per call rather than once, because
        the rate is the diagnosis — one ticker the source does not carry looks
        nothing like every ticker failing.

        The reason string is where the provider's own words are, and it goes
        both into this line and into the payload the caller already surfaces.
        """
        _log.warning(
            "market feed fell back to caller-supplied figures",
            extra={
                "event": "market_feed_fallback",
                "feed_kind": kind,
                "ticker": ticker,
                # `detail` rather than a key of its own: this string quotes the
                # provider's exception, which is free text an input can reach,
                # and `detail` is the field the formatter redacts like the
                # message. See `_EXTRA_KEYS` in app/observability.py.
                "detail": reason,
            },
        )
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

    def _cached(self, key: tuple, produce, fallback, deadline: float | None = None):
        entry = self.cache.get(key)
        if entry is not None:
            expires_at, result = entry
            if self._clock() < expires_at:
                return result
            del self.cache[key]  # stale — re-fetch below, or fall back
        # `key` is ("prices", ticker, …) / ("financials", ticker) / ("info", …)
        # for every caller, so it carries the two labels a reader of the log
        # line needs to tell one dead ticker from a dead source.
        kind = str(key[0]) if key else "unknown"
        ticker = key[1] if len(key) > 1 else None
        if self.provider is None:
            return self._fallback(
                "no market-data provider available (yfinance not installed)",
                fallback,
                kind=kind,
                ticker=ticker,
            )
        # The whole-request budget, when the caller is a fan-out. Checked after
        # the memo above, so a ticker already fetched costs nothing and is still
        # answered from it once the budget is spent.
        timeout_s = self.fetch_timeout_s
        if deadline is not None:
            remaining = deadline - self._clock()
            if remaining <= 0:
                return self._fallback(
                    "market-data fetch abandoned: the request's fetch budget was already spent",
                    fallback,
                    kind=kind,
                    ticker=ticker,
                )
            # Clamped, not just gated: without this the last fetch admitted may
            # still overrun the budget by a whole `fetch_timeout_s`, which is
            # the overshoot the budget exists to remove.
            timeout_s = remaining if timeout_s <= 0 else min(timeout_s, remaining)
        try:
            result = _run_bounded(lambda: produce(self.provider), timeout_s)
        except _FetchAbandoned as exc:
            # Said as what it is rather than folded into "fetch failed": the
            # provider did not refuse us, we stopped waiting. See
            # `FETCH_TIMEOUT_S` for why waiting is not an option here.
            return self._fallback(f"market-data fetch abandoned: {exc}", fallback, kind=kind, ticker=ticker)
        except Exception as exc:  # network/parse/library errors → fallback, never raise
            return self._fallback(
                f"market-data fetch failed: {exc}", fallback, kind=kind, ticker=ticker
            )
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

    def _info_entry(
        self, ticker: str, date: str | None = None, *, fallback=None, deadline: float | None = None
    ) -> dict:
        """One ticker's raw provider ``info``, memoized.

        Both the multiples summary and the universe refresh read whole-``info``
        fields off the same fetch, so they share a cache key rather than each
        paying for its own round trip against the same ticker.
        """
        return self._cached(
            ("multiples", ticker, date),
            lambda p: {"source": "yfinance", "info": p.info(ticker)},
            fallback,
            deadline,
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
            return self._fallback(
                f"unknown multiples requested: {unknown}", fallback, kind="multiples"
            )

        # One budget for the whole fan-out — see `MULTIPLES_BUDGET_S`. A ticker
        # reached after it is spent is answered from the memo if it is there and
        # reported as unavailable if it is not, which is the shape this loop
        # already uses for a ticker the source does not carry.
        budget = self.multiples_budget_s
        deadline = self._clock() + budget if budget > 0 else None

        companies: dict[str, dict] = {}
        any_live = False
        for ticker in tickers:
            entry = self._info_entry(ticker, date, deadline=deadline)
            if entry.get("source") == "yfinance":
                any_live = True
                info = entry.get("info", {})
                companies[ticker] = {
                    m: _safe_float(info.get(_INFO_MULTIPLE_KEYS[m])) for m in wanted
                }
            else:
                companies[ticker] = {"warning": entry.get("warning")}

        if not any_live:
            return self._fallback(
                "no live multiples available for any ticker", fallback, kind="multiples"
            )

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
