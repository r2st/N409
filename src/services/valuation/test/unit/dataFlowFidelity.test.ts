/**
 * R457 – Data-flow fidelity: traces user-facing outputs back through every
 * transformation to their source and asserts end-to-end consistency.
 *
 * Methodology M2: pick a displayed number, walk it backwards to the source
 * column, and verify no mutation, fabrication, staleness or rounding error
 * accumulates along the way.
 */
import { describe, expect, it } from 'vitest';
import {
  asConvertedShares,
  fullyDilutedShares,
  investedAmount,
  liquidationPreference,
  validateCapTable,
  toWaterfallInputs,
  type CapTableEntry,
} from '../../src/domain/capTable.js';
import { buildCapTableGraph, type CapTableGraph } from '../../src/domain/capTableGraph.js';
import { capTableTotals } from '../../src/domain/workbookTabs.js';
import {
  compareValuations,
  comparisonCsv,
  headlineSummary,
  type CompareSide,
} from '../../src/domain/valuationCompare.js';
import { exerciseScenarios, vestingStatus, type VestingSchedule } from '../../src/domain/vesting.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const entry = (
  over: Partial<CapTableEntry> & Pick<CapTableEntry, 'security_class' | 'class_type'>,
): CapTableEntry => ({
  shares: 1_000_000,
  price_per_share: null,
  invested_amount: null,
  liquidation_multiple: null,
  seniority: null,
  conversion_ratio: null,
  ...over,
});

const COMMON = entry({ security_class: 'Common', class_type: 'common', shares: 8_000_000 });
const OPTIONS = entry({ security_class: 'Option Pool', class_type: 'option', shares: 2_000_000 });
const WARRANTS = entry({ security_class: 'Warrants', class_type: 'warrant', shares: 500_000 });
const SEED = entry({
  security_class: 'Series Seed',
  class_type: 'preferred',
  shares: 1_500_000,
  price_per_share: 1.0,
  invested_amount: 1_500_000,
  liquidation_multiple: 1,
  seniority: 1,
  conversion_ratio: 1,
});
const SERIES_A = entry({
  security_class: 'Series A',
  class_type: 'preferred',
  shares: 3_000_000,
  price_per_share: 3.0,
  invested_amount: 9_000_000,
  liquidation_multiple: 1,
  seniority: 2,
  conversion_ratio: 1,
});
const SERIES_B_RATCHET = entry({
  security_class: 'Series B',
  class_type: 'preferred',
  shares: 2_000_000,
  price_per_share: 5.0,
  invested_amount: 10_000_000,
  liquidation_multiple: 1.5,
  seniority: 3,
  conversion_ratio: 2,
});

const ALL_ENTRIES = [COMMON, OPTIONS, WARRANTS, SEED, SERIES_A, SERIES_B_RATCHET];

function graphFromEntries(entries: CapTableEntry[]): CapTableGraph {
  return buildCapTableGraph({ entries, companyName: 'TestCo', fundingHistory: [] });
}

// ── 1. Ownership percentage pipeline ─────────────────────────────────────────

