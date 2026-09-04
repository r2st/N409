import { describe, expect, it } from 'vitest';
import {
  MAX_RECORDABLE_VOLATILITY,
  measuredCount,
  resolveWindow,
  MIN_BARS_BY_METHOD,
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

/**
 * A `date` column as the driver hands it back: midnight *local*.
 *
 * `new Date('2025-06-30T00:00:00Z')` is midnight UTC, which is a different
 * instant and not what node-postgres produces for OID 1082 — it only looked
 * equivalent because the host these tests were written on runs UTC. Building the
 * fixture the way the driver does is what makes the assertions below mean
 * anything about production. See src/domain/calendarDate.ts.
 */
const pgDate = (y: number, m: number, d: number) => new Date(y, m - 1, d);

/** A stored run, in the shape the repo hydrates. */
function estimate(over: Partial<VolatilityEstimateRow> = {}): VolatilityEstimateRow {
  return {
    id: '01J0000000000000000000000A',
    valuation_id: '01J0000000000000000000000V',
    method: 'historical',
    periods_per_year: 252,
    window_start: pgDate(2025, 6, 30),
    window_end: pgDate(2026, 6, 30),
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

  // R407 (M2): the floor is the estimator's, not a shared two. Close-to-close
  // and EWMA divide by `returns.length - 1`, which is zero on two closes, so
  // the engine refuses the *request* — every other peer's measurable history
  // with it. Excluded here instead.
  it('rejects a two-close series for the estimators that need three', () => {
    expect(seriesFromBars('AAA', [bar(10), bar(11)], 'historical')).toBeNull();
    expect(seriesFromBars('AAA', [bar(10), bar(11)], 'ewma')).toBeNull();
    expect(seriesFromBars('AAA', [bar(10), bar(11), bar(12)], 'historical')?.prices).toEqual([
      10, 11, 12,
    ]);
    expect(seriesFromBars('AAA', [bar(10), bar(11), bar(12)], 'ewma')?.prices).toEqual([
      10, 11, 12,
    ]);
  });

  it('still measures a two-bar range series, which parkinson can price', () => {
    // Parkinson reads each bar's own high/low, so it has no sample-variance
    // denominator to divide by and two bars is a measurement.
    const s = seriesFromBars('AAA', [bar(10), bar(11)], 'parkinson');
    expect(s?.prices).toHaveLength(2);
    expect(s?.highs).toHaveLength(2);
    expect(s?.lows).toHaveLength(2);
  });

  it('states the floor each estimator is actually held to', () => {
    expect(MIN_BARS_BY_METHOD).toEqual({ historical: 3, ewma: 3, parkinson: 2 });
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

  it('refuses a recommendation above the band the row is stored in', () => {
    // `volatility_estimates.recommended` is CHECK (> 0 AND <= 5) — a figure
    // over the ceiling used to reach the INSERT and come back as a 500, taking
    // the run's peer measurements with it.
    expect(() =>
      shapeEstimate({ ...response, recommended_volatility: 5.01 }, { series: [], feedFailures: [] }),
    ).toThrow(VolatilityInputError);
    expect(() =>
      shapeEstimate({ ...response, recommended_volatility: 5.01 }, { series: [], feedFailures: [] }),
    ).toThrow(/501.0%/);
  });

  it('records a recommendation between the adoption band and the storage ceiling', () => {
    // The overwrite field maxes at 3; the column takes up to 5. That gap is
    // deliberate — the measurement is recorded and refused at adoption, not at
    // the run that produced it — so the door must not narrow to the same band.
    expect(
      shapeEstimate({ ...response, recommended_volatility: 4.2 }, { series: [], feedFailures: [] })
        .recommended,
    ).toBe(4.2);
    expect(
      shapeEstimate({ ...response, recommended_volatility: MAX_RECORDABLE_VOLATILITY }, {
        series: [],
        feedFailures: [],
      }).recommended,
    ).toBe(5);
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

  /*
   * R387, methodology M19. The lead paragraph asserted the median — "taken at
   * the median, which is robust to a single outlier peer" — for every run,
   * including one the appraiser pinned. The footer under the peer table has
   * said `Analyst selection` for that case since it was written, and `Estimator`
   * reads `Analyst-selected`, so the exhibit's own opening sentence contradicted
   * two rows of its own table. R386 sharpens it: with a pinned figure over comps
   * with no measurable movement, the median claimed is the median of an empty
   * set, and the distribution table is dropped for exactly that reason.
   */
  it('does not claim the median for a figure the appraiser selected', () => {
    const s = volatilityExhibit(
      {
        ...CTX,
        volatility: estimate({
          method: 'manual',
          confidence: 'manual',
          manual_override: 0.6412,
          median_vol: null,
          mean_vol: null,
          min_vol: null,
          max_vol: null,
          coefficient_of_variation: null,
          companies: [{ ticker: 'AAA', volatility: 0, used: false }],
        }),
      },
      RESULTS,
    );
    expect(s?.html).toContain('selected by the appraiser');
    expect(s?.html).not.toContain('taken at the median');
    // The footer and the estimator row already said so; the paragraph now agrees.
    expect(s?.html).toContain('Analyst selection');
    expect(s?.html).toContain('Analyst-selected');
    // And the distribution table is gone with its figures, not printed as dashes.
    expect(s?.html).not.toContain('Cross-sectional distribution');
  });

  it('still says the median is what a measured run was taken at', () => {
    const s = volatilityExhibit({ ...CTX, volatility: estimate() }, RESULTS);
    expect(s?.html).toContain('taken at the median');
    expect(s?.html).not.toContain('selected by the appraiser');
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

/**
 * The shapes the market feed and the estimator actually return when something
 * upstream has gone wrong — as opposed to the well-formed ones the rest of this
 * file exercises.
 *
 * Every branch below is a coercion this module performs on data it does not
 * control: `engine/v1/market-feed` bars and the `engine/v1/volatility`
 * response. They are the boundary, so a shape it does not recognise has to
 * become a dropped peer or a documented default rather than a `NaN` in a
 * signed report or a throw inside a route.
 */
describe('volatility on inputs from outside this service', () => {
  it('anchors the window on today when the valuation date is unparseable', () => {
    const w = resolveWindow('not-a-date', 365, NOW);
    expect(w.end).toBe('2026-08-09');
    expect(w.start).toBe('2025-08-09');
  });

  it('skips a bar that is not an object at all', () => {
    // Three closes, not two: the close-to-close floor is the engine's sample
    // standard deviation (see MIN_BARS_BY_METHOD). What this asserts is that
    // the junk entries are skipped, not that a short series survives.
    const series = seriesFromBars('AAA', [null, 'x', 7, bar(10), bar(11), bar(12)], 'historical');
    expect(series?.prices).toEqual([10, 11, 12]);
  });

  it('refuses a Parkinson series whose highs and lows do not line up', () => {
    // A bar carrying a close and a high but no low passes the close filter for
    // the historical estimator and leaves the three legs ragged. The range
    // estimator reads them positionally, so a ragged set is refused outright
    // rather than measured against mismatched days.
    const bars = [
      { close: 10, high: 10.1, low: 9.9 },
      { close: 11, high: 11.1, low: 10.9 },
    ];
    expect(seriesFromBars('AAA', bars, 'parkinson')?.highs).toHaveLength(2);
    expect(seriesFromBars('AAA', [{ close: 10, high: 10.1 }, ...bars], 'parkinson')?.prices).toHaveLength(2);
  });

  it('defaults an unrecognised method and confidence rather than storing them', () => {
    // Both columns are enums in Postgres. A value the engine has started
    // emitting that this service does not know is an insert that fails at the
    // end of a job, so it is narrowed here to the conservative reading:
    // the plain estimator, and the lowest confidence.
    const shaped = shapeEstimate(
      { recommended_volatility: 0.5, method: 'garch', confidence: 42 },
      { series: [], feedFailures: [] },
    );
    expect(shaped.method).toBe('historical');
    expect(shaped.confidence).toBe('low');
  });

  it('drops a measured company with no ticker or no volatility', () => {
    const shaped = shapeEstimate(
      {
        recommended_volatility: 0.5,
        companies: [
          { ticker: 'AAA', volatility: 0.5 },
          { ticker: null, volatility: 0.6 },
          { ticker: 'BBB', volatility: 'n/a' },
        ],
      },
      { series: [], feedFailures: [] },
    );
    expect(shaped.companies.map((c) => c.ticker)).toEqual(['AAA']);
    // No series was sent for AAA, so no observation count is grafted on — the
    // exhibit prints a dash rather than claiming a sample size.
    expect(shaped.companies[0]).not.toHaveProperty('observations');
  });

  it('treats a non-list of companies or exclusions as an empty one', () => {
    const shaped = shapeEstimate(
      { recommended_volatility: 0.5, companies: 'x', excluded_companies: 3 },
      { series: [], feedFailures: [{ ticker: 'ZZZ', reason: 'feed timeout' }] },
    );
    expect(shaped.companies).toEqual([]);
    expect(shaped.excluded).toEqual([{ ticker: 'ZZZ', reason: 'feed timeout' }]);
  });

  it('gives an exclusion with no stated reason the estimator default', () => {
    const shaped = shapeEstimate(
      {
        recommended_volatility: 0.5,
        excluded_companies: [{ ticker: 'AAA' }, { ticker: 'BBB', reason: '   ' }, { reason: 'orphan' }],
      },
      { series: [], feedFailures: [] },
    );
    expect(shaped.excluded).toEqual([
      { ticker: 'AAA', reason: 'excluded by the estimator' },
      { ticker: 'BBB', reason: 'excluded by the estimator' },
    ]);
  });

  it('says an analyst selected the figure when the method is manual', () => {
    const text = volatilityNarrative(estimate({ method: 'manual' }), 0.6412);
    expect(text).toContain('selected by the analyst');
    expect(text).not.toContain('median of');
  });

  it('counts a single measured peer in the singular', () => {
    const text = volatilityNarrative(
      estimate({ companies: [{ ticker: 'AAA', volatility: 0.6412, used: true }] }),
      0.6412,
    );
    expect(text).toContain('median of 1 guideline company measured');
  });
});
