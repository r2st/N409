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

  it('reports an unchanged valuation as a zero delta with zero contributions', () => {
    // L(a,a) = a, and ln(1) = 0, so every contribution is exactly zero rather
    // than a division by ln(1).
    const same = results({ fmv: 2.5, equity: 10_000_000, dlom: 0.2, dloc: 0.05 });
    const bridge = buildBridge(same, results({ fmv: 2.5, equity: 10_000_000, dlom: 0.2, dloc: 0.05 }));
    expect(bridge.decomposable).toBe(true);
    expect(bridge.delta).toBe(0);
    expect(bridge.pct_change).toBe(0);
    for (const f of bridge.factors) expect(f.contribution).toBe(0);
  });

  it('treats a results object with no discounts block as undiscounted', () => {
    const bare = { fmv_per_share: 1, equity_value: 5_000_000 };
    const bridge = buildBridge(bare, { fmv_per_share: 2, equity_value: 10_000_000 });
    const byKey = Object.fromEntries(bridge.factors.map((f) => [f.key, f]));
    expect(byKey.dlom!.from).toBe(1); // 1 − 0
    expect(byKey.dloc!.to).toBe(1);
    expect(bridge.decomposable).toBe(true);
  });

  it('defaults a half-populated discounts block to zero on the missing leg', () => {
    const bridge = buildBridge(
      { fmv_per_share: 1, equity_value: 5_000_000, discounts: { dlom: 0.2 } },
      { fmv_per_share: 1.2, equity_value: 6_000_000, discounts: { dloc: 0.1 } },
    );
    const byKey = Object.fromEntries(bridge.drivers.map((d) => [d.key, d]));
    expect(byKey.dloc!.from).toBe(0);
    expect(byKey.dlom!.to).toBe(0);
  });

  it('reports every weight driver as unknown when there are no approaches at all', () => {
    const bridge = buildBridge(
      { fmv_per_share: 1, equity_value: 1_000_000 },
      { fmv_per_share: 2, equity_value: 2_000_000 },
    );
    const byKey = Object.fromEntries(bridge.drivers.map((d) => [d.key, d]));
    for (const k of ['weight_asset', 'weight_opm', 'weight_income', 'weight_market', 'market_multiple']) {
      expect(byKey[k]).toMatchObject({ from: null, to: null, delta: null });
    }
  });

  it('averages the market approach multiples and ignores non-numeric ones', () => {
    const withMultiples = (multiples: unknown) => ({
      fmv_per_share: 1,
      equity_value: 1_000_000,
      approaches: { market: { weight: 1, multiples } },
    });
    const bridge = buildBridge(withMultiples([4, 6, 'n/a']), withMultiples([5, 9]));
    const mm = bridge.drivers.find((d) => d.key === 'market_multiple')!;
    expect(mm.from).toBe(5); // (4+6)/2, the 'n/a' dropped
    expect(mm.to).toBe(7);
    expect(mm.delta).toBe(2);
  });

  it('falls back to a scalar multiple when the list is absent or empty', () => {
    const bridge = buildBridge(
      { fmv_per_share: 1, equity_value: 1e6, approaches: { market: { multiples: [], multiple: 3.5 } } },
      { fmv_per_share: 2, equity_value: 2e6, approaches: { market: { multiple: 4.5 } } },
    );
    const mm = bridge.drivers.find((d) => d.key === 'market_multiple')!;
    expect(mm.from).toBe(3.5);
    expect(mm.to).toBe(4.5);
  });

  it('reads a numeric field that arrives as a numeric string, and nulls a junk one', () => {
    // pg hands back `numeric` columns as strings; a genuinely unparseable
    // value must read as "not stated", never as NaN.
    const bridge = buildBridge(
      { fmv_per_share: '2.00', equity_value: '10000000' },
      { fmv_per_share: 2.5, equity_value: 'unavailable' },
    );
    expect(bridge.from_fmv).toBe(2);
    const equity = bridge.drivers.find((d) => d.key === 'equity_value')!;
    expect(equity.from).toBe(10_000_000);
    expect(equity.to).toBeNull();
    expect(equity.delta).toBeNull();
    // One side of the company-value factor is unknown, so no exact split.
    expect(bridge.decomposable).toBe(false);
  });

  it('reports levels without an attribution when equity value is missing', () => {
    const bridge = buildBridge({ fmv_per_share: 1 }, { fmv_per_share: 2 });
    expect(bridge.decomposable).toBe(false);
    const byKey = Object.fromEntries(bridge.factors.map((f) => [f.key, f]));
    // An unknown factor level prints as 0 rather than null — the shape is
    // fixed so the report table always has a cell.
    expect(byKey.company_value).toMatchObject({ from: 0, to: 0, contribution: 0 });
    expect(byKey.allocation_dilution).toMatchObject({ from: 0, to: 0 });
    // The discount factors are still known and still stated.
    expect(byKey.dlom).toMatchObject({ from: 1, to: 1 });
  });

  it('survives a total DLOM on either side without dividing by zero', () => {
    // (1 − dlom) = 0 would make the pre-discount base infinite, on whichever
    // side of the comparison it lands.
    const total = { fmv_per_share: 1, equity_value: 1e6, discounts: { dlom: 1 } };
    const partial = { fmv_per_share: 0.5, equity_value: 1e6, discounts: { dlom: 0.2 } };
    for (const [from, to] of [
      [total, partial],
      [partial, total],
    ]) {
      const bridge = buildBridge(from!, to!);
      expect(Number.isFinite(bridge.delta)).toBe(true);
      expect(bridge.decomposable).toBe(false); // (1 − 1) = 0 is not a positive factor
      for (const f of bridge.factors) {
        expect(Number.isFinite(f.from)).toBe(true);
        expect(Number.isFinite(f.to)).toBe(true);
      }
    }
  });

  it('reports no percentage change from a starting FMV of zero', () => {
    const bridge = buildBridge(
      { fmv_per_share: 0, equity_value: 1e6 },
      { fmv_per_share: 1.25, equity_value: 4e6 },
    );
    expect(bridge.delta).toBe(1.25);
    expect(bridge.pct_change).toBeNull();
  });

  it('throws when the later calculation has no FMV', () => {
    expect(() => buildBridge(results({ fmv: 1, equity: 1 }), { equity_value: 1 })).toThrow(/fmv_per_share/);
  });
});

