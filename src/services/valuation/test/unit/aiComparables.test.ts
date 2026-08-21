import { describe, expect, it } from 'vitest';
import {
  AiComparablesError,
  UNPRICED_REASON,
  ebitdaFor,
  enterpriseValueFor,
  mapAgentComparables,
} from '../../src/domain/aiComparables.js';
import { impliedMultiples, summarizeSet } from '../../src/domain/comparables.js';

/**
 * The `comp_selection` agent's output as peer-set rows.
 *
 * The property that matters most is the round trip in the last block: the
 * multiple `impliedMultiples` strikes from a stored row has to be the multiple
 * the agent reported. If the mapping stores an EV that does not divide into the
 * revenue beside it, the tab and the exhibit both print a number the agent
 * never produced — and it looks exactly as authoritative as one it did.
 */

const OBSERVED = new Date('2026-08-01T12:00:00Z');

const comp = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Acme Robotics Inc',
  ticker: 'acme',
  sic_code: '3559',
  market_cap: 1_200,
  revenue: 100,
  ebitda_margin: 0.25,
  ev_revenue: 12,
  ev_ebitda: 48,
  score: 0.82,
  score_breakdown: { industry: 1 },
  justification: 'Same sector and scale.',
  ...over,
});

const result = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  selected: [comp()],
  excluded: [{ ticker: 'ZZZ', name: 'Zeta Corp', reason: 'ten times the revenue' }],
  ...over,
});

describe('enterpriseValueFor', () => {
  it('takes market cap, which is the EV the engine snapshot strikes its own multiples on', () => {
    expect(enterpriseValueFor(comp({ market_cap: 1_200 }))).toBe(1_200);
  });

  it('falls back to ev_revenue x revenue when there is no market cap', () => {
    expect(enterpriseValueFor(comp({ market_cap: null, revenue: 100, ev_revenue: 9.5 }))).toBe(950);
  });

  it('is null when neither is available — a row with no EV implies no multiple', () => {
    expect(enterpriseValueFor(comp({ market_cap: null, ev_revenue: null }))).toBeNull();
  });

  it('treats a non-positive market cap as absent rather than as a figure', () => {
    expect(enterpriseValueFor(comp({ market_cap: 0, revenue: 100, ev_revenue: 4 }))).toBe(400);
    expect(enterpriseValueFor(comp({ market_cap: -50, revenue: null, ev_revenue: null }))).toBeNull();
  });

  it('reads a numeric string, which is how a stored JSON blob can hand one back', () => {
    expect(enterpriseValueFor(comp({ market_cap: '1200' }))).toBe(1_200);
  });
});

describe('ebitdaFor', () => {
  it('derives EBITDA from revenue and the reported margin', () => {
    expect(ebitdaFor(comp({ revenue: 100, ebitda_margin: 0.25 }))).toBe(25);
  });

  it('keeps a negative margin — a loss-making comp is a fact, not a missing value', () => {
    expect(ebitdaFor(comp({ revenue: 100, ebitda_margin: -0.1 }))).toBe(-10);
  });

  it('is null without a revenue to apply the margin to', () => {
    expect(ebitdaFor(comp({ revenue: null }))).toBeNull();
  });
});

