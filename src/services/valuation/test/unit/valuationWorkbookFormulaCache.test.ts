import { describe, expect, it } from 'vitest';
import {
  valuationWorkbookSheets,
  type ValuationWorkbookInput,
  type WorkbookGrant,
} from '../../src/export/valuationWorkbook.js';
import { validateCapTable, type CapTableEntry } from '../../src/domain/capTable.js';
import { WORKBOOK_SHEETS, type WorkbookCellInput } from '../../src/domain/workbook.js';
import type { XlsxSheet, XlsxValue } from '../../src/export/xlsx.js';

/**
 * A formula cell without a cached value is not the same thing as a total.
 *
 * `xlsx.ts` writes `<f>` and omits `<v>` when the cached value is not a finite
 * number, which is right when the formula's own answer is blank — a YoY row in
 * the first period, a percentage over a zero denominator. It is wrong when the
 * figure exists and simply was not passed: the file then opens with a blank
 * where a number belongs in every reader that shows the cached value rather
 * than recalculating, and Excel is not the only thing that opens these. The
 * grant schedule's vested and unvested totals shipped that way.
 *
 * The census below is the general form: on a workbook where every input is
 * populated, no formula anywhere may be cacheless. It is stated on a saturated
 * fixture on purpose — a blank input legitimately propagates blanks, so the
 * only fixture on which "every formula has an answer" is a true statement is
 * one with no missing inputs.
 */

const GENERATED_AT = new Date('2026-07-29T09:00:00Z');

/**
 * Every input cell of every model sheet, so nothing is blank for want of data.
 *
 * Values are walked off the sheet definitions rather than listed, so a row
 * added to the model is saturated by this fixture on the day it lands instead
 * of quietly re-opening the hole this test exists to close.
 */
function saturatedCells(): WorkbookCellInput[] {
  const out: WorkbookCellInput[] = [];
  let n = 0;
  for (const sheetDef of WORKBOOK_SHEETS) {
    for (const row of sheetDef.rows) {
      if (row.kind !== 'input') continue;
      for (const col of sheetDef.columns) {
        n += 1;
        // Distinct, strictly positive, and not so large that a ratio of two of
        // them rounds. Positive matters: `perUnit` rows are deliberately blank
        // over a non-positive denominator, and a saturated fixture must not
        // trip that or the census would excuse a real hole.
        const value = row.format === 'percent' ? 0.05 + n / 1000 : 1_000 * n + 250;
        out.push({ sheet: sheetDef.key, row_key: row.key, column_key: col.key, value });
      }
    }
  }
  return out;
}

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

function saturatedInput(overrides: Partial<ValuationWorkbookInput> = {}): ValuationWorkbookInput {
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
    cells: saturatedCells(),
    capTable: { entries: ENTRIES, validation: validateCapTable(ENTRIES) },
    grants: GRANTS,
    fmvPerShare: 1.42,
    generatedAt: GENERATED_AT,
    ...overrides,
  };
}

interface FormulaSite {
  sheet: string;
  /** Spreadsheet row number, so a failure names the cell an auditor would click. */
  ref: string;
  label: string;
  formula: string;
  value: number | null | undefined;
}

function unwrap(cell: XlsxValue): XlsxValue {
  return typeof cell === 'object' && cell !== null && !(cell instanceof Date) && 'format' in cell
    ? (cell as { value: XlsxValue }).value
    : cell;
}

const COLUMN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function formulaSites(sheets: XlsxSheet[]): FormulaSite[] {
  const out: FormulaSite[] = [];
  for (const s of sheets) {
    const firstDataRow = (s.titleLines?.length ?? 0) + 2;
    s.rows.forEach((row, rowIndex) => {
      row.forEach((raw, colIndex) => {
        const cell = unwrap(raw);
        if (typeof cell !== 'object' || cell === null || cell instanceof Date) return;
        if (!('formula' in cell)) return;
        out.push({
          sheet: s.name,
          ref: `${COLUMN_LETTERS[colIndex] ?? `?${colIndex}`}${firstDataRow + rowIndex}`,
          label: String(unwrap(row[0]) ?? ''),
          formula: cell.formula,
          value: cell.value,
        });
      });
    });
  }
  return out;
}

const cacheless = (sites: FormulaSite[]): FormulaSite[] =>
  sites.filter((f) => typeof f.value !== 'number' || !Number.isFinite(f.value));