describe('bridge report section', () => {
  const render = (from: Record<string, unknown>, to: Record<string, unknown>) =>
    renderBridgeSection(buildBridge(from, to), { fromRef: 'V-1', toRef: 'V-2' });

  it('says "decreased" and signs the change when value fell', () => {
    const section = render(
      { fmv_per_share: 3.5, equity_value: 15e6 },
      { fmv_per_share: 2, equity_value: 10e6 },
    );
    expect(section.html).toContain('decreased');
    expect(section.html).toContain('$-1.50');
    expect(section.html).toContain('(-42.9%)');
  });

  it('omits the percentage when there is no meaningful one', () => {
    const section = render({ fmv_per_share: 0, equity_value: 1e6 }, { fmv_per_share: 2, equity_value: 4e6 });
    expect(section.html).toContain('increased');
    expect(section.html).not.toContain('%)');
  });

  it('explains the absence of an attribution rather than printing an empty table', () => {
    const section = render({ fmv_per_share: 1, equity_value: 1e6 }, { fmv_per_share: 0, equity_value: 0 });
    expect(section.html).not.toContain('<table>');
    expect(section.html).toContain('not available');
    expect(sanitizeHtml(section.html)).toBe(section.html);
  });

  it('closes the attribution table on the total change', () => {
    const section = render(
      { fmv_per_share: 2, equity_value: 10e6, discounts: { dlom: 0.25 } },
      { fmv_per_share: 3.5, equity_value: 15e6, discounts: { dlom: 0.2 } },
    );
    expect(section.heading).toBe('Cross-Period Value Bridge');
    expect(section.html).toContain('<th>Total change</th><th>$1.50</th>');
    expect(section.html).toContain('Marketability (DLOM)');
  });

  it('escapes a calculation reference so it cannot inject markup', () => {
    const section = renderBridgeSection(
      buildBridge({ fmv_per_share: 1, equity_value: 1e6 }, { fmv_per_share: 2, equity_value: 2e6 }),
      { fromRef: '<b>V-1</b>', toRef: 'V & 2' },
    );
    expect(section.html).toContain('&lt;b&gt;V-1&lt;/b&gt;');
    expect(section.html).toContain('V &amp; 2');
    expect(section.html).not.toContain('<b>');
  });
});
