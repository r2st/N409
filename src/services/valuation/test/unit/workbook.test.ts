import { describe, expect, it } from 'vitest';
import {
  computeWorkbook,
  validateCellRef,
  WORKBOOK_SHEETS,
  type WorkbookCellInput,
} from '../../src/domain/workbook.js';

const cell = (sheet: string, row_key: string, column_key: string, value: number): WorkbookCellInput => ({
  sheet,
  row_key,
  column_key,
  value,
});

function valueOf(sheets: ReturnType<typeof computeWorkbook>, sheet: string, row: string, col: string) {
  return sheets
    .find((s) => s.key === sheet)!
    .rows.find((r) => r.key === row)!
    .cells.find((c) => c.column_key === col)!.value;
}

describe('workbook template', () => {
  it('defines the four sheets with input and derived rows', () => {
    expect(WORKBOOK_SHEETS.map((s) => s.key)).toEqual([
      'income_statement',
      'balance_sheet',
      'operating_metrics',
      'assumptions',
    ]);
    for (const sheet of WORKBOOK_SHEETS) {
      expect(sheet.rows.length).toBeGreaterThan(0);
      expect(sheet.columns.length).toBeGreaterThan(0);
      for (const row of sheet.rows) {
        if (row.kind === 'derived') expect(row.compute).toBeTypeOf('function');
      }
    }
  });

  it('derived formulas only reference rows defined earlier in the sheet (topological order)', () => {
    // computeWorkbook resolves rows in definition order; a formula reading a
    // later row would silently see null. Guard: with ALL inputs set, every
    // derived row must resolve to a number in every column but the first.
    //
    // The first column is exempt because a year-over-year row has no prior
    // period to reference there, and so does every row chaining off one — net
    // new ARR, and the burn multiple that divides by it. Exempting column 0
    // wholesale rather than naming those rows is deliberate: a list of names is
    // a thing that goes stale silently, and it is exactly what this test used
    // to carry (`revenue_growth`, alone) before the operating series added
    // three more.
    //
    // Inputs vary by column rather than being a flat 100 everywhere, because a
    // flat series has zero net new ARR in every period — which makes the burn
    // multiple legitimately null throughout and would hide a real ordering bug
    // behind a well-behaved guard.
    const cells: WorkbookCellInput[] = [];
    for (const sheet of WORKBOOK_SHEETS) {
      for (const row of sheet.rows) {
        if (row.kind !== 'input') continue;
        sheet.columns.forEach((col, i) => cells.push(cell(sheet.key, row.key, col.key, 100 * (i + 1))));
      }
    }
    const computed = computeWorkbook(cells);
    for (const sheet of computed) {
      for (const row of sheet.rows) {
        if (row.kind !== 'derived') continue;
        for (const c of row.cells.slice(1)) {
          expect(c.value, `${sheet.key}/${row.key}/${c.column_key}`).toBeTypeOf('number');
        }
      }
    }
  });
});

