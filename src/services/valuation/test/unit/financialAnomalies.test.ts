import { describe, expect, it } from 'vitest';
import {
  detectFinancialAnomalies,
  HOCKEY_STICK_FLOOR,
  REVENUE_DECLINE_FRACTION,
  REVENUE_JUMP_MULTIPLE,
  type FinancialAnomaly,
} from '../../src/domain/financialAnomalies.js';
import { computeWorkbook, type WorkbookCellInput } from '../../src/domain/workbook.js';

/**
 * Cells are written through `computeWorkbook`, not hand-built, so every test
 * here runs against the same derived rows the workbook UI and the historical
 * appendix read. A check that only passes on a hand-shaped grid would not be
 * evidence of anything.
 */
function grid(cells: Array<[string, string, string, number]>) {
  const input: WorkbookCellInput[] = cells.map(([sheet, row_key, column_key, value]) => ({
    sheet,
    row_key,
    column_key,
    value,
  }));
  return computeWorkbook(input);
}

const checks = (found: FinancialAnomaly[]): string[] => found.map((a) => a.check);

/** A plain, unremarkable three-year P&L and balance sheet. */
const CLEAN: Array<[string, string, string, number]> = [
  ['income_statement', 'revenue', 'fy_minus_2', 1_000_000],
  ['income_statement', 'cogs', 'fy_minus_2', 400_000],
  ['income_statement', 'operating_expenses', 'fy_minus_2', 450_000],
  ['income_statement', 'revenue', 'fy_minus_1', 1_400_000],
  ['income_statement', 'cogs', 'fy_minus_1', 560_000],
  ['income_statement', 'operating_expenses', 'fy_minus_1', 600_000],
  ['income_statement', 'revenue', 'fy_current', 1_900_000],
  ['income_statement', 'cogs', 'fy_current', 760_000],
  ['income_statement', 'operating_expenses', 'fy_current', 800_000],
  ['balance_sheet', 'cash', 'fy_minus_2', 500_000],
  ['balance_sheet', 'accounts_payable', 'fy_minus_2', 100_000],
  ['balance_sheet', 'cash', 'fy_minus_1', 600_000],
  ['balance_sheet', 'accounts_payable', 'fy_minus_1', 120_000],
  ['balance_sheet', 'cash', 'fy_current', 700_000],
  ['balance_sheet', 'accounts_payable', 'fy_current', 140_000],
];

