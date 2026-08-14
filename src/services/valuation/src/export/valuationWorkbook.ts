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
import {
  asConvertedShares,
  fullyDilutedShares,
  investedAmount,
  toWaterfallInputs,
  type CapTableEntry,
  type CapTableValidation,
} from '../domain/capTable.js';
import { OVERWRITE_FIELDS_BY_KEY } from '../domain/overwrites.js';
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

/** The manual-override register, as the repo stores it. */
export interface WorkbookOverwrite {
  category: string;
  field_key: string;
  class: string;
  value: unknown;
  /** The pre-override engine/AI value, frozen on the first write. */
  original_value: unknown;
  reason: string | null;
  created_by: string | null;
  updated_by: string | null;
  updated_at: Date | string | null;
}

/** The calculation run an auditor is tying to. */
export interface WorkbookCalculation {
  engine_version: string;
  status: string;
  inputs: Record<string, unknown> | null;
  results: Record<string, unknown> | null;
  equity_value: string | number | null;
  fmv_per_share: string | number | null;
  diagnostics: readonly {
    code: string;
    field: string;
    message: string;
    severity: string;
    hint: string | null;
  }[];
  created_at: Date | string | null;
}

export interface ValuationWorkbookInput {
  valuation: WorkbookValuation;
  cells: readonly WorkbookCellInput[];
  capTable: { entries: CapTableEntry[]; validation: CapTableValidation } | null;
  grants: readonly WorkbookGrant[];
  /** Concluded FMV per share, when the valuation has one. Drives the waterfall. */
  fmvPerShare: number | null;
  generatedAt: Date;
  /** Manual overrides. Absent (rather than empty) when not loaded. */
  overwrites?: readonly WorkbookOverwrite[];
  /** The latest succeeded run. Null when the valuation has never calculated. */
  calculation?: WorkbookCalculation | null;
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

/**
 * A preferred class's invested capital as every other consumer derives it, or
 * blank.
 *
 * Blank rather than zero for a row that states neither an amount nor a price:
 * that is `validateCapTable`'s `no_investment` warning, and a `0` in a currency
 * column reads as a measured figure rather than a missing one. Non-preferred
 * rows are blank for the same reason `capTableTotals` counts none of them.
 */
function preferredInvested(entry: CapTableEntry): number | null {
  if (entry.class_type !== 'preferred') return entry.invested_amount;
  return investedAmount(entry) || null;
}

function capTableSheet(entries: CapTableEntry[], currency: string): XlsxSheet {
  const columns: XlsxColumn[] = [
    { header: 'Security class', width: 28, format: 'text' },
    { header: 'Type', width: 12, format: 'text' },
    { header: 'Shares', width: 16, format: 'integer' },
    { header: `Price per share (${currency})`, width: 18, format: 'currency' },
    { header: `Invested (${currency})`, width: 18, format: 'currency' },
    { header: 'Liquidation multiple', width: 18, format: 'number' },
    { header: 'Seniority', width: 11, format: 'integer' },
    { header: 'Conversion ratio', width: 16, format: 'number' },
    /*
     * The as-converted count, shown rather than folded into the percentage.
     *
     * Ownership used to be `shares / SUM(shares)`, which counts a preferred
     * class 1:1 no matter what sits in the Conversion ratio column beside it —
     * so on any table with a ratchet the column disagreed with the engine's
     * denominator, and with this same workbook's Waterfall sheet, which has
     * carried an as-converted column all along. Making the conversion its own
     * column means the reader can see the step rather than having to trust that
     * the percentage did it, which is the point of shipping a workbook.
     */
    { header: 'As-converted shares', width: 20, format: 'integer' },
    { header: '% fully diluted', width: 16, format: 'percent' },
  ];

  // Recomputed from the entries this sheet prints rather than read off the
  // stored summary, so the cached values agree with the formulas beside them
  // even for a cap table persisted by a build that summed shares 1:1.
  const fd = fullyDilutedShares(entries);
  const firstDataRow = firstDataRowFor([]);
  const lastDataRow = firstDataRow + entries.length - 1;
  const totalRow = lastDataRow + 1;

  const rows: XlsxValue[][] = entries.map((e, i) => {
    const r = firstDataRow + i;
    const sharesRef = cellRef(2, r);
    const ratioRef = cellRef(7, r);
    const converted = asConvertedShares(e);
    return [
      e.security_class,
      e.class_type,
      e.shares,
      e.price_per_share,
      // What the class paid in, on the same fallback the engine feed and the
      // Cap table *tab* use: a blank amount column beside a stated price is
      // `price × shares`. The raw cell left this column empty on the ordinary
      // Carta export while the Waterfall sheet — two tabs along, in the same
      // file, off `toWaterfallInputs` — printed the derived figure and totalled
      // it, so one workbook stated two different invested-capital totals for
      // one cap table. Preferred only, matching `capTableTotals`: invested
      // capital is a preference-stack figure, and founders' common issued at
      // $0.0001 has not "invested" its issue value.
      preferredInvested(e),
      e.liquidation_multiple,
      e.seniority,
      e.conversion_ratio,
      // Only preferred converts, so only preferred reads the ratio cell — the
      // same rule the engine applies. A blank or non-positive ratio is 1:1,
      // matching `asConvertedShares`, so an edited sheet recomputes to what the
      // service would have sent.
      e.class_type === 'preferred'
        ? {
            formula: `${sharesRef}*IF(AND(ISNUMBER(${ratioRef}),${ratioRef}>0),${ratioRef},1)`,
            value: converted,
          }
        : { formula: sharesRef, value: converted },
      // Live against the total row below, so editing a share count or a ratio
      // reflows the ownership column.
      fd > 0 ? { formula: `IFERROR(${cellRef(8, r)}/$I$${totalRow},"")`, value: converted / fd } : null,
    ];
  });

  if (entries.length > 0) {
    rows.push([
      'Total (fully diluted)',
      null,
      {
        formula: `SUM(C${firstDataRow}:C${lastDataRow})`,
        value: entries.reduce((sum, e) => sum + (Number.isFinite(e.shares) ? e.shares : 0), 0),
      },
      null,
      {
        formula: `SUM(E${firstDataRow}:E${lastDataRow})`,
        value: entries.reduce((sum, e) => sum + (preferredInvested(e) ?? 0), 0),
      },
      null,
      null,
      null,
      { formula: `SUM(I${firstDataRow}:I${lastDataRow})`, value: fd },
      fd > 0 ? { formula: `SUM(J${firstDataRow}:J${lastDataRow})`, value: 1 } : null,
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

/** One leaf of a flattened JSON document, addressed by its dotted path. */
export interface FlatEntry {
  path: string;
  value: XlsxValue;
}

/**
 * Nesting past this is treated as an opaque leaf and stringified. The engine's
 * payloads are shallow; the cap exists so a malformed or self-referential blob
 * cannot turn one export into an unbounded sheet.
 */
const MAX_FLATTEN_DEPTH = 8;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

/**
 * Flattens an engine payload into one row per leaf, addressed by dotted path.
 *
 * Sorted by path rather than left in key order: auditors diff this year's
 * workbook against last year's, and a stable order is what makes that diff mean
 * "the assumption changed" instead of "the engine reordered its JSON".
 *
 * Arrays of scalars collapse to a single joined cell — a list of comparable
 * tickers reads better on one row than on nine. Arrays of objects keep indexed
 * paths, because their elements are records that deserve their own rows.
 */
export function flattenForAudit(source: Record<string, unknown> | null | undefined): FlatEntry[] {
  const out: FlatEntry[] = [];

  const walk = (value: unknown, path: string, depth: number): void => {
    if (value === null || value === undefined) {
      out.push({ path, value: null });
      return;
    }
    if (depth >= MAX_FLATTEN_DEPTH) {
      out.push({ path, value: JSON.stringify(value) ?? String(value) });
      return;
    }
    if (value instanceof Date) {
      out.push({ path, value });
      return;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        out.push({ path, value: null });
        return;
      }
      if (value.every((v) => !isPlainObject(v) && !Array.isArray(v))) {
        out.push({
          path,
          value: value.map((v) => (v === null || v === undefined ? '' : String(v))).join('; '),
        });
        return;
      }
      value.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      return;
    }
    if (isPlainObject(value)) {
      const keys = Object.keys(value);
      if (keys.length === 0) {
        out.push({ path, value: null });
        return;
      }
      for (const key of keys) walk(value[key], path ? `${path}.${key}` : key, depth + 1);
      return;
    }
    if (typeof value === 'number') {
      out.push({ path, value: Number.isFinite(value) ? value : String(value) });
      return;
    }
    if (typeof value === 'string' || typeof value === 'boolean') {
      out.push({ path, value });
      return;
    }
    out.push({ path, value: String(value) });
  };

  walk(source ?? {}, '', 0);
  // The empty-object case walks to a single pathless row; drop it rather than
  // emitting a blank line that reads as a missing assumption.
  return out.filter((e) => e.path !== '').sort((a, b) => a.path.localeCompare(b.path));
}

/** Renders an override value for a cell — these are user-supplied and untyped. */
function overwriteCell(value: unknown): XlsxValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  return JSON.stringify(value) ?? String(value);
}

/**
 * Assumptions: every input the engine consumed on the run being tied to, with
 * the manually-overridden ones called out.
 *
 * The "Source" column is the point of the sheet. An auditor's first question
 * about any assumption is whether a human set it, and answering that from the
 * override register alone means cross-referencing two tabs by hand.
 */
function assumptionsSheet(
  calculation: WorkbookCalculation,
  overwrites: readonly WorkbookOverwrite[],
): XlsxSheet {
  const entries = flattenForAudit(calculation.inputs);

  // An override on `discount_rate` should mark the input at `discount_rate` and
  // also one nested at `valuation_params.discount_rate`, so match on the last
  // path segment as well as the whole path.
  const overriddenKeys = new Set(overwrites.map((o) => o.field_key));
  const isOverridden = (path: string): boolean =>
    overriddenKeys.has(path) || overriddenKeys.has(path.split('.').pop() ?? path);

  const titleLines = [
    'Assumptions consumed by the calculation being tied to.',
    `Engine ${calculation.engine_version} · run ${asDate(calculation.created_at)?.toISOString() ?? 'unknown'}`,
  ];

  return {
    // Not "Assumptions" — the model already has a tab by that name, and two
    // near-identical tabs is worse than a longer one. This is the full register
    // of what the engine consumed; that one is the methodology inputs.
    name: 'Assumption register',
    titleLines,
    columns: [
      { header: 'Assumption', width: 46, format: 'text' },
      { header: 'Value', width: 30, format: 'number' },
      { header: 'Source', width: 18, format: 'text' },
    ],
    rows: entries.map((e) => [e.path, e.value, isOverridden(e.path) ? 'manual override' : 'engine']),
  };
}

/**
 * The override register: what a human changed, from what, and why.
 *
 * `original_value` is the frozen pre-override value, so the before/after pair
 * on each row is the whole evidentiary point — an override without its prior
 * value is an assertion rather than a record.
 */
function overridesSheet(overwrites: readonly WorkbookOverwrite[]): XlsxSheet {
  const rows: XlsxValue[][] = overwrites
    .map((o) => {
      const def = OVERWRITE_FIELDS_BY_KEY.get(o.field_key);
      return {
        category: o.category,
        label: def?.label ?? o.field_key,
        key: o.field_key,
        row: [
          o.category,
          def?.label ?? o.field_key,
          o.field_key,
          overwriteCell(o.original_value),
          overwriteCell(o.value),
          o.reason,
          o.updated_by ?? o.created_by,
          asDate(o.updated_at),
        ] as XlsxValue[],
      };
    })
    .sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label))
    .map((o) => o.row);

  return {
    name: 'Overrides',
    titleLines: [
      'Every value an analyst set by hand, with the engine value it replaced.',
      'An empty sheet means the model ran entirely on engine-derived inputs.',
    ],
    columns: [
      { header: 'Category', width: 20, format: 'text' },
      { header: 'Field', width: 32, format: 'text' },
      { header: 'Field key', width: 26, format: 'text' },
      { header: 'Engine value', width: 20, format: 'number' },
      { header: 'Applied value', width: 20, format: 'number' },
      { header: 'Reason', width: 44, format: 'text' },
      { header: 'Set by', width: 28, format: 'text' },
      { header: 'Set at', width: 20, format: 'date' },
    ],
    rows,
  };
}

/**
 * The calculation record: provenance, what it concluded, the full result
 * payload, and any diagnostics the analyst proceeded past.
 *
 * The diagnostics matter as much as the numbers. A successful run can still
 * carry review warnings, and a workbook that shows only the conclusion hides
 * exactly the thing an auditor is looking for.
 */
function calculationSheet(calculation: WorkbookCalculation, currency: string): XlsxSheet {
  const rows: XlsxValue[][] = [
    ['Engine version', calculation.engine_version],
    ['Status', calculation.status],
    ['Run at', asDate(calculation.created_at)],
    [`Concluded equity value (${currency})`, num(calculation.equity_value)],
    [`Concluded FMV per share (${currency})`, num(calculation.fmv_per_share)],
  ];

  const results = flattenForAudit(calculation.results);
  if (results.length > 0) {
    rows.push([], ['Results', '']);
    for (const r of results) rows.push([r.path, r.value]);
  }

  if (calculation.diagnostics.length > 0) {
    rows.push([], ['Diagnostics', '']);
    for (const d of calculation.diagnostics) {
      rows.push([`${d.severity}: ${d.field || d.code}`, [d.message, d.hint].filter(Boolean).join(' — ')]);
    }
  }

  return {
    name: 'Calculation',
    titleLines: ['The calculation run this workbook was generated from.'],
    columns: [
      { header: 'Field', width: 46, format: 'text' },
      { header: 'Value', width: 40, format: 'number' },
    ],
    rows,
  };
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
      // Same recomputation as the Cap table sheet, and for the same reason —
      // the two sit in one file and must not print different denominators.
      // `findCapTable` re-derives the whole summary on read, so the stale rows
      // this was written for no longer reach here; it stays because this is a
      // pure function over whatever validation it is handed, and the one place
      // both figures are rendered side by side is the one place a disagreement
      // is visible to the reader as arithmetic that does not add up.
      ['Fully diluted shares', fullyDilutedShares(input.capTable.entries)],
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

  const overwrites = input.overwrites ?? [];

  // Assumptions and the calculation record sit directly behind the cover, ahead
  // of the model: an auditor reads what was assumed before what it produced.
  if (input.calculation) {
    sheets.push(
      assumptionsSheet(input.calculation, overwrites),
      calculationSheet(input.calculation, input.valuation.currency),
    );
  }

  // Unlike the other optional sheets this one is emitted even when empty — for
  // an override register, "nothing was overridden" is a finding, not a blank.
  if (input.overwrites) sheets.push(overridesSheet(overwrites));

  for (const computed of computeWorkbook(input.cells)) {
    sheets.push(modelSheet(computed, input.valuation.currency));
  }

  if (input.capTable && input.capTable.entries.length > 0) {
    sheets.push(
      capTableSheet(input.capTable.entries, input.valuation.currency),
      waterfallSheet(input.capTable.entries, input.valuation.currency, input.fmvPerShare),
    );
  }

  if (input.grants.length > 0) {
    sheets.push(grantsSheet(input.grants, input.generatedAt, input.valuation.currency));
  }

  return sheets;
}
