import { describe, expect, it } from 'vitest';
import {
  resolveWindow,
  seriesFromBars,
  shapeEstimate,
  measuredCount,
  volatilityNarrative,
  VolatilityInputError,
  MAX_RECORDABLE_VOLATILITY,
  MIN_BARS_BY_METHOD,
  type VolatilityEngineResponse,
  type VolatilitySeries,
} from '../../src/domain/volatility.js';

describe('resolveWindow boundary inputs', () => {
  const now = new Date('2026-06-15T12:00:00Z');

  it('refuses window shorter than 30 days', () => {
    expect(() => resolveWindow('2026-06-15', 29, now)).toThrow(VolatilityInputError);
    expect(() => resolveWindow('2026-06-15', 0, now)).toThrow(VolatilityInputError);
    expect(() => resolveWindow('2026-06-15', -1, now)).toThrow(VolatilityInputError);
  });

  it('accepts exactly 30 days', () => {
    const { start, end } = resolveWindow('2026-06-15', 30, now);
    expect(end).toBe('2026-06-15');
    expect(start).toBe('2026-05-16');
  });

  it('refuses NaN days', () => {
    expect(() => resolveWindow('2026-06-15', NaN, now)).toThrow(VolatilityInputError);
  });

  it('refuses Infinity days', () => {
    expect(() => resolveWindow('2026-06-15', Infinity, now)).toThrow(VolatilityInputError);
  });

  it('falls back to now when valuation date is null', () => {
    const { end } = resolveWindow(null, 365, now);
    expect(end).toBe('2026-06-15');
  });

  it('falls back to now when valuation date is undefined', () => {
    const { end } = resolveWindow(undefined, 365, now);
    expect(end).toBe('2026-06-15');
  });

  it('falls back to now for an impossible calendar date like Feb 31', () => {
    const { end } = resolveWindow('2026-02-31', 365, now);
    expect(end).toBe('2026-06-15');
  });

  it('falls back to now for an empty string', () => {
    const { end } = resolveWindow('', 365, now);
    expect(end).toBe('2026-06-15');
  });

  it('accepts a Date object as the valuation date', () => {
    const { end } = resolveWindow(new Date('2026-03-15T00:00:00'), 365, now);
    expect(end).toBe('2026-03-15');
  });

  it('handles a very large window (10 years)', () => {
    const { start, end } = resolveWindow('2026-06-15', 3650, now);
    expect(end).toBe('2026-06-15');
    expect(start < end).toBe(true);
  });
});

describe('seriesFromBars boundary inputs', () => {
  it('returns null for a non-array input', () => {
    expect(seriesFromBars('AAPL', 'not an array', 'historical')).toBeNull();
    expect(seriesFromBars('AAPL', null, 'historical')).toBeNull();
    expect(seriesFromBars('AAPL', 42, 'historical')).toBeNull();
  });

  it('returns null for an empty array', () => {
    expect(seriesFromBars('AAPL', [], 'historical')).toBeNull();
  });

  it('needs at least 3 bars for historical method', () => {
    const twoBars = [{ close: 100 }, { close: 101 }];
    expect(seriesFromBars('AAPL', twoBars, 'historical')).toBeNull();
    const threeBars = [{ close: 100 }, { close: 101 }, { close: 102 }];
    expect(seriesFromBars('AAPL', threeBars, 'historical')).not.toBeNull();
    expect(seriesFromBars('AAPL', threeBars, 'historical')!.prices).toHaveLength(3);
  });

  it('needs at least 3 bars for ewma method', () => {
    expect(seriesFromBars('AAPL', [{ close: 100 }, { close: 101 }], 'ewma')).toBeNull();
  });

  it('needs at least 2 bars for parkinson method', () => {
    const oneBar = [{ close: 100, high: 105, low: 95 }];
    expect(seriesFromBars('AAPL', oneBar, 'parkinson')).toBeNull();
    const twoBars = [
      { close: 100, high: 105, low: 95 },
      { close: 101, high: 106, low: 96 },
    ];
    expect(seriesFromBars('AAPL', twoBars, 'parkinson')).not.toBeNull();
  });

  it('skips bars with zero or negative close for historical', () => {
    const bars = [{ close: 100 }, { close: 0 }, { close: -5 }, { close: 101 }, { close: 102 }];
    const series = seriesFromBars('AAPL', bars, 'historical');
    expect(series).not.toBeNull();
    expect(series!.prices).toEqual([100, 101, 102]);
  });

  it('skips bars with NaN close', () => {
    const bars = [{ close: 100 }, { close: NaN }, { close: 101 }, { close: 102 }];
    const series = seriesFromBars('AAPL', bars, 'historical');
    expect(series!.prices).toEqual([100, 101, 102]);
  });

  it('skips bars with Infinity close', () => {
    const bars = [{ close: 100 }, { close: Infinity }, { close: 101 }, { close: 102 }];
    const series = seriesFromBars('AAPL', bars, 'historical');
    expect(series!.prices).toEqual([100, 101, 102]);
  });

  it('skips null entries in bars array', () => {
    const bars = [null, { close: 100 }, null, { close: 101 }, { close: 102 }];
    const series = seriesFromBars('AAPL', bars, 'historical');
    expect(series!.prices).toEqual([100, 101, 102]);
  });

  it('parkinson drops bars with zero or negative high/low', () => {
    const bars = [
      { close: 100, high: 105, low: 0 },
      { close: 101, high: 106, low: 96 },
      { close: 102, high: 107, low: 97 },
    ];
    const series = seriesFromBars('AAPL', bars, 'parkinson');
    expect(series!.prices).toEqual([101, 102]);
  });

  it('parkinson returns null when highs/lows misaligned after filtering', () => {
    const bars = [
      { close: 100, high: 105 },
      { close: 101, high: 106, low: 96 },
      { close: 102, high: 107, low: 97 },
    ];
    const series = seriesFromBars('AAPL', bars, 'parkinson');
    expect(series!.prices).toEqual([101, 102]);
  });

  it('coerces string close values to numbers', () => {
    const bars = [{ close: '100' }, { close: '101' }, { close: '102' }];
    const series = seriesFromBars('AAPL', bars, 'historical');
    expect(series!.prices).toEqual([100, 101, 102]);
  });
});

