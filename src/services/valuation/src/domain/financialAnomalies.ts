import { isProjectionColumn, type ComputedSheet } from './workbook.js';

/**
 * Checks on the financial statements the analysis rests on.
 *
 * The workbook cannot produce an arithmetic error: subtotals, margins and
 * growth are derived rows (`domain/workbook.ts`), recomputed on every read, so
 * total assets always equals the sum of its parts and gross profit always
 * equals revenue less cost of sales. That is worth having, and it is also the
 * reason nothing here looks for a footing error — there cannot be one.
 *
 * What the workbook cannot catch is the input being wrong in a way the
 * arithmetic happily accepts. Every finding below is of that kind:
 *
 *   * A cost line entered negative. Accounting exports commonly carry expenses
 *     as negative numbers; the model *subtracts* these rows, so a negative
 *     cost is added back. Gross profit, EBITDA, EBIT and net income are then
 *     all overstated, every margin with them, and nothing on the page looks
 *     wrong — the statements foot, and they foot to the wrong number. This is
 *     the single failure mode that most deserved a check.
 *   * A period entered in different units from its neighbours — thousands
 *     against units — which reads as a thousandfold jump in revenue.
 *   * A forecast that departs from the record without saying so. The income
 *     approach discounts that stream; it is the most consequential unchecked
 *     input in the file.
 *   * Two statements that disagree: interest expense charged in a year with no
 *     debt on the balance sheet, tax charged on a pre-tax loss.
 *
 * ## What this is not
 *
 * It is not the engine's anomaly pass, and neither replaces the other. The
 * engine's (`engine-wrapper/app/engine/anomalies.py`, reported through
 * `validate.py` as preflight warnings) reads the *extracted payload* on its way
 * to a calculation, and catches what extraction gets wrong — a figure read off
 * a table denominated in thousands, a projection filled down a merged cell, an
 * EBITDA larger than its own revenue. This one reads the *entered workbook*,
 * which is a different artifact with different failure modes: it is the grid an
 * analyst types into and the one Appendix II prints, and half the findings here
 * are about lines the engine payload does not carry at all. A workbook can pass
 * every check below and still produce a payload the engine questions, and the
 * reverse. Where the two do look at one thing — a period-over-period step no
 * business explains — they are deliberately allowed to say so twice, on the two
 * surfaces where the person who can fix it is actually looking.
 *
 * It is not a gate and it does not correct anything. Several findings below are
 * ordinary for an early-stage company — negative gross profit, negative book
 * equity, a year of steep decline — and an engine that refused them would be
 * wrong more often than the analyst it overruled. So the severities say how
 * loudly to ask, never whether to proceed:
 *
 *   * `error`     — the arithmetic downstream is being fed something it cannot
 *                   mean. A negative cost is not a business fact.
 *   * `warning`   — legitimate under an explanation, and the explanation should
 *                   exist somewhere before the report is signed.
 *   * `info`      — worth a reader's attention, not anybody's correction.
 *
 * Thresholds are exported so a test names the same number the check applies,
 * rather than restating it.
 */

export type AnomalySeverity = 'error' | 'warning' | 'info';

export interface FinancialAnomaly {
  /** Stable identifier for the check, so findings group and tests name one. */
  check: string;
  severity: AnomalySeverity;
  sheet: string;
  sheet_label: string;
  /** The period the finding is about; null where it is about a whole series. */
  column_key: string | null;
  column_label: string | null;
  /** The line item carrying it; null where the finding spans lines. */
  row_key: string | null;
  row_label: string | null;
  /** One sentence stating what was found. */
  summary: string;
  /** Why it matters, and what would resolve it. */
  detail: string;
  /** The figure that triggered the check, for display alongside the text. */
  value: number | null;
}

