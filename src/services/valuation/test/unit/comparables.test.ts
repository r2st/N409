import { describe, expect, it } from 'vitest';
import {
  ComparableInputError,
  impliedMultiples,
  isDeletableSource,
  marketMultiples,
  median,
  multipleKeyFor,
  resolveExcludeReason,
  summarizeSet,
  type ComparableSetRow,
} from '../../src/domain/comparables.js';

/**
 * The peer set's arithmetic and its one rule (design §4.5).
 *
 * The property that matters most is the last one in this file: the multiples
 * handed to the market approach are the *included* rows' and nothing else. An
 * excluded comp that still moves the median is an exclusion that did not
 * happen, and the reason recorded against it is then a false statement in the
 * exhibit.
 */

const peer = (over: Partial<ComparableSetRow> = {}): ComparableSetRow => ({
  included: true,
  ev: 1_000,
  revenue_ltm: 100,
  revenue_ntm: 125,
  ebitda_ltm: 50,
  ebitda_ntm: 62.5,
  ...over,
});

describe('impliedMultiples', () => {
  it('derives all four quotients from EV and the metric legs', () => {
    expect(impliedMultiples(peer())).toEqual({
      ev_revenue_ltm: 10,
      ev_revenue_ntm: 8,
      ev_ebitda_ltm: 20,
      ev_ebitda_ntm: 16,
    });
  });

  it('returns null rather than a number for a non-positive denominator', () => {
    // A loss-making comp has no meaningful EV/EBITDA. Arithmetic would happily
    // produce -40x, and -40x in a median is the observation that quietly
    // halves a conclusion.
    const loss = impliedMultiples(peer({ ebitda_ltm: -25, ebitda_ntm: 0 }));
    expect(loss.ev_ebitda_ltm).toBeNull();
    expect(loss.ev_ebitda_ntm).toBeNull();
    expect(loss.ev_revenue_ltm).toBe(10);
  });

  it('returns null throughout when EV is unknown', () => {
    expect(impliedMultiples(peer({ ev: null }))).toEqual({
      ev_revenue_ltm: null,
      ev_revenue_ntm: null,
      ev_ebitda_ltm: null,
      ev_ebitda_ntm: null,
    });
  });

  it('reads numeric columns that arrive from pg as strings', () => {
    expect(
      impliedMultiples({ ev: '900' as unknown as number, revenue_ltm: '90' as unknown as number }),
    ).toMatchObject({ ev_revenue_ltm: 10 });
  });
});

describe('median', () => {
  // The engine selects statistics.median; this has to agree with it or the
  // tab previews a multiple the report never applies.
  it('averages the middle pair on an even count', () => {
    expect(median([4, 8, 10, 2])).toBe(6);
  });

  it('takes the middle value on an odd count', () => {
    expect(median([9, 1, 5])).toBe(5);
  });

  it('is null for an empty set', () => {
    expect(median([])).toBeNull();
  });
});

describe('multipleKeyFor', () => {
  it('maps the engagement params to one of the four multiples', () => {
    expect(multipleKeyFor('ebitda', 'ntm')).toBe('ev_ebitda_ntm');
    expect(multipleKeyFor('revenue', 'ltm')).toBe('ev_revenue_ltm');
  });

  it('falls back to LTM revenue when params say nothing', () => {
    // Matches the engine default (`horizon = "ltm"`) and the pre-existing
    // behaviour in buildCalculationInputs, where anything not 'ebitda' was
    // treated as revenue.
    expect(multipleKeyFor(null, null)).toBe('ev_revenue_ltm');
    expect(multipleKeyFor(undefined, 'nonsense')).toBe('ev_revenue_ltm');
  });
});

describe('summarizeSet', () => {
  it('summarises only the included rows', () => {
    const stats = summarizeSet([
      peer({ ev: 1_000, revenue_ltm: 100 }), // 10x
      peer({ ev: 1_200, revenue_ltm: 100 }), // 12x
      peer({ included: false, ev: 9_000, revenue_ltm: 100 }), // 90x, excluded
    ]);
    expect(stats.ev_revenue_ltm.count).toBe(2);
    expect(stats.ev_revenue_ltm.median).toBe(11);
    expect(stats.ev_revenue_ltm.max).toBe(12);
  });

  it('reports a zero count rather than a zero median when nothing implies the multiple', () => {
    const stats = summarizeSet([peer({ ebitda_ltm: null, ebitda_ntm: null })]);
    expect(stats.ev_ebitda_ltm).toMatchObject({ count: 0, median: null, min: null, max: null });
  });
});

describe('marketMultiples', () => {
  it('hands the engine the included rows for the configured multiple', () => {
    const rows = [
      peer({ ev: 1_000, revenue_ltm: 100, ebitda_ltm: 50 }),
      peer({ ev: 1_500, revenue_ltm: 100, ebitda_ltm: 50 }),
    ];
    expect(marketMultiples(rows, 'revenue', 'ltm')).toEqual([10, 15]);
    expect(marketMultiples(rows, 'ebitda', 'ltm')).toEqual([20, 30]);
  });

  it('drops an excluded comp entirely', () => {
    const rows = [
      peer({ ev: 1_000, revenue_ltm: 100 }),
      peer({ included: false, ev: 50_000, revenue_ltm: 100 }),
    ];
    expect(marketMultiples(rows, 'revenue', 'ltm')).toEqual([10]);
  });

  it('is empty when no included row implies the multiple, so the caller can fall back', () => {
    // Empty and not [0]: the engine rejects a multiples list with nothing
    // positive in it, so an engagement with an unscreened set would fail its
    // whole calculation rather than falling back to the AI aggregate.
    expect(marketMultiples([peer({ ebitda_ltm: null })], 'ebitda', 'ltm')).toEqual([]);
    expect(marketMultiples([], 'revenue', 'ltm')).toEqual([]);
  });
});

describe('resolveExcludeReason', () => {
  it('requires a reason to exclude', () => {
    expect(() => resolveExcludeReason(false, null)).toThrow(ComparableInputError);
    expect(() => resolveExcludeReason(false, '   ')).toThrow(/requires a reason/);
  });

  it('trims and keeps the reason on an exclusion', () => {
    expect(resolveExcludeReason(false, '  different industry ')).toBe('different industry');
  });

  it('clears a stale reason when a row is re-included', () => {
    // included = true with a reason still attached is a row two readers read
    // two ways, and the exhibit would print the contradiction.
    expect(resolveExcludeReason(true, 'different industry')).toBeNull();
  });
});

describe('isDeletableSource', () => {
  it('permits deleting analyst rows only', () => {
    expect(isDeletableSource('analyst')).toBe(true);
    expect(isDeletableSource('ai')).toBe(false);
    expect(isDeletableSource('market_feed')).toBe(false);
  });
});