describe('shapeEstimate boundary inputs', () => {
  const baseSeries: VolatilitySeries[] = [
    { ticker: 'AAPL', prices: Array(250).fill(150) },
    { ticker: 'GOOG', prices: Array(250).fill(2800) },
  ];

  it('refuses recommended_volatility of 0', () => {
    const response: VolatilityEngineResponse = { recommended_volatility: 0, companies: [] };
    expect(() => shapeEstimate(response, { series: baseSeries, feedFailures: [] })).toThrow(
      VolatilityInputError,
    );
  });

  it('refuses negative recommended_volatility', () => {
    const response: VolatilityEngineResponse = { recommended_volatility: -0.5, companies: [] };
    expect(() => shapeEstimate(response, { series: baseSeries, feedFailures: [] })).toThrow(
      VolatilityInputError,
    );
  });

  it('refuses NaN recommended_volatility', () => {
    const response: VolatilityEngineResponse = { recommended_volatility: NaN, companies: [] };
    expect(() => shapeEstimate(response, { series: baseSeries, feedFailures: [] })).toThrow(
      VolatilityInputError,
    );
  });

  it('refuses recommended_volatility above MAX_RECORDABLE_VOLATILITY', () => {
    const response: VolatilityEngineResponse = {
      recommended_volatility: MAX_RECORDABLE_VOLATILITY + 0.01,
      companies: [],
    };
    expect(() => shapeEstimate(response, { series: baseSeries, feedFailures: [] })).toThrow(
      VolatilityInputError,
    );
  });

  it('accepts recommended_volatility at exactly MAX_RECORDABLE_VOLATILITY', () => {
    const response: VolatilityEngineResponse = {
      recommended_volatility: MAX_RECORDABLE_VOLATILITY,
      method: 'historical',
      confidence: 'medium',
      companies: [],
    };
    const result = shapeEstimate(response, { series: baseSeries, feedFailures: [] });
    expect(result.recommended).toBe(MAX_RECORDABLE_VOLATILITY);
  });

  it('accepts a tiny recommended_volatility', () => {
    const response: VolatilityEngineResponse = {
      recommended_volatility: 0.001,
      method: 'historical',
      confidence: 'high',
      companies: [],
    };
    const result = shapeEstimate(response, { series: baseSeries, feedFailures: [] });
    expect(result.recommended).toBe(0.001);
  });

  it('defaults method to historical when missing', () => {
    const response: VolatilityEngineResponse = { recommended_volatility: 0.5, companies: [] };
    const result = shapeEstimate(response, { series: baseSeries, feedFailures: [] });
    expect(result.method).toBe('historical');
  });

  it('defaults method to historical for an unrecognized string', () => {
    const response: VolatilityEngineResponse = {
      recommended_volatility: 0.5,
      method: 'bogus_method',
      companies: [],
    };
    const result = shapeEstimate(response, { series: baseSeries, feedFailures: [] });
    expect(result.method).toBe('historical');
  });

  it('defaults confidence to low when missing', () => {
    const response: VolatilityEngineResponse = { recommended_volatility: 0.5, companies: [] };
    const result = shapeEstimate(response, { series: baseSeries, feedFailures: [] });
    expect(result.confidence).toBe('low');
  });

  it('handles companies array with nulls and missing fields', () => {
    const response: VolatilityEngineResponse = {
      recommended_volatility: 0.5,
      method: 'historical',
      confidence: 'high',
      companies: [
        { ticker: 'AAPL', volatility: 0.45, used: true },
        { ticker: null, volatility: 0.50 },
        { ticker: 'GOOG', volatility: null },
        null,
        { ticker: 'MSFT', volatility: 0.55, used: false },
      ],
    };
    const result = shapeEstimate(response, { series: baseSeries, feedFailures: [] });
    // ticker:null filtered, null entry filtered, GOOG with null vol → fin(null) = null → filtered
    expect(result.companies).toHaveLength(2);
    expect(result.companies[0]!.ticker).toBe('AAPL');
    expect(result.companies[1]!.ticker).toBe('MSFT');
  });

  it('handles excluded_companies with missing ticker', () => {
    const response: VolatilityEngineResponse = {
      recommended_volatility: 0.5,
      method: 'historical',
      companies: [],
      excluded_companies: [
        { ticker: 'TSLA', reason: 'degenerate series' },
        { ticker: null, reason: 'bad' },
        { ticker: 'META', reason: '' },
      ],
    };
    const result = shapeEstimate(response, { series: baseSeries, feedFailures: [] });
    expect(result.excluded).toHaveLength(2);
    expect(result.excluded[0]!.ticker).toBe('TSLA');
    expect(result.excluded[1]!.ticker).toBe('META');
    expect(result.excluded[1]!.reason).toBe('excluded by the estimator');
  });

  it('merges feed failures into excluded list', () => {
    const failures = [{ ticker: 'NFLX', reason: 'feed timeout' }];
    const response: VolatilityEngineResponse = {
      recommended_volatility: 0.5,
      companies: [],
      excluded_companies: [{ ticker: 'TSLA', reason: 'degenerate' }],
    };
    const result = shapeEstimate(response, { series: baseSeries, feedFailures: failures });
    expect(result.excluded).toHaveLength(2);
    expect(result.excluded[0]!.ticker).toBe('NFLX');
    expect(result.excluded[1]!.ticker).toBe('TSLA');
  });
});