export interface FinancialAnomalyReport {
  anomalies: FinancialAnomaly[];
  counts: Record<AnomalySeverity, number>;
  /**
   * Whether any financial input exists at all.
   *
   * An empty workbook produces no findings, and "no anomalies found" would
   * describe that as a clean bill of health. It is the opposite: nothing has
   * been checked because nothing has been entered.
   */
  empty: boolean;
}

/**
 * A period-over-period revenue multiple beyond which the likelier explanation
 * is a change of units, not a change of business. Chosen well above any real
 * growth rate — a company that genuinely grows elevenfold in a year exists, and
 * gets a warning it can dismiss — and well below the thousandfold jump that a
 * thousands-versus-units mix-up produces.
 */
export const REVENUE_JUMP_MULTIPLE = 10;

/** A single-period revenue decline steep enough to want a stated cause. */
export const REVENUE_DECLINE_FRACTION = 0.6;

/**
 * How far the first forecast period may outrun the best year the company
 * actually had before the forecast needs a basis on the page.
 *
 * Two conditions, both required, because either alone is noisy: the forecast
 * growth must exceed `HOCKEY_STICK_FLOOR` in absolute terms (a company stepping
 * from 5% to 20% has not made a claim worth challenging), and it must exceed
 * the best historical growth by `HOCKEY_STICK_MULTIPLE` (a company that has
 * repeatedly tripled is not asserting anything new by forecasting a triple).
 */
export const HOCKEY_STICK_MULTIPLE = 3;
export const HOCKEY_STICK_FLOOR = 0.5;

/** Sheets these checks understand. Anything else is passed over untouched. */
const INCOME = 'income_statement';
const BALANCE = 'balance_sheet';

/**
 * Cost lines the model subtracts, and which therefore cannot be negative
 * without inverting their own meaning.
 *
 * `interest_expense` and `taxes` are deliberately absent: net interest income
 * and a tax benefit are both real, and both correctly increase net income when
 * subtracted as a negative. They get an `info` below rather than an error.
 */
const SUBTRACTED_COST_ROWS = ['cogs', 'operating_expenses', 'depreciation_amortization'] as const;

/** Asset lines that cannot be negative under any reading. */
const HARD_ASSET_ROWS = ['cash', 'accounts_receivable', 'inventory', 'ppe_net', 'intangibles'] as const;

/** Asset buckets where a negative is likelier a contra-asset than an error. */
const SOFT_ASSET_ROWS = ['other_current_assets', 'other_long_term_assets'] as const;

const LIABILITY_ROWS = [
  'accounts_payable',
  'short_term_debt',
  'other_current_liabilities',
  'long_term_debt',
  'other_long_term_liabilities',
] as const;

const DEBT_ROWS = ['short_term_debt', 'long_term_debt'] as const;

/** Indexed read access over the computed grid. */
interface Grid {
  sheets: Map<string, ComputedSheet>;
  value: (sheet: string, row: string, column: string) => number | null;
  rowLabel: (sheet: string, row: string) => string;
  columnLabel: (sheet: string, column: string) => string;
  /** Input rows only — a derived row is populated iff its inputs are. */
  populated: (sheet: string, column: string) => boolean;
}

function indexSheets(sheets: readonly ComputedSheet[]): Grid {
  const byKey = new Map(sheets.map((s) => [s.key, s]));
  const cells = new Map<string, number | null>();
  const rowLabels = new Map<string, string>();
  const columnLabels = new Map<string, string>();

  for (const sheet of sheets) {
    for (const column of sheet.columns) columnLabels.set(`${sheet.key} ${column.key}`, column.label);
    for (const row of sheet.rows) {
      rowLabels.set(`${sheet.key} ${row.key}`, row.label);
      for (const cell of row.cells) {
        cells.set(`${sheet.key} ${row.key} ${cell.column_key}`, cell.value);
      }
    }
  }

  return {
    sheets: byKey,
    value: (sheet, row, column) => cells.get(`${sheet} ${row} ${column}`) ?? null,
    rowLabel: (sheet, row) => rowLabels.get(`${sheet} ${row}`) ?? row,
    columnLabel: (sheet, column) => columnLabels.get(`${sheet} ${column}`) ?? column,
    populated: (sheetKey, column) => {
      const sheet = byKey.get(sheetKey);
      if (!sheet) return false;
      return sheet.rows.some(
        (row) => row.kind === 'input' && row.cells.some((c) => c.column_key === column && c.value !== null),
      );
    },
  };
}

