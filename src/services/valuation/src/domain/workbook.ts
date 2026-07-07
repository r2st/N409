/**
 * Valuation workbook (features.md: "the working spreadsheet/model").
 * The template — sheets, periods, line items and derived formulas — is code;
 * only INPUT cells are persisted (workbook_cells). Derived rows are recomputed
 * on every read so stored data can never disagree with the model.
 */

export type WorkbookFormat = 'currency' | 'number' | 'percent';

export interface WorkbookColumnDef {
  key: string;
  label: string;
}

/** Reads a resolved value for the current column, or for the previous column. */
export interface ComputeCtx {
  value: (rowKey: string) => number | null;
  prev: (rowKey: string) => number | null;
}

export interface WorkbookRowDef {
  key: string;
  label: string;
  kind: 'input' | 'derived';
  format: WorkbookFormat;
  /** Formula for derived rows; null result means "not computable yet". */
  compute?: (ctx: ComputeCtx) => number | null;
}

export interface WorkbookSheetDef {
  key: string;
  label: string;
  description: string;
  columns: readonly WorkbookColumnDef[];
  rows: readonly WorkbookRowDef[];
}

const FISCAL_PERIODS: readonly WorkbookColumnDef[] = [
  { key: 'fy_minus_2', label: 'FY-2' },
  { key: 'fy_minus_1', label: 'FY-1' },
  { key: 'fy_current', label: 'FY (current)' },
  { key: 'fy_plus_1', label: 'FY+1' },
  { key: 'fy_plus_2', label: 'FY+2' },
];

const input = (key: string, label: string, format: WorkbookFormat = 'currency'): WorkbookRowDef => ({
  key,
  label,
  kind: 'input',
  format,
});

const derived = (
  key: string,
  label: string,
  format: WorkbookFormat,
  compute: (ctx: ComputeCtx) => number | null,
): WorkbookRowDef => ({ key, label, kind: 'derived', format, compute });

/** a - b, null-propagating (any missing operand → not computable). */
const sub = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : a - b;

const sum = (...xs: Array<number | null>): number | null =>
  xs.some((x) => x === null) ? null : xs.reduce<number>((acc, x) => acc + (x as number), 0);

/** a / b as a fraction; null when either side is missing or b is 0. */
const ratio = (a: number | null, b: number | null): number | null =>
  a === null || b === null || b === 0 ? null : a / b;

export const WORKBOOK_SHEETS: readonly WorkbookSheetDef[] = [
  {
    key: 'income_statement',
    label: 'Income statement',
    description: 'Historical and projected P&L; margins and growth are derived.',
    columns: FISCAL_PERIODS,
    rows: [
      input('revenue', 'Revenue'),
      input('cogs', 'Cost of goods sold'),
      derived('gross_profit', 'Gross profit', 'currency', (c) => sub(c.value('revenue'), c.value('cogs'))),
      derived('gross_margin', 'Gross margin', 'percent', (c) =>
        ratio(sub(c.value('revenue'), c.value('cogs')), c.value('revenue')),
      ),
      input('operating_expenses', 'Operating expenses'),
      derived('ebitda', 'EBITDA', 'currency', (c) =>
        sub(sub(c.value('revenue'), c.value('cogs')), c.value('operating_expenses')),
      ),
      derived('ebitda_margin', 'EBITDA margin', 'percent', (c) =>
        ratio(sub(sub(c.value('revenue'), c.value('cogs')), c.value('operating_expenses')), c.value('revenue')),
      ),
      input('depreciation_amortization', 'Depreciation & amortization'),
      derived('ebit', 'EBIT', 'currency', (c) =>
        sub(
          sub(sub(c.value('revenue'), c.value('cogs')), c.value('operating_expenses')),
          c.value('depreciation_amortization'),
        ),
      ),
      input('interest_expense', 'Interest expense'),
      input('taxes', 'Taxes'),
      derived('net_income', 'Net income', 'currency', (c) =>
        sub(
          sub(
            sub(
              sub(sub(c.value('revenue'), c.value('cogs')), c.value('operating_expenses')),
              c.value('depreciation_amortization'),
            ),
            c.value('interest_expense'),
          ),
          c.value('taxes'),
        ),
      ),
      derived('revenue_growth', 'Revenue growth (YoY)', 'percent', (c) => {
        const prev = c.prev('revenue');
        return ratio(sub(c.value('revenue'), prev), prev);
      }),
    ],
  },
  {
    key: 'balance_sheet',
    label: 'Balance sheet',
    description: 'Point-in-time balances; totals, equity and working capital are derived.',
    columns: FISCAL_PERIODS,
    rows: [
      input('cash', 'Cash & equivalents'),
      input('accounts_receivable', 'Accounts receivable'),
      input('inventory', 'Inventory'),
      input('other_current_assets', 'Other current assets'),
      derived('total_current_assets', 'Total current assets', 'currency', (c) =>
        sum(c.value('cash'), c.value('accounts_receivable'), c.value('inventory'), c.value('other_current_assets')),
      ),
      input('ppe_net', 'PP&E (net)'),
      input('intangibles', 'Intangible assets'),
      input('other_long_term_assets', 'Other long-term assets'),
      derived('total_assets', 'Total assets', 'currency', (c) =>
        sum(
          sum(c.value('cash'), c.value('accounts_receivable'), c.value('inventory'), c.value('other_current_assets')),
          c.value('ppe_net'),
          c.value('intangibles'),
          c.value('other_long_term_assets'),
        ),
      ),
      input('accounts_payable', 'Accounts payable'),
      input('short_term_debt', 'Short-term debt'),
      input('other_current_liabilities', 'Other current liabilities'),
      derived('total_current_liabilities', 'Total current liabilities', 'currency', (c) =>
        sum(c.value('accounts_payable'), c.value('short_term_debt'), c.value('other_current_liabilities')),
      ),
      input('long_term_debt', 'Long-term debt'),
      input('other_long_term_liabilities', 'Other long-term liabilities'),
      derived('total_liabilities', 'Total liabilities', 'currency', (c) =>
        sum(
          sum(c.value('accounts_payable'), c.value('short_term_debt'), c.value('other_current_liabilities')),
          c.value('long_term_debt'),
          c.value('other_long_term_liabilities'),
        ),
      ),
      derived('shareholders_equity', 'Shareholders’ equity', 'currency', (c) =>
        sub(c.value('total_assets'), c.value('total_liabilities')),
      ),
      derived('working_capital', 'Working capital', 'currency', (c) =>
        sub(c.value('total_current_assets'), c.value('total_current_liabilities')),
      ),
    ],
  },
  {
    key: 'assumptions',
    label: 'Assumptions',
    description: 'Single-column methodology assumptions feeding the engine.',
    columns: [{ key: 'value', label: 'Value' }],
    rows: [
      input('discount_rate', 'Discount rate', 'percent'),
      input('tax_rate', 'Tax rate', 'percent'),
      input('terminal_growth_rate', 'Terminal growth rate', 'percent'),
      input('revenue_multiple', 'Revenue multiple', 'number'),
      input('ebitda_multiple', 'EBITDA multiple', 'number'),
      input('dlom', 'DLOM', 'percent'),
      input('dloc', 'DLOC', 'percent'),
      input('volatility', 'Volatility', 'percent'),
      input('risk_free_rate', 'Risk-free rate', 'percent'),
      input('time_to_exit_years', 'Time to exit (years)', 'number'),
    ],
  },
];

