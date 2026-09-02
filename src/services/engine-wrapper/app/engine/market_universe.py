"""The guideline-company universe the screen actually ranks, and where it came from.

``market_data`` tabulates the classification — ticker, name, SIC code, sector —
which no price feed supplies and which somebody has to curate. It also tabulates
a set of *figures* under each of those names, and that half has always carried a
warning label: "an illustrative reference point, not a real-time quote". Until
this module, that label described every multiple the platform has ever concluded
on, because ``comparables.screen_comparables`` ranked the static tuple directly.

The live feed (``market_feed``) has served observed figures with a documented
graceful fallback since it was written. This module joins the two: it overlays
observed market data onto the curated classification and hands
``screen_comparables`` a universe that is live where the feed answered and the
snapshot where it did not — and, critically, one that says which each row is.

Three rules, the same three the Node-side refresh follows (migration 0133):

- **A row is refreshed whole or left exactly as it was.** A today market cap
  over a snapshot revenue is a multiple that never existed anywhere. So a
  ticker whose ``info`` is missing any of the figures that constitute the row
  keeps its snapshot figures entirely, and says so.
- **A fallback is reported, not swallowed.** Every ticker that could not be
  refreshed appears in ``warnings`` with the reason, and the counts make a
  partly-refreshed universe legible as ``"mixed"`` rather than passing for
  live.
- **The figures and their moment travel together.** ``figures_source`` and
  ``figures_as_of`` are set as a pair on a refreshed row; a snapshot row
  carries ``"snapshot"`` and ``None``, because we know where those numbers came
  from and not when they were current.

Availability, latency and cost are all bounded. The provider is optional and
imported lazily, so with ``yfinance`` absent — the default install — this
resolves to the snapshot on the first call and never touches the network. A
refresh fans out across a small thread pool under a wall-clock deadline, so a
slow or hanging source degrades to the snapshot instead of holding a request
open. And the result is memoized for ``TTL_SECONDS`` behind a lock, so a burst
of screens costs one fan-out rather than one per request.
"""

from __future__ import annotations

import math
import os
import threading
import time
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone

from .market_data import Company
from .market_data import _COMPANIES as SNAPSHOT  # noqa: PLC2701 — same package
from .market_feed import NO_PROVIDER_REASON, UNSET, MarketFeedClient

__all__ = [
    "UniverseResolution",
    "default_client",
    "live_enabled",
    "refresh_company",
    "reset_cache",
    "resolve_universe",
    "set_client",
]

# The environment switch. Unset means "live where the provider is available",
# which is what makes installing yfinance the whole of enabling this. Setting it
# to a falsey word pins the universe to the snapshot, which is what a deployment
# that needs byte-identical reruns across a period wants.
LIVE_ENV_VAR = "ENGINE_LIVE_UNIVERSE"
_FALSEY = {"0", "false", "no", "off", "none", "disabled"}

# One refresh covers ~55 tickers. Eight at a time keeps the fan-out polite
# against a public endpoint while still finishing inside the deadline; the
# deadline is the real guarantee, and it is generous enough that a healthy
# source completes and short enough that the screen route's own timeout is not
# the thing that fires.
MAX_WORKERS = 8
REFRESH_TIMEOUT_SECONDS = 20.0

# How long a resolved universe is served before it is refetched. Matched to the
# feed client's own memo: a shorter TTL here would only re-derive the same
# cached ``info`` dicts, and a longer one would let a report quote figures as
# observed that were observed a session ago.
TTL_SECONDS = 900.0

# What a refreshed figure has to look like to be believed. These are not tuning
# knobs — they are the range outside which a number is a data error rather than
# an unusual company, and a screen that ranks against one of those produces a
# comp set nobody can explain. The growth band matches the bound
# `comparable_analysis` already validates its target growth against.
_MAX_EV_REVENUE = 500.0
_MAX_EV_EBITDA = 1000.0
_MIN_GROWTH, _MAX_GROWTH = -1.0, 20.0

