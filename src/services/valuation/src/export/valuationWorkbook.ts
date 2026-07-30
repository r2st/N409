/**
 * Projects a valuation into the multi-sheet auditor workbook
 * (feature-improvements §4: "Workbook, cap table, waterfall and grant schedules
 * as a formatted multi-sheet workbook with live formulas where sensible").
 *
 * Pure: every input is already-loaded domain data, so the whole projection is
 * unit-testable without a database. The route below does the I/O.
 *
 * The model sheets carry real formulas rather than frozen numbers — an auditor
 * who changes revenue should see gross profit move, which is the difference
 * between shipping a model and shipping a screenshot of one. Derived rows are
 * marked so the reader can see at a glance which cells are inputs.
 */

import {
  WORKBOOK_SHEETS,
  computeWorkbook,
  type ComputedSheet,
  type FormulaCtx,
  type WorkbookCellInput,
} from '../domain/workbook.js';
import { toWaterfallInputs, type CapTableEntry, type CapTableValidation } from '../domain/capTable.js';
import { toIsoDate, vestingStatus } from '../domain/vesting.js';
import { cellRef, type XlsxColumn, type XlsxSheet, type XlsxValue } from './xlsx.js';

/** Only what the workbook needs — keeps the signature honest about its inputs. */
export interface WorkbookValuation {
  number: string;
  company_name: string;
  kind: string;
  state: string;
  currency: string;
  created_at: Date | string | null;
  published_at: Date | string | null;
}

export interface WorkbookGrant {
  grantee_name: string;
  grantee_email: string | null;
  grant_date: string | Date;
  options_count: number;
  exercise_price: string | number;
  currency: string;
  vesting_template: string;
  vesting_start_date: string | Date;
  vesting_months: number;
  cliff_months: number;
  frequency_months: number;
  status: string;
}

export interface ValuationWorkbookInput {
  valuation: WorkbookValuation;
  cells: readonly WorkbookCellInput[];
  capTable: { entries: CapTableEntry[]; validation: CapTableValidation } | null;
  grants: readonly WorkbookGrant[];
  /** Concluded FMV per share, when the valuation has one. Drives the waterfall. */
  fmvPerShare: number | null;
  generatedAt: Date;
}

function asDate(value: Date | string | null): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Spreadsheet row number of a sheet's first data row: the title lines, then the
 * header, then data. Every formula on every sheet is written against this, so it
 * is derived from the title lines rather than hardcoded — a sheet that gains a
 * title line would otherwise keep pointing its formulas at the header text, and
 * the numbers would still look plausible.
 */
function firstDataRowFor(titleLines: readonly string[]): number {
  return titleLines.length + 2;
}

/**
 * A model sheet: one row per line item, one column per period, plus a leading
 * label column and a trailing input/derived marker.
 */
function modelSheet(computed: ComputedSheet, currency: string): XlsxSheet {
  const def = WORKBOOK_SHEETS.find((s) => s.key === computed.key);
  const titleLines = [computed.label, computed.description];
  const firstDataRow = firstDataRowFor(titleLines);

  const columns: XlsxColumn[] = [
    { header: 'Line item', width: 34, format: 'text' },
    ...computed.columns.map((c) => ({ header: c.label, width: 16, format: 'number' as const })),
    { header: 'Type', width: 10, format: 'text' },
  ];

  const rowNumberOf = new Map(computed.rows.map((r, i) => [r.key, i + firstDataRow]));

  const rows: XlsxValue[][] = computed.rows.map((row, rowIdx) => {
    const rowDef = def?.rows.find((r) => r.key === row.key);
    const out: XlsxValue[] = [row.label];
    const ownRow = rowIdx + firstDataRow;

    row.cells.forEach((cell, colIdx) => {
      // Column 0 is the label, so period columns start at spreadsheet column B.
      const sheetCol = colIdx + 1;
      if (row.kind === 'derived' && rowDef?.excel) {
        const ctx: FormulaCtx = {
          cell: (rowKey) => cellRef(sheetCol, rowNumberOf.get(rowKey) ?? ownRow),
          prev: (rowKey) => (colIdx === 0 ? null : cellRef(sheetCol - 1, rowNumberOf.get(rowKey) ?? ownRow)),
        };
        const formula = rowDef.excel(ctx);
        // A null formula means the rule does not apply in this column (the first
        // period of a year-over-year row); the computed value stands alone.
        out.push(formula === null ? cell.value : { formula, value: cell.value });
      } else {
        out.push(cell.value);
      }
    });

    out.push(row.kind === 'derived' ? 'formula' : 'input');
    return out;
  });

  // Percent and currency rows share one column, so the per-column format cannot
  // express both. The label column carries the unit instead, and the numeric
  // columns stay on the plain number format.
  const labelled = rows.map((row, i) => {
    const format = computed.rows[i]?.format;
    if (format === 'percent') row[0] = `${String(row[0])} (%)`;
    else if (format === 'currency') row[0] = `${String(row[0])} (${currency})`;
    return row;
  });

  return { name: computed.label, titleLines, columns, rows: labelled };
}

