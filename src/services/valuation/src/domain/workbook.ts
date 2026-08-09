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

/**
 * A1 references for the XLSX export, so a derived row can be delivered as a
 * live spreadsheet formula rather than a frozen number.
 */
export interface FormulaCtx {
  /** Reference to another row of this sheet in the current column. */
  cell: (rowKey: string) => string;
  /** Reference in the previous column; null in the first column. */
  prev: (rowKey: string) => string | null;
}

export interface WorkbookRowDef {
  key: string;
  label: string;
  kind: 'input' | 'derived';
  format: WorkbookFormat;
  /** Formula for derived rows; null result means "not computable yet". */
  compute?: (ctx: ComputeCtx) => number | null;
  /**
   * The same rule as `compute`, expressed as an Excel formula for the XLSX
   * export. Returning null means "no formula in this column" — a year-over-year
   * row has nothing to reference in the first period — and the export falls
   * back to the statically computed value.
   */
  excel?: (ctx: FormulaCtx) => string | null;
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

/**
 * The periods that are forecast rather than reported.
 *
 * The workbook holds both in one grid because an analyst models them together,
 * but they are different kinds of evidence and a report must not print them as
 * though they were the same: FY-2 through FY (current) are what the company
 * did, and FY+1 onward is what management expects. The historical-financials
 * appendix (`reportExhibits.financialsExhibit`) shows only the reported ones —
 * an appendix of that name carrying two columns of somebody's forecast would
 * misdescribe its own contents in a document a reviewer relies on.
 *
 * Exported so the appendix and the workbook cannot come to disagree about which
 * column is which. `fy_current` counts as reported, the same call
 * `workbookTabs.ACTUALS_COLUMN` already makes.
 */
export const PROJECTION_COLUMN_KEYS: ReadonlySet<string> = new Set(['fy_plus_1', 'fy_plus_2']);

/** Whether a fiscal-period column holds a forecast. */
export function isProjectionColumn(columnKey: string): boolean {
  return PROJECTION_COLUMN_KEYS.has(columnKey);
}

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
  excel?: (ctx: FormulaCtx) => string | null,
): WorkbookRowDef => ({ key, label, kind: 'derived', format, compute, excel });

/** a - b, null-propagating (any missing operand → not computable). */
const sub = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a - b);

const sum = (...xs: Array<number | null>): number | null =>
  xs.some((x) => x === null) ? null : xs.reduce<number>((acc, x) => acc + (x as number), 0);

/** a / b as a fraction; null when either side is missing or b is 0. */
const ratio = (a: number | null, b: number | null): number | null =>
  a === null || b === null || b === 0 ? null : a / b;

/*
 * Excel counterparts of the three helpers above. The COUNT guard is what makes
 * them equivalent: a blank cell is 0 to Excel arithmetic, so `=B2-B3` on an
 * empty model would report a confident zero where the model says "not
 * computable yet". COUNT only counts numbers, so a guarded row that yields ""
 * propagates emptiness through every row that references it, exactly as the
 * null-propagating TypeScript does.
 */

/** first - rest…, blank unless every operand is a number. */
const xMinus = (first: string, ...rest: string[]): string => {
  const all = [first, ...rest].join(',');
  return `IF(COUNT(${all})<${rest.length + 1},"",${first}-${rest.join('-')})`;
};

const xSum = (...refs: string[]): string =>
  `IF(COUNT(${refs.join(',')})<${refs.length},"",SUM(${refs.join(',')}))`;

/** a / b, blank when either side is missing or the denominator is 0. */
const xRatio = (a: string, b: string): string => `IF(OR(COUNT(${a},${b})<2,${b}=0),"",${a}/${b})`;

/** (cur - prior) / prior — the growth form of xRatio. */
const xGrowth = (cur: string, prior: string): string =>
  `IF(OR(COUNT(${cur},${prior})<2,${prior}=0),"",(${cur}-${prior})/${prior})`;