/** The fiscal-period columns of a sheet, in model order. */
function periodsOf(grid: Grid, sheetKey: string): string[] {
  return grid.sheets.get(sheetKey)?.columns.map((c) => c.key) ?? [];
}

export function detectFinancialAnomalies(sheets: readonly ComputedSheet[]): FinancialAnomalyReport {
  const grid = indexSheets(sheets);
  const found: FinancialAnomaly[] = [];

  const add = (
    a: Omit<FinancialAnomaly, 'sheet_label' | 'row_label' | 'column_label'> & {
      row_label?: string;
      column_label?: string;
    },
  ): void => {
    found.push({
      ...a,
      sheet_label: grid.sheets.get(a.sheet)?.label ?? a.sheet,
      row_label: a.row_label ?? (a.row_key === null ? null : grid.rowLabel(a.sheet, a.row_key)),
      column_label:
        a.column_label ?? (a.column_key === null ? null : grid.columnLabel(a.sheet, a.column_key)),
    });
  };

  checkCostSigns(grid, add);
  checkIncomeStatement(grid, add);
  checkBalanceSheet(grid, add);
  checkRevenueSeries(grid, add);
  checkForecastBreak(grid, add);
  checkPeriodGaps(grid, add);
  checkCrossStatement(grid, add);

  const counts: Record<AnomalySeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const a of found) counts[a.severity] += 1;

  const empty = !sheets.some((sheet) =>
    sheet.rows.some((row) => row.kind === 'input' && row.cells.some((c) => c.value !== null)),
  );

  /*
   * Severity first, then model order. A reviewer opening this wants the thing
   * that changes a number before the thing that colours a comment, and within
   * one severity wants the statements in the order they read them.
   */
  const rank: Record<AnomalySeverity, number> = { error: 0, warning: 1, info: 2 };
  const anomalies = found
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank[x.a.severity] - rank[y.a.severity] || x.i - y.i)
    .map(({ a }) => a);

  return { anomalies, counts, empty };
}

type Add = (
  a: Omit<FinancialAnomaly, 'sheet_label' | 'row_label' | 'column_label'> & {
    row_label?: string;
    column_label?: string;
  },
) => void;

/**
 * The check this module exists for: a cost carried as a negative number.
 *
 * `gross_profit = revenue - cogs`. A COGS of -400 therefore *adds* 400 to gross
 * profit, and to EBITDA, EBIT and net income after it. The statements still
 * foot. Every margin is still internally consistent. The company is simply
 * reported to be more profitable than it is, in a document somebody relies on.
 */
