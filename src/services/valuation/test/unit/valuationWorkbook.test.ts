import { describe, expect, it } from 'vitest';
import {
  flattenForAudit,
  valuationWorkbookSheets,
  type ValuationWorkbookInput,
  type WorkbookCalculation,
  type WorkbookGrant,
  type WorkbookOverwrite,
} from '../../src/export/valuationWorkbook.js';
import { validateCapTable, type CapTableEntry } from '../../src/domain/capTable.js';
import { computeWorkbook, type WorkbookCellInput } from '../../src/domain/workbook.js';
import type { XlsxFormula, XlsxSheet, XlsxValue } from '../../src/export/xlsx.js';

/**
 * The formulas these sheets emit are the whole point of the XLSX export, and the
 * way they break is silently: an off-by-one row offset still produces a workbook
 * that opens, sums and looks right while pointing at the header text. So the
 * assertions here pin exact A1 references, and cross-check each reference
 * against the label of the row it lands on.
 */

const GENERATED_AT = new Date('2026-07-29T09:00:00Z');

const CELLS: WorkbookCellInput[] = [
  { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_minus_1', value: 4_000_000 },
  { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_current', value: 6_000_000 },
  { sheet: 'income_statement', row_key: 'cogs', column_key: 'fy_current', value: 2_000_000 },
  { sheet: 'income_statement', row_key: 'operating_expenses', column_key: 'fy_current', value: 2_500_000 },
  {
    sheet: 'income_statement',
    row_key: 'depreciation_amortization',
    column_key: 'fy_current',
    value: 200_000,
  },
  { sheet: 'income_statement', row_key: 'interest_expense', column_key: 'fy_current', value: 100_000 },
  { sheet: 'income_statement', row_key: 'taxes', column_key: 'fy_current', value: 50_000 },
  { sheet: 'balance_sheet', row_key: 'cash', column_key: 'fy_current', value: 1_500_000 },
  { sheet: 'assumptions', row_key: 'discount_rate', column_key: 'value', value: 0.22 },
];

const ENTRIES: CapTableEntry[] = [
  {
    security_class: 'Common',
    class_type: 'common',
    shares: 8_000_000,
    price_per_share: null,
    invested_amount: null,
    liquidation_multiple: null,
    seniority: null,
    conversion_ratio: null,
  },
  {
    security_class: 'Series B Preferred',
    class_type: 'preferred',
    shares: 1_000_000,
    price_per_share: 4,
    invested_amount: 4_000_000,
    liquidation_multiple: 1.5,
    seniority: 2,
    conversion_ratio: 1,
  },
  {
    security_class: 'Series A Preferred',
    class_type: 'preferred',
    shares: 2_000_000,
    price_per_share: 1.5,
    invested_amount: 3_000_000,
    liquidation_multiple: 1,
    seniority: 1,
    conversion_ratio: 1,
  },
  {
    security_class: 'Option pool',
    class_type: 'option',
    shares: 1_000_000,
    price_per_share: null,
    invested_amount: null,
    liquidation_multiple: null,
    seniority: null,
    conversion_ratio: null,
  },
];

const GRANTS: WorkbookGrant[] = [
  {
    grantee_name: 'Dana Lin',
    grantee_email: 'dana@acme.test',
    grant_date: '2024-06-01',
    options_count: 120_000,
    exercise_price: '0.85',
    currency: 'USD',
    vesting_template: '4yr_1yr_cliff',
    vesting_start_date: '2024-06-01',
    vesting_months: 48,
    cliff_months: 12,
    frequency_months: 1,
    status: 'active',
  },
];

function input(overrides: Partial<ValuationWorkbookInput> = {}): ValuationWorkbookInput {
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
    cells: CELLS,
    capTable: { entries: ENTRIES, validation: validateCapTable(ENTRIES) },
    grants: GRANTS,
    fmvPerShare: 1.42,
    generatedAt: GENERATED_AT,
    ...overrides,
  };
}

function sheet(sheets: XlsxSheet[], name: string): XlsxSheet {
  const found = sheets.find((s) => s.name === name);
  if (!found) throw new Error(`no sheet named ${name}; got ${sheets.map((s) => s.name).join(', ')}`);
  return found;
}

/** Spreadsheet row number (1-based) of a sheet's data row at `index`. */
function rowNumber(s: XlsxSheet, index: number): number {
  return (s.titleLines?.length ?? 0) + 2 + index;
}

/** The label in column A of the data row that spreadsheet row `n` refers to. */
function labelAtRow(s: XlsxSheet, n: number): string {
  const index = n - ((s.titleLines?.length ?? 0) + 2);
  return String(s.rows[index]?.[0] ?? '');
}

function formulaAt(s: XlsxSheet, rowIndex: number, colIndex: number): XlsxFormula {
  const cell = s.rows[rowIndex]?.[colIndex];
  if (typeof cell !== 'object' || cell === null || cell instanceof Date || !('formula' in cell)) {
    throw new Error(`cell [${rowIndex},${colIndex}] is not a formula: ${JSON.stringify(cell)}`);
  }
  return cell;
}

function valueAt(s: XlsxSheet, rowIndex: number, colIndex: number): XlsxValue {
  return unwrap(s.rows[rowIndex]?.[colIndex]);
}

/**
 * The value inside a cell that carries its own format.
 *
 * A per-share figure is written as `{ value, format: 'pershare' }` so it can
 * state four decimals in a column formatted for something else. Assertions
 * about the *value* should not have to know that, and an assertion about the
 * format has its own accessor.
 */
function unwrap(cell: XlsxValue): XlsxValue {
  return typeof cell === 'object' && cell !== null && !(cell instanceof Date) && 'format' in cell
    ? cell.value
    : cell;
}

/**
 * Data-row index of the row whose label starts with `prefix`. Most sheets label
 * in column A; the waterfall reserves A for seniority and labels in B.
 */
function indexOfLabel(s: XlsxSheet, prefix: string, labelCol = 0): number {
  const i = s.rows.findIndex((r) => String(r[labelCol] ?? '').startsWith(prefix));
  if (i < 0) throw new Error(`no row labelled ${prefix}`);
  return i;
}

describe('valuationWorkbookSheets', () => {
  it('emits the summary, model, cap-table, waterfall and grant sheets in order', () => {
    expect(valuationWorkbookSheets(input()).map((s) => s.name)).toEqual([
      'Summary',
      'Income statement',
      'Balance sheet',
      // The operating series (Appendix II-1) is a workbook sheet like any
      // other, so the export carries it — with live formulas for the ratios,
      // which is the half of it a client actually models against.
      'Operating metrics',
      'Assumptions',
      'Cap table',
      'Waterfall',
      'Grants',
    ]);
  });

  it('omits cap-table, waterfall and grant sheets when there is nothing to show', () => {
    const names = valuationWorkbookSheets(input({ capTable: null, grants: [] })).map((s) => s.name);
    expect(names).toEqual([
      'Summary',
      'Income statement',
      'Balance sheet',
      'Operating metrics',
      'Assumptions',
    ]);
  });

  it('omits the cap-table sheets when the table exists but is empty', () => {
    const names = valuationWorkbookSheets(
      input({ capTable: { entries: [], validation: validateCapTable([]) } }),
    ).map((s) => s.name);
    expect(names).not.toContain('Cap table');
    expect(names).not.toContain('Waterfall');
  });

  describe('model sheets', () => {
    const sheets = valuationWorkbookSheets(input());
    const is = sheet(sheets, 'Income statement');

    it('labels rows with their unit and marks inputs versus formulas', () => {
      const revenue = indexOfLabel(is, 'Revenue (USD)');
      expect(valueAt(is, revenue, 6)).toBe('input');
      const grossMargin = indexOfLabel(is, 'Gross margin (%)');
      expect(valueAt(is, grossMargin, 6)).toBe('formula');
    });

    it('points the gross-profit formula at the revenue and COGS rows', () => {
      const gp = indexOfLabel(is, 'Gross profit');
      // Column index 3 is the FY (current) period: A is the label, B is FY-2.
      const f = formulaAt(is, gp, 3);
      expect(f.formula).toBe('IF(COUNT(D4,D5)<2,"",D4-D5)');

      // The references must land on the rows they claim to.
      expect(labelAtRow(is, 4)).toBe('Revenue (USD)');
      expect(labelAtRow(is, 5)).toBe('Cost of goods sold (USD)');
      expect(rowNumber(is, gp)).toBe(6);
    });

    it('chains net income off EBIT rather than re-deriving it', () => {
      const ni = indexOfLabel(is, 'Net income');
      const f = formulaAt(is, ni, 3);
      expect(f.formula).toBe('IF(COUNT(D12,D13,D14)<3,"",D12-D13-D14)');
      expect(labelAtRow(is, 12)).toBe('EBIT (USD)');
      expect(labelAtRow(is, 13)).toBe('Interest expense (USD)');
      expect(labelAtRow(is, 14)).toBe('Taxes (USD)');
    });

    it('references the previous period for year-over-year growth', () => {
      const growth = indexOfLabel(is, 'Revenue growth');
      // FY-1 (column index 2) compares against FY-2 in column B.
      expect(formulaAt(is, growth, 2).formula).toBe('IF(OR(COUNT(C4,B4)<2,B4=0),"",(C4-B4)/B4)');
    });

    it('writes a plain value where a year-over-year rule has no prior period', () => {
      const growth = indexOfLabel(is, 'Revenue growth');
      // The first period has nothing to reference, so no formula is emitted.
      expect(valueAt(is, growth, 1)).toBeNull();
    });

    it('caches the same numbers the API computes', () => {
      const computed = computeWorkbook(CELLS).find((s) => s.key === 'income_statement')!;
      const expected = new Map(computed.rows.map((r) => [r.key, r.cells.map((c) => c.value)] as const));

      const gp = indexOfLabel(is, 'Gross profit');
      expect(formulaAt(is, gp, 3).value).toBe(expected.get('gross_profit')![2]);
      expect(formulaAt(is, gp, 3).value).toBe(4_000_000);

      const ni = indexOfLabel(is, 'Net income');
      // 6.0m − 2.0m − 2.5m − 0.2m − 0.1m − 0.05m
      expect(formulaAt(is, ni, 3).value).toBe(expected.get('net_income')![2]);
      expect(formulaAt(is, ni, 3).value).toBe(1_150_000);

      const growth = indexOfLabel(is, 'Revenue growth');
      expect(formulaAt(is, growth, 3).value).toBeCloseTo(0.5, 10);
    });

    it('puts the balance-sheet totals on the rows they aggregate', () => {
      const bs = sheet(sheets, 'Balance sheet');
      const tca = indexOfLabel(bs, 'Total current assets');
      const f = formulaAt(bs, tca, 3);
      expect(f.formula).toBe('IF(COUNT(D4,D5,D6,D7)<4,"",SUM(D4,D5,D6,D7))');
      expect(labelAtRow(bs, 4)).toBe('Cash & equivalents (USD)');
      expect(labelAtRow(bs, 7)).toBe('Other current assets (USD)');

      const equity = indexOfLabel(bs, 'Shareholders');
      expect(formulaAt(bs, equity, 3).formula).toBe(
        `IF(COUNT(D${rowNumber(bs, indexOfLabel(bs, 'Total assets'))},D${rowNumber(bs, indexOfLabel(bs, 'Total liabilities'))})<2,"",D${rowNumber(bs, indexOfLabel(bs, 'Total assets'))}-D${rowNumber(bs, indexOfLabel(bs, 'Total liabilities'))})`,
      );
    });

    it('leaves the single-column assumptions sheet free of formulas', () => {
      const assumptions = sheet(sheets, 'Assumptions');
      expect(assumptions.columns.map((c) => c.header)).toEqual(['Line item', 'Value', 'Type']);
      expect(assumptions.rows.every((r) => r[2] === 'input')).toBe(true);
      expect(valueAt(assumptions, indexOfLabel(assumptions, 'Discount rate'), 1)).toBe(0.22);
    });
  });

  describe('cap table', () => {
    const ct = sheet(valuationWorkbookSheets(input()), 'Cap table');

    it('has no title lines, so data starts on row 2', () => {
      expect(ct.titleLines).toBeUndefined();
      expect(rowNumber(ct, 0)).toBe(2);
    });

    it('computes ownership against the as-converted total row', () => {
      // Four classes on rows 2-5, so the total lands on row 6. The denominator
      // is column I (as-converted), not column C (raw shares) — the two differ
      // on any table carrying a conversion ratio.
      expect(formulaAt(ct, 0, 9).formula).toBe('IFERROR(I2/$I$6,"")');
      expect(formulaAt(ct, 3, 9).formula).toBe('IFERROR(I5/$I$6,"")');
      expect(formulaAt(ct, 0, 9).value).toBeCloseTo(8 / 12, 10);
    });

    it('converts preferred through its ratio cell and passes everything else through', () => {
      // Common (row 0) is already in common-equivalent units.
      expect(formulaAt(ct, 0, 8).formula).toBe('C2');
      // Series B (row 1) reads its own ratio, defaulting a blank one to 1:1.
      expect(formulaAt(ct, 1, 8).formula).toBe('C3*IF(AND(ISNUMBER(H3),H3>0),H3,1)');
    });

    it('totals shares and investment over exactly the data rows', () => {
      const total = indexOfLabel(ct, 'Total (fully diluted)');
      expect(rowNumber(ct, total)).toBe(6);
      expect(formulaAt(ct, total, 2).formula).toBe('SUM(C2:C5)');
      expect(formulaAt(ct, total, 2).value).toBe(12_000_000);
      expect(formulaAt(ct, total, 4).formula).toBe('SUM(E2:E5)');
      expect(formulaAt(ct, total, 4).value).toBe(7_000_000);
      expect(formulaAt(ct, total, 8).formula).toBe('SUM(I2:I5)');
      expect(formulaAt(ct, total, 8).value).toBe(12_000_000);
    });

    it('preserves the source order of the classes', () => {
      expect(ct.rows.slice(0, 4).map((r) => r[0])).toEqual([
        'Common',
        'Series B Preferred',
        'Series A Preferred',
        'Option pool',
      ]);
    });

    /*
     * A ratchet is the case the whole as-converted column exists for: Series A
     * converting 2:1 adds 2,000,000 shares to the denominator that a raw
     * `SUM(shares)` never sees.
     */
    describe('with a class converting at other than 1:1', () => {
      const RATCHETED = ENTRIES.map((e) =>
        e.security_class === 'Series A Preferred' ? { ...e, conversion_ratio: 2 } : e,
      );
      const sheets = (validation = validateCapTable(RATCHETED)) =>
        sheet(valuationWorkbookSheets(input({ capTable: { entries: RATCHETED, validation } })), 'Cap table');

      it('divides ownership by the as-converted total, not the share tally', () => {
        const ratcheted = sheets();
        const total = indexOfLabel(ratcheted, 'Total (fully diluted)');
        expect(formulaAt(ratcheted, total, 2).value).toBe(12_000_000);
        expect(formulaAt(ratcheted, total, 8).value).toBe(14_000_000);
        // Common holds 8M of 14M as-converted — not 8M of 12M.
        expect(formulaAt(ratcheted, 0, 9).value).toBeCloseTo(8 / 14, 10);
        expect(formulaAt(ratcheted, 2, 8).value).toBe(4_000_000);
      });

      it('still sums the ownership column to exactly one', () => {
        const ratcheted = sheets();
        const shares = ratcheted.rows.slice(0, 4).map((r) => (r[9] as { value: number }).value);
        expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
      });

      /*
       * The summary is persisted as JSONB at import time, so a table stored by
       * a build that summed 1:1 carries that number for good. Printing it beside
       * formulas derived from the entries would put a cached total on the page
       * that Excel contradicts the moment the reader touches a cell.
       */
      it('ignores a stored summary that disagrees with the entries', () => {
        const stale = validateCapTable(RATCHETED);
        stale.summary.fully_diluted_shares = 12_000_000; // as an older build wrote it
        const all = valuationWorkbookSheets(input({ capTable: { entries: RATCHETED, validation: stale } }));

        const capTable = sheet(all, 'Cap table');
        const total = indexOfLabel(capTable, 'Total (fully diluted)');
        expect(formulaAt(capTable, total, 8).value).toBe(14_000_000);

        // And the Summary sheet, which sits in the same file and must not
        // print a different denominator from the one two tabs over.
        const summary = sheet(all, 'Summary');
        expect(valueAt(summary, indexOfLabel(summary, 'Fully diluted shares'), 1)).toBe(14_000_000);
      });
    });

    /**
     * The Invested column, against the Waterfall sheet three tabs along.
     *
     * A Carta export carries the round price and leaves "Amount Invested"
     * blank; `toWaterfallInputs` reads such a row as `price × shares` and the
     * Waterfall sheet prints and totals that. This column read the raw cell, so
     * one workbook stated two different invested-capital totals for one cap
     * table — and the smaller one sat beside the share counts a reader checks
     * the preference stack against.
     */
    describe('a priced class with no stated amount', () => {
      const PRICED: CapTableEntry[] = ENTRIES.map((e) =>
        e.security_class === 'Series A Preferred' ? { ...e, invested_amount: null } : e,
      );
      const all = () =>
        valuationWorkbookSheets(input({ capTable: { entries: PRICED, validation: validateCapTable(PRICED) } }));

      it('states the same invested capital as the Waterfall sheet', () => {
        const ct = sheet(all(), 'Cap table');
        const wf = sheet(all(), 'Waterfall');
        const row = indexOfLabel(ct, 'Series A Preferred');
        // 2,000,000 × $1.50, which is what the engine is fed.
        expect(valueAt(ct, row, 4)).toBe(3_000_000);
        expect(wf.rows[0]?.[3]).toBe(3_000_000);
      });

      it('totals to the same figure the stack below it does', () => {
        const ct = sheet(all(), 'Cap table');
        const wf = sheet(all(), 'Waterfall');
        const ctTotal = formulaAt(ct, indexOfLabel(ct, 'Total (fully diluted)'), 4).value;
        const wfTotal = formulaAt(wf, indexOfLabel(wf, 'Total preference stack', 1), 3).value;
        expect(ctTotal).toBe(7_000_000);
        expect(wfTotal).toBe(7_000_000);
      });

      it('leaves a row with neither an amount nor a price blank, not zero', () => {
        // `no_investment` is a warning about a missing figure; a 0 in a
        // currency column reads as a measured one.
        const ct = sheet(all(), 'Cap table');
        expect(valueAt(ct, indexOfLabel(ct, 'Common'), 4)).toBeNull();
        expect(valueAt(ct, indexOfLabel(ct, 'Option pool'), 4)).toBeNull();
      });
    });
  });

  describe('waterfall', () => {
    const wf = sheet(valuationWorkbookSheets(input()), 'Waterfall');

    it('orders the preference stack by seniority, not by cap-table order', () => {
      expect(wf.rows[0]?.[1]).toBe('Series A Preferred');
      expect(wf.rows[1]?.[1]).toBe('Series B Preferred');
      expect(wf.rows[0]?.[0]).toBe(1);
      expect(wf.rows[1]?.[0]).toBe(2);
    });

    it('derives preference and as-converted shares on the row they belong to', () => {
      // Two title lines push the first data row to 4.
      expect(rowNumber(wf, 0)).toBe(4);
      expect(formulaAt(wf, 0, 5).formula).toBe('D4*E4');
      expect(formulaAt(wf, 0, 5).value).toBe(3_000_000);
      expect(formulaAt(wf, 1, 5).formula).toBe('D5*E5');
      expect(formulaAt(wf, 1, 5).value).toBe(6_000_000);
      expect(formulaAt(wf, 0, 7).formula).toBe('C4*G4');
    });

    it('totals the stack across the preferred rows only', () => {
      const total = indexOfLabel(wf, 'Total preference stack', 1);
      expect(formulaAt(wf, total, 5).formula).toBe('SUM(F4:F5)');
      // 3.0m × 1 + 4.0m × 1.5
      expect(formulaAt(wf, total, 5).value).toBe(9_000_000);
    });

    it('lists common and the option pool below the stack, not inside it', () => {
      // A blank spacer row separates the stack from the residual holders, so the
      // totals above cannot be mistaken for including them.
      const total = indexOfLabel(wf, 'Total preference stack', 1);
      expect(wf.rows[total + 1]).toEqual([]);
      const common = wf.rows.find((r) => r[1] === 'Common (incl. warrants)');
      const pool = wf.rows.find((r) => r[1] === 'Option pool');
      // Common includes warrants; the option pool is separate.
      expect(common?.[2]).toBe(8_000_000);
      expect(pool?.[2]).toBe(1_000_000);
    });

    it('states the concluded FMV when there is one, and omits the row otherwise', () => {
      expect(wf.rows.some((r) => String(r[1] ?? '').startsWith('Concluded FMV'))).toBe(true);
      const noFmv = sheet(valuationWorkbookSheets(input({ fmvPerShare: null })), 'Waterfall');
      expect(noFmv.rows.some((r) => String(r[1] ?? '').startsWith('Concluded FMV'))).toBe(false);
    });
  });

  describe('grants', () => {
    const g = sheet(valuationWorkbookSheets(input()), 'Grants');

    it('resolves vesting as of the export date', () => {
      // 2024-06-01 start, 48-month term, monthly after a 12-month cliff:
      // 2026-07-29 is 25 months in, so 120,000 × 25/48 = 62,500.
      expect(valueAt(g, 0, 10)).toBe(62_500);
    });

    it('derives unvested and percent-vested from the vested count', () => {
      // One title line puts the first data row on 3.
      expect(rowNumber(g, 0)).toBe(3);
      expect(formulaAt(g, 0, 11).formula).toBe('D3-K3');
      expect(formulaAt(g, 0, 11).value).toBe(57_500);
      expect(formulaAt(g, 0, 12).formula).toBe('IFERROR(K3/D3,"")');
      expect(formulaAt(g, 0, 12).value).toBeCloseTo(62_500 / 120_000, 10);
    });

    it('writes grant dates as dates and the exercise price as a number', () => {
      expect(valueAt(g, 0, 2)).toBeInstanceOf(Date);
      expect((valueAt(g, 0, 2) as Date).toISOString().slice(0, 10)).toBe('2024-06-01');
      expect(valueAt(g, 0, 4)).toBe(0.85);
    });

    it('totals the option count over the data rows', () => {
      const total = indexOfLabel(g, 'Total');
      expect(formulaAt(g, total, 3).formula).toBe('SUM(D3:D3)');
      expect(formulaAt(g, total, 3).value).toBe(120_000);
    });
  });

  describe('summary', () => {
    it('carries provenance and the cap-table roll-up', () => {
      const s = sheet(valuationWorkbookSheets(input()), 'Summary');
      const byField = new Map(s.rows.map((r) => [String(r[0] ?? ''), unwrap(r[1])]));
      expect(byField.get('Valuation number')).toBe('V-2026-0042');
      expect(byField.get('Company')).toBe('Acme, Inc.');
      expect(byField.get('Concluded FMV per share')).toBe(1.42);
      expect(byField.get('Generated at')).toBe(GENERATED_AT);
      expect(byField.get('Fully diluted shares')).toBe(12_000_000);
      expect(byField.get('Total preference stack')).toBe(9_000_000);
      expect(byField.get('Grant records')).toBe(1);
    });

    it('tolerates a valuation with no dates', () => {
      const s = sheet(
        valuationWorkbookSheets(
          input({
            valuation: {
              number: 'V-1',
              company_name: 'Nascent',
              kind: '409a',
              state: 'draft',
              currency: 'GBP',
              created_at: null,
              published_at: null,
            },
          }),
        ),
        'Summary',
      );
      const byField = new Map(s.rows.map((r) => [String(r[0] ?? ''), unwrap(r[1])]));
      expect(byField.get('Published')).toBeNull();
      expect(byField.get('Created')).toBeNull();
    });
  });

  it('uses the valuation currency in the column headers', () => {
    const sheets = valuationWorkbookSheets(
      input({
        valuation: {
          number: 'V-2',
          company_name: 'Brit Co',
          kind: 'emi',
          state: 'published',
          currency: 'GBP',
          created_at: null,
          published_at: null,
        },
      }),
    );
    expect(sheet(sheets, 'Cap table').columns.map((c) => c.header)).toContain('Invested (GBP)');
    expect(String(sheet(sheets, 'Income statement').rows[0]?.[0])).toBe('Revenue (GBP)');
  });
});

/**
 * The audit sheets (assumptions, overrides, calculation record). These are the
 * sheets an auditor works from, so what is asserted here is provenance: that an
 * assumption a human set is *labelled* as one, that an override carries the
 * value it replaced, and that a warning on a successful run still reaches the
 * file. A workbook that shows only conclusions is the failure mode.
 */

const CALCULATION: WorkbookCalculation = {
  engine_version: '2.4.1',
  status: 'succeeded',
  inputs: {
    discount_rate: 0.22,
    valuation_params: { dlom: 0.185, time_to_liquidity_years: 3.5 },
    market_comparables: { tickers: ['ABC', 'DEF', 'GHI'] },
    company_info: { incorporation_state: 'DE' },
  },
  results: {
    equity_value: 41_000_000,
    allocation: { method: 'opm', volatility: 0.62 },
  },
  equity_value: '41000000',
  fmv_per_share: '1.42',
  diagnostics: [
    {
      code: 'HIGH_DLOM',
      field: 'valuation_params.dlom',
      message: 'DLOM above the usual range for this stage.',
      severity: 'warning',
      hint: 'Document the marketability analysis.',
    },
  ],
  created_at: new Date('2026-03-01T12:00:00Z'),
};

const OVERWRITES: WorkbookOverwrite[] = [
  {
    category: 'valuation_params',
    field_key: 'dlom',
    class: 'numeric',
    value: 0.185,
    original_value: 0.14,
    reason: 'Longer expected hold following the delayed Series C.',
    created_by: 'analyst@n409.test',
    updated_by: 'reviewer@n409.test',
    updated_at: new Date('2026-02-20T10:30:00Z'),
  },
  {
    category: 'company_info',
    field_key: 'incorporation_state',
    class: 'character',
    value: 'DE',
    original_value: 'CA',
    reason: null,
    created_by: 'analyst@n409.test',
    updated_by: null,
    updated_at: new Date('2026-02-18T09:00:00Z'),
  },
];

describe('flattenForAudit', () => {
  it('addresses nested leaves by dotted path', () => {
    const flat = flattenForAudit({ a: { b: { c: 1 } }, d: 2 });
    expect(flat).toEqual([
      { path: 'a.b.c', value: 1 },
      { path: 'd', value: 2 },
    ]);
  });

  it('sorts by path so two runs of the same model diff cleanly', () => {
    const one = flattenForAudit({ zeta: 1, alpha: 2, mid: 3 });
    const two = flattenForAudit({ mid: 3, zeta: 1, alpha: 2 });
    expect(one.map((e) => e.path)).toEqual(['alpha', 'mid', 'zeta']);
    expect(one).toEqual(two);
  });

  it('joins a list of scalars onto one row but gives objects their own', () => {
    const flat = flattenForAudit({
      tickers: ['ABC', 'DEF'],
      comps: [{ name: 'Acme' }, { name: 'Globex' }],
    });
    expect(flat).toEqual([
      { path: 'comps[0].name', value: 'Acme' },
      { path: 'comps[1].name', value: 'Globex' },
      { path: 'tickers', value: 'ABC; DEF' },
    ]);
  });

  it('keeps numbers and booleans typed rather than stringifying them', () => {
    const flat = flattenForAudit({ rate: 0.22, applied: true, note: 'x' });
    expect(flat.find((e) => e.path === 'rate')?.value).toBe(0.22);
    expect(flat.find((e) => e.path === 'applied')?.value).toBe(true);
    expect(flat.find((e) => e.path === 'note')?.value).toBe('x');
  });

  it('renders an absent, null or empty value as a blank cell, not the word null', () => {
    expect(flattenForAudit(null)).toEqual([]);
    expect(flattenForAudit({ a: null, b: [], c: {} })).toEqual([
      { path: 'a', value: null },
      { path: 'b', value: null },
      { path: 'c', value: null },
    ]);
  });

  it('stops descending at the depth cap instead of unbounding the sheet', () => {
    // Ten levels deep — past the cap, so the tail arrives as one opaque leaf.
    let nested: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 10; i += 1) nested = { [`l${i}`]: nested };
    const flat = flattenForAudit(nested);
    expect(flat).toHaveLength(1);
    expect(typeof flat[0]?.value).toBe('string');
  });

  it('does not choke on a NaN the engine may emit', () => {
    expect(flattenForAudit({ x: Number.NaN })).toEqual([{ path: 'x', value: 'NaN' }]);
  });
});