function capTableSheet(
  entries: CapTableEntry[],
  validation: CapTableValidation,
  currency: string,
): XlsxSheet {
  const columns: XlsxColumn[] = [
    { header: 'Security class', width: 28, format: 'text' },
    { header: 'Type', width: 12, format: 'text' },
    { header: 'Shares', width: 16, format: 'integer' },
    { header: `Price per share (${currency})`, width: 18, format: 'currency' },
    { header: `Invested (${currency})`, width: 18, format: 'currency' },
    { header: 'Liquidation multiple', width: 18, format: 'number' },
    { header: 'Seniority', width: 11, format: 'integer' },
    { header: 'Conversion ratio', width: 16, format: 'number' },
    { header: '% fully diluted', width: 16, format: 'percent' },
  ];

  const fd = validation.summary.fully_diluted_shares;
  const firstDataRow = firstDataRowFor([]);
  const lastDataRow = firstDataRow + entries.length - 1;

  const rows: XlsxValue[][] = entries.map((e, i) => {
    const r = firstDataRow + i;
    const sharesRef = cellRef(2, r);
    return [
      e.security_class,
      e.class_type,
      e.shares,
      e.price_per_share,
      e.invested_amount,
      e.liquidation_multiple,
      e.seniority,
      e.conversion_ratio,
      // Live against the total row below, so editing a share count reflows the
      // ownership column.
      fd > 0 ? { formula: `IFERROR(${sharesRef}/$C$${lastDataRow + 1},"")`, value: e.shares / fd } : null,
    ];
  });

  if (entries.length > 0) {
    rows.push([
      'Total (fully diluted)',
      null,
      { formula: `SUM(C${firstDataRow}:C${lastDataRow})`, value: fd },
      null,
      {
        formula: `SUM(E${firstDataRow}:E${lastDataRow})`,
        value: entries.reduce((sum, e) => sum + (e.invested_amount ?? 0), 0),
      },
      null,
      null,
      null,
      fd > 0 ? { formula: `SUM(I${firstDataRow}:I${lastDataRow})`, value: 1 } : null,
    ]);
  }

  return { name: 'Cap table', columns, rows };
}

/**
 * The preference stack in seniority order — the input to any liquidation
 * analysis, and the sheet an auditor reaches for first.
 */