function checkCostSigns(grid: Grid, add: Add): void {
  for (const column of periodsOf(grid, INCOME)) {
    for (const row of SUBTRACTED_COST_ROWS) {
      const value = grid.value(INCOME, row, column);
      if (value === null || value >= 0) continue;
      add({
        check: 'cost_entered_negative',
        severity: 'error',
        sheet: INCOME,
        column_key: column,
        row_key: row,
        value,
        summary: `${grid.rowLabel(INCOME, row)} is negative in ${grid.columnLabel(INCOME, column)}.`,
        detail:
          'The model subtracts this line, so a negative figure is added back: gross profit, EBITDA, ' +
          'EBIT and net income are all overstated by twice the amount, and the statements still foot. ' +
          'Accounting exports often carry expenses as negatives — enter costs as positive amounts.',
      });
    }

    const interest = grid.value(INCOME, 'interest_expense', column);
    if (interest !== null && interest < 0) {
      add({
        check: 'net_interest_income',
        severity: 'info',
        sheet: INCOME,
        column_key: column,
        row_key: 'interest_expense',
        value: interest,
        summary: `Interest expense is negative in ${grid.columnLabel(INCOME, column)}.`,
        detail:
          'Read as net interest income, which is legitimate for a company holding more cash than debt, ' +
          'and the arithmetic is right either way. Confirm it is income rather than a sign error.',
      });
    }

    const taxes = grid.value(INCOME, 'taxes', column);
    if (taxes !== null && taxes < 0) {
      add({
        check: 'tax_benefit',
        severity: 'info',
        sheet: INCOME,
        column_key: column,
        row_key: 'taxes',
        value: taxes,
        summary: `Taxes are negative in ${grid.columnLabel(INCOME, column)}.`,
        detail:
          'Read as a tax benefit, which is legitimate against a loss. Confirm it is a benefit rather ' +
          'than an expense entered with the wrong sign.',
      });
    }
  }
}

function checkIncomeStatement(grid: Grid, add: Add): void {
  for (const column of periodsOf(grid, INCOME)) {
    const revenue = grid.value(INCOME, 'revenue', column);
    if (revenue !== null && revenue < 0) {
      add({
        check: 'negative_revenue',
        severity: 'error',
        sheet: INCOME,
        column_key: column,
        row_key: 'revenue',
        value: revenue,
        summary: `Revenue is negative in ${grid.columnLabel(INCOME, column)}.`,
        detail:
          'Revenue cannot be negative. Returns and allowances belong netted into the line as a smaller ' +
          'positive figure, or in cost of sales — every margin and growth rate on this sheet is ' +
          'computed from this number.',
      });
    }

    const grossProfit = grid.value(INCOME, 'gross_profit', column);
    if (revenue !== null && revenue > 0 && grossProfit !== null && grossProfit < 0) {
      add({
        check: 'negative_gross_profit',
        severity: 'warning',
        sheet: INCOME,
        column_key: column,
        row_key: 'gross_profit',
        value: grossProfit,
        summary: `Cost of sales exceeds revenue in ${grid.columnLabel(INCOME, column)}.`,
        detail:
          'Ordinary for a company still buying its market, and a real finding if it was not intended. ' +
          'Where it is intended, the report should say why the margin is expected to turn.',
      });
    }

    /*
     * Tax charged on a pre-tax loss.
     *
     * The derived `ebit` row cannot be read directly here. Derived rows are
     * null-propagating by design — a company that has not entered D&A must not
     * have a blank read as nil in a statement somebody relies on — so `ebit` is
     * null on any sheet with a line still empty, and a check reading it would
     * be silent on exactly the half-entered workbooks it is most wanted for.
     *
     * So the screen builds its own pre-tax figure from EBITDA, treating the
     * lines below it as nil when blank. That is not a statement of pre-tax
     * income and is not published anywhere; it is safe *in this direction*
     * only: D&A and interest are both subtractions, so a blank one can only
     * make the real figure more negative than the screen's. The check
     * therefore under-fires on incomplete data and never over-fires, which is
     * the right way round for something that questions an analyst's entry.
     */
    const ebitda = grid.value(INCOME, 'ebitda', column);
    const interest = grid.value(INCOME, 'interest_expense', column);
    const taxes = grid.value(INCOME, 'taxes', column);
    if (ebitda !== null && taxes !== null && taxes > 0) {
      const preTax =
        ebitda - (grid.value(INCOME, 'depreciation_amortization', column) ?? 0) - (interest ?? 0);
      if (preTax < 0) {
        add({
          check: 'tax_on_loss',
          severity: 'warning',
          sheet: INCOME,
          column_key: column,
          row_key: 'taxes',
          value: taxes,
          summary: `Tax is charged in ${grid.columnLabel(INCOME, column)} against a pre-tax loss.`,
          detail:
            'A loss-making period normally carries no current tax charge. State-level minimum taxes and ' +
            'foreign withholding are real explanations; a period mismatch or a sign error is the ' +
            'likelier one.',
        });
      }
    }
  }
}