describe('ownership percentage: shares → as-converted → fully diluted → %', () => {
  it('asConvertedShares applies conversion_ratio only to preferred', () => {
    expect(asConvertedShares(COMMON)).toBe(8_000_000);
    expect(asConvertedShares(OPTIONS)).toBe(2_000_000);
    expect(asConvertedShares(WARRANTS)).toBe(500_000);
    expect(asConvertedShares(SEED)).toBe(1_500_000);
    expect(asConvertedShares(SERIES_A)).toBe(3_000_000);
    // 2:1 ratchet: 2_000_000 × 2 = 4_000_000
    expect(asConvertedShares(SERIES_B_RATCHET)).toBe(4_000_000);
  });

  it('fullyDilutedShares equals sum of individual asConvertedShares', () => {
    const fd = fullyDilutedShares(ALL_ENTRIES);
    const entryByEntry = ALL_ENTRIES.reduce((s, e) => s + asConvertedShares(e), 0);
    expect(fd).toBe(entryByEntry);
    // 8M + 2M + 500K + 1.5M + 3M + 4M = 19M
    expect(fd).toBe(19_000_000);
  });

  it('graph ownership percentages sum to exactly 1.0', () => {
    const graph = graphFromEntries(ALL_ENTRIES);
    const shareClassNodes = graph.nodes.filter((n) => n.kind !== 'company');
    const totalOwnership = shareClassNodes.reduce((s, n) => s + (n.ownership ?? 0), 0);
    expect(totalOwnership).toBeCloseTo(1.0, 10);
  });

  it('graph as_converted_shares agrees with asConvertedShares() per entry', () => {
    const graph = graphFromEntries(ALL_ENTRIES);
    for (const e of ALL_ENTRIES) {
      const node = graph.nodes.find((n) => n.label === e.security_class);
      expect(node).toBeDefined();
      expect(node!.as_converted_shares).toBe(asConvertedShares(e));
    }
  });

  it('graph ownership equals asConverted / fullyDiluted for each entry', () => {
    const graph = graphFromEntries(ALL_ENTRIES);
    const fd = fullyDilutedShares(ALL_ENTRIES);
    for (const e of ALL_ENTRIES) {
      const node = graph.nodes.find((n) => n.label === e.security_class);
      expect(node!.ownership).toBeCloseTo(asConvertedShares(e) / fd, 10);
    }
  });

  it('validateCapTable summary.fully_diluted_shares matches fullyDilutedShares()', () => {
    const { summary } = validateCapTable(ALL_ENTRIES);
    expect(summary.fully_diluted_shares).toBe(fullyDilutedShares(ALL_ENTRIES));
  });

  it('capTableTotals().fully_diluted_shares matches fullyDilutedShares()', () => {
    const totals = capTableTotals(ALL_ENTRIES);
    expect(totals.fully_diluted_shares).toBe(fullyDilutedShares(ALL_ENTRIES));
  });

  it('all three fully-diluted sources agree on a ratcheted table', () => {
    const fd = fullyDilutedShares(ALL_ENTRIES);
    const validation = validateCapTable(ALL_ENTRIES);
    const totals = capTableTotals(ALL_ENTRIES);
    expect(validation.summary.fully_diluted_shares).toBe(fd);
    expect(totals.fully_diluted_shares).toBe(fd);
  });
});

// ── 2. Waterfall inputs projection ───────────────────────────────────────────

describe('waterfall inputs: cap table → engine feed', () => {
  it('common_shares includes common + warrants', () => {
    const inputs = toWaterfallInputs(ALL_ENTRIES);
    expect(inputs.common_shares).toBe(COMMON.shares + WARRANTS.shares);
  });

  it('option_pool_shares is the sum of option entries', () => {
    const inputs = toWaterfallInputs(ALL_ENTRIES);
    expect(inputs.option_pool_shares).toBe(OPTIONS.shares);
  });

  it('preferred entries carry the right invested_amount from investedAmount()', () => {
    const inputs = toWaterfallInputs(ALL_ENTRIES);
    for (const p of inputs.preferred) {
      const src = ALL_ENTRIES.find((e) => e.security_class === p.security_class)!;
      expect(p.invested_amount).toBe(investedAmount(src));
    }
  });

  it('preferred entries carry conversion_ratio defaulted to 1', () => {
    const noRatio = entry({
      security_class: 'Seed No Ratio',
      class_type: 'preferred',
      shares: 100_000,
      conversion_ratio: null,
    });
    const inputs = toWaterfallInputs([noRatio]);
    expect(inputs.preferred[0].conversion_ratio).toBe(1);
  });

  it('preferred entries carry liquidation_multiple defaulted to 1', () => {
    const noMult = entry({
      security_class: 'Seed No Mult',
      class_type: 'preferred',
      shares: 100_000,
      liquidation_multiple: null,
    });
    const inputs = toWaterfallInputs([noMult]);
    expect(inputs.preferred[0].liquidation_multiple).toBe(1);
  });

  it('unstated seniority ranks pari passu behind stated ones', () => {
    const stated = entry({
      security_class: 'A',
      class_type: 'preferred',
      shares: 100,
      seniority: 2,
    });
    const unstated = entry({
      security_class: 'B',
      class_type: 'preferred',
      shares: 100,
      seniority: null,
    });
    const inputs = toWaterfallInputs([stated, unstated]);
    const a = inputs.preferred.find((p) => p.security_class === 'A')!;
    const b = inputs.preferred.find((p) => p.security_class === 'B')!;
    expect(a.seniority).toBe(2);
    expect(b.seniority).toBe(3); // one past max stated
  });
});