export const WORKBOOK_SHEETS_BY_KEY: ReadonlyMap<string, WorkbookSheetDef> = new Map(
  WORKBOOK_SHEETS.map((s) => [s.key, s]),
);

export interface WorkbookCellInput {
  sheet: string;
  row_key: string;
  column_key: string;
  value: number;
}

/** Validates that (sheet,row,column) addresses an editable input cell. */
export function validateCellRef(sheet: string, rowKey: string, columnKey: string): string | null {
  const sheetDef = WORKBOOK_SHEETS_BY_KEY.get(sheet);
  if (!sheetDef) return `unknown sheet '${sheet}'`;
  const row = sheetDef.rows.find((r) => r.key === rowKey);
  if (!row) return `unknown row '${rowKey}' in sheet '${sheet}'`;
  if (row.kind !== 'input') return `row '${rowKey}' is derived and cannot be edited`;
  if (!sheetDef.columns.some((c) => c.key === columnKey)) {
    return `unknown column '${columnKey}' in sheet '${sheet}'`;
  }
  return null;
}

export interface ComputedCell {
  row_key: string;
  column_key: string;
  value: number | null;
}

export interface ComputedSheet {
  key: string;
  label: string;
  description: string;
  columns: WorkbookColumnDef[];
  rows: Array<{
    key: string;
    label: string;
    kind: 'input' | 'derived';
    format: WorkbookFormat;
    cells: Array<{ column_key: string; value: number | null }>;
  }>;
}

/**
 * Resolves the full grid from stored input cells: inputs pass through,
 * derived rows are evaluated column by column (formulas may reference the
 * previous column, e.g. YoY growth). Row order in a sheet definition is
 * topological — a formula only reads rows defined above it or plain inputs.
 */
export function computeWorkbook(cells: readonly WorkbookCellInput[]): ComputedSheet[] {
  const stored = new Map<string, number>();
  for (const cell of cells) {
    stored.set(`${cell.sheet} ${cell.row_key} ${cell.column_key}`, cell.value);
  }

  return WORKBOOK_SHEETS.map((sheetDef) => {
    // resolved[rowKey][colIndex] — filled as we walk rows in definition order
    const resolved = new Map<string, Array<number | null>>();
    for (const row of sheetDef.rows) {
      resolved.set(row.key, new Array<number | null>(sheetDef.columns.length).fill(null));
    }

    sheetDef.columns.forEach((col, colIdx) => {
      for (const row of sheetDef.rows) {
        let value: number | null;
        if (row.kind === 'input') {
          value = stored.get(`${sheetDef.key} ${row.key} ${col.key}`) ?? null;
        } else {
          const ctx: ComputeCtx = {
            value: (rowKey) => resolved.get(rowKey)?.[colIdx] ?? null,
            prev: (rowKey) => (colIdx > 0 ? (resolved.get(rowKey)?.[colIdx - 1] ?? null) : null),
          };
          value = row.compute ? row.compute(ctx) : null;
        }
        resolved.get(row.key)![colIdx] = value;
      }
    });

    return {
      key: sheetDef.key,
      label: sheetDef.label,
      description: sheetDef.description,
      columns: [...sheetDef.columns],
      rows: sheetDef.rows.map((row) => ({
        key: row.key,
        label: row.label,
        kind: row.kind,
        format: row.format,
        cells: sheetDef.columns.map((col, colIdx) => ({
          column_key: col.key,
          value: resolved.get(row.key)![colIdx] ?? null,
        })),
      })),
    };
  });
}