function checkBalanceSheet(grid: Grid, add: Add): void {
  for (const column of periodsOf(grid, BALANCE)) {
    for (const row of HARD_ASSET_ROWS) {
      const value = grid.value(BALANCE, row, column);
      if (value === null || value >= 0) continue;
      add({
        check: 'negative_asset',
        severity: 'error',
        sheet: BALANCE,
        column_key: column,
        row_key: row,
        value,
        summary: `${grid.rowLabel(BALANCE, row)} is negative in ${grid.columnLabel(BALANCE, column)}.`,
        detail:
          row === 'cash'
            ? 'A bank balance cannot be negative. An overdraft is borrowing and belongs in short-term ' +
              'debt, where it is carried as a liability rather than netted against the asset side.'
            : 'This balance cannot be negative. A valuation allowance or accumulated depreciation ' +
              'belongs netted into the line as a smaller positive figure.',
      });
    }

    for (const row of SOFT_ASSET_ROWS) {
      const value = grid.value(BALANCE, row, column);
      if (value === null || value >= 0) continue;
      add({
        check: 'negative_other_asset',
        severity: 'warning',
        sheet: BALANCE,
        column_key: column,
        row_key: row,
        value,
        summary: `${grid.rowLabel(BALANCE, row)} is negative in ${grid.columnLabel(BALANCE, column)}.`,
        detail:
          'Read as a contra-asset. It reduces total assets, and through them shareholders’ equity, so ' +
          'confirm it belongs on the asset side rather than in liabilities.',
      });
    }

    for (const row of LIABILITY_ROWS) {
      const value = grid.value(BALANCE, row, column);
      if (value === null || value >= 0) continue;
      add({
        check: 'negative_liability',
        severity: 'warning',
        sheet: BALANCE,
        column_key: column,
        row_key: row,
        value,
        summary: `${grid.rowLabel(BALANCE, row)} is negative in ${grid.columnLabel(BALANCE, column)}.`,
        detail:
          'A negative liability adds to shareholders’ equity, which is derived as total assets less ' +
          'total liabilities. A prepayment or a debit balance belongs on the asset side.',
      });
    }

    /*
     * Read from the derived row deliberately, which means it is silent on a
     * part-entered balance sheet. The screening shortcut taken for `tax_on_loss`
     * is unsafe here and in the opposite direction: a missing asset line makes a
     * summed-what-is-there figure *smaller*, so a screen would report a solvent
     * company as underwater on nothing more than an unfilled cell. Saying
     * nothing until the statement is complete is the only honest option.
     */
    const equity = grid.value(BALANCE, 'shareholders_equity', column);
    if (equity !== null && equity < 0 && grid.populated(BALANCE, column)) {
      add({
        check: 'negative_book_equity',
        severity: 'info',
        sheet: BALANCE,
        column_key: column,
        row_key: 'shareholders_equity',
        value: equity,
        summary: `Book equity is negative in ${grid.columnLabel(BALANCE, column)}.`,
        detail:
          'Common for a company financed by convertible debt, and not an error. It does mean the asset ' +
          'approach cannot serve as a floor on value here, which the reconciliation should reflect ' +
          'rather than assert a low weight without saying why.',
      });
    }
  }
}

/**
 * Revenue moving by more than a business plausibly moves.
 *
 * The finding this is really for is a units mismatch — one period entered in
 * thousands beside a period entered in whole currency — which produces a
 * thousandfold step that no growth rate explains, and which flows straight into
 * every multiple and growth assumption struck off the series.
 */