# The universe is denominated in one currency, and a screen ranking a USD
# target against a EUR revenue is measuring a 1.1× FX rate as if it were scale.
# The feed reports two currencies per name and they disagree more often than
# one would hope: Adyen and Spotify are quoted in USD and report their
# financials in EUR, so their revenue is EUR while their market cap is USD —
# which makes the ratio between them a number with no units at all. Both have
# to be USD before a row is believed. A name that fails this keeps its snapshot
# figures, which are stated in USD by construction.
_REPORTING_CURRENCY = "USD"

# Guideline *public company* — an ETF or a fund is not one, whatever its
# multiples look like. This is not hypothetical: "WISE" on the feed is not Wise
# plc but a generative-AI ETF, and without this check a refresh keyed on the
# snapshot's ticker would have pulled a fund's figures into a fintech comp set.
_EQUITY_QUOTE_TYPE = "EQUITY"

# Warnings are per-ticker and a total outage produces one for every name in the
# universe. The response says how many there were either way; it does not need
# to print all of them.
_MAX_WARNINGS = 12


@dataclass(frozen=True)
class UniverseResolution:
    """A screenable universe plus the provenance of the figures in it."""

    companies: tuple[Company, ...]
    source: str  # "live" | "mixed" | "snapshot"
    as_of: str | None
    live_count: int
    snapshot_count: int
    warnings: tuple[str, ...]

    def provenance(self) -> dict:
        """The block the screen response carries, and the exhibit prints."""
        shown = list(self.warnings[:_MAX_WARNINGS])
        if len(self.warnings) > _MAX_WARNINGS:
            shown.append(f"… and {len(self.warnings) - _MAX_WARNINGS} more")
        return {
            "source": self.source,
            "as_of": self.as_of,
            "live_count": self.live_count,
            "snapshot_count": self.snapshot_count,
            "warnings": shown,
            "warning_count": len(self.warnings),
        }


def live_enabled() -> bool:
    """Whether a resolution may go to the network, read fresh each call.

    Read from the environment rather than captured at import so a deployment
    can pin the universe without a rebuild, and so a test can set it.
    """
    raw = (os.environ.get(LIVE_ENV_VAR) or "").strip().lower()
    return raw not in _FALSEY if raw else True


# ── the shared feed client ───────────────────────────────────────────────────
# One client for the process, so the refresh and the /market-feed route share a
# memo instead of each paying for the same fetch. Built on first use rather than
# at import: constructing it imports yfinance, and an import that reaches out to
# the network belongs on a request, not on module load.
_client: MarketFeedClient | None = None
_client_lock = threading.Lock()


def default_client() -> MarketFeedClient:
    global _client
    with _client_lock:
        if _client is None:
            _client = MarketFeedClient()
        return _client


def set_client(client: MarketFeedClient | None) -> MarketFeedClient | None:
    """Install the process-wide feed client, returning the one it replaced.

    The seam a test injects a stub provider through, and the reason the resolved
    universe is dropped at the same time: a universe resolved through the old
    client is not an answer about the new one.
    """
    global _client
    with _client_lock:
        previous, _client = _client, client
    reset_cache()
    return previous


# ── one row ──────────────────────────────────────────────────────────────────


def _finite(value) -> float | None:
    """A float, or None for anything that is not a usable number.

    ``info`` is pandas-backed, so a field the provider does not have for a
    ticker arrives as ``nan`` as often as it arrives absent — and ``nan``
    survives ``float()`` and ``isinstance(..., float)`` both.
    """
    try:
        if value is None or isinstance(value, bool):
            return None
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _positive(value, ceiling: float) -> float | None:
    out = _finite(value)
    if out is None or out <= 0 or out > ceiling:
        return None
    return out


