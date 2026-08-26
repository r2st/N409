/**
 * Cap-table import, validation and waterfall feed (feature 9). Pure functions —
 * no I/O — so CSV parsing, column mapping, validation and the engine-input
 * projection are all unit-testable. The route layer persists the result.
 */

export const CAP_TABLE_EVENT_TYPES = {
  imported: 'cap_table_imported',
} as const;

export type CapTableClassType = 'common' | 'preferred' | 'option' | 'warrant';

export interface CapTableEntry {
  /**
   * The line this entry came from in the uploaded sheet, 1-based and counting
   * the header — so it is the row number the importer sees in Excel, not an
   * index into `entries`.
   *
   * Those are not the same number and that is the whole reason this field
   * exists: `parseCapTable` drops blank and totals rows, so by the time an
   * issue is raised the position in `entries` has already slipped past the
   * source. A validation message that said "the third row" would point at the
   * wrong line on any real export.
   *
   * Optional because not every entry has one: the hand-entry path builds
   * entries from a form, where "which row of the file" is not a question with
   * an answer. Issues on those keep their class name and no row.
   */
  source_row?: number;
  security_class: string;
  class_type: CapTableClassType;
  shares: number;
  price_per_share: number | null;
  invested_amount: number | null;
  liquidation_multiple: number | null;
  seniority: number | null;
  conversion_ratio: number | null;
}

/** Canonical fields the importer maps source columns onto. */
export const CAP_TABLE_FIELDS = [
  'security_class',
  'class_type',
  'shares',
  'price_per_share',
  'invested_amount',
  'liquidation_multiple',
  'seniority',
  'conversion_ratio',
] as const;
export type CapTableField = (typeof CAP_TABLE_FIELDS)[number];

export type ColumnMapping = Partial<Record<CapTableField, string>>;

export interface FormatPreset {
  key: string;
  label: string;
  mapping: ColumnMapping;
}

/**
 * Column-name presets for common cap-table exports. Matched case-insensitively
 * and trimmed; unmatched columns fall back to the user-supplied mapping.
 */
export const FORMAT_PRESETS: readonly FormatPreset[] = [
  {
    key: 'carta',
    label: 'Carta export',
    mapping: {
      security_class: 'Security',
      shares: 'Shares',
      price_per_share: 'Issue Price',
      invested_amount: 'Amount Invested',
      liquidation_multiple: 'Liquidation Preference',
      seniority: 'Seniority',
    },
  },
  {
    key: 'pulley',
    label: 'Pulley export',
    mapping: {
      security_class: 'Share Class',
      shares: 'Shares Outstanding',
      price_per_share: 'Price Per Share',
      invested_amount: 'Total Invested',
      liquidation_multiple: 'Liquidation Multiple',
    },
  },
  {
    key: 'generic',
    label: 'Generic CSV',
    mapping: {
      security_class: 'class',
      class_type: 'type',
      shares: 'shares',
      price_per_share: 'price',
      invested_amount: 'invested',
      liquidation_multiple: 'liquidation_multiple',
      seniority: 'seniority',
      conversion_ratio: 'conversion_ratio',
    },
  },
] as const;

export function presetByKey(key: string): FormatPreset | undefined {
  return FORMAT_PRESETS.find((p) => p.key === key);
}

/**
 * Parse a money/number cell: strips $, commas and whitespace; '' → null.
 *
 * A fully parenthesised figure is negative — that is what `(500,000)` means in
 * every accounting export a cap table arrives from. Discarding the parentheses
 * instead, as this did, turned a 500,000-share repurchase into a 500,000-share
 * holding: `-500000` is rejected by `validateCapTable` as a bad share count,
 * but `(500000)` sailed through as a legitimate position and inflated the
 * fully-diluted count that divides the equity value into a per-share figure.
 *
 * An unbalanced parenthesis is now unparseable rather than silently positive:
 * `(500000` says the cell was not understood, and null is the honest answer.
 */
