import { describe, expect, it } from 'vitest';
import {
  measuredCount,
  resolveWindow,
  seriesFromBars,
  shapeEstimate,
  volatilityNarrative,
  VolatilityInputError,
} from '../../src/domain/volatility.js';
import { volatilityExhibit } from '../../src/domain/reportExhibits.js';
import type { VolatilityEstimateRow } from '../../src/repos/volatilityEstimates.js';

const NOW = new Date('2026-08-09T12:00:00Z');

function bar(close: number, high = close * 1.01, low = close * 0.99) {
  return { date: '2026-01-02', open: close, high, low, close };
}

/** A stored run, in the shape the repo hydrates. */
function estimate(over: Partial<VolatilityEstimateRow> = {}): VolatilityEstimateRow {
  return {
    id: '01J0000000000000000000000A',
    valuation_id: '01J0000000000000000000000V',
    method: 'historical',
    periods_per_year: 252,
    window_start: new Date('2025-06-30T00:00:00Z'),
    window_end: new Date('2026-06-30T00:00:00Z'),
    time_to_exit_years: 3,
    recommended: 0.6412,
    median_vol: 0.6412,
    mean_vol: 0.6501,
    min_vol: 0.4802,
    max_vol: 0.8103,
    coefficient_of_variation: 0.19,
    confidence: 'high',
    manual_override: null,
    companies: [
      { ticker: 'AAA', volatility: 0.4802, used: true, observations: 251 },
      { ticker: 'BBB', volatility: 0.6412, used: true, observations: 251 },
      { ticker: 'CCC', volatility: 0.8103, used: true, observations: 248 },
    ],
    excluded: [{ ticker: 'DDD', reason: 'no measurable price movement' }],
    applied_at: new Date('2026-07-01T00:00:00Z'),
    applied_by: null,
    created_by: null,
    created_at: new Date('2026-07-01T00:00:00Z'),
    ...over,
  };
}

describe('resolveWindow', () => {
  it('anchors the window on the valuation date, not on today', () => {
    // A sigma supporting a 409A as of a past date must not be measured over
    // price history the subject could not have known about.
    const w = resolveWindow('2025-12-31', 365, NOW);
    expect(w.end).toBe('2025-12-31');
    expect(w.start).toBe('2024-12-31');
  });

  it('falls back to today when the engagement has no valuation date', () => {
    const w = resolveWindow(null, 365, NOW);
    expect(w.end).toBe('2026-08-09');
  });

  it('refuses a window too short to measure anything', () => {
    expect(() => resolveWindow('2026-06-30', 5, NOW)).toThrow(VolatilityInputError);
  });
});

describe('seriesFromBars', () => {
  it('takes the closes for a close-to-close estimate', () => {
    const s = seriesFromBars('AAA', [bar(10), bar(11), bar(12)], 'historical');
    expect(s?.prices).toEqual([10, 11, 12]);
    expect(s?.highs).toBeUndefined();
  });

  it('keeps the three legs the same length for a range estimate', () => {
    // Positional pairing inside the engine is why: a highs array one element
    // shorter would silently pair each day's high with the next day's low.
    const bars = [bar(10), { date: 'x', close: 11 }, bar(12)];
    const s = seriesFromBars('AAA', bars, 'parkinson');
    expect(s?.prices).toHaveLength(2);
    expect(s?.highs).toHaveLength(2);
    expect(s?.lows).toHaveLength(2);
  });

  it('rejects a series with fewer than two usable closes', () => {
    expect(seriesFromBars('AAA', [bar(10)], 'historical')).toBeNull();
    expect(seriesFromBars('AAA', [{ close: null }, { close: 0 }], 'historical')).toBeNull();
    expect(seriesFromBars('AAA', 'not-an-array', 'historical')).toBeNull();
  });
});

describe('shapeEstimate', () => {
  const response = {
    method: 'historical',
    recommended_volatility: 0.64,
    median_volatility: 0.64,
    mean_volatility: 0.65,
    min_volatility: 0.48,
    max_volatility: 0.81,
    coefficient_of_variation: 0.19,
    confidence: 'high',
    manual_override: null,
    companies: [
      { ticker: 'AAA', volatility: 0.48, used: true },
      { ticker: 'DDD', volatility: 0, used: false },
    ],
    excluded_companies: [{ ticker: 'DDD', reason: 'no measurable price movement' }],
  };

  it('carries the observation count from the series that were sent', () => {
    // "64% off eleven closes" is a materially different disclosure from the
    // same figure off two hundred and fifty, and the engine reports only what
    // it measured, not how much of it there was.
    const shaped = shapeEstimate(response, {
      series: [{ ticker: 'AAA', prices: new Array(251).fill(1) }],
      feedFailures: [],
    });
    expect(shaped.companies.find((c) => c.ticker === 'AAA')?.observations).toBe(251);
    expect(shaped.companies.find((c) => c.ticker === 'DDD')?.observations).toBeUndefined();
  });

  it('folds feed failures into the same excluded list as the engine drops', () => {
    // To a reader of Exhibit F-1 both are "in the set, not in the measurement",
    // and two lists would invite the reading that one of them is complete.
    const shaped = shapeEstimate(response, {
      series: [],
      feedFailures: [{ ticker: 'EEE', reason: 'the price feed could not be reached' }],
    });
    expect(shaped.excluded.map((e) => e.ticker)).toEqual(['EEE', 'DDD']);
  });

  it('refuses a response with no usable recommendation', () => {
    expect(() =>
      shapeEstimate({ ...response, recommended_volatility: 0 }, { series: [], feedFailures: [] }),
    ).toThrow(VolatilityInputError);
  });
});