describe('financial statement anomalies', () => {
  it('says nothing about statements that read normally', () => {
    const report = detectFinancialAnomalies(grid(CLEAN));
    expect(report.anomalies).toEqual([]);
    expect(report.counts).toEqual({ error: 0, warning: 0, info: 0 });
    expect(report.empty).toBe(false);
  });

  it('reports an empty workbook as unchecked rather than clean', () => {
    const report = detectFinancialAnomalies(grid([]));
    expect(report.anomalies).toEqual([]);
    // The distinction the flag exists for: nothing was found because nothing
    // was entered, which is not a clean bill of health.
    expect(report.empty).toBe(true);
  });

  describe('cost lines entered negative', () => {
    it('catches a negative cost of sales, which the model would add back', () => {
      const report = detectFinancialAnomalies(
        grid([
          ['income_statement', 'revenue', 'fy_current', 1_000_000],
          ['income_statement', 'cogs', 'fy_current', -400_000],
        ]),
      );
      const found = report.anomalies.find((a) => a.check === 'cost_entered_negative');
      expect(found).toBeDefined();
      expect(found?.severity).toBe('error');
      expect(found?.row_key).toBe('cogs');
      expect(found?.column_key).toBe('fy_current');
      expect(found?.value).toBe(-400_000);
    });

    it('is raised precisely because the statements still foot', () => {
      // Gross profit reads 1.4m off 1.0m of revenue. Nothing is inconsistent;
      // the number is simply wrong, which is why a footing check cannot find it.
      const sheets = grid([
        ['income_statement', 'revenue', 'fy_current', 1_000_000],
        ['income_statement', 'cogs', 'fy_current', -400_000],
      ]);
      const income = sheets.find((s) => s.key === 'income_statement')!;
      const grossProfit = income.rows
        .find((r) => r.key === 'gross_profit')!
        .cells.find((c) => c.column_key === 'fy_current')!.value;
      expect(grossProfit).toBe(1_400_000);
      expect(checks(detectFinancialAnomalies(sheets).anomalies)).toContain('cost_entered_negative');
    });

    it('covers operating expenses and D&A, not just cost of sales', () => {
      const report = detectFinancialAnomalies(
        grid([
          ['income_statement', 'revenue', 'fy_current', 1_000_000],
          ['income_statement', 'operating_expenses', 'fy_current', -200_000],
          ['income_statement', 'depreciation_amortization', 'fy_current', -50_000],
        ]),
      );
      const rows = report.anomalies.filter((a) => a.check === 'cost_entered_negative').map((a) => a.row_key);
      expect(rows).toEqual(['operating_expenses', 'depreciation_amortization']);
    });

    it('treats negative interest and tax as legitimate, and only notes them', () => {
      const report = detectFinancialAnomalies(
        grid([
          ['income_statement', 'revenue', 'fy_current', 1_000_000],
          ['income_statement', 'cogs', 'fy_current', 400_000],
          ['income_statement', 'operating_expenses', 'fy_current', 300_000],
          ['income_statement', 'interest_expense', 'fy_current', -20_000],
          ['income_statement', 'taxes', 'fy_current', -30_000],
          ['balance_sheet', 'cash', 'fy_current', 400_000],
        ]),
      );
      expect(checks(report.anomalies)).toEqual(['net_interest_income', 'tax_benefit']);
      expect(report.counts.error).toBe(0);
      // Net interest income and a tax benefit are both real things a company
      // reports; refusing them would overrule the analyst more often than not.
      expect(report.anomalies.every((a) => a.severity === 'info')).toBe(true);
    });
  });

  describe('the income statement on its own', () => {
    it('refuses negative revenue', () => {
      const report = detectFinancialAnomalies(grid([['income_statement', 'revenue', 'fy_current', -5_000]]));
      const found = report.anomalies.find((a) => a.check === 'negative_revenue');
      expect(found?.severity).toBe('error');
    });

    it('warns on cost of sales above revenue without calling it an error', () => {
      const report = detectFinancialAnomalies(
        grid([
          ['income_statement', 'revenue', 'fy_current', 100_000],
          ['income_statement', 'cogs', 'fy_current', 180_000],
        ]),
      );
      const found = report.anomalies.find((a) => a.check === 'negative_gross_profit');
      expect(found?.severity).toBe('warning');
    });

    it('flags tax charged against a pre-tax loss', () => {
      const report = detectFinancialAnomalies(
        grid([
          ['income_statement', 'revenue', 'fy_current', 100_000],
          ['income_statement', 'cogs', 'fy_current', 40_000],
          ['income_statement', 'operating_expenses', 'fy_current', 200_000],
          ['income_statement', 'taxes', 'fy_current', 9_000],
        ]),
      );
      expect(checks(report.anomalies)).toContain('tax_on_loss');
    });

    it('does not flag tax charged against a profit', () => {
      const report = detectFinancialAnomalies(
        grid([
          ['income_statement', 'revenue', 'fy_current', 1_000_000],
          ['income_statement', 'cogs', 'fy_current', 400_000],
          ['income_statement', 'operating_expenses', 'fy_current', 300_000],
          ['income_statement', 'taxes', 'fy_current', 60_000],
        ]),
      );
      expect(checks(report.anomalies)).not.toContain('tax_on_loss');
    });
  });

  describe('the balance sheet', () => {
    it('refuses a negative bank balance and says where an overdraft belongs', () => {
      const report = detectFinancialAnomalies(grid([['balance_sheet', 'cash', 'fy_current', -25_000]]));
      const found = report.anomalies.find((a) => a.check === 'negative_asset');
      expect(found?.severity).toBe('error');
      expect(found?.detail).toMatch(/short-term debt/i);
    });

    it('treats a negative "other" bucket as a contra-asset worth confirming', () => {
      const report = detectFinancialAnomalies(
        grid([['balance_sheet', 'other_current_assets', 'fy_current', -10_000]]),
      );
      const found = report.anomalies.find((a) => a.check === 'negative_other_asset');
      expect(found?.severity).toBe('warning');
    });

    it('warns on a negative liability, which inflates derived equity', () => {
      const report = detectFinancialAnomalies(
        grid([['balance_sheet', 'accounts_payable', 'fy_current', -10_000]]),
      );
      expect(checks(report.anomalies)).toContain('negative_liability');
    });

    it('notes negative book equity without treating it as a mistake', () => {
      // Every line entered: the derived equity row is null-propagating, so a
      // partial balance sheet has no total to be negative.
      const report = detectFinancialAnomalies(
        grid([
          ['balance_sheet', 'cash', 'fy_current', 50_000],
          ['balance_sheet', 'accounts_receivable', 'fy_current', 0],
          ['balance_sheet', 'inventory', 'fy_current', 0],
          ['balance_sheet', 'other_current_assets', 'fy_current', 0],
          ['balance_sheet', 'ppe_net', 'fy_current', 0],
          ['balance_sheet', 'intangibles', 'fy_current', 0],
          ['balance_sheet', 'other_long_term_assets', 'fy_current', 0],
          ['balance_sheet', 'accounts_payable', 'fy_current', 0],
          ['balance_sheet', 'short_term_debt', 'fy_current', 0],
          ['balance_sheet', 'other_current_liabilities', 'fy_current', 0],
          ['balance_sheet', 'long_term_debt', 'fy_current', 900_000],
          ['balance_sheet', 'other_long_term_liabilities', 'fy_current', 0],
        ]),
      );
      const found = report.anomalies.find((a) => a.check === 'negative_book_equity');
      expect(found?.severity).toBe('info');
      expect(found?.value).toBe(-850_000);
    });

    it('claims nothing about solvency from a part-entered balance sheet', () => {
      // Cash alone leaves total assets uncomputable. Summing what is there
      // would report this company as underwater on an unfilled cell.
      const report = detectFinancialAnomalies(
        grid([
          ['balance_sheet', 'cash', 'fy_current', 50_000],
          ['balance_sheet', 'long_term_debt', 'fy_current', 900_000],
        ]),
      );
      expect(checks(report.anomalies)).not.toContain('negative_book_equity');
    });
  });

  describe('the revenue series', () => {
    it('catches a units mismatch as an implausible step', () => {
      const report = detectFinancialAnomalies(
        grid([
          // FY-1 in thousands, FY in whole currency — the classic import error.
          ['income_statement', 'revenue', 'fy_minus_1', 1_400],
          ['income_statement', 'revenue', 'fy_current', 1_900_000],
        ]),
      );
      const found = report.anomalies.find((a) => a.check === 'revenue_jump');
      expect(found?.severity).toBe('warning');
      expect(found?.column_key).toBe('fy_current');
    });

    it('leaves growth below the threshold alone', () => {
      const report = detectFinancialAnomalies(
        grid([
          ['income_statement', 'revenue', 'fy_minus_1', 100_000],
          // Just under the multiple, so this is the boundary the constant names.
          ['income_statement', 'revenue', 'fy_current', 100_000 * (REVENUE_JUMP_MULTIPLE - 0.1)],
        ]),
      );
      expect(checks(report.anomalies)).not.toContain('revenue_jump');
    });

    it('flags a steep decline as bearing on the going-concern premise', () => {
      const report = detectFinancialAnomalies(
        grid([
          ['income_statement', 'revenue', 'fy_minus_1', 1_000_000],
          ['income_statement', 'revenue', 'fy_current', 1_000_000 * (1 - REVENUE_DECLINE_FRACTION)],
        ]),
      );
      expect(checks(report.anomalies)).toContain('revenue_decline');
    });
  });

  describe('the forecast against the record', () => {
    it('flags a forecast that outruns every year the company actually had', () => {
      const report = detectFinancialAnomalies(
        grid([
          ['income_statement', 'revenue', 'fy_minus_2', 1_000_000],
          ['income_statement', 'revenue', 'fy_minus_1', 1_100_000],
          ['income_statement', 'revenue', 'fy_current', 1_200_000],
          // ~8% a year, then 400%.
          ['income_statement', 'revenue', 'fy_plus_1', 6_000_000],
        ]),
      );
      const found = report.anomalies.find((a) => a.check === 'forecast_break');
      expect(found?.severity).toBe('warning');
      expect(found?.column_key).toBe('fy_plus_1');
      expect(found?.detail).toMatch(/income approach discounts this stream/i);
    });

    it('leaves a forecast in line with the company’s own history alone', () => {
      const report = detectFinancialAnomalies(
        grid([
          ['income_statement', 'revenue', 'fy_minus_2', 1_000_000],
          ['income_statement', 'revenue', 'fy_minus_1', 2_000_000],
          ['income_statement', 'revenue', 'fy_current', 4_000_000],
          // Another double, from a company that has twice doubled.
          ['income_statement', 'revenue', 'fy_plus_1', 8_000_000],
        ]),
      );
      expect(checks(report.anomalies)).not.toContain('forecast_break');
    });

    it('leaves a modest forecast alone even from a company that has never grown', () => {
      const report = detectFinancialAnomalies(
        grid([
          ['income_statement', 'revenue', 'fy_minus_2', 1_000_000],
          ['income_statement', 'revenue', 'fy_minus_1', 1_000_000],
          ['income_statement', 'revenue', 'fy_current', 1_000_000],
          ['income_statement', 'revenue', 'fy_plus_1', 1_000_000 * (1 + HOCKEY_STICK_FLOOR)],
        ]),
      );
      expect(checks(report.anomalies)).not.toContain('forecast_break');
    });

    it('flags a step change from a flat company once it clears the floor', () => {
      const report = detectFinancialAnomalies(
        grid([
          ['income_statement', 'revenue', 'fy_minus_2', 1_000_000],
          ['income_statement', 'revenue', 'fy_minus_1', 1_000_000],
          ['income_statement', 'revenue', 'fy_current', 1_000_000],
          ['income_statement', 'revenue', 'fy_plus_1', 3_000_000],
        ]),
      );
      expect(checks(report.anomalies)).toContain('forecast_break');
    });
  });

  describe('holes in a series', () => {
    it('flags a missing middle period', () => {
      const report = detectFinancialAnomalies(
        grid([
          ['income_statement', 'revenue', 'fy_minus_2', 1_000_000],
          ['income_statement', 'revenue', 'fy_current', 1_400_000],
        ]),
      );
      const found = report.anomalies.find((a) => a.check === 'period_gap');
      expect(found?.column_key).toBe('fy_minus_1');
    });

    it('says nothing about a series that simply starts late', () => {
      const report = detectFinancialAnomalies(
        grid([
          ['income_statement', 'revenue', 'fy_minus_1', 1_000_000],
          ['income_statement', 'revenue', 'fy_current', 1_400_000],
        ]),
      );
      // A company that did not exist in FY-2 has not omitted anything.
      expect(checks(report.anomalies)).not.toContain('period_gap');
    });
  });

  describe('the two statements read against each other', () => {
    it('flags interest charged in a year carrying no debt', () => {
      const report = detectFinancialAnomalies(
        grid([
          ['income_statement', 'revenue', 'fy_current', 1_000_000],
          ['income_statement', 'cogs', 'fy_current', 300_000],
          ['income_statement', 'operating_expenses', 'fy_current', 200_000],
          ['income_statement', 'interest_expense', 'fy_current', 40_000],
          ['balance_sheet', 'cash', 'fy_current', 500_000],
        ]),
      );
      expect(checks(report.anomalies)).toContain('interest_without_debt');
    });

    it('says nothing when the borrowing is on the balance sheet', () => {
      const report = detectFinancialAnomalies(
        grid([
          ['income_statement', 'revenue', 'fy_current', 1_000_000],
          ['income_statement', 'cogs', 'fy_current', 300_000],
          ['income_statement', 'operating_expenses', 'fy_current', 200_000],
          ['income_statement', 'interest_expense', 'fy_current', 40_000],
          ['balance_sheet', 'cash', 'fy_current', 500_000],
          ['balance_sheet', 'long_term_debt', 'fy_current', 800_000],
        ]),
      );
      expect(checks(report.anomalies)).not.toContain('interest_without_debt');
    });

    it('flags a reported period with a P&L and no balance sheet', () => {
      const report = detectFinancialAnomalies(
        grid([['income_statement', 'revenue', 'fy_current', 1_000_000]]),
      );
      const found = report.anomalies.find((a) => a.check === 'missing_balance_sheet');
      expect(found?.column_key).toBe('fy_current');
    });

    it('does not demand a forecast balance sheet', () => {
      const report = detectFinancialAnomalies(
        grid([
          ['income_statement', 'revenue', 'fy_current', 1_000_000],
          ['balance_sheet', 'cash', 'fy_current', 500_000],
          ['income_statement', 'revenue', 'fy_plus_1', 1_200_000],
        ]),
      );
      // A modelled forward balance sheet is optional in a way a historical one
      // is not; requiring it would fire on nearly every engagement.
      expect(checks(report.anomalies)).not.toContain('missing_balance_sheet');
    });
  });

  it('orders findings by severity, so the number-changing one is read first', () => {
    const report = detectFinancialAnomalies(
      grid([
        ['income_statement', 'revenue', 'fy_current', 1_000_000],
        ['income_statement', 'cogs', 'fy_current', -400_000],
        ['income_statement', 'taxes', 'fy_current', -1_000],
        ['balance_sheet', 'accounts_payable', 'fy_current', -10_000],
      ]),
    );
    expect(report.anomalies.map((a) => a.severity)).toEqual(['error', 'warning', 'info']);
  });

  it('labels every finding with the sheet, row and period a reader must open', () => {
    const report = detectFinancialAnomalies(grid([['income_statement', 'cogs', 'fy_minus_1', -400_000]]));
    const found = report.anomalies.find((a) => a.check === 'cost_entered_negative')!;
    expect(found.sheet_label).toBe('Income statement');
    expect(found.row_label).toBe('Cost of goods sold');
    expect(found.column_label).toBe('FY-1');
  });
});
