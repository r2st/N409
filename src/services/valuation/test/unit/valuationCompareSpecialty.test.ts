import { describe, expect, it } from 'vitest';
import {
  changedRows,
  comparableKinds,
  compareValuations,
  comparisonCsv,
  comparisonFamily,
  headlineSummary,
  type CompareGroup,
  type CompareSide,
} from '../../src/domain/valuationCompare.js';
import { SPECIALTY_KINDS } from '../../src/domain/specialty.js';
import { VALUATION_KINDS } from '../../src/domain/valuation.js';

/**
 * Comparing two specialty valuations.
 *
 * Every row the comparison used to build reads a key the 409A engine writes.
 * A specialty run persists `results = { kind, specialty: <engine result> }`
 * and writes its headline into the calculation's typed columns instead, so on
 * two EMI runs every one of those rows dropped out, `compareValuations`
 * returned no groups at all, and the view printed "Every metric these two
 * report is identical" over two runs whose conclusions differed. The
 * comparator had not found no differences — it had looked in the wrong place.
 */

const side = (over: Partial<CompareSide> = {}): CompareSide => ({
  valuation_id: '01N409VAL0000000000000AA',
  company_name: 'Ashcombe Devices',
  kind: 'emi',
  currency: 'GBP',
  state: 'published',
  calculation_id: '01N409CALC000000000000AA',
  engine_version: '2.1.0',
  calculated_at: '2026-03-01T00:00:00.000Z',
  valuation_date: '2026-02-28',
  results: null,
  ...over,
});

const emi = (specialty: Record<string, unknown>) => ({ kind: 'emi', specialty });

const A = emi({
  umv_per_share: 2.25,
  amv_per_share: 1.8,
  minority_discount: 0.1,
  restriction_discount: 0.2,
  qualification: {
    qualifies: true,
    checks: { individual_limit: { passed: true, detail: '£225,000 in the window' } },
  },
});

const B = emi({
  umv_per_share: 2.5,
  amv_per_share: 2.0,
  minority_discount: 0.1,
  restriction_discount: 0.2,
  qualification: {
    qualifies: false,
    checks: { individual_limit: { passed: false, detail: '£310,000 in the window' } },
  },
});

const rowsOf = (groups: CompareGroup[]) => new Map(groups.flatMap((g) => g.rows).map((r) => [r.key, r]));

describe('specialty results are compared at all', () => {
  const groups = compareValuations(side({ results: A }), side({ results: B }));

  it('produces a group rather than an empty comparison', () => {
    expect(groups).not.toHaveLength(0);
    expect(groups.map((g) => g.key)).toContain('specialty');
  });

  it('reports the moved figure with a delta an analyst can read', () => {
    const amv = rowsOf(groups).get('specialty_amv_per_share')!;
    expect(amv.a_display).toBe('1.8');
    expect(amv.b_display).toBe('2');
    expect(amv.delta).toBeCloseTo(0.2, 10);
    expect(amv.delta_display).toBe('+0.2');
    expect(amv.changed).toBe(true);
  });

  it('leaves an unchanged figure unchanged', () => {
    const row = rowsOf(groups).get('specialty_minority_discount')!;
    expect(row.changed).toBe(false);
    expect(row.delta).toBe(0);
  });

  it('reaches nested leaves by their dotted path', () => {
    const row = rowsOf(groups).get('specialty_qualification.checks.individual_limit.passed')!;
    expect(row.label).toBe('qualification.checks.individual_limit.passed');
    expect(row.a_display).toBe('true');
    expect(row.b_display).toBe('false');
    expect(row.changed).toBe(true);
  });

  it('counts the qualification flip among the changes', () => {
    const keys = changedRows(groups).map((r) => r.key);
    expect(keys).toContain('specialty_qualification.qualifies');
  });

  /*
   * The unit is not knowable from the path — these payloads carry discounts,
   * counts and per-share figures side by side — so a currency symbol here
   * would be a claim rather than a rendering.
   */
  it('does not dress an unknown unit as currency', () => {
    const numeric = [...rowsOf(groups).values()].filter((r) => r.format === 'scalar');
    expect(numeric.length).toBeGreaterThan(0);
    for (const row of numeric) {
      // The engine's own prose may quote a limit in pounds; what must not
      // happen is this module *adding* a symbol to a bare figure it cannot
      // attribute a unit to.
      expect(row.a_display ?? '').not.toMatch(/[£$€]/);
      expect(row.b_display ?? '').not.toMatch(/[£$€]/);
      expect(row.delta_display ?? '').not.toMatch(/[£$€]/);
    }
  });

  it('groups thousands and trims trailing zeros', () => {
    const g = compareValuations(
      side({ results: emi({ shares: 1_000_000, ratio: 0.5 }) }),
      side({ results: emi({ shares: 1_250_000, ratio: 0.5 }) }),
    );
    expect(rowsOf(g).get('specialty_shares')!.b_display).toBe('1,250,000');
    expect(rowsOf(g).get('specialty_ratio')!.a_display).toBe('0.5');
  });

  it('keeps no per-share headline sentence — that figure is not in these results', () => {
    expect(headlineSummary(groups)).toBeNull();
  });

  it('exports the specialty rows to the board pack CSV', () => {
    const csv = comparisonCsv(side({ results: A }), side({ results: B }), groups);
    expect(csv).toContain('amv_per_share');
    expect(csv).toContain('qualification.qualifies');
  });
});