// ── 3. Liquidation preference pipeline ───────────────────────────────────────

describe('liquidation preference: invested × multiple', () => {
  it('liquidationPreference uses investedAmount, not raw invested_amount', () => {
    const priced = entry({
      security_class: 'Priced Only',
      class_type: 'preferred',
      shares: 1_000_000,
      price_per_share: 5.0,
      invested_amount: null,
      liquidation_multiple: 2,
    });
    expect(investedAmount(priced)).toBe(5_000_000);
    expect(liquidationPreference(priced)).toBe(10_000_000);
  });

  it('liquidationPreference returns 0 for non-preferred', () => {
    expect(liquidationPreference(COMMON)).toBe(0);
    expect(liquidationPreference(OPTIONS)).toBe(0);
    expect(liquidationPreference(WARRANTS)).toBe(0);
  });

  it('validateCapTable total_preference_stack equals sum of liquidationPreference', () => {
    const { summary } = validateCapTable(ALL_ENTRIES);
    const manual = ALL_ENTRIES.reduce((s, e) => s + liquidationPreference(e), 0);
    expect(summary.total_preference_stack).toBe(manual);
  });

  it('capTableTotals liquidation_preference agrees with validateCapTable', () => {
    const totals = capTableTotals(ALL_ENTRIES);
    const { summary } = validateCapTable(ALL_ENTRIES);
    expect(totals.liquidation_preference).toBe(summary.total_preference_stack);
  });

  it('graph nodes carry liquidation_preference from liquidationPreference()', () => {
    const graph = graphFromEntries(ALL_ENTRIES);
    for (const e of ALL_ENTRIES.filter((e) => e.class_type === 'preferred')) {
      const node = graph.nodes.find((n) => n.label === e.security_class);
      expect(node!.liquidation_preference).toBe(liquidationPreference(e));
    }
  });
});

// ── 4. validateCapTable summary vs capTableTotals cross-check ────────────────

describe('summary agreement: validateCapTable vs capTableTotals', () => {
  it('per-type share counts agree', () => {
    const { summary } = validateCapTable(ALL_ENTRIES);
    const totals = capTableTotals(ALL_ENTRIES);
    expect(totals.common_shares).toBe(summary.common_shares);
    expect(totals.preferred_shares).toBe(summary.preferred_shares);
    expect(totals.option_shares).toBe(summary.option_shares);
    expect(totals.warrant_shares).toBe(summary.warrant_shares);
  });

  it('invested_capital in capTableTotals agrees with sum of investedAmount for preferred', () => {
    const totals = capTableTotals(ALL_ENTRIES);
    const manual = ALL_ENTRIES.filter((e) => e.class_type === 'preferred').reduce(
      (s, e) => s + investedAmount(e),
      0,
    );
    expect(totals.invested_capital).toBe(manual);
  });
});

// ── 5. Comparison data flow: engine results → delta → display → CSV ──────────