describe('measuredCount', () => {
  it('returns 0 for empty companies list', () => {
    expect(measuredCount({ companies: [] })).toBe(0);
  });

  it('counts only companies with used=true', () => {
    expect(
      measuredCount({
        companies: [
          { ticker: 'A', volatility: 0.5, used: true },
          { ticker: 'B', volatility: 0.6, used: false },
          { ticker: 'C', volatility: 0.7, used: true },
        ],
      }),
    ).toBe(2);
  });
});

describe('volatilityNarrative boundary inputs', () => {
  it('returns null when no estimate exists', () => {
    expect(volatilityNarrative(null, 0.5)).toBeNull();
  });

  it('notes when estimate has not been adopted', () => {
    const row = {
      id: 'test',
      engagement_id: 'test',
      method: 'historical' as const,
      recommended: 0.5,
      median_vol: 0.5,
      mean_vol: 0.5,
      min_vol: 0.3,
      max_vol: 0.7,
      coefficient_of_variation: 0.1,
      confidence: 'high' as const,
      manual_override: null,
      companies: [{ ticker: 'AAPL', volatility: 0.5, used: true }],
      excluded: [],
      window_start: new Date('2025-06-15'),
      window_end: new Date('2026-06-15'),
      applied_at: null,
      created_at: new Date(),
    };
    const narrative = volatilityNarrative(row, 0.5);
    expect(narrative).toContain('has not been adopted');
  });

  it('notes when applied volatility diverges from recommended', () => {
    const row = {
      id: 'test',
      engagement_id: 'test',
      method: 'historical' as const,
      recommended: 0.5,
      median_vol: 0.5,
      mean_vol: 0.5,
      min_vol: 0.3,
      max_vol: 0.7,
      coefficient_of_variation: 0.1,
      confidence: 'high' as const,
      manual_override: null,
      companies: [{ ticker: 'AAPL', volatility: 0.5, used: true }],
      excluded: [],
      window_start: new Date('2025-06-15'),
      window_end: new Date('2026-06-15'),
      applied_at: new Date(),
      created_at: new Date(),
    };
    const narrative = volatilityNarrative(row, 0.65);
    expect(narrative).toContain('differs from the derived');
  });

  it('uses singular "company" for a single measured peer', () => {
    const row = {
      id: 'test',
      engagement_id: 'test',
      method: 'historical' as const,
      recommended: 0.5,
      median_vol: 0.5,
      mean_vol: 0.5,
      min_vol: 0.5,
      max_vol: 0.5,
      coefficient_of_variation: 0,
      confidence: 'low' as const,
      manual_override: null,
      companies: [{ ticker: 'ONLY', volatility: 0.5, used: true }],
      excluded: [],
      window_start: new Date('2025-06-15'),
      window_end: new Date('2026-06-15'),
      applied_at: new Date(),
      created_at: new Date(),
    };
    const narrative = volatilityNarrative(row, 0.5);
    expect(narrative).toContain('1 guideline company');
    expect(narrative).not.toContain('companies');
  });
});