describe('specialty payload edges', () => {
  it('takes the union, so a key one run dropped still shows', () => {
    const groups = compareValuations(
      side({ results: emi({ umv_per_share: 2, superseded_field: 7 }) }),
      side({ results: emi({ umv_per_share: 2, replacement_field: 9 }) }),
    );
    const rows = rowsOf(groups);
    expect(rows.get('specialty_superseded_field')!.b_display).toBeNull();
    expect(rows.get('specialty_replacement_field')!.a_display).toBeNull();
  });

  it('compares as text when a field changed type between engine versions', () => {
    const groups = compareValuations(
      side({ results: emi({ limit: 60_000 }) }),
      side({ results: emi({ limit: 'not applicable' }) }),
    );
    const row = rowsOf(groups).get('specialty_limit')!;
    expect(row.format).toBe('text');
    expect(row.delta).toBeNull();
    expect(row.changed).toBe(true);
  });

  it('collapses a list of scalars onto one row', () => {
    const groups = compareValuations(
      side({ results: emi({ tickers: ['AAA', 'BBB'] }) }),
      side({ results: emi({ tickers: ['AAA', 'CCC'] }) }),
    );
    const row = rowsOf(groups).get('specialty_tickers')!;
    expect(row.a_display).toBe('AAA; BBB');
    expect(row.changed).toBe(true);
  });

  it('indexes a list of records so each element keeps its own rows', () => {
    const groups = compareValuations(
      side({ results: emi({ tranches: [{ shares: 10 }, { shares: 20 }] }) }),
      side({ results: emi({ tranches: [{ shares: 10 }, { shares: 25 }] }) }),
    );
    const rows = rowsOf(groups);
    expect(rows.get('specialty_tranches[0].shares')!.changed).toBe(false);
    expect(rows.get('specialty_tranches[1].shares')!.delta).toBe(5);
  });

  /*
   * An absent branch is not a metric. Emitting it as a null leaf puts a row of
   * dashes in front of the rows that actually moved.
   */
  it('drops empty objects and lists rather than rendering them as dashes', () => {
    const groups = compareValuations(
      side({ results: emi({ checks: {}, notes: [], umv_per_share: 1 }) }),
      side({ results: emi({ checks: {}, notes: [], umv_per_share: 2 }) }),
    );
    expect([...rowsOf(groups).keys()]).toEqual(['specialty_umv_per_share']);
  });

  it('keeps a non-finite figure visible instead of comparing it as missing', () => {
    const groups = compareValuations(
      side({ results: emi({ ratio: 1 }) }),
      side({ results: emi({ ratio: Number.POSITIVE_INFINITY }) }),
    );
    const row = rowsOf(groups).get('specialty_ratio')!;
    expect(row.b_display).toBe('Infinity');
    expect(row.changed).toBe(true);
  });

  it('adds no group when neither side ran a specialty engine', () => {
    const groups = compareValuations(
      side({ kind: '409a', results: { fmv_per_share: 1 } }),
      side({ kind: '409a', results: { fmv_per_share: 2 } }),
    );
    expect(groups.map((g) => g.key)).not.toContain('specialty');
  });

  it('survives a payload that is not an object', () => {
    const groups = compareValuations(
      side({ results: { kind: 'qsbs', specialty: [] } }),
      side({ results: { kind: 'qsbs', specialty: null } }),
    );
    expect(groups.map((g) => g.key)).not.toContain('specialty');
  });

  it('does not recurse without bound on a deeply nested payload', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 40; i += 1) deep = { down: deep };
    const groups = compareValuations(side({ results: emi(deep) }), side({ results: emi(deep) }));
    expect(groups.flatMap((g) => g.rows).length).toBeGreaterThan(0);
  });
});

describe('comparisonFamily', () => {
  it('puts every 409A-engine kind in one family', () => {
    const shared = VALUATION_KINDS.filter((k) => !(SPECIALTY_KINDS as readonly string[]).includes(k)).map(
      comparisonFamily,
    );
    expect(new Set(shared).size).toBe(1);
    expect(comparableKinds('409a', '718')).toBe(true);
  });

  it('gives each specialty kind a family of its own', () => {
    const families = SPECIALTY_KINDS.map(comparisonFamily);
    expect(new Set(families).size).toBe(SPECIALTY_KINDS.length);
  });

  /*
   * The census: a kind added to VALUATION_KINDS without a decision about which
   * vocabulary it speaks would silently join the 409A family and be compared
   * against a 409A run metric for metric.
   */
  it('classifies every kind the product offers', () => {
    for (const kind of VALUATION_KINDS) {
      expect(typeof comparisonFamily(kind)).toBe('string');
    }
  });

  it('refuses two different specialty kinds', () => {
    expect(comparableKinds('emi', 'ifrs2')).toBe(false);
    expect(comparableKinds('820', 'gifts')).toBe(false);
  });

  it('refuses a specialty kind against a 409A-engine one', () => {
    expect(comparableKinds('409a', 'esop')).toBe(false);
  });

  it('allows a kind against itself', () => {
    for (const kind of VALUATION_KINDS) expect(comparableKinds(kind, kind)).toBe(true);
  });
});