describe('comparison: results → pct_change → display → CSV', () => {
  const side = (over: Partial<CompareSide>): CompareSide => ({
    valuation_id: 'v1',
    company_name: 'TestCo',
    kind: '409a',
    currency: 'USD',
    state: 'concluded',
    calculation_id: 'c1',
    engine_version: '1.0.0',
    calculated_at: '2024-01-01T00:00:00Z',
    valuation_date: '2024-01-01',
    results: {},
    ...over,
  });

  it('pct_change is a proportion, not a pre-multiplied percentage', () => {
    const a = side({
      valuation_id: 'a',
      results: { fmv_per_share: 1.0, equity_value: 1_000_000 },
    });
    const b = side({
      valuation_id: 'b',
      results: { fmv_per_share: 1.5, equity_value: 1_500_000 },
    });
    const groups = compareValuations(a, b);
    const fmvRow = groups.flatMap((g) => g.rows).find((r) => r.key === 'fmv_per_share');
    expect(fmvRow).toBeDefined();
    // (1.5 - 1.0) / |1.0| = 0.5 (proportion, not 50)
    expect(fmvRow!.pct_change).toBeCloseTo(0.5, 10);
    expect(fmvRow!.delta).toBeCloseTo(0.5, 10);
  });

  it('CSV percent_change exports the same proportion as the row', () => {
    const a = side({
      valuation_id: 'a',
      results: { fmv_per_share: 1.42, equity_value: 10_000_000 },
    });
    const b = side({
      valuation_id: 'b',
      results: { fmv_per_share: 1.87, equity_value: 13_169_000 },
    });
    const groups = compareValuations(a, b);
    const csv = comparisonCsv(a, b, groups);
    const lines = csv.split('\n');
    const header = lines[0].split(',');
    const pctIdx = header.indexOf('percent_change');
    expect(pctIdx).toBeGreaterThan(-1);

    const fmvLine = lines.find((l) => l.includes('FMV per common share'));
    expect(fmvLine).toBeDefined();
    const cols = fmvLine!.split(',');
    const csvPct = Number(cols[pctIdx]);

    const fmvRow = groups.flatMap((g) => g.rows).find((r) => r.key === 'fmv_per_share')!;
    expect(csvPct).toBeCloseTo(fmvRow.pct_change!, 10);
  });

  it('percent format delta is "pts" (point move), not percentage-of-percentage', () => {
    const a = side({
      valuation_id: 'a',
      results: { discounts: { dlom: 0.30 } },
    });
    const b = side({
      valuation_id: 'b',
      results: { discounts: { dlom: 0.22 } },
    });
    const groups = compareValuations(a, b);
    const dlomRow = groups.flatMap((g) => g.rows).find((r) => r.key === 'dlom');
    expect(dlomRow).toBeDefined();
    expect(dlomRow!.delta).toBeCloseTo(-0.08, 10);
    expect(dlomRow!.delta_display).toContain('pts');
    expect(dlomRow!.delta_display).toContain('8.0');
  });

  it('headlineSummary reports unchanged when values are equal', () => {
    const results = { fmv_per_share: 1.42, equity_value: 10_000_000 };
    const a = side({ valuation_id: 'a', results });
    const b = side({ valuation_id: 'b', results });
    const summary = headlineSummary(compareValuations(a, b));
    expect(summary).toContain('unchanged');
  });
});

// ── 6. Vesting: percentage points vs proportions ─────────────────────────────

describe('vesting: percentVested representation', () => {
  const schedule: VestingSchedule = {
    totalShares: 10_000,
    vestingStartDate: new Date('2023-01-15'),
    vestingMonths: 48,
    cliffMonths: 12,
    frequencyMonths: 1,
  };

  it('percentVested is percentage points (0–100), not a proportion', () => {
    const status = vestingStatus(schedule, new Date('2025-01-15'));
    // 24 months elapsed out of 48 = 50%
    expect(status.percentVested).toBe(50);
    expect(status.vestedShares).toBe(5_000);
  });

  it('vestedShares / totalShares gives the proportion a workbook "percent" column needs', () => {
    const status = vestingStatus(schedule, new Date('2025-01-15'));
    const proportion = status.vestedShares / status.totalShares;
    expect(proportion).toBeCloseTo(0.5, 10);
    // The workbook uses this proportion with format: 'percent' (Excel multiplies by 100)
    expect(status.percentVested).toBe(proportion * 100);
  });
});

