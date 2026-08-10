import { describe, expect, it } from 'vitest';
import {
  compareValuations,
  comparisonCsv,
  direction,
  isFavourable,
  type CompareSide,
} from '../../src/domain/valuationCompare.js';

/**
 * The comparison as a file, and the direction of a move as a word.
 *
 * The screen says "up" with a green delta; a CSV has no colour, and neither
 * does a reader with a red-green deficiency. Both are covered by the same
 * predicate, which is the point of pinning it here.
 */

const side = (over: Partial<CompareSide> = {}): CompareSide => ({
  valuation_id: '01N409VAL0000000000000AA',
  company_name: 'Northwind Robotics',
  kind: '409a',
  currency: 'USD',
  state: 'published',
  calculation_id: '01N409CALC000000000000AA',
  engine_version: '1.4.0',
  calculated_at: '2025-06-01T00:00:00.000Z',
  valuation_date: '2025-05-31',
  results: null,
  ...over,
});

const A = side({
  results: {
    fmv_per_share: 1.42,
    equity_value: 48_000_000,
    discounts: { dloc: 0.05, dlom: 0.3 },
    assumptions: { volatility: 0.65 },
  },
});
const B = side({
  valuation_id: '01N409VAL0000000000000BB',
  valuation_date: '2026-05-31',
  results: {
    fmv_per_share: 1.87,
    equity_value: 61_000_000,
    discounts: { dloc: 0.05, dlom: 0.22 },
    assumptions: { volatility: 0.58 },
  },
});

const groups = compareValuations(A, B);
const rows = new Map(groups.flatMap((g) => g.rows).map((r) => [r.key, r]));

describe('direction', () => {
  it('names the way a metric moved instead of only colouring it', () => {
    expect(direction(rows.get('fmv_per_share')!)).toBe('up');
    expect(direction(rows.get('dlom')!)).toBe('down');
    expect(direction(rows.get('dloc')!)).toBe('unchanged');
  });

  it('says "changed" rather than guessing a direction for a non-numeric move', () => {
    expect(direction({ key: 'dlom_method', delta: null, changed: true })).toBe('changed');
  });

  it('reads a discount the other way round — a rising DLOM lowers the FMV', () => {
    // Same sign, opposite verdict: that inversion is the whole reason this is a
    // function rather than `delta > 0`.
    expect(isFavourable(rows.get('fmv_per_share')!)).toBe(true);
    expect(isFavourable(rows.get('dlom')!)).toBe(true);
    expect(isFavourable({ key: 'dlom', delta: 0.08, changed: true })).toBe(false);
    expect(isFavourable({ key: 'equity_value', delta: -1, changed: true })).toBe(false);
  });

  it('offers no verdict where there is no reasoned one', () => {
    expect(isFavourable(rows.get('dloc')!)).toBeNull();
    expect(isFavourable({ key: 'allocation_method', delta: null, changed: true })).toBeNull();
  });
});

describe('comparisonCsv', () => {
  const csv = comparisonCsv(A, B, groups);
  const lines = csv.trimEnd().split('\r\n');
  const header = lines[0]!.split(',');
  const cells = (label: string): Record<string, string> => {
    const line = lines.find((l) => l.includes(label));
    if (!line) throw new Error(`no row for ${label}`);
    return Object.fromEntries(line.split(',').map((value, i) => [header[i]!, value]));
  };

  it('is RFC 4180: CRLF endings and a header naming every column', () => {
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(header).toEqual([
      'group',
      'metric',
      'a_label',
      'a_value',
      'a_raw',
      'b_label',
      'b_value',
      'b_raw',
      'change',
      'change_raw',
      'percent_change',
      'direction',
      'changed',
    ]);
  });

  it('has one row per metric, unchanged rows included', () => {
    const metricCount = groups.reduce((total, group) => total + group.rows.length, 0);
    expect(lines.length - 1).toBe(metricCount);
    expect(cells('Discount for lack of control').changed).toBe('no');
  });

  it('carries the raw value beside the formatted one, so a formula can use it', () => {
    const fmv = cells('FMV per common share');
    expect(fmv.a_raw).toBe('1.42');
    expect(fmv.b_raw).toBe('1.87');
    // The formatted column is what a reader checks against the report.
    expect(fmv.a_value).toContain('1.4200');
  });

  it('states percent change as a proportion, not pre-multiplied by 100', () => {
    // A spreadsheet's own percent format multiplies; shipping 31.7 renders 3170%.
    const fmv = cells('FMV per common share');
    expect(Number(fmv.percent_change)).toBeCloseTo(0.3169, 3);
  });

  it('carries direction as text, because a CSV cannot be green', () => {
    expect(cells('FMV per common share').direction).toBe('up');
    expect(cells('Discount for lack of marketability').direction).toBe('down');
    expect(cells('Discount for lack of control').direction).toBe('unchanged');
  });

  it('labels each side with the company and its valuation date', () => {
    const fmv = cells('FMV per common share');
    expect(fmv.a_label).toContain('2025-05-31');
    expect(fmv.b_label).toContain('2026-05-31');
  });

  it('quotes a company name containing a comma rather than splitting the row', () => {
    const comma = side({ company_name: 'Acme Robotics, Inc.', results: { fmv_per_share: 1 } });
    const out = comparisonCsv(comma, B, compareValuations(comma, B));
    expect(out).toContain('"Acme Robotics, Inc. (2025-05-31)"');
    for (const line of out.trimEnd().split('\r\n')) {
      // 13 columns; a naive split would find more if the name leaked a comma.
      expect(line.split('","').length).toBeLessThanOrEqual(3);
    }
  });

  it('neutralises a company name a spreadsheet would run as a formula', () => {
    const hostile = side({ company_name: '=cmd|/c calc', results: { fmv_per_share: 1 } });
    const out = comparisonCsv(hostile, B, compareValuations(hostile, B));
    expect(out).toContain("'=cmd");
    expect(out).not.toMatch(/,=cmd/);
  });

  it('emits a header-only file rather than failing when nothing computed', () => {
    const empty = comparisonCsv(side(), side(), []);
    expect(empty.trimEnd().split('\r\n')).toHaveLength(1);
  });

  it('leaves a side with no calculation blank instead of writing a misleading zero', () => {
    const never = side({ valuation_id: '01N409VAL0000000000000CC', results: null });
    const out = comparisonCsv(A, never, compareValuations(A, never));
    const fmvLine = out.split('\r\n').find((l) => l.includes('FMV per common share'))!;
    const values = fmvLine.split(',');
    expect(values[6]).toBe('');
    expect(values[7]).toBe('');
    expect(values).not.toContain('0');
  });
});