export function parseNumericCell(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let cleaned = String(value).replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  let negated = false;
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    negated = true;
    cleaned = cleaned.slice(1, -1);
    if (cleaned === '') return null;
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  // `n !== 0` keeps `(0)` from becoming -0, which formats as "-0".
  return negated && n !== 0 ? -n : n;
}

/** Infer the class type from the security name when it isn't a column. */
export function inferClassType(name: string): CapTableClassType {
  const n = name.toLowerCase();
  if (/\boption|\bisos?\b|\bnso|pool\b/.test(n)) return 'option';
  if (/warrant/.test(n)) return 'warrant';
  if (/common|founder|restricted stock|\brsu/.test(n)) return 'common';
  if (/preferred|series|seed|convertible/.test(n)) return 'preferred';
  return 'common';
}

/** Delimiters worth guessing between, in tie-break order. */
const DELIMITERS = [',', ';', '\t'] as const;

/**
 * Guess the field separator from the header line.
 *
 * Excel writes the *locale's* list separator, not a comma: in most of
 * continental Europe "Save as CSV" produces semicolon-delimited text, and a
 * copy-paste out of a spreadsheet is tab-delimited. Parsing either as
 * comma-separated does not fail — it yields one column whose name is the whole
 * header line, so the mapping matches nothing, `parseCapTable` returns zero
 * entries, and the importer reports an empty cap table for a file that plainly
 * has one. Guessing wrong is no worse than the single-column result assuming
 * always-comma already gives.
 *
 * Only the first line is inspected, and only separators outside quotes count,
 * so a quoted company name with a comma in it does not vote.
 */
export function sniffDelimiter(text: string): string {
  const end = text.search(/[\r\n]/);
  const header = end === -1 ? text : text.slice(0, end);

  let best: string = DELIMITERS[0];
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < header.length; i++) {
      const c = header[i];
      if (c === '"') {
        // A doubled quote is an escaped quote, not a state change.
        if (inQuotes && header[i + 1] === '"') i++;
        else inQuotes = !inQuotes;
      } else if (!inQuotes && c === delimiter) count++;
    }
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Name the columns, given the raw header cells.
 *
 * Two things real exports do that the naive `headers[i]` mapping got wrong:
 *
 *  - **Blank headers.** A trailing comma, or a spacer column between two
 *    blocks, produces an unnamed column. Keying them all on `''` meant the
 *    last such column silently overwrote the others, and `''` then appeared in
 *    the mapping UI as a selectable source. They are dropped instead, matching
 *    what the `.xlsx` reader already does with the same shape.
 *  - **Duplicate headers.** Carta exports both a granted and an outstanding
 *    "Shares" column; a fund administrator's sheet repeats "Price". Last-wins
 *    meant the mapping silently read a column the operator did not pick, and
 *    the preview gave no hint which. Suffixing keeps every column reachable
 *    and visibly distinct.
 *
 * `null` marks a dropped column so the caller can keep header positions
 * aligned with row cells.
 */
function nameColumns(cells: string[]): Array<string | null> {
  const seen = new Map<string, number>();
  return cells.map((cell) => {
    const name = cell.trim();
    if (name === '') return null;
    const priorUses = seen.get(name) ?? 0;
    seen.set(name, priorUses + 1);
    return priorUses === 0 ? name : `${name} (${priorUses + 1})`;
  });
}

/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped quotes and
 * CRLF, sniffs the delimiter, and strips a leading BOM.
 *
 * The BOM is stripped here rather than only at the upload route because every
 * entry point has the problem, not just the one that was noticed: the API's
 * pasted-`csv` body and any future caller get the same file out of the same
 * "Save as CSV UTF-8" that put the BOM there. Left in place it becomes part of
 * the first header name — `U+FEFF` + `Security Class` matches neither the exact
 * nor the case-insensitive lookup in `readCell` — so the first column, which is
 * almost always the security class, silently maps to nothing.
 *
 * Returns the header row alongside the data so the mapping UI can list columns
 * even when the file has none of the latter, and so it lists them in source
 * order rather than in whatever order the first row's keys happen to enumerate.
 *
 * `lines` is the 1-based line of the file each data row came from. It exists
 * because this parser drops wholly blank lines, so the position of a row in
 * `rows` stops tracking the file at the first one — and a validation issue
 * reported against a position is then pointing at the wrong line of the sheet
 * the reader has open. Every real export has blank spacer lines, so this is the
 * common case rather than an edge.
 */
