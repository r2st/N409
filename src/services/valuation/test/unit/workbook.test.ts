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
  it('defines the three sheets with input and derived rows', () => {
    expect(WORKBOOK_SHEETS.map((s) => s.key)).toEqual(['income_statement', 'balance_sheet', 'assumptions']);
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
    // derived row that has all operands must resolve to a number.
    const cells: WorkbookCellInput[] = [];
    for (const sheet of WORKBOOK_SHEETS) {
      for (const row of sheet.rows) {
        if (row.kind !== 'input') continue;
        for (const col of sheet.columns) cells.push(cell(sheet.key, row.key, col.key, 100));
      }
    }
    const computed = computeWorkbook(cells);
    for (const sheet of computed) {
      for (const row of sheet.rows) {
        if (row.kind !== 'derived') continue;
        // growth needs a previous column, so skip the first column for it
        const startIdx = row.key === 'revenue_growth' ? 1 : 0;
        for (const c of row.cells.slice(startIdx)) {
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