def refresh_company(base: Company, info: dict, as_of: str) -> tuple[Company | None, str | None]:
    """``base`` restated on observed figures, or ``(None, reason)``.

    The classification is kept from ``base`` and never taken from the feed: SIC
    code and description are the axis the screen weights most heavily, the feed
    does not report them, and its free-text ``sector`` is not the same fact
    under a different name. Country is kept for the same reason — the snapshot
    holds ISO codes and the feed holds prose, and a universe with both in one
    column is a column nothing can filter on.

    Every figure the *screen* reads is required. Taking the ones that happen to
    be present and leaving the rest at snapshot values would produce a row whose
    multiple, scale and growth were measured at different times, which is a
    company that does not exist.

    Two fields are exceptions, and both because absent already means something
    here. ``ev_ebitda`` is null exactly when EBITDA is not meaningfully
    positive, which is an ordinary state for a name in this universe. And
    ``market_cap`` is reported alongside a live row rather than read by it —
    scale comes from revenue, and the enterprise value the multiples are struck
    on is implied by them — so a source that omits it (the feed does, for
    Salesforce, today) leaves it null rather than sinking the row or, worse,
    quietly pairing today's multiples with a market cap of unknown vintage.
    """
    quote_type = info.get("quoteType")
    if isinstance(quote_type, str) and quote_type.strip().upper() != _EQUITY_QUOTE_TYPE:
        return None, f"the symbol resolves to a {quote_type}, not an operating company"

    for field in ("financialCurrency", "currency"):
        reported = info.get(field)
        if isinstance(reported, str) and reported.strip().upper() != _REPORTING_CURRENCY:
            return None, f"reported in {reported}, and the universe is denominated in USD"

    ev_revenue = _positive(info.get("enterpriseToRevenue"), _MAX_EV_REVENUE)
    if ev_revenue is None:
        return None, "no usable EV/Revenue reported"

    revenue_ltm = _positive(info.get("totalRevenue"), math.inf)
    if revenue_ltm is None:
        return None, "no LTM revenue reported"

    growth = _finite(info.get("revenueGrowth"))
    if growth is None or not (_MIN_GROWTH <= growth <= _MAX_GROWTH):
        return None, "no usable revenue growth reported"

    # Null rather than rejected: a company whose EBITDA is not meaningfully
    # positive is a normal member of this universe, and null is how the
    # snapshot says so too.
    ev_ebitda = _positive(info.get("enterpriseToEbitda"), _MAX_EV_EBITDA)
    market_cap = _positive(info.get("marketCap"), math.inf)

    return (
        Company(
            ticker=base.ticker,
            name=base.name,
            sic_code=base.sic_code,
            sic_description=base.sic_description,
            sector=base.sector,
            market_cap=market_cap,
            ev_revenue=ev_revenue,
            ev_ebitda=ev_ebitda,
            revenue_growth=growth,
            country=base.country,
            revenue_ltm=revenue_ltm,
            figures_source="live",
            figures_as_of=as_of,
        ),
        None,
    )


# ── the whole universe ───────────────────────────────────────────────────────

_cache: tuple[float, UniverseResolution] | None = None
_cache_lock = threading.RLock()


def reset_cache() -> None:
    """Drop the memoized resolution. For tests and for an explicit re-fetch."""
    global _cache
    with _cache_lock:
        _cache = None


def _snapshot_only(
    snapshot: Sequence[Company], warnings: Sequence[str] = ()
) -> UniverseResolution:
    return UniverseResolution(
        companies=tuple(snapshot),
        source="snapshot",
        as_of=None,
        live_count=0,
        snapshot_count=len(snapshot),
        warnings=tuple(warnings),
    )


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _fetch_all(
    client: MarketFeedClient, snapshot: Sequence[Company], deadline: float, clock
) -> dict[str, dict]:
    """One ``info`` payload per ticker, as far as the deadline allows.

    A ticker whose fetch has not landed by the deadline is simply absent from
    the result and is reported as a fallback by the caller. The pool is not
    waited on afterwards: the feed client swallows provider errors already, so
    a straggler can only finish writing into its own memo, where the next
    refresh will find it.
    """
    fetched: dict[str, dict] = {}
    pool = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="universe-refresh")
    try:
        futures = {
            pool.submit(client.get_company_info, company.ticker): company.ticker
            for company in snapshot
        }
        for future, ticker in futures.items():
            remaining = deadline - clock()
            if remaining <= 0:
                break
            try:
                fetched[ticker] = future.result(timeout=remaining)
            except Exception:  # timeout, or a provider error the client re-raised
                continue
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    return fetched


