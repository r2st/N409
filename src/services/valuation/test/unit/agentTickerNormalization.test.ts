import { describe, expect, it } from 'vitest';
import { mapAgentComparables, normalizeAgentTicker } from '../../src/domain/aiComparables.js';

/**
 * The one door onto `comparable_items.ticker` that is fed by a language model
 * (R410, methodology M19).
 *
 * Three doors write that column. The analyst door holds it to
 * `/^[A-Za-z0-9.-]+$/` and upper-cases; the engine's `normalize_ticker`
 * upper-cases *and* "drops an exchange prefix like `NASDAQ:DDOG` that models
 * sometimes emit" — its own words, about the very producer feeding this one.
 * This door only upper-cased, and truncated anything long to twelve characters.
 *
 * The column's unique index is on the raw text, and its migration says what it
 * is for: "a re-screen that proposed AAPL twice, or an analyst adding a peer the
 * agent already found, is a duplicate observation and would double that comp's
 * weight in the median". `NASDAQ:DDOG` and `DDOG` are two rows to that index —
 * and to `replaceMachineComparables`'s `taken` set, and to the include/exclude
 * decisions it carries across a re-screen, both keyed on the same exact string.
 */
const OBSERVED = new Date('2026-08-01T12:00:00Z');

const comp = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Datadog Inc',
  ticker: 'DDOG',
  sic_code: '7372',
  market_cap: 1_200,
  revenue: 100,
  ebitda_margin: 0.25,
  score: 0.82,
  ...over,
});

describe('normalizeAgentTicker', () => {
  it('upper-cases, as it always did', () => {
    expect(normalizeAgentTicker(' ddog ')).toBe('DDOG');
  });

  it('drops the exchange prefix the engine says models emit', () => {
    expect(normalizeAgentTicker('NASDAQ:DDOG')).toBe('DDOG');
    expect(normalizeAgentTicker('nyse: brk.b')).toBe('BRK.B');
  });

  it('takes the last colon, so a doubled prefix still resolves to the ticker', () => {
    // `rsplit(":", 1)` in `market_data.normalize_ticker`.
    expect(normalizeAgentTicker('NASDAQ:NASDAQ:DDOG')).toBe('DDOG');
  });

  it('refuses a ticker too long to store rather than truncating it to a different one', () => {
    // `sliceChars(_, 12)` turned `OTCMKTS:XXXXX` into `OTCMKTS:XXXX`, which is
    // not a shorter ticker but a different one, in the column everything
    // reconciles on. After the prefix strip this one is short enough and is
    // kept; a genuinely over-long symbol is dropped.
    expect(normalizeAgentTicker('OTCMKTS:XXXXX')).toBe('XXXXX');
    expect(normalizeAgentTicker('A'.repeat(13))).toBeNull();
    expect(normalizeAgentTicker('A'.repeat(12))).toBe('A'.repeat(12));
  });

  it('refuses anything that is not a ticker at all', () => {
    for (const raw of ['', '   ', 'NASDAQ:', 'AC ME', 'Δ', null, 42, { ticker: 'DDOG' }]) {
      expect(normalizeAgentTicker(raw)).toBeNull();
    }
  });
});

describe('mapAgentComparables reconciles with the other two doors', () => {
  it('stores a prefixed ticker as the plain symbol the analyst and feed rows use', () => {
    const { rows } = mapAgentComparables(
      { selected: [comp({ ticker: 'NASDAQ:DDOG' })], excluded: [] },
      OBSERVED,
    );
    expect(rows.map((r) => r.ticker)).toEqual(['DDOG']);
  });

  it('treats a prefixed and a plain spelling of one company as one comp', () => {
    // Before the fix these were two rows, and every downstream dedupe — the
    // unique index, `taken`, the carried exclusion — is keyed on the string.
    const { rows } = mapAgentComparables(
      { selected: [comp({ ticker: 'NASDAQ:DDOG' }), comp({ ticker: 'ddog' })], excluded: [] },
      OBSERVED,
    );
    expect(rows.filter((r) => r.ticker === 'DDOG')).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });

  it('drops a comp whose ticker cannot be read, as it drops one with none', () => {
    // The branch the callers already document: a row that cannot be reconciled,
    // refreshed or carried into the next screen is not a stored peer.
    const { rows } = mapAgentComparables(
      { selected: [comp(), comp({ ticker: 'NOT A TICKER', name: 'Mystery Co' })], excluded: [] },
      OBSERVED,
    );
    expect(rows.map((r) => r.name)).toEqual(['Datadog Inc']);
  });
});
