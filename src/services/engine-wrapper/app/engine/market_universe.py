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

import logging
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

# The second log line this tier's `app/engine` package writes, and it is the
# other half of the first (R384, methodology M11). `market_feed._fallback` says
# so whenever a *fetch* was converted into the caller's own figures; this module
# is the one caller whose fetches it cannot speak for — see `_report`.
_log = logging.getLogger("market_universe")

# How much of the per-ticker reasoning goes on the log line. The reasons are a
# provider's own words (`_fallback` passes `str(exc)`), one per ticker, over a
# universe of every guideline company on file: without a bound a single dead
# afternoon writes the whole snapshot's worth of exception text to disk on every
# TTL expiry. `detail` is the redacted field, as it is on `_fallback`'s line.
_LOGGED_REASONS = 5
_LOGGED_REASON_CHARS = 500

__all__ = [
    "MARKET_FEED_PROVIDER_STATES",
    "UniverseResolution",
    "default_client",
    "live_enabled",
    "market_feed_provider_state",
    "refresh_company",
    "register_market_feed_metrics",
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


#: Every value `market_feed_provider_state` can report. Exactly one series of
#: `market_feed_provider` is 1 at any moment; the rest are 0, which is what makes
#: `{state="misbuilt"} == 1` an expression somebody can read.
MARKET_FEED_PROVIDER_STATES: tuple[str, ...] = (
    "available",
    "misbuilt",
    "unconfigured",
    "unresolved",
)


def market_feed_provider_state() -> str:
    """Whether this process can reach market data at all, without finding out.

    WHY THIS IS A GAUGE (R369, methodology M11). R368 made a misbuilt image say
    so: `resolve_default_provider` quotes the exception the import raised and
    logs it once, at construction, "instead of only on the first valuation that
    happens to want market data". That line goes to the journal, and the journal
    is a place somebody looks after they already suspect something.

    The one rule that would catch the condition is `MarketFeedFallingBack`, and
    it cannot catch it early. It is a *ratio* — `market_feed_answers_total`,
    recorded in the valuation tier from the caller's side — held over an hour,
    so it needs an hour of sustained valuation traffic before it says anything,
    and on a quiet night the denominator is zero and the expression is NaN. A
    deployment that has just been rebuilt without a working yfinance therefore
    produces correct-looking valuations on substituted figures for as long as it
    takes somebody to run enough of them, which is exactly the failure mode the
    market-feed instruments were written against — the engine turns every
    market-data failure into a 200.

    The fact is already computed and already stable for the life of the process,
    so a gauge costs nothing to publish and fires in minutes rather than hours.

    A state-set and not an encoded number, the idiom `upstream_circuit_state`
    and `job_queue_alert_rule` already use here: `{state="misbuilt"} == 1` reads
    as itself where a gauge holding 2 needs the legend to be somewhere else.
    Four states, because three of them are conditions nobody should be paged
    about and only telling them apart makes the fourth alertable:

      * `unresolved` — no client built yet. `default_client` is lazy on purpose
        ("constructing it imports yfinance, and an import that reaches out to
        the network belongs on a request, not on module load"), so a freshly
        started unit that has not been asked for market data reports this. It
        must never alert, and this gauge must never *cause* a construction: a
        scrape that imported yfinance would be a collect callback doing network
        work inside the scrape, against `Gauge`'s "cheap and synchronous".
      * `unconfigured` — a client built with an explicit `provider=None`. That
        is the deliberate opt-out `MarketFeedClient` documents and the whole
        test tree runs on; told apart from the one below by
        `NO_PROVIDER_REASON` being the reason verbatim, which is the constant
        that exists precisely because an opt-out "has no failure behind it to
        quote".
      * `misbuilt` — a client built with no provider and a reason that quotes an
        exception. `requirements.txt` declares yfinance, so every way to reach
        this is a deployment that is wrong.
      * `available` — a live provider.
    """
    with _client_lock:
        client = _client
    if client is None:
        return "unresolved"
    if client.provider is not None:
        return "available"
    return "unconfigured" if client.no_provider_reason == NO_PROVIDER_REASON else "misbuilt"


def _collect_market_feed_provider():
    """One reading of the state per scrape, not one per series.

    Sampled once and compared, rather than re-asked inside the comprehension: a
    client built between the `available` row and the `misbuilt` row would
    otherwise render a set with two ones in it, or none, and an alert reading
    `== 1` would see whichever it happened to catch.
    """
    active = market_feed_provider_state()
    return tuple(
        (1.0 if state == active else 0.0, {"state": state})
        for state in MARKET_FEED_PROVIDER_STATES
    )


def register_market_feed_metrics(registry) -> None:
    """Publish the state above on this unit's own `/metrics`.

    On the engine unit rather than the caller, which is the point: the caller's
    `market_feed_answers_total` answers "did an analyst get substituted figures"
    and is the right series for that, and this answers "can this process reach
    market data at all" — a question with an answer before anybody asks for a
    valuation. `alerts.yml`'s scrape note makes the same distinction about the
    `upstream_*` families, and neither view replaces the other.
    """
    registry.gauge(
        "market_feed_provider",
        'Market-data provider state for this engine process; 1 on the active state. state="misbuilt" means yfinance is declared in requirements.txt and this image cannot import it, so every valuation runs on substituted figures.',
        _collect_market_feed_provider,
        ("state",),
    )


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
) -> tuple[dict[str, dict], int]:
    """One ``info`` payload per ticker, as far as the deadline allows.

    A ticker whose fetch has not landed by the deadline is simply absent from
    the result and is reported as a fallback by the caller. The pool is not
    waited on afterwards: the feed client swallows provider errors already, so
    a straggler can only finish writing into its own memo, where the next
    refresh will find it.

    Returns how many tickers the deadline took, alongside what landed. That
    count is the one thing about this refresh nothing else can see (R384,
    methodology M11): every *other* way a fetch fails goes through
    ``market_feed._fallback``, which writes a `warning` naming the ticker and
    quoting the provider. A fetch abandoned here never gets there — the worker
    is still running, and it is this thread that gave up on it — so a source
    that has stopped answering rather than started refusing produced a universe
    of snapshot figures with not one line in any log at any tier, which is the
    exact shape R305 wrote `_fallback` to close one module over.
    """
    fetched: dict[str, dict] = {}
    abandoned = 0
    pool = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="universe-refresh")
    try:
        futures = {
            pool.submit(client.get_company_info, company.ticker): company.ticker
            for company in snapshot
        }
        expired = False
        for future, ticker in futures.items():
            if not expired:
                remaining = deadline - clock()
                expired = remaining <= 0
            if expired:
                # Counted rather than broken out of. The loop used to stop at
                # the first ticker past the deadline, which is the same set of
                # figures and a different number: every ticker after it is as
                # unfetched as that one, and the count is what the log line is
                # about. The clock is not read again, so a scripted one sees
                # exactly the calls it saw before.
                abandoned += 1
                continue
            try:
                fetched[ticker] = future.result(timeout=remaining)
            except Exception:  # timeout, or a provider error the client re-raised
                abandoned += 1
                continue
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    return fetched, abandoned


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
        fetched, abandoned = _fetch_all(feed, snapshot, clock() + REFRESH_TIMEOUT_SECONDS, clock)

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
        _report(resolved, abandoned)
        if cached_ok:
            _store(resolved, clock)
        return resolved


