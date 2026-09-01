import type { Counter, MetricsRegistry } from '@n409/shared';

/**
 * How often the live market feed answered with observed data, and how often it
 * did not.
 *
 * WHY THIS EXISTS (R305, methodology M11). `engine/v1/market-feed` never fails:
 * the engine converts a missing provider, a network error, a parse error and an
 * unknown ticker alike into a 200 carrying `source: "fallback"`, so a
 * market-data outage arrives here as a successful HTTP call with a warning
 * string in the body. Every guard this service has for a sick upstream — the
 * circuit breaker, `network_items`, `http_request_errors_total` — reads that as
 *healthy and is right to: nothing failed.
 *
 * What the callers then do with it is per-ticker and per-request. The
 * volatility estimator drops the peer into `excluded`, the comparables refresh
 * into `unavailable`, and ASC 718 measures on the caller's own defaults. All
 * three are read by an analyst, on a screen, one engagement at a time. So the
 * platform-wide question — is the feed down for everyone, or does this peer set
 * just contain three tickers Yahoo does not carry — could not be asked at all.
 *
 * R305 gave the engine a log line per fallback. This is the other half, and the
 * one that matters for the first M11 question: `infra/journald` is retention
 * and rate-limit configuration only, nothing on the box consumes a log field,
 * and the engine tier serves no `/metrics` at all. This endpoint is the channel
 * an alert can be written against, and the valuation service is the only tier
 * on both sides of that wire.
 *
 * Shaped like `report_render_total` next door, for the same reason: a fallback
 * still produces a usable answer, so the failure has no other symptom.
 * `observed` against `fallback` is a ratio a rule can fire on; a bare fallback
 * count could not separate one absent ticker from a dead source.
 *
 * DELIBERATELY NOT LABELLED BY TICKER. Symbols come from a caller's peer set,
 * so a label would mint an unbounded series set against
 * `MAX_SERIES_PER_METRIC` — the exact cardinality trap `routeLabel` exists to
 * avoid. The ticker is on the engine's log line, which is where you look once
 * this has told you to look.
 */
let answers: Counter | null = null;

/** What the feed was asked for. Matches the engine's `kind` cache-key prefix. */
export type MarketFeedKind = 'prices' | 'financials' | 'multiples';

/**
 * What came back.
 *
 * `unreachable` is kept apart from `fallback` because they are different
 * incidents with different first moves: the engine did not answer at all
 * (a 5xx, a timeout, an open breaker — already visible in the breaker and in
 * `network_items`), against the engine answering fine with no data behind it,
 * which nothing else can see.
 */
export type MarketFeedOutcome = 'observed' | 'fallback' | 'unreachable';

export function registerMarketFeedMetrics(registry: MetricsRegistry): void {
  answers = registry.counter(
    'market_feed_answers_total',
    'Live market-feed answers by outcome. outcome="fallback" is the engine answering 200 with no observed data behind it — a market-data outage has no other symptom.',
    ['kind', 'outcome'],
  );
}

/** Test seam: drops the instrument so one suite's counts cannot leak into another. */
export function resetMarketFeedMetrics(): void {
  answers = null;
}

export function recordMarketFeedAnswer(kind: MarketFeedKind, outcome: MarketFeedOutcome): void {
  answers?.inc({ kind, outcome });
}
