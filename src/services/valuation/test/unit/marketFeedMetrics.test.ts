import { afterEach, describe, expect, it } from 'vitest';
import { MetricsRegistry } from '@n409/shared';
import {
  recordMarketFeedAnswer,
  registerMarketFeedMetrics,
  resetMarketFeedMetrics,
} from '../../src/clients/marketFeedMetrics.js';

/**
 * A market-data outage that answers 200 (R305, methodology M11).
 *
 * `engine/v1/market-feed` never fails: the engine turns a missing provider, a
 * network error, a parse error and an unknown ticker alike into a 200 carrying
 * `source: "fallback"`. So the circuit breaker, the `network_items` row and
 * `http_request_errors_total` all read healthy for a feed that has gone dark,
 * and they are right to — nothing failed.
 *
 * What the three callers do with a fallback is per-ticker and per-request: the
 * volatility estimator drops the peer into `excluded`, the comparables refresh
 * into `unavailable`, ASC 718 measures on the caller's substituted defaults.
 * All three are read by one analyst looking at one engagement, so "is the feed
 * down for everybody" was not a question anything could answer.
 *
 * `/metrics` is the channel that matters for the first M11 question. Nothing on
 * the box consumes a log field — `infra/journald` is retention and rate-limit
 * configuration — and the engine tier serves no `/metrics` at all, so the
 * valuation service, sitting on both sides of that wire, is where this has to
 * be counted.
 */
describe('the market-feed outcome counter', () => {
  afterEach(() => resetMarketFeedMetrics());

  it('separates an answer with data behind it from one without', () => {
    const registry = new MetricsRegistry();
    registerMarketFeedMetrics(registry);

    recordMarketFeedAnswer('prices', 'observed');
    recordMarketFeedAnswer('prices', 'observed');
    recordMarketFeedAnswer('prices', 'fallback');
    recordMarketFeedAnswer('financials', 'unreachable');

    const text = registry.render();
    expect(text).toContain('market_feed_answers_total{kind="prices",outcome="observed"} 2');
    expect(text).toContain('market_feed_answers_total{kind="prices",outcome="fallback"} 1');
    expect(text).toContain('market_feed_answers_total{kind="financials",outcome="unreachable"} 1');
  });

  it('keeps `observed` so a fallback count has a denominator', () => {
    // The R297 lesson applied one wire over: a bare failure tally cannot
    // separate "three tickers nobody carries" from "the source is dead", and
    // the number of estimates a deployment runs per hour is not something a
    // dashboard holds. The ratio is the alertable quantity.
    const registry = new MetricsRegistry();
    registerMarketFeedMetrics(registry);
    recordMarketFeedAnswer('prices', 'observed');
    expect(registry.render()).toContain('outcome="observed"');
  });

  it('is inert before registration rather than throwing', () => {
    // Every unit test that exercises a route without building the app reaches
    // these call sites with no registry anywhere. The instrument is
    // module-level for the same reason `reportRender`'s is, so an unregistered
    // record has to be a no-op.
    expect(() => recordMarketFeedAnswer('prices', 'fallback')).not.toThrow();
  });

  it('carries no ticker label', () => {
    // Symbols come out of a caller's peer set, so a ticker label is an
    // unbounded series set measured against MAX_SERIES_PER_METRIC — the exact
    // cardinality trap `routeLabel` exists for. The ticker belongs on the
    // engine's log line, which is where you look after this has told you to.
    const registry = new MetricsRegistry();
    registerMarketFeedMetrics(registry);
    recordMarketFeedAnswer('prices', 'fallback');
    expect(registry.render()).not.toMatch(/market_feed_answers_total\{[^}]*ticker=/);
  });
});