export function parseCsvSheet(text: string): {
  headers: string[];
  rows: Record<string, string>[];
  lines: number[];
} {
  const body = text.replace(/^\uFEFF/, '');
  const delimiter = sniffDelimiter(body);

  const grid: string[][] = [];
  /** Source line of each kept row, parallel to `grid`. */
  const gridLines: number[] = [];
  /**
   * The physical line of the file, and the physical line the record now being
   * read began on. They are two counters because a record is not a line: a
   * quoted field may hold newlines, so one record can span several.
   *
   * Counting only the newlines that *end* a record — which is what a single
   * counter does — makes every line number after a multi-line cell too low by
   * the number of lines that cell swallowed, and the whole point of this figure
   * is to name the row the reader has open. `capTableCsvParity` pins a quoted
   * header spanning two lines as a shape real exports have, and that one alone
   * shifts every data row in the file.
   */
  let line = 1;
  let rowStart = 1;
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  /** Flush the record in progress, keeping the line it started on. */
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.some((f) => f.trim() !== '')) {
      grid.push(row);
      gridLines.push(rowStart);
    }
    row = [];
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inQuotes) {
      if (c === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        field += c;
        // The newline stays in the field — it is data — but the file moved on
        // a line and the counter has to move with it. A CRLF counts once, on
        // its `\n`; a lone `\r` counts where it stands.
        if (c === '\n' || (c === '\r' && body[i + 1] !== '\n')) line += 1;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i++;
      endRow();
      line += 1;
      rowStart = line;
    } else field += c;
  }
  if (field !== '' || row.length > 0) endRow();
  if (grid.length === 0) return { headers: [], rows: [], lines: [] };

  const columns = nameColumns(grid[0]!);
  const headers = columns.filter((c): c is string => c !== null);
  const rows = grid.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    columns.forEach((name, i) => {
      if (name !== null) obj[name] = (cells[i] ?? '').trim();
    });
    return obj;
  });
  return { headers, rows, lines: gridLines.slice(1) };
}

/** Header-keyed rows only — the shape most callers want. */
export function parseCsv(text: string): Record<string, string>[] {
  return parseCsvSheet(text).rows;
}