function waterfallSheet(entries: CapTableEntry[], currency: string, fmvPerShare: number | null): XlsxSheet {
  const inputs = toWaterfallInputs(entries);
  const bySeniority = [...inputs.preferred].sort((a, b) => a.seniority - b.seniority);

  const titleLines = [
    'Preference stack in seniority order',
    'Preference = invested × liquidation multiple. Residual proceeds are shared across common, warrants and the option pool.',
  ];
  const firstDataRow = firstDataRowFor(titleLines);

  const columns: XlsxColumn[] = [
    { header: 'Seniority', width: 11, format: 'integer' },
    { header: 'Security class', width: 28, format: 'text' },
    { header: 'Shares', width: 16, format: 'integer' },
    { header: `Invested (${currency})`, width: 18, format: 'currency' },
    { header: 'Liquidation multiple', width: 18, format: 'number' },
    { header: `Preference (${currency})`, width: 20, format: 'currency' },
    { header: 'Conversion ratio', width: 16, format: 'number' },
    { header: 'As-converted shares', width: 20, format: 'integer' },
  ];

  const rows: XlsxValue[][] = bySeniority.map((p, i) => {
    const r = firstDataRow + i;
    return [
      p.seniority,
      p.security_class,
      p.shares,
      p.invested_amount,
      p.liquidation_multiple,
      { formula: `D${r}*E${r}`, value: p.invested_amount * p.liquidation_multiple },
      p.conversion_ratio,
      { formula: `C${r}*G${r}`, value: p.shares * p.conversion_ratio },
    ];
  });

  const lastPreferredRow = firstDataRow + bySeniority.length - 1;
  if (bySeniority.length > 0) {
    rows.push([
      null,
      'Total preference stack',
      {
        formula: `SUM(C${firstDataRow}:C${lastPreferredRow})`,
        value: bySeniority.reduce((s, p) => s + p.shares, 0),
      },
      {
        formula: `SUM(D${firstDataRow}:D${lastPreferredRow})`,
        value: bySeniority.reduce((s, p) => s + p.invested_amount, 0),
      },
      null,
      {
        formula: `SUM(F${firstDataRow}:F${lastPreferredRow})`,
        value: bySeniority.reduce((s, p) => s + p.invested_amount * p.liquidation_multiple, 0),
      },
      null,
      {
        formula: `SUM(H${firstDataRow}:H${lastPreferredRow})`,
        value: bySeniority.reduce((s, p) => s + p.shares * p.conversion_ratio, 0),
      },
    ]);
  }

  // Common and the option pool sit below the stack: they are what the residual
  // is shared across, not part of the preference itself.
  rows.push([]);
  rows.push([null, 'Common (incl. warrants)', inputs.common_shares]);
  rows.push([null, 'Option pool', inputs.option_pool_shares]);
  if (fmvPerShare !== null) {
    rows.push([]);
    rows.push([null, `Concluded FMV per share (${currency})`, null, fmvPerShare]);
  }

  return { name: 'Waterfall', titleLines, columns, rows };
}