/**
 * Cells whose formula is live but whose answer is blank even here, each with
 * the reason it cannot be saturated.
 *
 * Excuses are checked in both directions below. An excuse listed for a cell
 * that does have a value fails, so this register cannot outlive the reason it
 * was written; and every excuse must name a cell the workbook actually emits a
 * formula into, so a row that moves does not leave a silent exemption behind.
 */
const EXCUSED: ReadonlyMap<string, string> = new Map([
  [
    'Operating metrics!B12',
    // Burn multiple divides by net new ARR, and net new ARR is the change from
    // the prior period. The first column has no prior period, so its
    // denominator is blank for a structural reason no input can fix. The
    // formula is still emitted — the cell above it is writable, and an auditor
    // who fills it in gets a burn multiple rather than a frozen dash.
    'net new ARR has no prior period in the first column',
  ],
]);

describe('every workbook formula ships the answer it computed', () => {
  it('finds formulas to check at all', () => {
    // Guards the census against passing by having nothing left to ask: a
    // refactor that stopped emitting formulas would otherwise read as green.
    const sites = formulaSites(valuationWorkbookSheets(saturatedInput()));
    expect(sites.length).toBeGreaterThan(30);
    expect(new Set(sites.map((f) => f.sheet)).size).toBeGreaterThanOrEqual(4);
  });

  it('caches a finite value in every one of them', () => {
    const sites = formulaSites(valuationWorkbookSheets(saturatedInput()));
    const missing = cacheless(sites)
      .filter((f) => !EXCUSED.has(`${f.sheet}!${f.ref}`))
      .map((f) => `${f.sheet}!${f.ref} (${f.label}) = ${f.formula}`);
    expect(missing).toEqual([]);
  });

  it('keeps the excuse register honest in both directions', () => {
    const sites = formulaSites(valuationWorkbookSheets(saturatedInput()));
    const byRef = new Map(sites.map((f) => [`${f.sheet}!${f.ref}`, f]));

    for (const [ref, reason] of EXCUSED) {
      const site = byRef.get(ref);
      expect(site, `excused ${ref} (${reason}) is not a formula cell any more`).toBeDefined();
      // Stale the moment the cell learns its answer: the excuse says the value
      // cannot exist, so a value existing means the excuse is the thing to
      // delete, not the assertion to relax.
      expect(cacheless([site!]).length, `excused ${ref} (${reason}) now caches ${String(site!.value)}`).toBe(
        1,
      );
    }
  });

  it('totals the vested and unvested columns rather than leaving them blank', () => {
    const sheets = valuationWorkbookSheets(saturatedInput());
    const grants = sheets.find((s) => s.name === 'Grants')!;
    const total = grants.rows[grants.rows.length - 1]!;
    expect(total[0]).toBe('Total (active grants)');

    const vested = total[10] as { formula: string; value: number };
    const unvested = total[11] as { formula: string; value: number };
    // `SUMIF` over the Status column, not `SUM` over the whole one: cancelled
    // grants are printed and not counted (R296). Both grants in this fixture
    // are active, so the arithmetic below is unchanged by that.
    expect(vested.formula).toMatch(/^SUMIF\(\$N\$\d+:\$N\$\d+,"active",K\d+:K\d+\)$/);
    expect(unvested.formula).toMatch(/^SUMIF\(\$N\$\d+:\$N\$\d+,"active",L\d+:L\d+\)$/);

    // The two totals answer to the same 165,000 options column D totals, which
    // is the arithmetic an auditor does by eye and the reason a blank here is
    // worse than a wrong number: it reads as "no options", not as "not shown".
    expect(vested.value + unvested.value).toBe(165_000);
    expect(vested.value).toBeGreaterThan(0);
    expect(unvested.value).toBeGreaterThan(0);
  });

  it('still leaves a formula blank when its own answer is blank', () => {
    // The converse, so the fix above cannot be "cache something, anything".
    // A grant of zero options divides by zero; `IFERROR` yields "" and the
    // cached value must stay absent rather than become a confident 0%.
    const sheets = valuationWorkbookSheets(saturatedInput({ grants: [{ ...GRANTS[0]!, options_count: 0 }] }));
    const grants = sheets.find((s) => s.name === 'Grants')!;
    const percentVested = grants.rows[0]![12] as { formula: string; value: number | null };
    expect(percentVested.formula).toMatch(/^IFERROR\(K\d+\/D\d+,""\)$/);
    expect(percentVested.value).toBeNull();
  });
});
