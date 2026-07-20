import { describe, it, expect } from 'vitest';
import { buildBridge, renderBridgeSection } from '../../src/domain/valuationBridge.js';
import { sanitizeHtml } from '../../src/domain/report.js';

/** A minimal engine `results` object with the fields the bridge reads. */
function results(over: {
  fmv: number;
  equity: number;
  dloc?: number;
  dlom?: number;
  volatility?: number;
  weights?: Partial<Record<'asset' | 'opm_backsolve' | 'income' | 'market', number>>;
}) {
  const approaches: Record<string, unknown> = {};
  for (const [k, w] of Object.entries(over.weights ?? {})) approaches[k] = { weight: w };
  return {
    fmv_per_share: over.fmv,
    equity_value: over.equity,
    common_equity_value: over.equity,
    fully_diluted_common: 1_000_000,
    discounts: { dloc: over.dloc ?? 0, dlom: over.dlom ?? 0 },
    assumptions: { volatility: over.volatility ?? 0.5 },
    approaches,
  };
}

describe('valuation bridge (feature 3)', () => {
  it('LMDI contributions sum exactly to the total delta', () => {
    const from = results({ fmv: 2.0, equity: 10_000_000, dlom: 0.25, dloc: 0.05, volatility: 0.6 });
    const to = results({ fmv: 3.5, equity: 15_000_000, dlom: 0.2, dloc: 0.05, volatility: 0.5 });
    const bridge = buildBridge(from, to);

    expect(bridge.decomposable).toBe(true);
    const sum = bridge.factors.reduce((a, f) => a + f.contribution, 0);
    expect(sum).toBeCloseTo(bridge.delta, 5);
    expect(bridge.delta).toBeCloseTo(1.5, 6);
  });

  it('attributes a pure DLOM improvement to the DLOM factor only', () => {
    // Only DLOM changes (0.25 -> 0.20); company value and allocation constant.
    const from = results({ fmv: 0.75, equity: 10_000_000, dlom: 0.25 });
    const to = results({ fmv: 0.8, equity: 10_000_000, dlom: 0.2 });
    const bridge = buildBridge(from, to);

    const byKey = Object.fromEntries(bridge.factors.map((f) => [f.key, f.contribution]));
    expect(byKey.dlom).toBeCloseTo(bridge.delta, 6);
    expect(byKey.company_value).toBeCloseTo(0, 6);
    expect(byKey.allocation_dilution).toBeCloseTo(0, 6);
    expect(byKey.dloc).toBeCloseTo(0, 6);
  });

  it('reports raw driver deltas including weighting and volatility', () => {
    const from = results({
      fmv: 2,
      equity: 10_000_000,
      dlom: 0.25,
      volatility: 0.6,
      weights: { opm_backsolve: 0.5, market: 0.5 },
    });
    const to = results({
      fmv: 2.5,
      equity: 12_000_000,
      dlom: 0.25,
      volatility: 0.55,
      weights: { opm_backsolve: 0.3, market: 0.7 },
    });
    const bridge = buildBridge(from, to);
    const drivers = Object.fromEntries(bridge.drivers.map((d) => [d.key, d]));
    expect(drivers.equity_value.delta).toBeCloseTo(2_000_000, 0);
    expect(drivers.volatility.delta).toBeCloseTo(-0.05, 6);
    expect(drivers.weight_market.delta).toBeCloseTo(0.2, 6);
    expect(drivers.weight_opm.delta).toBeCloseTo(-0.2, 6);
  });

  it('marks a wiped-out (zero FMV) case non-decomposable but still reports totals', () => {
    const from = results({ fmv: 1.0, equity: 10_000_000 });
    const to = results({ fmv: 0, equity: 2_000_000 });
    const bridge = buildBridge(from, to);
    expect(bridge.decomposable).toBe(false);
    expect(bridge.delta).toBeCloseTo(-1.0, 6);
  });

  it('throws when an FMV is missing', () => {
    expect(() => buildBridge({ equity_value: 1 }, results({ fmv: 1, equity: 1 }))).toThrow();
  });

  it('renders an optional report section with only whitelisted HTML', () => {
    const from = results({ fmv: 2.0, equity: 10_000_000, dlom: 0.25 });
    const to = results({ fmv: 3.5, equity: 15_000_000, dlom: 0.2 });
    const section = renderBridgeSection(buildBridge(from, to), { fromRef: 'V-1', toRef: 'V-2' });
    expect(section.key).toBe('value_bridge');
    expect(section.html).toContain('$3.50');
    // The report sanitizer must not strip anything — the section is already
    // within the whitelist.
    expect(sanitizeHtml(section.html)).toBe(section.html);
  });
});