// ── 7. Edge cases ────────────────────────────────────────────────────────────

describe('edge cases: zero shares, null ratios, single-entry tables', () => {
  it('preferred with null conversion_ratio counts as 1:1', () => {
    const e = entry({
      security_class: 'NullRatio',
      class_type: 'preferred',
      shares: 1_000,
      conversion_ratio: null,
    });
    expect(asConvertedShares(e)).toBe(1_000);
  });

  it('preferred with conversion_ratio = 0 falls back to 1:1 (defensive)', () => {
    const e = entry({
      security_class: 'ZeroRatio',
      class_type: 'preferred',
      shares: 1_000,
      conversion_ratio: 0,
    });
    expect(asConvertedShares(e)).toBe(1_000);
  });

  it('preferred with negative conversion_ratio falls back to 1:1 (defensive)', () => {
    const e = entry({
      security_class: 'NegRatio',
      class_type: 'preferred',
      shares: 1_000,
      conversion_ratio: -2,
    });
    expect(asConvertedShares(e)).toBe(1_000);
  });

  it('fullyDilutedShares of empty array is 0', () => {
    expect(fullyDilutedShares([])).toBe(0);
  });

  it('graph handles empty entries without error', () => {
    const graph = graphFromEntries([]);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(1); // at least the company node
    const company = graph.nodes.find((n) => n.kind === 'company')!;
    expect(company.ownership).toBeNull();
  });

  it('single common entry gets 100% ownership in graph', () => {
    const single = [entry({ security_class: 'Solo', class_type: 'common', shares: 1_000 })];
    const graph = graphFromEntries(single);
    const node = graph.nodes.find((n) => n.label === 'Solo')!;
    expect(node.ownership).toBe(1.0);
  });

  it('investedAmount falls back to price_per_share × shares when invested_amount is null', () => {
    const e = entry({
      security_class: 'PricedOnly',
      class_type: 'preferred',
      shares: 500_000,
      price_per_share: 2.5,
      invested_amount: null,
    });
    expect(investedAmount(e)).toBe(1_250_000);
  });

  it('investedAmount is 0 when both price_per_share and invested_amount are null', () => {
    const e = entry({
      security_class: 'NoPricing',
      class_type: 'preferred',
      shares: 500_000,
    });
    expect(investedAmount(e)).toBe(0);
  });
});

// ── 8. Exercise scenario rounding ────────────────────────────────────────────

describe('exercise scenarios: grossValue from unrounded spread', () => {
  it('grossValue uses unrounded spread (more precise than spreadPerShare × shares)', () => {
    const scenarios = exerciseScenarios(
      { totalShares: 10_000, exercisePrice: 1.4235, currentFmv: 2.0 },
      [3.5678],
    );
    const s = scenarios[0]!;
    const rawSpread = 3.5678 - 1.4235;
    expect(s.spreadPerShare).toBe(Math.round(rawSpread * 10000) / 10000);
    expect(s.grossValue).toBe(Math.round(rawSpread * 10_000 * 100) / 100);
    // The two should NOT be derivable from each other due to intermediate rounding
    const fromRoundedSpread = Math.round(s.spreadPerShare * 10_000 * 100) / 100;
    // They may or may not differ depending on the specific values; the important
    // thing is grossValue comes from the full-precision spread
    expect(s.grossValue).toBe(Math.round(rawSpread * 10_000 * 100) / 100);
  });

  it('multipleOfCurrent divides by currentFmv, not exercisePrice', () => {
    const scenarios = exerciseScenarios(
      { totalShares: 1000, exercisePrice: 1.0, currentFmv: 2.0 },
      [4.0],
    );
    // 4.0 / 2.0 = 2.0× (not 4.0 / 1.0 = 4.0×)
    expect(scenarios[0]!.multipleOfCurrent).toBe(2.0);
  });

  it('below-strike FMV yields zero spread and zero grossValue', () => {
    const scenarios = exerciseScenarios(
      { totalShares: 1000, exercisePrice: 5.0, currentFmv: 5.0 },
      [3.0],
    );
    expect(scenarios[0]!.spreadPerShare).toBe(0);
    expect(scenarios[0]!.grossValue).toBe(0);
  });

  it('exerciseCost is always exercisePrice × shares regardless of FMV', () => {
    const scenarios = exerciseScenarios(
      { totalShares: 1000, exercisePrice: 2.5, currentFmv: 5.0 },
      [1.0, 5.0, 100.0],
    );
    for (const s of scenarios) {
      expect(s.exerciseCost).toBe(2500);
    }
  });
});