describe('audit sheets', () => {
  const audited = () => valuationWorkbookSheets(input({ calculation: CALCULATION, overwrites: OVERWRITES }));

  it('omits the assumption and calculation sheets when nothing has been calculated', () => {
    const names = valuationWorkbookSheets(input()).map((s) => s.name);
    expect(names).not.toContain('Assumption register');
    expect(names).not.toContain('Calculation');
    expect(names).not.toContain('Overrides');
  });

  it('puts assumptions and the calculation record directly behind the cover', () => {
    const names = audited().map((s) => s.name);
    expect(names.slice(0, 4)).toEqual(['Summary', 'Assumption register', 'Calculation', 'Overrides']);
  });

  it('marks each assumption as engine-derived or manually set', () => {
    const rows = sheet(audited(), 'Assumption register').rows;
    const sourceOf = (path: string) => rows.find((r) => r[0] === path)?.[2];

    // Overridden by key, matched on the last path segment.
    expect(sourceOf('valuation_params.dlom')).toBe('manual override');
    expect(sourceOf('company_info.incorporation_state')).toBe('manual override');
    // Untouched by any override.
    expect(sourceOf('discount_rate')).toBe('engine');
    expect(sourceOf('valuation_params.time_to_liquidity_years')).toBe('engine');
  });

  it('carries the engine value each override replaced, and why', () => {
    const s = sheet(audited(), 'Overrides');
    const dlom = s.rows.find((r) => r[2] === 'dlom');
    expect(dlom?.[3]).toBe(0.14); // engine value
    expect(dlom?.[4]).toBe(0.185); // applied value
    expect(dlom?.[5]).toBe('Longer expected hold following the delayed Series C.');
    // The last person to touch it, not the first.
    expect(dlom?.[6]).toBe('reviewer@n409.test');
  });

  it('falls back to the creator when an override was never edited', () => {
    const s = sheet(audited(), 'Overrides');
    expect(s.rows.find((r) => r[2] === 'incorporation_state')?.[6]).toBe('analyst@n409.test');
  });

  it('names overridden fields by their registry label, not their key', () => {
    const s = sheet(audited(), 'Overrides');
    expect(s.rows.find((r) => r[2] === 'dlom')?.[1]).toBe('DLOM');
    expect(s.rows.find((r) => r[2] === 'incorporation_state')?.[1]).toBe('State of incorporation');
  });

  it('falls back to the raw key for a field the registry does not know', () => {
    // A retired or hand-inserted key must still appear rather than blanking the
    // row — an override the register cannot name is exactly the one to surface.
    const sheets = valuationWorkbookSheets(
      input({
        calculation: CALCULATION,
        overwrites: [{ ...OVERWRITES[0]!, field_key: 'legacy_mystery_field' }],
      }),
    );
    expect(sheet(sheets, 'Overrides').rows[0]?.[1]).toBe('legacy_mystery_field');
  });

  it('emits the override register even when nothing was overridden', () => {
    // "Nothing was overridden" is a finding an auditor needs stated, so unlike
    // the waterfall this sheet is not dropped when empty.
    const sheets = valuationWorkbookSheets(input({ calculation: CALCULATION, overwrites: [] }));
    expect(sheet(sheets, 'Overrides').rows).toEqual([]);
    expect(sheet(sheets, 'Assumption register').rows.every((r) => r[2] === 'engine')).toBe(true);
  });

  it('records provenance and the concluded numbers on the calculation sheet', () => {
    const rows = sheet(audited(), 'Calculation').rows;
    const valueOf = (label: string) => unwrap(rows.find((r) => r[0] === label)?.[1]);
    expect(valueOf('Engine version')).toBe('2.4.1');
    expect(valueOf('Status')).toBe('succeeded');
    expect(valueOf('Run at')).toEqual(new Date('2026-03-01T12:00:00Z'));
    // Numeric, not the string the DB hands back — an auditor foots this column.
    expect(valueOf('Concluded equity value (USD)')).toBe(41_000_000);
    expect(valueOf('Concluded FMV per share (USD)')).toBe(1.42);
  });

  it('carries warnings from a successful run through to the file', () => {
    const rows = sheet(audited(), 'Calculation').rows;
    const warning = rows.find((r) => String(r[0]).startsWith('warning:'));
    expect(warning?.[0]).toBe('warning: valuation_params.dlom');
    expect(String(warning?.[1])).toContain('DLOM above the usual range');
    expect(String(warning?.[1])).toContain('Document the marketability analysis.');
  });

  it('flattens the result payload onto the calculation sheet', () => {
    const rows = sheet(audited(), 'Calculation').rows;
    expect(rows.find((r) => r[0] === 'allocation.method')?.[1]).toBe('opm');
    expect(rows.find((r) => r[0] === 'allocation.volatility')?.[1]).toBe(0.62);
  });

  it('uses the valuation currency on the concluded-value labels', () => {
    const sheets = valuationWorkbookSheets(
      input({
        calculation: CALCULATION,
        overwrites: OVERWRITES,
        valuation: {
          number: 'V-2',
          company_name: 'Brit Co',
          kind: 'emi',
          state: 'published',
          currency: 'GBP',
          created_at: null,
          published_at: null,
        },
      }),
    );
    const labels = sheet(sheets, 'Calculation').rows.map((r) => String(r[0]));
    expect(labels).toContain('Concluded FMV per share (GBP)');
  });
});