function checkRevenueSeries(grid: Grid, add: Add): void {
  const periods = periodsOf(grid, INCOME);
  for (let i = 1; i < periods.length; i += 1) {
    const column = periods[i]!;
    const prior = periods[i - 1]!;
    const current = grid.value(INCOME, 'revenue', column);
    const previous = grid.value(INCOME, 'revenue', prior);
    if (current === null || previous === null || previous <= 0 || current < 0) continue;

    if (current / previous >= REVENUE_JUMP_MULTIPLE) {
      add({
        check: 'revenue_jump',
        severity: 'warning',
        sheet: INCOME,
        column_key: column,
        row_key: 'revenue',
        value: current,
        summary:
          `Revenue rises ${(current / previous).toFixed(1)}× from ` +
          `${grid.columnLabel(INCOME, prior)} to ${grid.columnLabel(INCOME, column)}.`,
        detail:
          'A step this size is more often two periods stated in different units — thousands against ' +
          'whole currency — than growth. Confirm the scale of both periods before any multiple or ' +
          'growth rate is struck off this series.',
      });
      continue;
    }

    if ((previous - current) / previous >= REVENUE_DECLINE_FRACTION) {
      add({
        check: 'revenue_decline',
        severity: 'warning',
        sheet: INCOME,
        column_key: column,
        row_key: 'revenue',
        value: current,
        summary:
          `Revenue falls ${(((previous - current) / previous) * 100).toFixed(0)}% from ` +
          `${grid.columnLabel(INCOME, prior)} to ${grid.columnLabel(INCOME, column)}.`,
        detail:
          'A decline this steep bears on the going-concern premise and on the weight the income ' +
          'approach can carry. Where it is real, the report should state the cause; where it is a ' +
          'part-year figure entered as a full year, it is an error.',
      });
    }
  }
}

/**
 * A forecast that departs from the record without a stated basis.
 *
 * This is the most consequential unchecked input in the file: the income
 * approach discounts these periods, so the conclusion moves with them, and
 * unlike the historical statements there is nothing behind them to tie to.
 * The check does not judge the forecast — it asks whether the page explains a
 * step change the company's own history does not support.
 */
function checkForecastBreak(grid: Grid, add: Add): void {
  const periods = periodsOf(grid, INCOME);
  const firstForecastIdx = periods.findIndex((c) => isProjectionColumn(c));
  if (firstForecastIdx <= 0) return;

  const column = periods[firstForecastIdx]!;
  const prior = periods[firstForecastIdx - 1]!;
  const forecast = grid.value(INCOME, 'revenue', column);
  const last = grid.value(INCOME, 'revenue', prior);
  if (forecast === null || last === null || last <= 0) return;

  const forecastGrowth = (forecast - last) / last;
  if (forecastGrowth <= HOCKEY_STICK_FLOOR) return;

  // The best year the company actually had, across the reported periods only.
  let bestHistorical: number | null = null;
  for (let i = 1; i < firstForecastIdx; i += 1) {
    const cur = grid.value(INCOME, 'revenue', periods[i]!);
    const prev = grid.value(INCOME, 'revenue', periods[i - 1]!);
    if (cur === null || prev === null || prev <= 0) continue;
    const growth = (cur - prev) / prev;
    if (bestHistorical === null || growth > bestHistorical) bestHistorical = growth;
  }
  if (bestHistorical === null) return;

  /*
   * Compared against the best historical growth floored at zero: a company
   * coming off a decline has a negative best year, and dividing by it would
   * make every forecast either infinitely aggressive or trivially fine
   * depending on its sign. Floored, the test reads "a forecast well above
   * HOCKEY_STICK_FLOOR from a company that has never grown" — which is the
   * question worth asking.
   */
  const benchmark = Math.max(bestHistorical, 0);
  if (forecastGrowth < HOCKEY_STICK_MULTIPLE * benchmark && benchmark > 0) return;

  add({
    check: 'forecast_break',
    severity: 'warning',
    sheet: INCOME,
    column_key: column,
    row_key: 'revenue',
    value: forecast,
    summary:
      `Forecast revenue growth of ${(forecastGrowth * 100).toFixed(0)}% in ` +
      `${grid.columnLabel(INCOME, column)} exceeds anything in the reported periods` +
      (bestHistorical > 0 ? ` (best ${(bestHistorical * 100).toFixed(0)}%)` : '') +
      '.',
    detail:
      'The income approach discounts this stream, so the conclusion moves with it, and nothing behind ' +
      'the forecast can be tied to. Where the step change is real — a product launched, a contract ' +
      'signed, a market opened — the report should name it; where it is management’s plan rather than ' +
      'the analyst’s expectation, the weight on the income approach should reflect that.',
  });
}