describe('computeWorkbook', () => {
  it('computes P&L derived rows', () => {
    const sheets = computeWorkbook([
      cell('income_statement', 'revenue', 'fy_current', 1000),
      cell('income_statement', 'cogs', 'fy_current', 400),
      cell('income_statement', 'operating_expenses', 'fy_current', 350),
      cell('income_statement', 'depreciation_amortization', 'fy_current', 50),
      cell('income_statement', 'interest_expense', 'fy_current', 20),
      cell('income_statement', 'taxes', 'fy_current', 30),
    ]);
    expect(valueOf(sheets, 'income_statement', 'gross_profit', 'fy_current')).toBe(600);
    expect(valueOf(sheets, 'income_statement', 'gross_margin', 'fy_current')).toBeCloseTo(0.6);
    expect(valueOf(sheets, 'income_statement', 'ebitda', 'fy_current')).toBe(250);
    expect(valueOf(sheets, 'income_statement', 'ebitda_margin', 'fy_current')).toBeCloseTo(0.25);
    expect(valueOf(sheets, 'income_statement', 'ebit', 'fy_current')).toBe(200);
    expect(valueOf(sheets, 'income_statement', 'net_income', 'fy_current')).toBe(150);
  });

  it('computes YoY revenue growth against the previous period', () => {
    const sheets = computeWorkbook([
      cell('income_statement', 'revenue', 'fy_minus_1', 800),
      cell('income_statement', 'revenue', 'fy_current', 1000),
    ]);
    expect(valueOf(sheets, 'income_statement', 'revenue_growth', 'fy_current')).toBeCloseTo(0.25);
    // first column has no predecessor
    expect(valueOf(sheets, 'income_statement', 'revenue_growth', 'fy_minus_2')).toBeNull();
  });

  it('computes balance-sheet totals, equity and working capital', () => {
    const sheets = computeWorkbook([
      cell('balance_sheet', 'cash', 'fy_current', 500),
      cell('balance_sheet', 'accounts_receivable', 'fy_current', 100),
      cell('balance_sheet', 'inventory', 'fy_current', 50),
      cell('balance_sheet', 'other_current_assets', 'fy_current', 25),
      cell('balance_sheet', 'ppe_net', 'fy_current', 200),
      cell('balance_sheet', 'intangibles', 'fy_current', 75),
      cell('balance_sheet', 'other_long_term_assets', 'fy_current', 10),
      cell('balance_sheet', 'accounts_payable', 'fy_current', 80),
      cell('balance_sheet', 'short_term_debt', 'fy_current', 40),
      cell('balance_sheet', 'other_current_liabilities', 'fy_current', 30),
      cell('balance_sheet', 'long_term_debt', 'fy_current', 120),
      cell('balance_sheet', 'other_long_term_liabilities', 'fy_current', 15),
    ]);
    expect(valueOf(sheets, 'balance_sheet', 'total_current_assets', 'fy_current')).toBe(675);
    expect(valueOf(sheets, 'balance_sheet', 'total_assets', 'fy_current')).toBe(960);
    expect(valueOf(sheets, 'balance_sheet', 'total_current_liabilities', 'fy_current')).toBe(150);
    expect(valueOf(sheets, 'balance_sheet', 'total_liabilities', 'fy_current')).toBe(285);
    expect(valueOf(sheets, 'balance_sheet', 'shareholders_equity', 'fy_current')).toBe(675);
    expect(valueOf(sheets, 'balance_sheet', 'working_capital', 'fy_current')).toBe(525);
  });

  it('returns null (not NaN) when inputs are missing or a divisor is zero', () => {
    const missing = computeWorkbook([cell('income_statement', 'revenue', 'fy_current', 1000)]);
    expect(valueOf(missing, 'income_statement', 'gross_profit', 'fy_current')).toBeNull();

    const zeroRevenue = computeWorkbook([
      cell('income_statement', 'revenue', 'fy_current', 0),
      cell('income_statement', 'cogs', 'fy_current', 0),
    ]);
    expect(valueOf(zeroRevenue, 'income_statement', 'gross_margin', 'fy_current')).toBeNull();
  });

  it('returns a full empty grid with no stored cells', () => {
    const sheets = computeWorkbook([]);
    expect(sheets).toHaveLength(WORKBOOK_SHEETS.length);
    for (const sheet of sheets) {
      for (const row of sheet.rows) {
        for (const c of row.cells) expect(c.value).toBeNull();
      }
    }
  });
});

/**
 * The operating series (gap #13). Appendix II-1 transcribes this sheet without
 * doing arithmetic of its own, so every ratio the deliverable prints is one of
 * these — which is why they are pinned here rather than only through the
 * rendered page.
 */