export const WORKBOOK_SHEETS: readonly WorkbookSheetDef[] = [
  {
    key: 'income_statement',
    label: 'Income statement',
    description: 'Historical and projected P&L; margins and growth are derived.',
    columns: FISCAL_PERIODS,
    rows: [
      input('revenue', 'Revenue'),
      input('cogs', 'Cost of goods sold'),
      derived(
        'gross_profit',
        'Gross profit',
        'currency',
        (c) => sub(c.value('revenue'), c.value('cogs')),
        (x) => xMinus(x.cell('revenue'), x.cell('cogs')),
      ),
      derived(
        'gross_margin',
        'Gross margin',
        'percent',
        (c) => ratio(sub(c.value('revenue'), c.value('cogs')), c.value('revenue')),
        // The exported formula chains off the gross-profit row rather than
        // repeating the subtraction: same arithmetic, and an auditor tracing the
        // sheet sees one dependency instead of a re-derivation.
        (x) => xRatio(x.cell('gross_profit'), x.cell('revenue')),
      ),
      input('operating_expenses', 'Operating expenses'),
      derived(
        'ebitda',
        'EBITDA',
        'currency',
        (c) => sub(sub(c.value('revenue'), c.value('cogs')), c.value('operating_expenses')),
        (x) => xMinus(x.cell('gross_profit'), x.cell('operating_expenses')),
      ),
      derived(
        'ebitda_margin',
        'EBITDA margin',
        'percent',
        (c) =>
          ratio(
            sub(sub(c.value('revenue'), c.value('cogs')), c.value('operating_expenses')),
            c.value('revenue'),
          ),
        (x) => xRatio(x.cell('ebitda'), x.cell('revenue')),
      ),
      input('depreciation_amortization', 'Depreciation & amortization'),
      derived(
        'ebit',
        'EBIT',
        'currency',
        (c) =>
          sub(
            sub(sub(c.value('revenue'), c.value('cogs')), c.value('operating_expenses')),
            c.value('depreciation_amortization'),
          ),
        (x) => xMinus(x.cell('ebitda'), x.cell('depreciation_amortization')),
      ),
      input('interest_expense', 'Interest expense'),
      input('taxes', 'Taxes'),
      derived(
        'net_income',
        'Net income',
        'currency',
        (c) =>
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
        (x) => xMinus(x.cell('ebit'), x.cell('interest_expense'), x.cell('taxes')),
      ),
      derived(
        'revenue_growth',
        'Revenue growth (YoY)',
        'percent',
        (c) => {
          const prev = c.prev('revenue');
          return ratio(sub(c.value('revenue'), prev), prev);
        },
        (x) => {
          const prior = x.prev('revenue');
          return prior === null ? null : xGrowth(x.cell('revenue'), prior);
        },
      ),
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
      derived(
        'total_current_assets',
        'Total current assets',
        'currency',
        (c) =>
          sum(
            c.value('cash'),
            c.value('accounts_receivable'),
            c.value('inventory'),
            c.value('other_current_assets'),
          ),
        (x) =>
          xSum(
            x.cell('cash'),
            x.cell('accounts_receivable'),
            x.cell('inventory'),
            x.cell('other_current_assets'),
          ),
      ),
      input('ppe_net', 'PP&E (net)'),
      input('intangibles', 'Intangible assets'),
      input('other_long_term_assets', 'Other long-term assets'),
      derived(
        'total_assets',
        'Total assets',
        'currency',
        (c) =>
          sum(
            sum(
              c.value('cash'),
              c.value('accounts_receivable'),
              c.value('inventory'),
              c.value('other_current_assets'),
            ),
            c.value('ppe_net'),
            c.value('intangibles'),
            c.value('other_long_term_assets'),
          ),
        (x) =>
          xSum(
            x.cell('total_current_assets'),
            x.cell('ppe_net'),
            x.cell('intangibles'),
            x.cell('other_long_term_assets'),
          ),
      ),
      input('accounts_payable', 'Accounts payable'),
      input('short_term_debt', 'Short-term debt'),
      input('other_current_liabilities', 'Other current liabilities'),
      derived(
        'total_current_liabilities',
        'Total current liabilities',
        'currency',
        (c) =>
          sum(c.value('accounts_payable'), c.value('short_term_debt'), c.value('other_current_liabilities')),
        (x) =>
          xSum(x.cell('accounts_payable'), x.cell('short_term_debt'), x.cell('other_current_liabilities')),
      ),
      input('long_term_debt', 'Long-term debt'),
      input('other_long_term_liabilities', 'Other long-term liabilities'),
      derived(
        'total_liabilities',
        'Total liabilities',
        'currency',
        (c) =>
          sum(
            sum(
              c.value('accounts_payable'),
              c.value('short_term_debt'),
              c.value('other_current_liabilities'),
            ),
            c.value('long_term_debt'),
            c.value('other_long_term_liabilities'),
          ),
        (x) =>
          xSum(
            x.cell('total_current_liabilities'),
            x.cell('long_term_debt'),
            x.cell('other_long_term_liabilities'),
          ),
      ),
      derived(
        'shareholders_equity',
        'Shareholders’ equity',
        'currency',
        (c) => sub(c.value('total_assets'), c.value('total_liabilities')),
        (x) => xMinus(x.cell('total_assets'), x.cell('total_liabilities')),
      ),
      derived(
        'working_capital',
        'Working capital',
        'currency',
        (c) => sub(c.value('total_current_assets'), c.value('total_current_liabilities')),
        (x) => xMinus(x.cell('total_current_assets'), x.cell('total_current_liabilities')),
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