/** Case-insensitive lookup of a source column in a row. */
function readCell(row: Record<string, unknown>, header: string | undefined): unknown {
  if (!header) return undefined;
  if (header in row) return row[header];
  const lower = header.toLowerCase();
  for (const [k, v] of Object.entries(row)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * Map raw rows to canonical cap-table entries using the column mapping.
 *
 * `sourceLines[i]` is the line of the uploaded file that `rows[i]` came from,
 * as `parseCsvSheet` and `readXlsx` report it. Supply it and every entry — and
 * so every validation issue — can name the row the reader has open.
 *
 * Deliberately not derived from the array index when it is absent. The index
 * only equals the file line for a sheet with no blank or skipped lines, which
 * no real export is; deriving it would put a confident, wrong line number on
 * the error, and sending someone to line 3 to fix a problem on line 7 is worse
 * than telling them the class name and letting them search. Entries with no
 * known line simply carry none.
 */
export function parseCapTable(
  rows: Record<string, unknown>[],
  mapping: ColumnMapping,
  sourceLines?: readonly number[],
): CapTableEntry[] {
  const entries: CapTableEntry[] = [];
  for (const [index, row] of rows.entries()) {
    const name = String(readCell(row, mapping.security_class) ?? '').trim();
    const sharesRaw = parseNumericCell(readCell(row, mapping.shares));
    // Skip blank rows / totals rows with no class and no shares.
    if (name === '' && sharesRaw === null) continue;
    const typeCell = String(readCell(row, mapping.class_type) ?? '')
      .trim()
      .toLowerCase();
    const classType: CapTableClassType =
      typeCell === 'common' || typeCell === 'preferred' || typeCell === 'option' || typeCell === 'warrant'
        ? (typeCell as CapTableClassType)
        : inferClassType(name);
    entries.push({
      source_row: sourceLines?.[index],
      security_class: name,
      class_type: classType,
      shares: sharesRaw ?? 0,
      price_per_share: parseNumericCell(readCell(row, mapping.price_per_share)),
      invested_amount: parseNumericCell(readCell(row, mapping.invested_amount)),
      liquidation_multiple: parseNumericCell(readCell(row, mapping.liquidation_multiple)),
      seniority: parseNumericCell(readCell(row, mapping.seniority)),
      conversion_ratio: parseNumericCell(readCell(row, mapping.conversion_ratio)),
    });
  }
  return entries;
}

export interface CapTableIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  security_class?: string;
  /**
   * The line in the uploaded sheet this issue is about — see
   * `CapTableEntry.source_row`. Absent on table-level issues (`empty`,
   * `no_option_pool`) and on entries that never came from a file.
   *
   * Carried structurally as well as inside `message` so the import screen can
   * link to the row rather than making the reader search a 300-line
   * spreadsheet for the class name quoted at them.
   */
  row?: number;
}

export interface CapTableSummary {
  total_shares: number;
  common_shares: number;
  preferred_shares: number;
  option_shares: number;
  warrant_shares: number;
  /**
   * Every security counted once, **as converted** — see `asConvertedShares`.
   *
   * Not the same figure as `total_shares`, which is the raw sum of the shares
   * column, and the difference is the whole point: this is the denominator a
   * per-share price is quoted against.
   */
  fully_diluted_shares: number;
  total_preference_stack: number;
  class_count: number;
}

export interface CapTableValidation {
  valid: boolean;
  issues: CapTableIssue[];
  summary: CapTableSummary;
}

/** Coerce a cell that is typed `number` but arrives from JSON as either. */
function finiteOr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * One class's share count on an as-converted basis.
 *
 * This is the basis the engine allocates on — `waterfall.py` computes
 * `total_as_converted = Σ shares × conversion_ratio`, with the ratio defaulting
 * to 1.0 for anything that has none — and therefore the only basis a
 * fully-diluted count may be quoted on. Only preferred converts; common,
 * options and warrants are already in common-equivalent units, which is why the
 * engine attaches a ratio to no other kind.
 *
 * A ratio of zero or below is a broken row rather than a class that converts
 * into nothing: `validateCapTable` raises `bad_conversion` on it and the engine
 * refuses the allocation outright, so such a table never reaches a price. It
 * counts 1:1 here so that an already-invalid table does not additionally hand a
 * zero denominator to the callers that only read the summary.
 */
export function asConvertedShares(entry: CapTableEntry): number {
  const shares = finiteOr(entry.shares, 0);
  if (entry.class_type !== 'preferred') return shares;
  const ratio = finiteOr(entry.conversion_ratio, 1);
  return shares * (ratio > 0 ? ratio : 1);
}

/**
 * What a class paid in — the base a liquidation preference multiplies.
 *
 * A stated `invested_amount` wins; absent one it is `price_per_share × shares`,
 * which is the same derivation `toWaterfallInputs` feeds the engine. Real
 * exports leave the amount column blank far more often than they leave the
 * price blank — Carta's "Amount Invested" is optional and a fund
 * administrator's sheet frequently carries only a round price — so the fallback
 * is the common path, not a repair for malformed input.
 *
 * Shared because the workbook tab had its own version that skipped the fallback
 * and reported such a class as having invested nothing and holding no
 * preference, while the engine allocated it a real one off the same row.
 */
export function investedAmount(entry: CapTableEntry): number {
  const stated = Number(entry.invested_amount);
  if (entry.invested_amount !== null && Number.isFinite(stated)) return stated;
  const price = Number(entry.price_per_share);
  return entry.price_per_share !== null && Number.isFinite(price) ? price * finiteOr(entry.shares, 0) : 0;
}

/**
 * What a preferred class is paid before common: invested × multiple.
 *
 * The third figure the platform derived in four places from the same two
 * nullable columns, and the third to disagree with the engine. Both defaults
 * are the engine's: `toWaterfallInputs` takes the invested amount as
 * `price_per_share × shares` when the amount column is blank, and defaults an
 * absent multiple to 1× — which `validateCapTable` warns about (`default_liq_pref`)
 * rather than treating as "no preference".
 *
 * Reading the two columns raw instead is how the cap-table *graph* — the one
 * picture on the platform whose subject is the preference stack — drew an
 * ordinary Carta export's Series A with no preference at all, on a row the
 * waterfall was paying ahead of common.
 *
 * Zero for a non-preferred class: options, warrants and common hold no
 * preference, and returning the multiple times nothing would invite a caller to
 * print one.
 */
export function liquidationPreference(entry: CapTableEntry): number {
  if (entry.class_type !== 'preferred') return 0;
  return investedAmount(entry) * (entry.liquidation_multiple ?? 1);
}

/**
 * The fully-diluted, as-converted count for a whole table.
 *
 * Prefer this over a stored `CapTableSummary.fully_diluted_shares` anywhere the
 * entries are in hand. The summary is persisted as JSONB at import time, so a
 * row written by an earlier build carries whatever that build computed — and a
 * workbook that printed a stale total beside live formulas derived from the
 * entries would hand the reader a cached number Excel disagrees with the moment
 * it recalculates.
 */
export function fullyDilutedShares(entries: readonly CapTableEntry[]): number {
  return entries.reduce((sum, e) => sum + asConvertedShares(e), 0);
}

/**
 * Validate parsed entries: share counts, preference stacks, conversion ratios
 * and option pool. Errors make the table invalid (block save); warnings note
 * defaulted or missing figures.
 */
export function validateCapTable(entries: CapTableEntry[]): CapTableValidation {
  const issues: CapTableIssue[] = [];
  const summary: CapTableSummary = {
    total_shares: 0,
    common_shares: 0,
    preferred_shares: 0,
    option_shares: 0,
    warrant_shares: 0,
    fully_diluted_shares: 0,
    total_preference_stack: 0,
    class_count: entries.length,
  };

  if (entries.length === 0) {
    issues.push({ severity: 'error', code: 'empty', message: 'No cap-table rows were found.' });
  }

  const seen = new Set<string>();
  for (const e of entries) {
    // Every per-entry issue carries where it came from, structurally and in the
    // prose. Naming only the security class was fine for a ten-row table and
    // useless for the exports this importer actually receives: "Row 147" is
    // something the reader can act on, a quoted class name in a 300-line sheet
    // is something they have to go and search for — and `missing_class`, the
    // one issue whose row has no name to quote, identified nothing whatsoever.
    const where = { security_class: e.security_class, row: e.source_row };
    const at = e.source_row === undefined ? '' : `Row ${e.source_row}: `;

    if (e.security_class === '') {
      issues.push({
        ...where,
        severity: 'error',
        code: 'missing_class',
        message: `${at}this row is missing a security class name.`,
      });
    } else if (seen.has(e.security_class.toLowerCase())) {
      issues.push({
        ...where,
        severity: 'warning',
        code: 'duplicate_class',
        message: `${at}duplicate security class "${e.security_class}".`,
      });
    }
    seen.add(e.security_class.toLowerCase());

    if (!Number.isFinite(e.shares) || e.shares < 0) {
      issues.push({
        ...where,
        severity: 'error',
        code: 'bad_shares',
        message: `${at}"${e.security_class}" has an invalid share count.`,
      });
    } else if (e.shares === 0) {
      // A warning rather than an error, unlike the negative money below: zero
      // is a real thing for a row to say (a retired class, an option pool with
      // nothing left in it) and refusing the import would lose the other
      // fifteen rows over it. But it is not a thing the *waterfall* can say —
      // the engine's rule is `shares must be positive`, so this row is the one
      // that turns the allocation into a 422 — and the importer is the only
      // place that still knows which row it was.
      issues.push({
        ...where,
        severity: 'warning',
        code: 'zero_shares',
        message: `${at}"${e.security_class}" has no shares outstanding — the waterfall allocation will refuse this row.`,
      });
    }
    summary.total_shares += Math.max(0, e.shares);
    if (e.class_type === 'common') summary.common_shares += e.shares;
    else if (e.class_type === 'preferred') summary.preferred_shares += e.shares;
    else if (e.class_type === 'option') summary.option_shares += e.shares;
    else if (e.class_type === 'warrant') summary.warrant_shares += e.shares;

    if (e.class_type === 'preferred') {
      const mult = e.liquidation_multiple ?? 1;
      if (e.liquidation_multiple === null) {
        issues.push({
          ...where,
          severity: 'warning',
          code: 'default_liq_pref',
          message: `${at}"${e.security_class}" has no liquidation preference — defaulting to 1×.`,
        });
      }
      if (mult < 0) {
        issues.push({
          ...where,
          severity: 'error',
          code: 'bad_liq_pref',
          message: `${at}"${e.security_class}" has a negative liquidation preference.`,
        });
      }
      if (e.conversion_ratio !== null && e.conversion_ratio <= 0) {
        issues.push({
          ...where,
          severity: 'error',
          code: 'bad_conversion',
          message: `${at}"${e.security_class}" has a non-positive conversion ratio.`,
        });
      }
      // Seniority was the one preferred field nothing here checked, and it is
      // the field that orders the stack. `parseNumericCell` accepts any finite
      // number, so a 0-based export ("0, 1, 2"), a negative, or a fractional
      // rank imported as `valid: true` and was carried through unexamined:
      //
      //   - `waterfallSheet` sorts the preference stack by it and declares the
      //     column `integer`, so the sheet an auditor reaches for first shows
      //     the wrong liquidation order — with a fraction in an integer column.
      //   - the ops `waterfall-inputs` endpoint hands it to an engine whose own
      //     rule is `seniority must be an integer >= 1`, so the allocation is
      //     refused for a table the importer had just called valid.
      //
      // Same rule as the hand-entry schema (`z.number().int().min(1)`) and the
      // engine, stated where the import can still say which row is wrong.
      if (e.seniority !== null && (!Number.isInteger(e.seniority) || e.seniority < 1)) {
        issues.push({
          ...where,
          severity: 'error',
          code: 'bad_seniority',
          message: `${at}"${e.security_class}" has a seniority of ${e.seniority} — it must be a whole number of 1 or more (1 is the most senior).`,
        });
      }
      // Preference stack: invested × multiple, else shares × price × multiple.
      const invested = investedAmount(e);
      // The two money columns were the last unchecked inputs to the preference
      // stack, and `parseNumericCell` hands them straight through: it reads a
      // fully parenthesised `(5,000,000)` as −5,000,000, which is the correct
      // reading of an accounting export and precisely how a negative one
      // arrives. Shares are checked for it; these were not, so a repurchase or
      // a contra row imported as `valid: true` and carried a *negative*
      // preference through everything downstream:
      //
      //   - `waterfallSheet` prints it as the class's "Preference (currency)"
      //     and sums it into the total, so the preference stack an auditor
      //     reads is understated by twice the row.
      //   - `summary.total_preference_stack` is understated the same way, and
      //     that is the figure the import screen reports back.
      //   - the ops `waterfall-inputs` endpoint hands it to an engine whose own
      //     rule is `preference must be >= 0`, so the allocation is refused for
      //     a table the importer had just called valid.
      //
      // A liquidation preference is a claim on proceeds; there is no such thing
      // as a negative one. Same severity as `bad_liq_pref` just above, which
      // has been making this exact check on the multiple all along.
      if (e.invested_amount !== null && e.invested_amount < 0) {
        issues.push({
          ...where,
          severity: 'error',
          code: 'negative_investment',
          message: `${at}"${e.security_class}" has a negative invested amount (${e.invested_amount}) — a liquidation preference cannot be negative.`,
        });
      }
      if (e.price_per_share !== null && e.price_per_share < 0) {
        issues.push({
          ...where,
          severity: 'error',
          code: 'negative_price',
          message: `${at}"${e.security_class}" has a negative price per share (${e.price_per_share}).`,
        });
      }
      if (invested === 0) {
        issues.push({
          ...where,
          severity: 'warning',
          code: 'no_investment',
          message: `${at}"${e.security_class}" has no invested amount or price — preference stack may be understated.`,
        });
      }
      summary.total_preference_stack += liquidationPreference(e);
    }
  }

  /*
   * As-converted, not the raw sum of the four kind buckets.
   *
   * Summing the buckets counts every preferred share 1:1 and so ignores
   * `conversion_ratio` — a column this importer maps, validates
   * (`bad_conversion`) and writes into the row, and which the engine then
   * multiplies by. Any class converting at other than 1:1 therefore produced a
   * fully-diluted count that disagreed with the one the valuation is actually
   * divided by, and it disagreed in three visible places at once: the figure
   * the import screen reports back as confirmation the sheet read correctly,
   * the "% fully diluted" column of the exported workbook (whose Cap table
   * sheet then contradicted its own Waterfall sheet, which has been
   * as-converted all along), and the `cap_table` monitoring baseline, which
   * compares this number across runs and cannot match one the engine computes
   * differently.
   *
   * A 2× ratchet on a Series A is not exotic, and it understates the
   * denominator — so every holder's ownership percentage came out too high.
   */
  summary.fully_diluted_shares = fullyDilutedShares(entries);
  /*
   * A table of rows that between them hold no shares.
   *
   * Each such row is only a `zero_shares` warning on its own, and correctly so:
   * a retired class or a drained option pool is a real line for a cap table to
   * carry. But a *table* whose fully diluted count is zero is not a cap table
   * that happens to have an empty row in it — there is no denominator to divide
   * an equity value by, and every consumer downstream has had to guard for it
   * separately (`valuationWorkbook` suppresses the ownership column on
   * `fd > 0`, the waterfall engine 422s).
   *
   * The reason it is reachable at all is the mapping step: point the shares
   * column at a text column and every row parses to null, which `parseCapTable`
   * stores as 0. The result was a table of warnings that `valid: true` let
   * through the PUT and persisted — the one moment at which the importer still
   * knows the mapping is what went wrong.
   */
  if (entries.length > 0 && summary.fully_diluted_shares <= 0) {
    issues.push({
      severity: 'error',
      code: 'no_shares',
      message:
        `No row in this cap table holds any shares (${entries.length} ` +
        `${entries.length === 1 ? 'row' : 'rows'} read). Check that the shares column is mapped ` +
        'to the right column of the sheet.',
    });
  }
  if (summary.option_shares === 0) {
    issues.push({
      severity: 'warning',
      code: 'no_option_pool',
      message: 'No option pool detected in the cap table.',
    });
  }

  return { valid: !issues.some((i) => i.severity === 'error'), issues, summary };
}

export interface WaterfallInputs {
  common_shares: number;
  option_pool_shares: number;
  preferred: Array<{
    security_class: string;
    shares: number;
    invested_amount: number;
    liquidation_multiple: number;
    seniority: number;
    conversion_ratio: number;
  }>;
}

/**
 * Project the cap table into the structured inputs the waterfall engine
 * consumes: common (incl. warrants) + option pool + preferred stack with
 * defaulted preferences.
 */
export function toWaterfallInputs(entries: CapTableEntry[]): WaterfallInputs {
  const preferred = entries
    .filter((e) => e.class_type === 'preferred')
    .map((e, i) => ({
      security_class: e.security_class,
      shares: e.shares,
      invested_amount: investedAmount(e),
      liquidation_multiple: e.liquidation_multiple ?? 1,
      seniority: e.seniority ?? i + 1,
      conversion_ratio: e.conversion_ratio ?? 1,
    }));
  return {
    common_shares: entries
      .filter((e) => e.class_type === 'common' || e.class_type === 'warrant')
      .reduce((n, e) => n + e.shares, 0),
    option_pool_shares: entries.filter((e) => e.class_type === 'option').reduce((n, e) => n + e.shares, 0),
    preferred,
  };
}
