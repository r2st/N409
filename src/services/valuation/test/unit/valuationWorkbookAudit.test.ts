import { describe, expect, it } from 'vitest';
import {
  flattenForAudit,
  valuationWorkbookSheets,
  type ValuationWorkbookInput,
  type WorkbookCalculation,
  type WorkbookOverwrite,
} from '../../src/export/valuationWorkbook.js';
import type { XlsxSheet, XlsxValue } from '../../src/export/xlsx.js';

/**
 * The three audit sheets — Assumptions, Overrides, Calculation — and the
 * flattener they are all built on.
 *
 * `valuationWorkbook.test.ts` covers the model, cap-table, waterfall and grant
 * sheets in detail and never passes a `calculation`, so the entire audit half of
 * the export was unexercised: 84% branch coverage with the gap concentrated in
 * exactly the sheets an auditor opens first. These sheets are the reason the
 * workbook exists — the model tabs show what was computed, and these show what
 * it was computed from and who changed it.
 */

const GENERATED_AT = new Date('2026-04-01T00:00:00Z');

function baseInput(overrides: Partial<ValuationWorkbookInput> = {}): ValuationWorkbookInput {
  return {
    valuation: {
      number: 'V-2026-0042',
      company_name: 'Acme, Inc.',
      kind: '409a',
      state: 'published',
      currency: 'USD',
      created_at: new Date('2026-01-15T00:00:00Z'),
      published_at: new Date('2026-03-02T00:00:00Z'),
    },
    cells: [],
    capTable: null,
    grants: [],
    fmvPerShare: null,
    generatedAt: GENERATED_AT,
    ...overrides,
  };
}

function calculation(over: Partial<WorkbookCalculation> = {}): WorkbookCalculation {
  return {
    engine_version: '2.4.1',
    status: 'succeeded',
    inputs: { discount_rate: 0.24, valuation_params: { discount_rate: 0.24, volatility: 0.55 } },
    results: { equity_value: 12_000_000, fmv_per_share: 1.42 },
    equity_value: '12000000',
    fmv_per_share: '1.42',
    diagnostics: [],
    created_at: new Date('2026-03-01T12:00:00Z'),
    ...over,
  };
}

function overwrite(over: Partial<WorkbookOverwrite> = {}): WorkbookOverwrite {
  return {
    category: 'valuation',
    field_key: 'discount_rate',
    class: 'number',
    value: 0.24,
    original_value: 0.19,
    reason: 'Board-approved rate',
    created_by: 'analyst@example.com',
    updated_by: null,
    updated_at: new Date('2026-02-20T09:00:00Z'),
    ...over,
  };
}

function sheet(sheets: XlsxSheet[], name: string): XlsxSheet {
  const found = sheets.find((s) => s.name === name);
  if (!found) throw new Error(`no sheet named ${name}; got ${sheets.map((s) => s.name).join(', ')}`);
  return found;
}

/** The row whose first cell equals `label`. */
function rowFor(s: XlsxSheet, label: string): XlsxValue[] {
  const row = s.rows.find((r) => r[0] === label);
  if (!row) throw new Error(`no row labelled ${label} in ${s.name}`);
  return row;
}

/**
 * The value inside a cell carrying its own number format.
 *
 * The concluded per-share figure states four decimals in a column formatted for
 * everything else on the sheet, so it is written as `{ value, format }`.
 * Assertions about the value read through it.
 */
function cellValue(cell: XlsxValue): XlsxValue {
  return typeof cell === 'object' && cell !== null && !(cell instanceof Date) && 'format' in cell
    ? cell.value
    : cell;
}

