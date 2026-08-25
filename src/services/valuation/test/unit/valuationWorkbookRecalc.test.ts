import { describe, expect, it } from 'vitest';
import {
  valuationWorkbookSheets,
  type ValuationWorkbookInput,
  type WorkbookGrant,
} from '../../src/export/valuationWorkbook.js';
import { validateCapTable, type CapTableEntry } from '../../src/domain/capTable.js';
import { WORKBOOK_SHEETS, type WorkbookCellInput } from '../../src/domain/workbook.js';
import type { XlsxSheet, XlsxValue } from '../../src/export/xlsx.js';
import { ExcelError, evaluateFormula, type Cell, type Grid } from '../support/excelEval.js';

/**
 * Recalculates the exported workbook and checks it against itself.
 *
 * Every derived cell ships twice — as a live formula for the auditor who
 * changes an input, and as a cached value for every reader that shows what was
 * computed. The two are written by different code from different sources: the
 * cache comes from the TypeScript model in `domain/workbook.ts`, the formula
 * from an A1 expression built beside it. Nothing made them agree, and the way
 * they come apart is silent: a row inserted into a sheet definition shifts the
 * references by one and the workbook still opens, still sums, and divides by
 * the wrong line.
 *
 * `valuationWorkbook.test.ts` pins a dozen references by hand, which is as many
 * as a person will ever write. This evaluates all of them.
 */

const GENERATED_AT = new Date('2026-07-29T09:00:00Z');

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
    // Not 1: a ratcheted class is the only thing that makes the cap table's
    // as-converted column differ from its share count, so a formula that
    // silently ignored the ratio would otherwise agree with the cache.
    conversion_ratio: 1.25,
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
  {
    grantee_name: 'Ravi Shah',
    grantee_email: 'ravi@acme.test',
    grant_date: '2025-09-15',
    options_count: 45_000,
    exercise_price: '1.10',
    currency: 'USD',
    vesting_template: '4yr_1yr_cliff',
    vesting_start_date: '2025-09-15',
    vesting_months: 48,
    cliff_months: 12,
    frequency_months: 1,
    status: 'active',
  },
];

/** Every input cell of every model sheet, walked off the sheet definitions. */
function saturatedCells(): WorkbookCellInput[] {
  const out: WorkbookCellInput[] = [];
  let n = 0;
  for (const sheetDef of WORKBOOK_SHEETS) {
    for (const row of sheetDef.rows) {
      if (row.kind !== 'input') continue;
      for (const col of sheetDef.columns) {
        n += 1;
        out.push({
          sheet: sheetDef.key,
          row_key: row.key,
          column_key: col.key,
          value: row.format === 'percent' ? 0.05 + n / 1000 : 1_000 * n + 250,
        });
      }
    }
  }
  return out;
}