describe('measuredCount', () => {
  it('counts only the peers the recommendation rests on', () => {
    expect(measuredCount(estimate())).toBe(3);
    expect(
      measuredCount(
        estimate({
          companies: [
            { ticker: 'AAA', volatility: 0.48, used: true },
            { ticker: 'DDD', volatility: 0, used: false },
          ],
        }),
      ),
    ).toBe(1);
  });
});

describe('volatilityNarrative', () => {
  it('says so when a derivation was not adopted', () => {
    const text = volatilityNarrative(estimate({ applied_at: null }), 0.65);
    expect(text).toContain('has not been adopted');
  });

  it('says so when the applied figure departs from the derived one', () => {
    const text = volatilityNarrative(estimate(), 0.7);
    expect(text).toContain('70.0%');
    expect(text).toContain('differs from the derived figure');
  });

  it('states the basis plainly when the two agree', () => {
    const text = volatilityNarrative(estimate(), 0.6412);
    expect(text).toContain('median of 3 guideline companies');
    expect(text).not.toContain('differs');
  });

  it('is absent when nothing was derived', () => {
    expect(volatilityNarrative(null, 0.65)).toBeNull();
  });
});

describe('volatilityExhibit', () => {
  const CTX = { currency: 'USD', companyName: 'Northwind Robotics, Inc.' };
  const RESULTS = { allocation: { assumptions: { volatility: 0.6412 } } };

  it('is not rendered for an engagement with no derivation', () => {
    expect(volatilityExhibit({ ...CTX }, RESULTS)).toBeNull();
    expect(volatilityExhibit({ ...CTX, volatility: null }, RESULTS)).toBeNull();
  });

  it('prints every peer, the median, and the peers not measured', () => {
    const s = volatilityExhibit({ ...CTX, volatility: estimate() }, RESULTS);
    expect(s?.heading).toBe('Exhibit F-1 — Selected Volatility');
    expect(s?.html).toContain('AAA');
    expect(s?.html).toContain('64.1%');
    // Considered and not measured — the column an auditor asks about.
    expect(s?.html).toContain('DDD');
    expect(s?.html).toContain('no measurable price movement');
    expect(s?.html).toContain('2025-06-30 to 2026-06-30');
  });

  it('sorts the peers by measured volatility, not by screen order', () => {
    const html = volatilityExhibit({ ...CTX, volatility: estimate() }, RESULTS)?.html ?? '';
    expect(html.indexOf('CCC')).toBeLessThan(html.indexOf('BBB'));
    expect(html.indexOf('BBB')).toBeLessThan(html.indexOf('AAA'));
  });

  it('says in terms when the derivation was not adopted', () => {
    const s = volatilityExhibit({ ...CTX, volatility: estimate({ applied_at: null }) }, RESULTS);
    expect(s?.html).toContain('not been adopted');
  });

  it('reports a departure between the applied and the derived figure', () => {
    const s = volatilityExhibit(
      { ...CTX, volatility: estimate() },
      { allocation: { assumptions: { volatility: 0.72 } } },
    );
    expect(s?.html).toContain('72.0%');
    expect(s?.html).toContain('departs from the derived');
  });

  it('does not claim a departure when the calculation ran on the derived figure', () => {
    const s = volatilityExhibit({ ...CTX, volatility: estimate() }, RESULTS);
    expect(s?.html).not.toContain('departs from the derived');
    expect(s?.html).not.toContain('not been adopted');
  });

  it('escapes a ticker that could close a cell', () => {
    const s = volatilityExhibit(
      {
        ...CTX,
        volatility: estimate({
          companies: [{ ticker: '<b>X</b>', volatility: 0.5, used: true }],
          excluded: [],
        }),
      },
      RESULTS,
    );
    expect(s?.html).toContain('&lt;b&gt;X&lt;/b&gt;');
    expect(s?.html).not.toContain('<b>X</b>');
  });
});