describe('flattenForAudit', () => {
  it('renders null and undefined as an empty cell rather than the word', () => {
    // A cell reading "null" in a signed workbook is worse than a blank one: it
    // looks like a value somebody entered.
    expect(flattenForAudit({ a: null, b: undefined })).toEqual([
      { path: 'a', value: null },
      { path: 'b', value: null },
    ]);
  });

  it('keeps a Date as a Date so the sheet can format it', () => {
    const d = new Date('2026-03-01T00:00:00Z');
    expect(flattenForAudit({ when: d })).toEqual([{ path: 'when', value: d }]);
  });

  it('joins a scalar array onto one row instead of exploding it', () => {
    // A list of peer tickers is one assumption, not eight. Nulls inside it
    // render as gaps so the positions still line up.
    expect(flattenForAudit({ peers: ['AAA', 'BBB', null, 3] })).toEqual([
      { path: 'peers', value: 'AAA; BBB; ; 3' },
    ]);
  });

  it('gives each element of an array of records its own indexed rows', () => {
    // The opposite rule, for the opposite reason: these elements each carry
    // several fields, and joining them would produce an unreadable cell.
    expect(flattenForAudit({ tiers: [{ p: 50 }, { p: 75 }] })).toEqual([
      { path: 'tiers[0].p', value: 50 },
      { path: 'tiers[1].p', value: 75 },
    ]);
  });

  it('renders an empty array or object as a blank rather than dropping it', () => {
    // Dropping it would make an assumption that was deliberately set to nothing
    // indistinguishable from one that was never set at all.
    expect(flattenForAudit({ peers: [], opts: {} })).toEqual([
      { path: 'opts', value: null },
      { path: 'peers', value: null },
    ]);
  });

  it('stringifies past the depth limit instead of recursing forever', () => {
    // MAX_FLATTEN_DEPTH is 8, so nine levels forces the stringify arm.
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: 'bottom' } } } } } } } } };
    const rows = flattenForAudit(deep);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path.startsWith('a.b')).toBe(true);
    // Whatever the limit is, the leaf arrives as a string and nothing is lost.
    expect(String(rows[0]!.value)).toContain('bottom');
  });

  it('keeps scalars as themselves, so the sheet can sum and format them', () => {
    // A number that arrived as a number leaves as one: an assumptions sheet
    // whose figures are text cannot be totalled or charted by the auditor
    // reading it.
    expect(flattenForAudit({ s: 'text', t: true, n: 42 })).toEqual([
      { path: 'n', value: 42 },
      { path: 's', value: 'text' },
      { path: 't', value: true },
    ]);
  });

  it('returns nothing at all for null, undefined or an empty object', () => {
    // The empty walk produces one pathless row; emitting it would read as a
    // missing assumption rather than an absent section.
    for (const source of [null, undefined, {}]) {
      expect(flattenForAudit(source)).toEqual([]);
    }
  });

  it('sorts by path so two exports of the same run are diffable', () => {
    const paths = flattenForAudit({ zeta: 1, alpha: 2, mid: 3 }).map((e) => e.path);
    expect(paths).toEqual(['alpha', 'mid', 'zeta']);
  });
});