/**
 * The workbook and the report state the same per-share figure the same way.
 *
 * The exhibits print every per-share number to four decimals — the concluded
 * FMV, the strike on an option row — because that is what a §409A concludes to
 * and what a grant is priced at. Every one of them reached this workbook through
 * a two-decimal format, so the file an auditor reconciles against the opinion
 * showed $1.49 beside the opinion's $1.4947. The exact value was always in the
 * cell; what disagreed was the figure on screen and in print, which is the one
 * anybody reads.
 */
describe('per-share figures carry the precision the report states them to', () => {
  const FMV = 1.4947;

  /** The format a cell resolves to: its own override, else its column's. */
  function formatAt(s: XlsxSheet, rowIndex: number, colIndex: number): string | undefined {
    const cell = s.rows[rowIndex]?.[colIndex];
    if (typeof cell === 'object' && cell !== null && !(cell instanceof Date) && 'format' in cell) {
      return cell.format;
    }
    return s.columns[colIndex]?.format;
  }

  it('states the concluded FMV to four decimals on the waterfall', () => {
    const wf = sheet(valuationWorkbookSheets(input({ fmvPerShare: FMV })), 'Waterfall');
    const i = indexOfLabel(wf, 'Concluded FMV per share', 1);
    expect(formatAt(wf, i, 3)).toBe('pershare');
  });

  it('states the concluded FMV to four decimals on the summary sheet', () => {
    const s = sheet(valuationWorkbookSheets(input({ fmvPerShare: FMV })), 'Summary');
    const i = indexOfLabel(s, 'Concluded FMV per share');
    expect(formatAt(s, i, 1)).toBe('pershare');
  });

  /**
   * The neighbours are the point: this cell shares its column with the engine
   * version and the run timestamp, so it can only be right if the override
   * leaves them alone.
   */
  it('states the concluded FMV to four decimals without restyling the column', () => {
    const s = sheet(
      valuationWorkbookSheets(input({ calculation: CALCULATION, fmvPerShare: FMV })),
      'Calculation',
    );
    expect(formatAt(s, indexOfLabel(s, 'Concluded FMV per share'), 1)).toBe('pershare');
    expect(formatAt(s, indexOfLabel(s, 'Engine version'), 1)).toBe('number');
    expect(formatAt(s, indexOfLabel(s, 'Concluded equity value'), 1)).toBe('number');
  });

  it('prices cap table and grant rows to four decimals', () => {
    const sheets = valuationWorkbookSheets(input({ fmvPerShare: FMV }));
    const ct = sheet(sheets, 'Cap table');
    const price = ct.columns.findIndex((c) => c.header.startsWith('Price per share'));
    expect(ct.columns[price]?.format).toBe('pershare');

    const g = sheet(sheets, 'Grants');
    const strike = g.columns.findIndex((c) => c.header.startsWith('Exercise price'));
    expect(g.columns[strike]?.format).toBe('pershare');
  });

  /** Aggregates are money, not per-share money, and must stay at two decimals. */
  it('leaves aggregate money columns at two decimals', () => {
    const sheets = valuationWorkbookSheets(input({ fmvPerShare: FMV }));
    const ct = sheet(sheets, 'Cap table');
    expect(ct.columns[ct.columns.findIndex((c) => c.header.startsWith('Invested'))]?.format).toBe(
      'currency',
    );
    const wf = sheet(sheets, 'Waterfall');
    expect(wf.columns[wf.columns.findIndex((c) => c.header.startsWith('Preference'))]?.format).toBe(
      'currency',
    );
  });
});
