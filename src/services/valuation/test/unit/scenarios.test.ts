import { describe, it, expect } from 'vitest';
import { scenarioOverrides, scenarioDefaults, contentDisposition } from '../../src/routes/scenarios.js';

describe('scenarioOverrides', () => {
  it('maps named knobs to engine input paths', () => {
    const overrides = scenarioOverrides({
      revenue: 1_000_000,
      growth_rate: 0.05,
      discount_rate: 0.12,
      multiples: [3, 4, 5],
      volatility: 0.6,
    });
    expect(overrides).toEqual({
      income: { discount_rate: 0.12, terminal_growth: 0.05 },
      market: { metric: 1_000_000, multiples: [3, 4, 5] },
      volatility: 0.6,
    });
  });

  it('returns empty object when no knobs are set', () => {
    expect(scenarioOverrides({})).toEqual({});
  });

  it('handles partial knobs', () => {
    const overrides = scenarioOverrides({ discount_rate: 0.1 });
    expect(overrides).toEqual({ income: { discount_rate: 0.1 } });
    expect(overrides).not.toHaveProperty('market');
    expect(overrides).not.toHaveProperty('volatility');
  });
});

describe('scenarioDefaults', () => {
  it('extracts knob values from a stored engine payload', () => {
    const defaults = scenarioDefaults({
      params: {},
      inputs: {
        income: { discount_rate: 0.15, terminal_growth: 0.03 },
        market: { metric: 500_000, multiples: [2, 3] },
        volatility: 0.45,
      },
    });
    expect(defaults).toEqual({
      revenue: 500_000,
      growth_rate: 0.03,
      discount_rate: 0.15,
      multiples: [2, 3],
      volatility: 0.45,
    });
  });

  it('returns nulls when engine inputs are empty', () => {
    const defaults = scenarioDefaults({ params: {}, inputs: {} });
    expect(defaults).toEqual({
      revenue: null,
      growth_rate: null,
      discount_rate: null,
      multiples: null,
      volatility: null,
    });
  });

  it('returns null for multiples when not an array', () => {
    const defaults = scenarioDefaults({
      params: {},
      inputs: { market: { multiples: 'not-an-array' } },
    });
    expect(defaults.multiples).toBeNull();
  });
});