/** A partly-filled model, so the blank-propagating guards are exercised too. */
const SPARSE_CELLS: WorkbookCellInput[] = [
  { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_minus_1', value: 4_000_000 },
  { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_current', value: 6_000_000 },
  { sheet: 'income_statement', row_key: 'cogs', column_key: 'fy_current', value: 2_000_000 },
  { sheet: 'balance_sheet', row_key: 'cash', column_key: 'fy_current', value: 1_500_000 },
  { sheet: 'operating_metrics', row_key: 'arr', column_key: 'fy_current', value: 5_000_000 },
  { sheet: 'operating_metrics', row_key: 'customers', column_key: 'fy_current', value: 0 },
  { sheet: 'operating_metrics', row_key: 'net_burn', column_key: 'fy_current', value: 900_000 },
  { sheet: 'assumptions', row_key: 'discount_rate', column_key: 'value', value: 0.22 },
];

function workbook(overrides: Partial<ValuationWorkbookInput> = {}): XlsxSheet[] {
  return valuationWorkbookSheets({
    valuation: {
      number: 'V-2026-0042',
      company_name: 'Acme, Inc.',
      kind: '409a',
      state: 'published',
      currency: 'USD',
      created_at: new Date('2026-01-15T00:00:00Z'),
      published_at: new Date('2026-03-02T00:00:00Z'),
    },
    cells: saturatedCells(),
    capTable: { entries: ENTRIES, validation: validateCapTable(ENTRIES) },
    grants: GRANTS,
    fmvPerShare: 1.42,
    generatedAt: GENERATED_AT,
    ...overrides,
  });
}

function unwrap(cell: XlsxValue): XlsxValue {
  return typeof cell === 'object' && cell !== null && !(cell instanceof Date) && 'format' in cell
    ? (cell as { value: XlsxValue }).value
    : cell;
}

function asFormula(cell: XlsxValue): { formula: string; value?: number | null } | null {
  const v = unwrap(cell);
  if (typeof v !== 'object' || v === null || v instanceof Date) return null;
  return 'formula' in v ? v : null;
}

const COLUMN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

interface Disagreement {
  ref: string;
  label: string;
  formula: string;
  cached: number | null | undefined;
  recalculated: string;
}

/**
 * Resolves one sheet A1-style, evaluating formulas on demand.
 *
 * Memoised with an in-progress marker rather than a plain cache: these sheets
 * are acyclic by construction, and a change that made one cyclic should say so
 * instead of recursing until the stack gives out.
 */
function gridFor(sheet: XlsxSheet): Grid {
  const firstDataRow = (sheet.titleLines?.length ?? 0) + 2;
  const resolved = new Map<string, Cell>();
  const inProgress = new Set<string>();

  const grid: Grid = {
    at(column, row) {
      const key = `${column}:${row}`;
      if (resolved.has(key)) return resolved.get(key)!;
      if (inProgress.has(key)) throw new Error(`circular reference at ${key} on ${sheet.name}`);

      const raw = sheet.rows[row - firstDataRow]?.[column - 1];
      const cell = raw === undefined ? null : unwrap(raw);
      let value: Cell;
      const formula = raw === undefined ? null : asFormula(raw);
      if (formula) {
        inProgress.add(key);
        try {
          value = evaluateFormula(formula.formula, grid);
        } finally {
          inProgress.delete(key);
        }
      } else if (typeof cell === 'number') {
        value = cell;
      } else if (typeof cell === 'boolean') {
        value = cell;
      } else if (typeof cell === 'string') {
        // Header and label text. Not a number to COUNT, which is the only
        // thing these formulas ask about it.
        value = cell;
      } else {
        value = null;
      }
      resolved.set(key, value);
      return value;
    },
  };
  return grid;
}

function disagreements(sheets: XlsxSheet[]): Disagreement[] {
  const out: Disagreement[] = [];
  for (const sheet of sheets) {
    const grid = gridFor(sheet);
    const firstDataRow = (sheet.titleLines?.length ?? 0) + 2;
    sheet.rows.forEach((row, rowIndex) => {
      row.forEach((raw, colIndex) => {
        const formula = asFormula(raw);
        if (!formula) return;
        const ref = `${sheet.name}!${COLUMN_LETTERS[colIndex] ?? `?${colIndex}`}${firstDataRow + rowIndex}`;
        const label = String(unwrap(row[0]) ?? '');
        const cached = formula.value ?? null;

        let recalculated: Cell;
        try {
          recalculated = grid.at(colIndex + 1, firstDataRow + rowIndex);
        } catch (err) {
          out.push({
            ref,
            label,
            formula: formula.formula,
            cached,
            recalculated: err instanceof ExcelError ? err.code : `threw: ${(err as Error).message}`,
          });
          return;
        }

        // Blank agrees with no cached value; a number must match to the
        // precision a spreadsheet would show.
        const bothBlank = (recalculated === '' || recalculated === null) && cached === null;
        const bothNumeric =
          typeof recalculated === 'number' &&
          typeof cached === 'number' &&
          Math.abs(recalculated - cached) <= Math.max(1e-9, Math.abs(cached) * 1e-12);
        if (bothBlank || bothNumeric) return;
        out.push({ ref, label, formula: formula.formula, cached, recalculated: String(recalculated) });
      });
    });
  }
  return out;
}

const describeAll = (d: Disagreement[]): string[] =>
  d.map((x) => `${x.ref} (${x.label}) ${x.formula} → ${x.recalculated}, cached ${String(x.cached)}`);

describe('the exported workbook agrees with itself when recalculated', () => {
  it('checks every formula on every sheet, not a sample', () => {
    // The guard against passing vacuously: this claim is only worth anything
    // if the walk is actually reaching the formulas.
    const sheets = workbook();
    let count = 0;
    for (const s of sheets) for (const row of s.rows) for (const c of row) if (asFormula(c)) count += 1;
    expect(count).toBeGreaterThan(100);
  });

  it('recalculates a fully populated model to the values it cached', () => {
    expect(describeAll(disagreements(workbook()))).toEqual([]);
  });

  it('recalculates a half-empty model to the values it cached', () => {
    // Where the interesting guards live: a YoY row with no prior period, a
    // per-unit row over zero customers, a subtotal missing one of its inputs.
    expect(describeAll(disagreements(workbook({ cells: SPARSE_CELLS })))).toEqual([]);
  });

  it('recalculates a workbook with no cap table and no grants', () => {
    expect(describeAll(disagreements(workbook({ capTable: null, grants: [] })))).toEqual([]);
  });

  it('recalculates the override and calculation sheets, which only appear when loaded', () => {
    // Both are optional inputs, so a fixture that omits them walks a workbook
    // two sheets short of the one an auditor is sent.
    const sheets = workbook({
      overwrites: [
        {
          category: 'discounts',
          field_key: 'dlom',
          class: 'common',
          value: 0.24,
          original_value: 0.31,
          reason: 'Analyst judgement on holding period',
          created_by: 'analyst@acme.test',
          updated_by: 'analyst@acme.test',
          updated_at: new Date('2026-03-01T10:00:00Z'),
        },
      ],
      calculation: {
        engine_version: '2026.7.1',
        status: 'succeeded',
        inputs: { volatility: 0.62, time_to_exit_years: 4 },
        results: { equity_value: 41_500_000, fmv_per_share: 1.42 },
        equity_value: 41_500_000,
        fmv_per_share: 1.42,
        diagnostics: [
          {
            code: 'DLOM_HIGH',
            field: 'dlom',
            message: 'Discount above the review threshold',
            severity: 'warning',
            hint: null,
          },
        ],
        created_at: new Date('2026-03-01T09:30:00Z'),
      },
    });
    expect(sheets.map((s) => s.name)).toEqual(
      expect.arrayContaining(['Overrides', 'Calculation', 'Summary']),
    );
    expect(describeAll(disagreements(sheets))).toEqual([]);
  });

  it('reaches no uncaught spreadsheet error on any of them', () => {
    // #DIV/0! in a file an auditor opens is a finding, not a rounding
    // difference, so it is called out separately from a value mismatch.
    for (const sheets of [workbook(), workbook({ cells: SPARSE_CELLS })]) {
      const errors = disagreements(sheets).filter((d) => d.recalculated.startsWith('#'));
      expect(errors.map((e) => `${e.ref}: ${e.recalculated}`)).toEqual([]);
    }
  });

  it('notices a reference that points one row off', () => {
    // The failure this exists for. Shifting a single reference by one row is
    // exactly what inserting a line into a sheet definition does, and the
    // resulting workbook opens and sums as though nothing were wrong.
    const sheets = workbook();
    const is = sheets.find((s) => s.name === 'Income statement')!;
    const broken = is.rows.map((row) =>
      row.map((cell) => {
        const f = asFormula(cell);
        return f ? { ...f, formula: f.formula.replace(/\bB4\b/g, 'B5') } : cell;
      }),
    );
    const found = disagreements([{ ...is, rows: broken }]);
    expect(found.length).toBeGreaterThan(0);
  });
});
