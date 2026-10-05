# R377 — Observability Audit

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Round          | R377                                     |
| Methodology    | M11 — observability audit                |
| Cycle / Pass   | 57 / 5                                   |
| Findings       | 3 (1 HIGH, 2 MEDIUM)                     |
| Commit         | (this commit)                            |

## Finding 1 — HIGH: `PoolCheckoutLeaked` fires on a single scrape

**File**: `infra/monitoring/alerts.yml` (line 1073, pre-fix)

**Bug**: Of 98 alert rules, `PoolCheckoutLeaked` was the only one unintentionally
missing a `for` clause. (The other, `IntegrationConnectGrantedButUnstored`, is
intentionally instant per its inline comment.) The alert expression uses
`increase(db_pool_checkouts_leaked[1h]) > 0` with severity `page`.

Without `for`, a single scrape where `increase()` returns a nonzero value fires
a page immediately. Counter resets from deploys and restarts make `increase()`
briefly read a large value as the new zero replaces the old accumulation —
producing a spurious 3 a.m. page for a condition that does not exist.

**Impact**: False pages on every deploy or restart where the counter had a
nonzero value before the reset. Each false page erodes trust in the alerting
system and trains on-call to dismiss leak alerts.

**Fix**: Added `for: 5m` so the condition must persist across multiple scrapes
before paging.

**Test**: `alertRulesCensus.test.ts` — new case `gives every page-severity alert
a \`for\` clause` asserts that all page-severity rules carry a `for` duration,
with an explicit allowlist for the one intentionally instant alert.

## Finding 2 — MEDIUM: Gauges named with `_total` (counter convention)

**Files**: `src/services/valuation/src/index.ts` (lines 170, 179, pre-fix)

**Bug**: Two metrics were registered as `gauge()` with the `_total` suffix that
Prometheus reserves for counters:

- `db_pool_checkouts_leaked_total` (cumulative leak count from pool health)
- `db_slow_queries_total` (cumulative slow query count since boot)

Both are monotonically increasing values exposed as `ObservableGauge` via a
scrape-time `collect` callback. The `_total` suffix tells every Prometheus-aware
tool — Grafana's query builder, `promtool check metrics`, type inference in
recording rules — that the metric is a counter. Alert rules using `increase()`
on a gauge work by accident but do not get counter-reset handling, so a restart
that zeros the value can produce a brief spike or a negative delta instead of the
clean reset a counter would produce.

**Impact**: Confusing metric type for operators and tooling. `increase()` on a
gauge is technically valid but semantically wrong — it works until a restart
makes it produce the opposite of the truth.

**Fix**: Renamed to `db_pool_checkouts_leaked` and `db_slow_queries` (dropping
the `_total` suffix). Updated the two alert rules (`PoolCheckoutLeaked`,
`SlowQueriesAppearing`) to reference the new names.

**Test**: `alertRulesCensus.test.ts` — new case `does not name a gauge with the
_total suffix reserved for counters` scans all `.gauge()` registrations and
asserts none use `_total`, with a documented allowlist of six pre-existing
violations that are not alert-watched and can be cleaned up in a future pass.

## Finding 3 — MEDIUM: No event loop lag metric

**File**: `src/packages/shared/src/prometheus.ts` (`registerProcessMetrics`)

**Bug**: The codebase documents that PDF rendering blocks the event loop for
~500 ms and that synchronous crypto operations stall request processing. Yet no
metric measured event loop lag. The only indirect signal was `RequestsPilingUp`
(`http_requests_in_flight > 100`), which fires after the consequence is visible
rather than when the cause begins — and does not distinguish event loop blocking
from a slow dependency or a traffic spike.

Node's `perf_hooks.monitorEventLoopDelay()` has been stable since Node 12 and
measures exactly this: how long a timer callback waits beyond its scheduled
firing time.

**Impact**: No way to alert on or diagnose event loop blocking. An operator
seeing `RequestsPilingUp` has no way to tell whether the event loop is stuck or
a downstream dependency is slow, and must correlate manually with logs to
identify the cause.

**Fix**: Added `nodejs_eventloop_lag_seconds` gauge to `registerProcessMetrics`
using `monitorEventLoopDelay({ resolution: 20 })`. Reports the max observed
delay in the sampling window, converted from nanoseconds to seconds.

Added `EventLoopBlocked` alert rule (`> 0.5` for 2 minutes, severity `ticket`)
in the `n409-availability` group, alongside `RequestsPilingUp`.

**Test**: `prometheus.test.ts` — new case `exposes event loop lag as a gauge`
asserts the metric is registered with the correct TYPE header and produces a
non-negative numeric value.

## Scan summary

Searched the full estate for observability gaps:

- **Alert `for` clauses**: 97 of 98 rules carry `for`; the one exception is
  documented inline. No other missing clauses found.
- **Gauge/counter naming**: 8 gauges used `_total`; 2 were alert-watched and
  fixed, 6 are allowlisted for a future pass.
- **Event loop monitoring**: No `monitorEventLoopDelay`, `eventLoopUtilization`,
  or `perf_hooks` usage existed anywhere in `src/`.
- **Log levels**: Checked housekeeping sweep logging — failed sweeps are logged
  at `warn` (correct) when `r.failed > 0` per the sweep tally pattern; the
  `info`-level log at line 750 is the summary line that includes both successes
  and failures, which is correct.
- **Health endpoints**: `/health` is intentionally a liveness probe (always OK);
  `/ready` performs dependency checks with coalescing and per-check timeouts.
  Both are correct for their roles.