describe('mapAgentComparables', () => {
  it('maps a selected comp to an included row with the agent figures', () => {
    const { rows } = mapAgentComparables(result(), OBSERVED);
    const acme = rows.find((r) => r.ticker === 'ACME');
    expect(acme).toMatchObject({
      ticker: 'ACME',
      name: 'Acme Robotics Inc',
      sic: '3559',
      included: true,
      revenueLtm: 100,
      ebitdaLtm: 25,
      ev: 1_200,
      score: 0.82,
      figuresSource: 'snapshot',
    });
    expect(acme?.figuresAsOf).toEqual(OBSERVED);
  });

  it('upper-cases the ticker so it reconciles with the analyst and feed rows', () => {
    const { rows } = mapAgentComparables(result(), OBSERVED);
    expect(rows.map((r) => r.ticker)).toContain('ACME');
  });

  it('carries the excluded half across with the agent reason', () => {
    const { rows, summary } = mapAgentComparables(result(), OBSERVED);
    const zeta = rows.find((r) => r.ticker === 'ZZZ');
    expect(zeta).toMatchObject({
      included: false,
      excludeReason: 'ten times the revenue',
      ev: null,
      revenueLtm: null,
    });
    expect(summary).toEqual({ selected: 1, excluded: 1, unusable: 0 });
  });

  it('supplies a reason for an excluded comp the agent gave none for', () => {
    const { rows } = mapAgentComparables(result({ excluded: [{ ticker: 'QQQ', name: 'Quad' }] }), OBSERVED);
    expect(rows.find((r) => r.ticker === 'QQQ')?.excludeReason).toBe(
      'not selected by the AI comparable agent',
    );
  });

  it('excludes a selected comp the engine could not price, rather than dropping it', () => {
    const { rows, summary } = mapAgentComparables(
      result({ selected: [comp({ market_cap: null, revenue: null, ev_revenue: null })] }),
      OBSERVED,
    );
    const acme = rows.find((r) => r.ticker === 'ACME');
    expect(acme).toMatchObject({ included: false, excludeReason: UNPRICED_REASON, ev: null });
    expect(summary.unusable).toBe(1);
  });

  it('drops a selected comp with no ticker — it can never be reconciled or refreshed', () => {
    const { rows } = mapAgentComparables(
      result({ selected: [comp(), comp({ ticker: '  ', name: 'Nameless Co' })] }),
      OBSERVED,
    );
    expect(rows.filter((r) => r.included)).toHaveLength(1);
  });

  it('keeps the first of a repeated ticker rather than writing the pair', () => {
    const { rows } = mapAgentComparables(
      result({ selected: [comp(), comp({ market_cap: 999 })], excluded: [] }),
      OBSERVED,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ev).toBe(1_200);
  });

  it('does not let the excluded list overwrite a comp already selected', () => {
    const { rows } = mapAgentComparables(
      result({ excluded: [{ ticker: 'ACME', reason: 'stale' }] }),
      OBSERVED,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ticker: 'ACME', included: true });
  });

  it('falls back to the ticker when the agent named no company', () => {
    const { rows } = mapAgentComparables(result({ selected: [comp({ name: null })] }), OBSERVED);
    expect(rows[0]!.name).toBe('ACME');
  });

  it('ignores non-object entries in either list', () => {
    const { rows } = mapAgentComparables(
      result({ selected: ['ACME', null, comp()], excluded: [42] }),
      OBSERVED,
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses a job whose result is not an object', () => {
    expect(() => mapAgentComparables(null, OBSERVED)).toThrow(AiComparablesError);
    expect(() => mapAgentComparables('selected: none', OBSERVED)).toThrow(AiComparablesError);
  });

  it('refuses a run that named no company with a ticker, rather than writing an empty set', () => {
    expect(() => mapAgentComparables({ selected: [], excluded: [] }, OBSERVED)).toThrow(
      /named no company with a ticker/,
    );
  });

  /**
   * The round trip. `impliedMultiples` is what the tab and Exhibit D-1 print,
   * so it — not the agent's own `ev_revenue` field — is the number a reader
   * sees. The two have to be the same number.
   */
  it('stores figures whose implied multiple reproduces the agent multiple', () => {
    const { rows } = mapAgentComparables(
      result({ selected: [comp({ market_cap: 1_200, revenue: 100, ebitda_margin: 0.25 })] }),
      OBSERVED,
    );
    const multiples = impliedMultiples(
      rows[0]!.ev === null
        ? {}
        : {
            ev: rows[0]!.ev,
            revenue_ltm: rows[0]!.revenueLtm,
            ebitda_ltm: rows[0]!.ebitdaLtm,
          },
    );
    expect(multiples.ev_revenue_ltm).toBe(12);
    expect(multiples.ev_ebitda_ltm).toBe(48);
  });

  it('leaves the median struck from the priced rows only', () => {
    const { rows } = mapAgentComparables(
      {
        selected: [
          comp({ ticker: 'AAA', market_cap: 1_000, revenue: 100 }),
          comp({ ticker: 'BBB', market_cap: 3_000, revenue: 100 }),
          comp({ ticker: 'CCC', market_cap: null, revenue: null, ev_revenue: null }),
        ],
        excluded: [],
      },
      OBSERVED,
    );
    const stats = summarizeSet(
      rows.map((r) => ({ included: r.included, ev: r.ev, revenue_ltm: r.revenueLtm })),
    );
    expect(stats.ev_revenue_ltm.count).toBe(2);
    expect(stats.ev_revenue_ltm.median).toBe(20);
  });
});