/** One row per grant, with vesting resolved as of the export date. */
function grantsSheet(grants: readonly WorkbookGrant[], asOf: Date, currency: string): XlsxSheet {
  const titleLines = [`Grant schedule — vesting resolved as of ${asOf.toISOString().slice(0, 10)}`];
  const firstDataRow = firstDataRowFor(titleLines);

  const columns: XlsxColumn[] = [
    { header: 'Grantee', width: 26, format: 'text' },
    { header: 'Email', width: 26, format: 'text' },
    { header: 'Grant date', width: 13, format: 'date' },
    { header: 'Options', width: 14, format: 'integer' },
    { header: `Exercise price (${currency})`, width: 18, format: 'currency' },
    { header: 'Vesting template', width: 18, format: 'text' },
    { header: 'Vesting start', width: 13, format: 'date' },
    { header: 'Term (months)', width: 14, format: 'integer' },
    { header: 'Cliff (months)', width: 14, format: 'integer' },
    { header: 'Cadence (months)', width: 16, format: 'integer' },
    { header: 'Vested', width: 14, format: 'integer' },
    { header: 'Unvested', width: 14, format: 'integer' },
    { header: '% vested', width: 12, format: 'percent' },
    { header: 'Status', width: 11, format: 'text' },
  ];

  const rows: XlsxValue[][] = grants.map((g, i) => {
    const status = vestingStatus(
      {
        totalShares: g.options_count,
        vestingStartDate: g.vesting_start_date,
        vestingMonths: g.vesting_months,
        cliffMonths: g.cliff_months,
        frequencyMonths: g.frequency_months,
      },
      asOf,
    );
    const r = firstDataRow + i;
    return [
      g.grantee_name,
      g.grantee_email,
      asDate(toIsoDate(g.grant_date)),
      g.options_count,
      num(g.exercise_price),
      g.vesting_template,
      asDate(toIsoDate(g.vesting_start_date)),
      g.vesting_months,
      g.cliff_months,
      g.frequency_months,
      status.vestedShares,
      // Unvested and % vested follow from the vested count, so they recompute if
      // an auditor overrides it.
      { formula: `D${r}-K${r}`, value: status.unvestedShares },
      {
        formula: `IFERROR(K${r}/D${r},"")`,
        value: status.totalShares > 0 ? status.vestedShares / status.totalShares : null,
      },
      g.status,
    ];
  });

  if (grants.length > 0) {
    const last = firstDataRow + grants.length - 1;
    rows.push([
      'Total',
      null,
      null,
      { formula: `SUM(D${firstDataRow}:D${last})`, value: grants.reduce((s, g) => s + g.options_count, 0) },
      null,
      null,
      null,
      null,
      null,
      null,
      { formula: `SUM(K${firstDataRow}:K${last})`, value: null },
      { formula: `SUM(L${firstDataRow}:L${last})`, value: null },
      null,
      null,
    ]);
  }

  return { name: 'Grants', titleLines, columns, rows };
}

/** Cover sheet: what this file is, and what it was generated from. */
function summarySheet(input: ValuationWorkbookInput): XlsxSheet {
  const { valuation: v } = input;
  const rows: XlsxValue[][] = [
    ['Valuation number', v.number],
    ['Company', v.company_name],
    ['Product', v.kind],
    ['State', v.state],
    ['Currency', v.currency],
    ['Created', asDate(v.created_at)],
    ['Published', asDate(v.published_at)],
    ['Concluded FMV per share', input.fmvPerShare],
    ['Generated at', input.generatedAt],
  ];

  if (input.capTable) {
    const s = input.capTable.validation.summary;
    rows.push(
      [],
      ['Cap table', ''],
      ['Security classes', s.class_count],
      ['Fully diluted shares', s.fully_diluted_shares],
      ['Common shares', s.common_shares],
      ['Preferred shares', s.preferred_shares],
      ['Option pool shares', s.option_shares],
      ['Warrant shares', s.warrant_shares],
      ['Total preference stack', s.total_preference_stack],
    );
  }

  rows.push([], ['Grants', ''], ['Grant records', input.grants.length]);

  return {
    name: 'Summary',
    titleLines: [`${v.company_name} — ${v.number}`, 'Generated by N409. Derived cells are live formulas.'],
    columns: [
      { header: 'Field', width: 30, format: 'text' },
      { header: 'Value', width: 34, format: 'number' },
    ],
    rows,
  };
}

/**
 * Assembles the sheet list: summary, the model sheets, then cap table,
 * waterfall and grants when the valuation has them. Sheets are omitted rather
 * than emitted empty — a blank "Waterfall" tab reads as a bug.
 */
export function valuationWorkbookSheets(input: ValuationWorkbookInput): XlsxSheet[] {
  const sheets: XlsxSheet[] = [summarySheet(input)];

  for (const computed of computeWorkbook(input.cells)) {
    sheets.push(modelSheet(computed, input.valuation.currency));
  }

  if (input.capTable && input.capTable.entries.length > 0) {
    sheets.push(
      capTableSheet(input.capTable.entries, input.capTable.validation, input.valuation.currency),
      waterfallSheet(input.capTable.entries, input.valuation.currency, input.fmvPerShare),
    );
  }

  if (input.grants.length > 0) {
    sheets.push(grantsSheet(input.grants, input.generatedAt, input.valuation.currency));
  }

  return sheets;
}