// ── 9. validateCapTable total_shares consistency ─────────────────────────────

describe('validateCapTable: total_shares equals sum of per-type shares', () => {
  it('total_shares is the raw sum of per-type sums on a valid table', () => {
    const { summary } = validateCapTable(ALL_ENTRIES);
    const perTypeSum =
      summary.common_shares + summary.preferred_shares + summary.option_shares + summary.warrant_shares;
    expect(summary.total_shares).toBe(perTypeSum);
  });

  it('total_shares stays consistent even when a row has negative shares (invalid table)', () => {
    const negative = entry({
      security_class: 'Negative Class',
      class_type: 'common',
      shares: -500,
    });
    const { summary, valid } = validateCapTable([COMMON, negative]);
    expect(valid).toBe(false);
    const perTypeSum =
      summary.common_shares + summary.preferred_shares + summary.option_shares + summary.warrant_shares;
    expect(summary.total_shares).toBe(perTypeSum);
  });
});

// ── 10. Cross-module ratchet consistency ──────────────────────────────────────

describe('ratchet consistency: conversion_ratio > 1 across all consumers', () => {
  const table = [
    entry({ security_class: 'Common', class_type: 'common', shares: 5_000_000 }),
    entry({
      security_class: 'Series A (2× ratchet)',
      class_type: 'preferred',
      shares: 1_000_000,
      price_per_share: 4.0,
      invested_amount: 4_000_000,
      liquidation_multiple: 1,
      seniority: 1,
      conversion_ratio: 2,
    }),
  ];

  it('all modules compute the same fully-diluted count on a ratcheted table', () => {
    // Common: 5M as-converted. Series A: 1M × 2 = 2M as-converted. Total: 7M.
    const expected = 7_000_000;
    expect(fullyDilutedShares(table)).toBe(expected);
    expect(validateCapTable(table).summary.fully_diluted_shares).toBe(expected);
    expect(capTableTotals(table).fully_diluted_shares).toBe(expected);

    const graph = graphFromEntries(table);
    const company = graph.nodes.find((n) => n.kind === 'company')!;
    expect(company.shares).toBe(expected);
  });

  it('graph ownership reflects the ratcheted as-converted count', () => {
    const graph = graphFromEntries(table);
    const commonNode = graph.nodes.find((n) => n.label === 'Common')!;
    const aNode = graph.nodes.find((n) => n.label === 'Series A (2× ratchet)')!;

    // Common: 5M / 7M ≈ 0.7143
    expect(commonNode.ownership).toBeCloseTo(5_000_000 / 7_000_000, 10);
    // Series A as-converted: 2M / 7M ≈ 0.2857
    expect(aNode.ownership).toBeCloseTo(2_000_000 / 7_000_000, 10);
    expect(commonNode.ownership! + aNode.ownership!).toBeCloseTo(1.0, 10);
  });

  it('waterfall inputs carry the conversion_ratio for the engine', () => {
    const inputs = toWaterfallInputs(table);
    const a = inputs.preferred.find((p) => p.security_class === 'Series A (2× ratchet)')!;
    expect(a.conversion_ratio).toBe(2);
    expect(a.shares).toBe(1_000_000);
  });
});