def resolve_universe(
    *,
    live: bool | None = None,
    client=UNSET,
    snapshot: Sequence[Company] = SNAPSHOT,
    now=None,
    clock=time.monotonic,
    use_cache: bool | None = None,
) -> UniverseResolution:
    """The universe to screen against, live where the feed answered.

    ``live=None`` defers to the environment; ``live=False`` pins the snapshot
    and is what a caller wanting a reproducible rerun passes. Nothing here
    raises: an unavailable provider, a failed fetch and an unusable payload all
    resolve to the snapshot with the reason recorded.
    """
    defaults = client is UNSET and snapshot is SNAPSHOT
    cached_ok = defaults if use_cache is None else use_cache

    if live is None:
        live = live_enabled()
    if not live:
        # Not cached: pinning to the snapshot is free, and caching it would let
        # one `live=False` call answer the next caller who did want live data.
        return _snapshot_only(snapshot)

    with _cache_lock:
        if cached_ok and _cache is not None:
            expires_at, resolution = _cache
            if clock() < expires_at:
                return resolution

        feed = default_client() if client is UNSET else client
        if not isinstance(feed, MarketFeedClient) or feed.provider is None:
            # The ordinary case with no live provider. Cached like any other
            # resolution so the next screen does not retry the import.
            #
            # The reason comes from the client, which settled it when it tried
            # to build the provider (R368, M5). This line used to state
            # "yfinance not installed" as a fact, and it is the analyst-facing
            # half of that sentence: it is rendered into `universe.warnings` on
            # a comparables screen. An import that failed for any other reason —
            # a transitive dependency gone, an ABI mismatch after an in-place
            # upgrade — reported a package that is sitting right there as
            # missing.
            reason = getattr(feed, "no_provider_reason", NO_PROVIDER_REASON)
            resolved = _snapshot_only(
                snapshot,
                [f"{reason} — screening against the static snapshot"],
            )
            if cached_ok:
                _store(resolved, clock)
            return resolved

        as_of = _utc_now_iso() if now is None else str(now() if callable(now) else now)
        fetched = _fetch_all(feed, snapshot, clock() + REFRESH_TIMEOUT_SECONDS, clock)

        companies: list[Company] = []
        warnings: list[str] = []
        live_count = 0
        for base in snapshot:
            entry = fetched.get(base.ticker)
            if not isinstance(entry, dict) or entry.get("source") != "yfinance":
                reason = (entry or {}).get("warning") if isinstance(entry, dict) else "fetch timed out"
                warnings.append(f"{base.ticker}: {reason or 'no live figures returned'}")
                companies.append(base)
                continue
            refreshed, reason = refresh_company(base, entry.get("info") or {}, as_of)
            if refreshed is None:
                warnings.append(f"{base.ticker}: {reason}")
                companies.append(base)
                continue
            companies.append(refreshed)
            live_count += 1

        snapshot_count = len(companies) - live_count
        if live_count == 0:
            source = "snapshot"
        elif snapshot_count == 0:
            source = "live"
        else:
            source = "mixed"
        resolved = UniverseResolution(
            companies=tuple(companies),
            source=source,
            # A resolution with nothing live in it has no moment to report;
            # stamping one would date snapshot figures to now, which is the
            # single claim this whole module exists to stop anyone making.
            as_of=as_of if live_count else None,
            live_count=live_count,
            snapshot_count=snapshot_count,
            warnings=tuple(warnings),
        )
        if cached_ok:
            _store(resolved, clock)
        return resolved


def _store(resolution: UniverseResolution, clock) -> None:
    global _cache
    _cache = (clock() + TTL_SECONDS, resolution)