describe('audit sheets', () => {
  it('omits assumptions and calculation when the valuation has never calculated', () => {
    const names = valuationWorkbookSheets(baseInput()).map((s) => s.name);
    expect(names).not.toContain('Assumptions consumed');
    expect(names).not.toContain('Calculation');
    expect(names).not.toContain('Overrides');
  });

  it('places the audit sheets behind the cover and ahead of the model', () => {
    // An auditor reads what was assumed before what it produced, so the order
    // is part of the deliverable rather than an implementation detail.
    const names = valuationWorkbookSheets(
      baseInput({ calculation: calculation(), overwrites: [overwrite()] }),
    ).map((s) => s.name);
    expect(names[0]).toMatch(/summary|cover/i);
    const assumptionsIdx = names.findIndex((n) => /assumption/i.test(n));
    const calcIdx = names.indexOf('Calculation');
    const overridesIdx = names.indexOf('Overrides');
    expect(assumptionsIdx).toBeGreaterThan(0);
    expect(calcIdx).toBe(assumptionsIdx + 1);
    expect(overridesIdx).toBe(calcIdx + 1);
  });

  it('emits the override register even when empty, because that is a finding', () => {
    // Unlike every other optional sheet: "nothing was overridden" is something
    // an auditor needs stated, not a blank they have to infer.
    const withEmpty = valuationWorkbookSheets(baseInput({ overwrites: [] })).map((s) => s.name);
    expect(withEmpty).toContain('Overrides');

    // Absent (not empty) means not loaded, which is a different claim.
    const withNone = valuationWorkbookSheets(baseInput()).map((s) => s.name);
    expect(withNone).not.toContain('Overrides');
  });

  describe('assumptions', () => {
    it('marks an overridden assumption as manual and the rest as engine', () => {
      const sheets = valuationWorkbookSheets(
        baseInput({ calculation: calculation(), overwrites: [overwrite({ field_key: 'volatility' })] }),
      );
      const s = sheets.find((x) => /assumption/i.test(x.name))!;
      const source = (path: string) => rowFor(s, path)[2];
      expect(source('valuation_params.volatility')).toBe('manual override');
      expect(source('discount_rate')).toBe('engine');
    });

    it('matches an override on the last path segment as well as the whole path', () => {
      // An override recorded against `discount_rate` has to mark the input
      // nested at `valuation_params.discount_rate` too — otherwise the Source
      // column says "engine" next to a figure a human set, which is the one
      // thing this sheet exists to prevent.
      const sheets = valuationWorkbookSheets(
        baseInput({ calculation: calculation(), overwrites: [overwrite({ field_key: 'discount_rate' })] }),
      );
      const s = sheets.find((x) => /assumption/i.test(x.name))!;
      expect(rowFor(s, 'discount_rate')[2]).toBe('manual override');
      expect(rowFor(s, 'valuation_params.discount_rate')[2]).toBe('manual override');
    });

    it('names the engine version and run timestamp in its title lines', () => {
      const sheets = valuationWorkbookSheets(baseInput({ calculation: calculation() }));
      const s = sheets.find((x) => /assumption/i.test(x.name))!;
      expect(s.titleLines?.join(' ')).toContain('2.4.1');
      expect(s.titleLines?.join(' ')).toContain('2026-03-01');
    });

    it('says the run time is unknown rather than printing an invalid date', () => {
      const sheets = valuationWorkbookSheets(
        baseInput({ calculation: calculation({ created_at: 'not-a-date' }) }),
      );
      const s = sheets.find((x) => /assumption/i.test(x.name))!;
      expect(s.titleLines?.join(' ')).toContain('unknown');
    });

    it('produces an empty body when the run recorded no inputs', () => {
      const sheets = valuationWorkbookSheets(
        baseInput({ calculation: calculation({ inputs: null }) }),
      );
      const s = sheets.find((x) => /assumption/i.test(x.name))!;
      expect(s.rows).toEqual([]);
    });
  });

  describe('overrides', () => {
    it('records the before and after pair, which is the evidentiary point', () => {
      const s = sheet(
        valuationWorkbookSheets(baseInput({ overwrites: [overwrite()] })),
        'Overrides',
      );
      const row = s.rows[0]!;
      expect(row).toContain(0.19);
      expect(row).toContain(0.24);
      expect(row).toContain('Board-approved rate');
    });

    it('attributes to the last editor, falling back to whoever created it', () => {
      const s = sheet(
        valuationWorkbookSheets(
          baseInput({
            overwrites: [
              overwrite({ field_key: 'a', created_by: 'first@example.com', updated_by: null }),
              overwrite({ field_key: 'b', created_by: 'first@example.com', updated_by: 'second@example.com' }),
            ],
          }),
        ),
        'Overrides',
      );
      const setBy = s.rows.map((r) => r[6]);
      expect(setBy).toContain('first@example.com');
      expect(setBy).toContain('second@example.com');
    });

    it('renders every shape a user-supplied override value can take', () => {
      // These values are untyped by construction — an override is whatever an
      // analyst typed. None of them may reach the sheet as "[object Object]"
      // or as a NaN.
      const when = new Date('2026-05-05T00:00:00Z');
      const s = sheet(
        valuationWorkbookSheets(
          baseInput({
            overwrites: [
              overwrite({ field_key: 'k_null', value: null, original_value: undefined }),
              overwrite({ field_key: 'k_date', value: when, original_value: when }),
              overwrite({ field_key: 'k_num', value: 12.5, original_value: 1 }),
              overwrite({ field_key: 'k_inf', value: Number.POSITIVE_INFINITY, original_value: Number.NaN }),
              overwrite({ field_key: 'k_str', value: 'text', original_value: false }),
              overwrite({ field_key: 'k_obj', value: { nested: true }, original_value: [1, 2] }),
            ],
          }),
        ),
        'Overrides',
      );
      const applied = new Map(s.rows.map((r) => [r[2], r[4]]));
      expect(applied.get('k_null')).toBeNull();
      expect(applied.get('k_date')).toEqual(when);
      expect(applied.get('k_num')).toBe(12.5);
      // A non-finite number is not a number the sheet can hold, so it becomes
      // its text — visibly wrong beats silently zero.
      expect(applied.get('k_inf')).toBe('Infinity');
      expect(applied.get('k_str')).toBe('text');
      expect(applied.get('k_obj')).toBe('{"nested":true}');

      const original = new Map(s.rows.map((r) => [r[2], r[3]]));
      expect(original.get('k_null')).toBeNull();
      expect(original.get('k_inf')).toBe('NaN');
      expect(original.get('k_str')).toBe(false);
      expect(original.get('k_obj')).toBe('[1,2]');
    });

    it('sorts by category then label so the register reads by section', () => {
      const s = sheet(
        valuationWorkbookSheets(
          baseInput({
            overwrites: [
              overwrite({ category: 'zeta', field_key: 'z1' }),
              overwrite({ category: 'alpha', field_key: 'a2' }),
              overwrite({ category: 'alpha', field_key: 'a1' }),
            ],
          }),
        ),
        'Overrides',
      );
      expect(s.rows.map((r) => r[0])).toEqual(['alpha', 'alpha', 'zeta']);
    });

    it('falls back to the raw field key when the catalogue has no label for it', () => {
      const s = sheet(
        valuationWorkbookSheets(baseInput({ overwrites: [overwrite({ field_key: 'not_in_catalogue' })] })),
        'Overrides',
      );
      expect(s.rows[0]![1]).toBe('not_in_catalogue');
    });

    it('renders an unparseable set-at as blank rather than an invalid date', () => {
      const s = sheet(
        valuationWorkbookSheets(baseInput({ overwrites: [overwrite({ updated_at: 'nonsense' })] })),
        'Overrides',
      );
      expect(s.rows[0]![7]).toBeNull();
    });
  });

  describe('calculation', () => {
    it('states provenance and the concluded figures as numbers', () => {
      const s = sheet(valuationWorkbookSheets(baseInput({ calculation: calculation() })), 'Calculation');
      expect(rowFor(s, 'Engine version')[1]).toBe('2.4.1');
      expect(rowFor(s, 'Status')[1]).toBe('succeeded');
      // Numeric strings out of pg become numbers, or the auditor cannot sum them.
      expect(cellValue(rowFor(s, 'Concluded equity value (USD)')[1])).toBe(12_000_000);
      expect(cellValue(rowFor(s, 'Concluded FMV per share (USD)')[1])).toBe(1.42);
      // …and the per-share figure keeps the four decimals the report states it
      // to, which is the whole reason it carries a format of its own here.
      expect(rowFor(s, 'Concluded FMV per share (USD)')[1]).toMatchObject({ format: 'pershare' });
    });

    it('renders an unparseable or empty concluded figure as blank, never as NaN', () => {
      const s = sheet(
        valuationWorkbookSheets(
          baseInput({ calculation: calculation({ equity_value: '', fmv_per_share: 'n/a' }) }),
        ),
        'Calculation',
      );
      expect(rowFor(s, 'Concluded equity value (USD)')[1]).toBeNull();
      expect(rowFor(s, 'Concluded FMV per share (USD)')[1]).toBeNull();
    });

    it('omits the results block when the run stored none', () => {
      const s = sheet(
        valuationWorkbookSheets(baseInput({ calculation: calculation({ results: null }) })),
        'Calculation',
      );
      expect(s.rows.some((r) => r[0] === 'Results')).toBe(false);
    });

    it('lists the diagnostics an analyst proceeded past', () => {
      // A succeeded run can still carry warnings, and a workbook showing only
      // the conclusion hides exactly what an auditor is looking for.
      const s = sheet(
        valuationWorkbookSheets(
          baseInput({
            calculation: calculation({
              diagnostics: [
                { code: 'C1', field: 'volatility', message: 'Peer set is thin', severity: 'warning', hint: 'Add peers' },
                { code: 'C2', field: '', message: 'Rounded to cents', severity: 'info', hint: null },
              ],
            }),
          }),
        ),
        'Calculation',
      );
      expect(rowFor(s, 'warning: volatility')[1]).toBe('Peer set is thin — Add peers');
      // No field means the row is keyed by code instead, and a null hint is not
      // rendered as a trailing dash.
      expect(rowFor(s, 'info: C2')[1]).toBe('Rounded to cents');
    });

    it('omits the diagnostics block entirely when the run was clean', () => {
      const s = sheet(valuationWorkbookSheets(baseInput({ calculation: calculation() })), 'Calculation');
      expect(s.rows.some((r) => r[0] === 'Diagnostics')).toBe(false);
    });
  });
});
