import { describe, expect, it } from 'vitest';
import {
  valuationWorkbookSheets,
  type ValuationWorkbookInput,
  type WorkbookGrant,
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
  return s.rows[rowIndex]?.[colIndex];
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
      'Assumptions',
      'Cap table',
      'Waterfall',
      'Grants',
    ]);
  });

  it('omits cap-table, waterfall and grant sheets when there is nothing to show', () => {
    const names = valuationWorkbookSheets(input({ capTable: null, grants: [] })).map((s) => s.name);
    expect(names).toEqual(['Summary', 'Income statement', 'Balance sheet', 'Assumptions']);
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

    it('computes ownership against the total row', () => {
      // Four classes on rows 2-5, so the total lands on row 6.
      expect(formulaAt(ct, 0, 8).formula).toBe('IFERROR(C2/$C$6,"")');
      expect(formulaAt(ct, 3, 8).formula).toBe('IFERROR(C5/$C$6,"")');
      expect(formulaAt(ct, 0, 8).value).toBeCloseTo(8 / 12, 10);
    });

    it('totals shares and investment over exactly the data rows', () => {
      const total = indexOfLabel(ct, 'Total (fully diluted)');
      expect(rowNumber(ct, total)).toBe(6);
      expect(formulaAt(ct, total, 2).formula).toBe('SUM(C2:C5)');
      expect(formulaAt(ct, total, 2).value).toBe(12_000_000);
      expect(formulaAt(ct, total, 4).formula).toBe('SUM(E2:E5)');
      expect(formulaAt(ct, total, 4).value).toBe(7_000_000);
    });

    it('preserves the source order of the classes', () => {
      expect(ct.rows.slice(0, 4).map((r) => r[0])).toEqual([
        'Common',
        'Series B Preferred',
        'Series A Preferred',
        'Option pool',
      ]);
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
      const byField = new Map(s.rows.map((r) => [String(r[0] ?? ''), r[1]]));
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
      const byField = new Map(s.rows.map((r) => [String(r[0] ?? ''), r[1]]));
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