describe('operating metrics sheet', () => {
  const base = (over: Partial<Record<string, number>> = {}) =>
    computeWorkbook([
      cell('operating_metrics', 'arr', 'fy_minus_1', 4_000_000),
      cell('operating_metrics', 'arr', 'fy_current', over.arr ?? 6_000_000),
      cell('operating_metrics', 'customers', 'fy_current', over.customers ?? 120),
      cell('operating_metrics', 'employees', 'fy_minus_1', 30),
      cell('operating_metrics', 'employees', 'fy_current', over.employees ?? 48),
      cell('operating_metrics', 'net_burn', 'fy_current', over.net_burn ?? 3_000_000),
    ]);

  const at = (sheets: ReturnType<typeof computeWorkbook>, row: string) =>
    valueOf(sheets, 'operating_metrics', row, 'fy_current');

  it('derives the growth, per-unit and efficiency rows', () => {
    const sheets = base();
    expect(at(sheets, 'net_new_arr')).toBe(2_000_000);
    expect(at(sheets, 'arr_growth')).toBeCloseTo(0.5, 10);
    expect(at(sheets, 'arr_per_customer')).toBe(50_000);
    expect(at(sheets, 'arr_per_employee')).toBe(125_000);
    expect(at(sheets, 'burn_multiple')).toBe(1.5);
    expect(at(sheets, 'headcount_growth')).toBeCloseTo(0.6, 10);
  });

  it('has no growth row in the first period, where there is no prior', () => {
    const sheets = base();
    expect(valueOf(sheets, 'operating_metrics', 'arr_growth', 'fy_minus_2')).toBeNull();
    expect(valueOf(sheets, 'operating_metrics', 'net_new_arr', 'fy_minus_2')).toBeNull();
  });

  it('refuses a per-unit figure on a non-positive denominator', () => {
    // Not "a very large ARR per customer": zero customers with revenue is a
    // broken input, and a finite number here invites a reader to interpret it.
    expect(at(base({ customers: 0 }), 'arr_per_customer')).toBeNull();
    expect(at(base({ employees: -5 }), 'arr_per_employee')).toBeNull();
  });

  it('refuses a burn multiple where recurring revenue did not grow', () => {
    // Flat: the quotient is undefined, not infinite.
    expect(at(base({ arr: 4_000_000 }), 'burn_multiple')).toBeNull();
    // Contracting: 3.0M / -1.0M = -3, and a negative burn multiple reads as the
    // efficient end of a scale it is the wrong end of.
    const shrank = base({ arr: 3_000_000 });
    expect(at(shrank, 'net_new_arr')).toBe(-1_000_000);
    expect(at(shrank, 'burn_multiple')).toBeNull();
  });

  it('carries a negative burn through as cash generated', () => {
    // The sign convention is consumption-positive, so a company throwing off
    // cash has a negative burn — and a negative burn multiple that means what
    // it says, which is why this one is not withheld.
    expect(at(base({ net_burn: -500_000 }), 'burn_multiple')).toBe(-0.25);
  });

  it('accepts writes to its inputs and refuses them to its derived rows', () => {
    expect(validateCellRef('operating_metrics', 'arr', 'fy_current')).toBeNull();
    expect(validateCellRef('operating_metrics', 'net_burn', 'fy_minus_2')).toBeNull();
    expect(validateCellRef('operating_metrics', 'burn_multiple', 'fy_current')).toMatch(/derived/);
    expect(validateCellRef('operating_metrics', 'arr_growth', 'fy_current')).toMatch(/derived/);
  });
});

describe('validateCellRef', () => {
  it('accepts a valid input cell', () => {
    expect(validateCellRef('income_statement', 'revenue', 'fy_current')).toBeNull();
    expect(validateCellRef('assumptions', 'discount_rate', 'value')).toBeNull();
  });

  it('rejects unknown sheet, row and column', () => {
    expect(validateCellRef('nope', 'revenue', 'fy_current')).toMatch(/unknown sheet/);
    expect(validateCellRef('income_statement', 'nope', 'fy_current')).toMatch(/unknown row/);
    expect(validateCellRef('income_statement', 'revenue', 'nope')).toMatch(/unknown column/);
  });

  it('rejects writes to derived rows', () => {
    expect(validateCellRef('income_statement', 'ebitda', 'fy_current')).toMatch(/derived/);
    expect(validateCellRef('balance_sheet', 'total_assets', 'fy_current')).toMatch(/derived/);
  });
});