/**
 * A hole in the middle of a series.
 *
 * A missing trailing period is a company that has not filed yet, and a missing
 * leading period is a company that did not exist. A missing *middle* period is
 * neither — it is data that was meant to be there, and every growth rate
 * spanning the hole is computed against the wrong base.
 */
function checkPeriodGaps(grid: Grid, add: Add): void {
  for (const sheetKey of [INCOME, BALANCE]) {
    const periods = periodsOf(grid, sheetKey);
    const filled = periods.map((c) => grid.populated(sheetKey, c));
    const first = filled.indexOf(true);
    const last = filled.lastIndexOf(true);
    if (first === -1 || last - first < 2) continue;

    for (let i = first + 1; i < last; i += 1) {
      if (filled[i]) continue;
      add({
        check: 'period_gap',
        severity: 'warning',
        sheet: sheetKey,
        column_key: periods[i]!,
        row_key: null,
        value: null,
        summary: `${grid.columnLabel(sheetKey, periods[i]!)} is empty between two populated periods.`,
        detail:
          'Growth rates and averages spanning the gap are struck against the wrong base period, and the ' +
          'historical appendix prints the series with the year missing. Enter the period or say why it ' +
          'is unavailable.',
      });
    }
  }
}

/** Findings only visible when the two statements are read against each other. */
function checkCrossStatement(grid: Grid, add: Add): void {
  const periods = periodsOf(grid, INCOME);

  for (const column of periods) {
    /*
     * A reported period with a P&L and no balance sheet. Restricted to the
     * reported periods: a forecast balance sheet is optional in a way a
     * historical one is not, and flagging its absence would fire on almost
     * every engagement.
     */
    if (!isProjectionColumn(column) && grid.populated(INCOME, column) && !grid.populated(BALANCE, column)) {
      add({
        check: 'missing_balance_sheet',
        severity: 'warning',
        sheet: BALANCE,
        column_key: column,
        row_key: null,
        value: null,
        summary: `${grid.columnLabel(INCOME, column)} has an income statement and no balance sheet.`,
        detail:
          'The asset approach and the net-cash bridge both read the balance sheet, and the historical ' +
          'appendix prints the period with one statement missing. Enter it, or state that the approach ' +
          'was not applied for want of it.',
      });
    }

    // Interest charged in a year the company carried no debt.
    const interest = grid.value(INCOME, 'interest_expense', column);
    if (interest === null || interest <= 0) continue;
    if (!grid.populated(BALANCE, column)) continue;
    const debt = DEBT_ROWS.reduce((sum, row) => sum + (grid.value(BALANCE, row, column) ?? 0), 0);
    if (debt > 0) continue;

    add({
      check: 'interest_without_debt',
      severity: 'warning',
      sheet: INCOME,
      column_key: column,
      row_key: 'interest_expense',
      value: interest,
      summary: `Interest is charged in ${grid.columnLabel(INCOME, column)} with no debt on the balance sheet.`,
      detail:
        'Either the borrowing is missing from the balance sheet — which understates liabilities and ' +
        'overstates equity and the net-cash bridge — or the charge belongs elsewhere. Debt repaid ' +
        'within the year is a real explanation and should be stated.',
    });
  }
}