def _report(resolution: UniverseResolution, abandoned: int) -> None:
    """What a degraded refresh leaves in the log, having a provider to blame.

    WHY IT LOGS (R384, methodology M11). `market_feed._fallback` writes the one
    line this tier's engine package had, and it is written per *fetch*: the
    provider missing, a network error, a parse error, a ticker the source does
    not carry. This module is the caller that fetch can be silent for. A refresh
    abandoned at the deadline never reaches `_fallback` — the worker thread is
    still going, and it is this thread that stopped waiting — so a source that
    has stopped answering, as opposed to one that has started refusing, produced
    a universe of snapshot figures with nothing in any log at any tier.

    Nor does the caller's side see it. `market_feed_answers_total` is the
    valuation service counting answers to `engine/v1/market-feed`, and the
    universe is resolved *inside* this process on the way to a comparables
    screen — it never crosses that wire. What does reach an operator is
    `universe.source` and `universe.warnings` on one analyst's screen, and an
    audit row per engagement: exactly the per-request, per-engagement shape
    R305 wrote both of those instruments to get out from behind.

    Two events, because they are two incidents with two first moves. Nothing
    live at all is the provider, its credentials or its reachability — the same
    diagnosis `MarketFeedFallingBack` is about, arrived at from a source that
    rule cannot see. Tickers abandoned is this refresh's own budget:
    `MARKET_UNIVERSE_REFRESH_TIMEOUT_SECONDS` against a source that is answering
    but slowly, and the remedy is a number rather than a credential. Both fire
    together when both are true, which is a fact rather than a duplicate.

    `warning` on `_fallback`'s reasoning: yfinance is a declared requirement, so
    a deployment that has one and cannot use it is unwell rather than configured
    that way. Per resolution rather than per screen — the result is memoised for
    `TTL_SECONDS`, so this is one line per refresh, not one per analyst.

    Alertable without a new instrument: `register_process_metrics` counts every
    warning-or-worse line carrying an `event` into `log_degraded_events_total`,
    keyed on the word. That is the channel R376 built for exactly this — a tier
    whose degrades are reported in the log and nowhere else.
    """
    if resolution.live_count == 0:
        _log.warning(
            "market universe refresh returned no live figures",
            extra={
                "event": "market_universe_degraded",
                # The same two dimensions `_fallback` carries. There is no one
                # ticker this line is about, so only the kind is set.
                "feed_kind": "universe",
                "count": resolution.live_count,
                "total": resolution.live_count + resolution.snapshot_count,
                # The providers' own words, bounded twice — see `_LOGGED_REASONS`.
                # `detail` is the redacted field, as it is on `_fallback`'s line.
                "detail": _reasons(resolution.warnings),
            },
        )
    if abandoned:
        _log.warning(
            "market universe refresh ran out of time before every ticker answered",
            extra={
                "event": "market_universe_refresh_timeout",
                "feed_kind": "universe",
                "count": abandoned,
                "total": resolution.live_count + resolution.snapshot_count,
                "limit": REFRESH_TIMEOUT_SECONDS,
            },
        )


def _reasons(warnings: Sequence[str]) -> str:
    """The first few per-ticker reasons, as one bounded string."""
    if not warnings:
        # Not "no reason": every non-live row appends one, so an empty tuple
        # beside a zero live count is this module disagreeing with itself.
        return "no per-ticker reason was recorded"
    joined = "; ".join(warnings[:_LOGGED_REASONS])
    if len(warnings) > _LOGGED_REASONS:
        joined += f"; and {len(warnings) - _LOGGED_REASONS} more"
    return joined[:_LOGGED_REASON_CHARS]


def _store(resolution: UniverseResolution, clock) -> None:
    global _cache
    _cache = (clock() + TTL_SECONDS, resolution)
