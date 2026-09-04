/**
 * Cap-table import, validation and waterfall feed (feature 9). Pure functions —
 * no I/O — so CSV parsing, column mapping, validation and the engine-input
 * projection are all unit-testable. The route layer persists the result.
 */

import { nameColumns, rowByColumn } from './sheetColumns.js';
import { sliceChars } from './textSlice.js';

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
  /**
   * Mapped numeric columns whose cell held something this could not read as a
   * number, keyed by field and carrying the text that was there.
   *
   * Every numeric column parses to `number | null`, and until this existed
   * `null` said two different things: the cell was empty, or the cell held
   * `TBD`. The first is ordinary — real exports leave the amount column blank
   * — and the second is a column pointed at the wrong place, a row shifted by
   * an unquoted comma, or a notation the parser does not know. Both were
   * treated as "not provided", so the second imported as a *default*: a share
   * count of 0 with a warning, a liquidation preference of 1x, a conversion
   * ratio of 1.
   *
   * That is a wrong number rather than a missing one, and nothing downstream
   * can tell. `validateCapTable` turns each of these into an error naming the
   * row, the column and the text, which is the last point at which the
   * importer still knows what the cell actually said.
   *
   * Absent when every mapped cell read cleanly, which is the ordinary case.
   */
  unreadable_numbers?: Partial<Record<NumericCapTableField, string>>;
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

/** The fields whose cells are read as numbers rather than as text. */
export type NumericCapTableField = Exclude<CapTableField, 'security_class' | 'class_type'>;

/** How each numeric field is named in a message to whoever uploaded the sheet. */
const NUMERIC_FIELD_LABELS: Record<NumericCapTableField, string> = {
  shares: 'share count',
  price_per_share: 'price per share',
  invested_amount: 'invested amount',
  liquidation_multiple: 'liquidation preference',
  seniority: 'seniority',
  conversion_ratio: 'conversion ratio',
};

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

/**
 * The most entries one `cap_tables` row may hold, on every path into it.
 *
 * The import routes have enforced this since a pasted CSV was found to be
 * bounded only by its two megabytes of text: a table refused as `rows` was
 * accepted as `csv` and persisted, and hundreds of thousands of entries in one
 * JSON document is then loaded whole by every reader of that valuation — the
 * workbook export, the waterfall projection, the graph, the report exhibits,
 * the monitoring scan's batch fetch.
 *
 * Stated here rather than in `routes/capTable.ts` because the routes are not
 * the only writer. The provider sync maps whatever the provider's JSON holds
 * and hands it to `saveCapTable` unbounded — and its body cap is 16 MB of JSON,
 * which is tens of thousands of securities. Pulley's payload is a flat
 * `securities` list rather than a list of classes, so that is not a hostile
 * shape, it is a large company's ordinary one.
 *
 * "A bound two of three callers enforce is not a bound" was the note when the
 * pasted-CSV hole was closed; the sync was the fourth caller.
 */
export const MAX_CAP_TABLE_ENTRIES = 2000;

export function presetByKey(key: string): FormatPreset | undefined {
  return FORMAT_PRESETS.find((p) => p.key === key);
}

/**
 * The preset keys, as a tuple a schema can be built from.
 *
 * `format` on the import and preview bodies names a member of this set, and
 * `presetByKey` answers a key outside it with `undefined` — which
 * `resolveMapping` reads as "no preset", leaving the import to run on the
 * caller's own column overrides alone. A Carta export sent under `'Carta'`
 * therefore parsed with no `Security` column, no `Shares` column and no error:
 * every entry came back empty rather than the request coming back refused.
 *
 * A vocabulary a body names is checked against it, the same rule
 * `pathParamValidationCensus.test.ts` states for the ones that travel in the
 * path. Derived from `FORMAT_PRESETS` rather than written out, so a fourth
 * preset is in the schema the moment it exists.
 */
export const FORMAT_PRESET_KEYS = FORMAT_PRESETS.map((p) => p.key) as unknown as [string, ...string[]];

/** Digits grouped in threes by commas — `1,234`, `12,345,678`. US thousands. */
const COMMA_GROUPED = /^\d{1,3}(?:,\d{3})+$/;

/**
 * The Indian grouping — `1,00,000`, `12,34,567`: groups of two above the last
 * three, which is what a spreadsheet set to en-IN writes and what an Indian
 * subsidiary's cap table arrives as.
 *
 * Listed because stripping every comma read these correctly, and a rule that
 * only knows the three-digit grouping turns them into `null`. Refusing a figure
 * the parser used to get right is a regression however sound the reasoning
 * behind the new rule; the grouping is unambiguous, so it is recognised rather
 * than lost.
 */
const COMMA_GROUPED_INDIAN = /^\d{1,2}(?:,\d{2})+,\d{3}$/;

/**
 * Resolve `.` and `,` into the one decimal point JS `Number` understands.
 *
 * The comma used to be stripped outright, on the reading that it is always a
 * thousands separator. It is not, and this module knows it is not: the
 * delimiter sniffer above exists precisely because "Save as CSV" outside the US
 * writes semicolons, and the same locale that writes the semicolon writes
 * `1,00` for one euro and `1.234,56` for a thousand of them.
 *
 * So `1,00` — a price per share of one — was read as **one hundred**, and
 * `1.234,56` as `1.23456`. Both land in `price_per_share`, which is what a
 * 409A's per-share conclusion is reconciled against, and neither looks wrong
 * anywhere downstream: they are finite, positive numbers of a plausible shape.
 * `capTableCsvParity` has carried `Common;100;1,00` as a fixture the whole time
 * — the parser was pinned on the columns of that file and never on its figures.
 *
 * The rules, in the order they are decided:
 *
 *  - **Both separators present.** The last one is the decimal point and the
 *    other is grouping, whichever way round they fall. This settles
 *    `1,234.56` and `1.234,56` without knowing the locale.
 *  - **Commas only, in a grouping pattern** — threes (`1,234`, `12,345,678`) or
 *    the Indian twos-above-three (`1,00,000`). Read as grouping, which keeps
 *    every such file parsing exactly as it did. `1,234` is genuinely ambiguous
 *    — it is 1.234 to a German spreadsheet — and this is the reading the
 *    platform's own exports use.
 *  - **Commas only, in no grouping pattern** (`1,00`, `1,5`, `12,345,6`). Not a
 *    thousands separator, because no thousands separator produces those. The
 *    first two are a decimal comma; the third is not a number, and turning it
 *    into `12.345.6` makes it unparseable, which is the honest answer.
 *  - **Dots only.** Left alone. `1.234` is as ambiguous as `1,234` and is read
 *    the same way round, as the plain JS number it already is.
 */
function normalizeDecimalSeparator(digits: string): string {
  const lastDot = digits.lastIndexOf('.');
  const lastComma = digits.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    return lastComma > lastDot ? digits.replace(/\./g, '').replace(',', '.') : digits.replace(/,/g, '');
  }
  if (lastComma === -1) return digits;
  const grouped = COMMA_GROUPED.test(digits) || COMMA_GROUPED_INDIAN.test(digits);
  return grouped ? digits.replace(/,/g, '') : digits.replace(/,/g, '.');
}

/**
 * Every currency symbol Unicode knows, which is the set a sheet's money columns
 * are written in.
 *
 * `[$\s]` was the strip set, and `$` is the one symbol this module had no
 * business privileging: everything else here goes out of its way to read the
 * files a non-US spreadsheet writes. `sniffDelimiter` exists because "Save as
 * CSV" outside the US writes semicolons; `normalizeDecimalSeparator` exists
 * because the same locale writes `1,00` for one euro. A euro cap table
 * therefore got its delimiter read, its decimal comma read — and every money
 * cell refused, because the figure was spelled `€1,00`.
 *
 * Refused loudly rather than quietly, so nothing was mis-valued: an unreadable
 * cell is an `unreadable_number` error and the import is blocked. But it blocks
 * on a cell the sheet stated perfectly clearly, and the reader is told their
 * price per share "is not a number" — for a file the rest of this module was
 * written to accept.
 *
 * `\p{Sc}` rather than a hand-listed set: it is $ € £ ¥ ₹ ₩ ₽ ¢ and the
 * fullwidth forms an East Asian sheet writes, without this module having to
 * guess which of them it will meet. A three-letter currency *code* (`USD 1.50`,
 * `1.50 EUR`) is deliberately not stripped — letters beside a figure are as
 * often a shifted row as a currency, and `2x` in the multiple column is a
 * notation this file reads for meaning.
 */
const CURRENCY_SYMBOLS = /[\p{Sc}]/gu;

/**
 * Parse a money/number cell: strips currency symbols and whitespace, resolves
 * the decimal separator (see {@link normalizeDecimalSeparator}); '' → null.
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
  // A cell that is an object or a list is not a figure written badly, it is a
  // shape — and `String()` reads a figure out of some of them. `[1000]`
  // stringifies to `1000` and imported as a share count of one thousand, off a
  // body field typed `z.record(z.string(), z.unknown())` that accepts any JSON
  // at all. The provider reader beside this one has refused the same thing on
  // the same field since it was written ("a name that is an object or a list is
  // refused rather than stringified"); this half was left reading whatever
  // `String()` made of it. Null here, so `read` records it as a cell it could
  // not read and `validateCapTable` raises the error rather than the figure.
  if (typeof value === 'object') return null;
  let cleaned = String(value).replace(CURRENCY_SYMBOLS, '').replace(/\s/g, '');
  if (cleaned === '') return null;
  let negated = false;
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    negated = true;
    cleaned = cleaned.slice(1, -1);
    if (cleaned === '') return null;
  }
  // The sign travels separately: the grouping test is about the digits, and
  // `-1,234` groups exactly as `1,234` does.
  const sign = /^[+-]/.test(cleaned) ? cleaned[0]! : '';
  const n = Number(sign + normalizeDecimalSeparator(sign ? cleaned.slice(1) : cleaned));
  if (!Number.isFinite(n)) return null;
  // `n !== 0` keeps `(0)` from becoming -0, which formats as "-0".
  return negated && n !== 0 ? -n : n;
}

/**
 * Text a sheet uses to say "there is no figure here".
 *
 * A blank cell and a cell reading `N/A` mean the same thing and neither is an
 * error: a common-stock row has no issue price, and the sheet says so with a
 * dash, an `n/a` or an Excel error left over from a formula that divided by an
 * empty cell. Every one of these parses to `null` through
 * {@link parseNumericCell} already — what this list decides is whether that
 * `null` is *reported*. Without it, hardening the unreadable-cell path would
 * have refused the most ordinary export there is.
 *
 * Compared lower-cased and trimmed. The `#`-prefixed entries are Excel's own
 * error strings, which arrive as literal text once a workbook is saved as CSV
 * (inside a workbook they are `t="e"` cells and the reader already blanks
 * them).
 */
const NOT_A_FIGURE = new Set([
  '-',
  '--',
  '\u2013',
  '\u2014',
  '.',
  '?',
  'na',
  'n/a',
  'n.a.',
  'n/a.',
  'none',
  'null',
  'nil',
  'tbd',
  'tbc',
  '#n/a',
  '#value!',
  '#ref!',
  '#div/0!',
  '#name?',
  '#num!',
  '#null!',
]);

/** Does this cell say "no figure" rather than carrying one this failed to read? */
export function meansNoFigure(text: string): boolean {
  return text === '' || NOT_A_FIGURE.has(text.toLowerCase());
}

/** The most of an unreadable value to quote back in a validation issue. */
const CELL_TEXT_MAX = 120;

/**
 * A cell's contents as they are quoted back at whoever supplied them.
 *
 * Shared with the provider reader (`clients/capTableSync.ts`), which authored
 * it: an object or a list is named as what it is rather than stringified, so
 * the message says the column "reads an object" instead of quoting
 * `[object Object]` at somebody as though the sheet had that in it. Bounded
 * because the value is the thing that could not be read, and a megabyte of it
 * would become the issue.
 */
export function cellText(raw: unknown): string {
  const text = Array.isArray(raw)
    ? 'a list'
    : typeof raw === 'object' && raw !== null
      ? 'an object'
      : String(raw).trim();
  return text.length > CELL_TEXT_MAX ? `${sliceChars(text, CELL_TEXT_MAX)}\u2026` : text;
}

/**
 * A liquidation preference cell, which is written `2x` at least as often as `2`.
 *
 * "1x", "2x", "1.5x" is how a term sheet says it, how a cap table's own column
 * *header* says it ("Liquidation Preference (1x)"), and how several
 * administrators export the column. `parseNumericCell` reads none of them —
 * `Number('2x')` is `NaN` — so every one arrived as `null`, and a `null`
 * multiple defaults to 1x. A 2x preference therefore imported as 1x: the
 * preference stack, the waterfall's payout to that class, and the residual left
 * for common were all wrong, the table validated clean, and the one warning
 * raised said the row "has no liquidation preference", which was a statement
 * about a cell that plainly had one.
 *
 * Only this column reads the suffix. `2x` in a share count or a price is not a
 * notation anything writes, and would be a shifted row rather than a multiple.
 */
export function parseMultipleCell(value: unknown): number | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const body = /^(.*[^\s])\s*[x\u00d7]$/i.exec(trimmed)?.[1];
    if (body !== undefined) return parseNumericCell(body);
  }
  return parseNumericCell(value);
}

/**
 * A conversion-ratio cell, which is written `1:1` at least as often as `1`.
 *
 * A ratio is a ratio, and a hand-built sheet writes it with the colon. `1:1`
 * parsed to `null` and defaulted to 1, which is the right answer by luck; `2:1`
 * parsed to `null` and defaulted to 1 as well, which understates the
 * fully-diluted count and so overstates every holder's ownership percentage and
 * the per-share price the valuation divides out.
 *
 * A non-positive or unreadable denominator is not a ratio, and is left for the
 * unreadable-cell path to report rather than being turned into an Infinity.
 */
export function parseRatioCell(value: unknown): number | null {
  if (typeof value === 'string' && value.includes(':')) {
    const parts = value.split(':');
    if (parts.length !== 2) return null;
    const numerator = parseNumericCell(parts[0]);
    const denominator = parseNumericCell(parts[1]);
    if (numerator === null || denominator === null || denominator <= 0) return null;
    return numerator / denominator;
  }
  return parseNumericCell(value);
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
 * Only the header *record* is inspected, and only separators outside quotes
 * count, so a quoted company name with a comma in it does not vote.
 *
 * A record, not a line, and the distinction is the whole of a bug this had.
 * `text.search(/[\r\n]/)` finds the first newline in the file, which is not
 * the end of the header when the header's own first cell is quoted and holds a
 * line break — a two-line column title typed into a spreadsheet, which is a
 * shape `parseCsvSheet` explicitly supports and `capTableCsvParity` pins as one
 * real exports have. Cutting there left the scan inside an unclosed quote, so
 * every separator after it was read as quoted text and none of them voted: the
 * count came back zero for all three candidates and the comma won by being
 * first.
 *
 * For a comma file that is invisible. For the two this function exists for it
 * is the failure it exists to prevent: a semicolon sheet out of a European
 * Excel, or a tab-delimited paste, parsed as one column whose name is the whole
 * header, mapping to nothing, reported to the client as a file with no cap
 * table in it.
 *
 * So the header ends where `parseCsvSheet` says it ends — at the first newline
 * *outside* quotes — and the two readers of the same bytes agree about which
 * bytes the header is. One forward pass, tracking quotes once for all three
 * candidates rather than re-scanning per delimiter.
 */
export function sniffDelimiter(text: string): string {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      // A doubled quote is an escaped quote, not a state change.
      if (inQuotes && text[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (c === '\n' || c === '\r') break; // the header record ends here
    const seen = counts.get(c);
    if (seen !== undefined) counts.set(c, seen + 1);
  }

  let best: string = DELIMITERS[0];
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    const count = counts.get(delimiter)!;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
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
export class CsvReadError extends Error {}

/**
 * The most columns one record may have — Excel's own XFD limit, which is what
 * {@link MAX_COLUMN} bounds the workbook reader by.
 *
 * Delimited text has no such limit of its own, and a record's width is set by
 * one byte per field: `','.repeat(10_485_760)` is a single header line inside
 * the route's 10 MB upload cap that builds a ten-million-entry array and
 * returns *no rows at all* — measured, 247 MB of heap and a third of a second
 * of blocked event loop for a file the importer then reports as empty. Text
 * with more columns than a worksheet has is not a sheet anyone is importing.
 */
export const MAX_CSV_COLUMNS = 16_384;

/**
 * The most cells one parse may materialise, across every row it keeps.
 *
 * The row and column bounds each hold one dimension and neither holds their
 * product: 2,000 rows of 5,000 columns is legal under both. This is the
 * counterpart to `MAX_GRID_CELLS` in the workbook reader, and generous by the
 * same margin — a large real cap table is 2,000 rows of a few tens of columns,
 * some 100,000 cells.
 */
export const MAX_CSV_CELLS = 2_000_000;

export function parseCsvSheet(
  text: string,
  options: {
    /**
     * Data rows to materialise. Records past it are counted into `totalRows`
     * and discarded, so a caller that is going to keep 2,000 rows does not pay
     * for 300,000 first — see `totalRows`.
     */
    maxRows?: number;
  } = {},
): {
  headers: string[];
  rows: Record<string, string>[];
  lines: number[];
  /**
   * Data rows the text holds, which is `rows.length` unless `maxRows` cut it
   * short. Both callers need the true figure and neither needs the rows: the
   * upload endpoint reports `truncated`, and the pasted-CSV path refuses the
   * import naming how many rows were sent.
   *
   * It exists because those two are the whole reason 10 MB of text was ever
   * parsed into 300,000 records — a 138 MB allocation, per concurrent upload,
   * to answer a question a counter answers.
   */
  totalRows: number;
} {
  const body = text.replace(/^\uFEFF/, '');
  const delimiter = sniffDelimiter(body);
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;

  const grid: string[][] = [];
  /** Source line of each kept row, parallel to `grid`. */
  const gridLines: number[] = [];
  /** Records with anything in them, header included — `totalRows` is this less the header. */
  let records = 0;
  /** Cells `grid` holds, against {@link MAX_CSV_CELLS}. */
  let cells = 0;
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
  /** Close the field in progress, bounding how wide one record may get. */
  const pushField = () => {
    if (row.length >= MAX_CSV_COLUMNS) {
      throw new CsvReadError(
        `A row has more than ${MAX_CSV_COLUMNS.toLocaleString('en-US')} columns, ` +
          'the most a worksheet has',
      );
    }
    row.push(field);
    field = '';
  };
  /** Flush the record in progress, keeping the line it started on. */
  const endRow = () => {
    pushField();
    if (row.some((f) => f.trim() !== '')) {
      records += 1;
      // The header is not one of `maxRows`, so a cap of 2,000 keeps 2,001
      // records. Past that the record is counted and dropped: nothing reads it
      // and materialising it is the whole cost this bound exists to avoid.
      if (grid.length <= maxRows) {
        cells += row.length;
        if (cells > MAX_CSV_CELLS) {
          throw new CsvReadError(
            `This file needs more than ${MAX_CSV_CELLS.toLocaleString('en-US')} cells to lay out`,
          );
        }
        grid.push(row);
        gridLines.push(rowStart);
      }
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
      pushField();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i++;
      endRow();
      line += 1;
      rowStart = line;
    } else field += c;
  }
  if (field !== '' || row.length > 0) endRow();
  if (grid.length === 0) return { headers: [], rows: [], lines: [], totalRows: 0 };

  const columns = nameColumns(grid[0]!);
  const headers = columns.filter((c): c is string => c !== null);
  const rows = grid.slice(1).map((cells) => rowByColumn(columns, cells));
  return { headers, rows, lines: gridLines.slice(1), totalRows: Math.max(0, records - 1) };
}

/** Header-keyed rows only — the shape most callers want. */
export function parseCsv(text: string): Record<string, string>[] {
  return parseCsvSheet(text).rows;
}

/**
 * Case-insensitive lookup of a source column in a row.
 *
 * `Object.hasOwn` rather than `in`, for the reason `renderTemplate` in
 * domain/communications.ts already carries: `in` walks the prototype chain, and
 * the header being looked up is a string the importer sent. `mapping` on the
 * import body is `z.record(z.string(), z.string())` — any column name at all —
 * so mapping `shares` to `constructor` made this return the `Object` function
 * for a column the sheet does not have. Every one of `constructor`, `toString`,
 * `valueOf`, `hasOwnProperty` and `__proto__` behaved that way, and none of
 * them is ever `undefined`, so none of them could reach the "no such column"
 * answer that is the truth about all of them. What the importer got instead was
 * `Number(…)` of a function — a validation error about a bad quantity — or a
 * holder named `function toString() { [native code] }`.
 */
function readCell(row: Record<string, unknown>, header: string | undefined): unknown {
  if (!header) return undefined;
  if (Object.hasOwn(row, header)) return row[header];
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
  return parseCapTableSheet(rows, mapping, sourceLines).entries;
}

/**
 * A row of the sheet that states a total rather than holding a security.
 *
 * Kept rather than discarded because the figure on it is a checksum over the
 * import — see {@link validateCapTable}. `shares` is what its share column
 * said, or null when it had none.
 */
export interface CapTableTotalsRow {
  /** The line of the uploaded sheet, when it is known. */
  source_row?: number;
  /** The label as written, for quoting back at whoever uploaded the file. */
  label: string;
  shares: number | null;
}

/**
 * Words a totals row's label is built from once its parenthetical is dropped.
 *
 * The tail is a closed list, and that is what keeps a security class out of
 * it: `Total (fully diluted)`, `Total Shares Outstanding` and `Total Preferred`
 * are totals rows, while `Total Return Preferred` — every word of which but one
 * is on this list — is a class, and is imported as one.
 */
const TOTALS_TAIL =
  /^(?:shares?|outstanding|issued|fully|diluted|fd|capitali[sz]ation|cap|equity|classes|class|securities|common|preferred|options?|warrants?|converted|basis|all|of|and|on|as)$/;

/**
 * Does this row say "here is the sum of the rows above" rather than naming a
 * security?
 *
 * Every real cap-table export ends with one — Carta, Pulley, the workbook this
 * platform writes itself — and until this existed each one imported as a
 * *security class*: a phantom holding whose share count was, by construction,
 * the sum of every genuine class. That doubles the fully-diluted count, which
 * halves every ownership percentage and halves the per-share price the 409A
 * concludes, and the table validated clean while it did so. `parseCapTable`
 * has always carried the comment "skip blank rows / totals rows", and skipped
 * only rows with neither a name nor a share count — which a totals row, having
 * both, was never one of.
 *
 * Matching is on the label alone rather than on the arithmetic. A subtotal does
 * not equal the sum of everything above it, a total over a class this import
 * dropped does not either, and both are still totals rows; making the sum a
 * condition of recognising one would let exactly the rows that indicate a
 * problem through as securities. The arithmetic is used for what it is good
 * for instead — a check on the import, applied after the fact.
 */
function isTotalsLabel(name: string): boolean {
  const words = name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    // Punctuation and digits go: `TOTAL:`, `Total —`, `Total 2024` are all the
    // same row, and a stray `*` footnote marker is not a word.
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/[\s-]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w !== '');
  let i = 0;
  if (words[i] === 'grand' || words[i] === 'sub') i += 1;
  const head = words[i];
  if (head === undefined || !/^(?:totals?|subtotals?|sum)$/.test(head)) return false;
  return words.slice(i + 1).every((w) => TOTALS_TAIL.test(w));
}

/**
 * {@link parseCapTable}, keeping the totals rows it set aside.
 *
 * Both are exported because the route needs the totals and every other caller
 * needs the entries; the totals feed `validateCapTable`, which is the only
 * thing that can tell whoever uploaded the file that the sheet's own total
 * disagrees with what was read out of it.
 */
export function parseCapTableSheet(
  rows: Record<string, unknown>[],
  mapping: ColumnMapping,
  sourceLines?: readonly number[],
): { entries: CapTableEntry[]; totals: CapTableTotalsRow[] } {
  const entries: CapTableEntry[] = [];
  const totals: CapTableTotalsRow[] = [];
  for (const [index, row] of rows.entries()) {
    /*
     * The name cell, or nothing when it holds a shape rather than text.
     *
     * `String()` of an object mints the class `[object Object]` and of a list
     * mints `a,b` — a security class the sheet never named, carrying whatever
     * share count sat beside it into the fully-diluted denominator. The
     * provider reader states the rule ("a name that is an object or a list is
     * refused rather than stringified") and this reader, on the same field, did
     * the thing the rule forbids: `rows` on the import body is
     * `z.record(z.string(), z.unknown())`, so any JSON value reaches here.
     *
     * Empty rather than a special issue, which puts the row through
     * `missing_class` — there is no name in that cell, which is what that error
     * says. The row is kept and reported, not dropped.
     */
    const nameCell = readCell(row, mapping.security_class);
    const name = typeof nameCell === 'object' && nameCell !== null ? '' : String(nameCell ?? '').trim();
    /**
     * Read one mapped numeric column, keeping *why* it came back null.
     *
     * `unreadable` is the text that was in the cell when there was text and it
     * did not parse — see `CapTableEntry.unreadable_numbers`. A cell that is
     * empty, or that says `N/A` in one of the ways sheets say it, is a figure
     * that was not supplied and reports nothing.
     */
    const unreadable: Partial<Record<NumericCapTableField, string>> = {};
    const read = (
      field: NumericCapTableField,
      parse: (value: unknown) => number | null = parseNumericCell,
    ): number | null => {
      const raw = readCell(row, mapping[field]);
      const value = parse(raw);
      if (value === null) {
        const text = raw === null || raw === undefined ? '' : cellText(raw);
        if (!meansNoFigure(text)) unreadable[field] = text;
      }
      return value;
    };

    const sharesRaw = read('shares');
    // Skip blank rows: no class, no shares. A cell that held something
    // unreadable is not blank, so such a row is kept and reported rather than
    // dropped on the floor.
    if (name === '' && sharesRaw === null && Object.keys(unreadable).length === 0) continue;
    // A row that states a total is not a security — see `isTotalsLabel`. Set
    // aside rather than dropped: the figure on it checks the import.
    if (isTotalsLabel(name)) {
      totals.push({ source_row: sourceLines?.[index], label: name, shares: sharesRaw });
      continue;
    }
    const typeCell = String(readCell(row, mapping.class_type) ?? '')
      .trim()
      .toLowerCase();
    const classType: CapTableClassType =
      typeCell === 'common' || typeCell === 'preferred' || typeCell === 'option' || typeCell === 'warrant'
        ? (typeCell as CapTableClassType)
        : inferClassType(name);
    const entry: CapTableEntry = {
      source_row: sourceLines?.[index],
      security_class: name,
      class_type: classType,
      shares: sharesRaw ?? 0,
      price_per_share: read('price_per_share'),
      invested_amount: read('invested_amount'),
      liquidation_multiple: read('liquidation_multiple', parseMultipleCell),
      seniority: read('seniority'),
      conversion_ratio: read('conversion_ratio', parseRatioCell),
    };
    if (Object.keys(unreadable).length > 0) entry.unreadable_numbers = unreadable;
    entries.push(entry);
  }
  return { entries, totals };
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

/**
 * The most issues one validation may carry (R402, methodology M8).
 *
 * The per-entry rules are a *product* — entries times rules — and nothing
 * bounded the result. That is not a hostile shape: a register of preferred
 * classes with no price recorded raises `no_investment` on every row, which is
 * valid, saveable and the ordinary shape of a share register off a transfer
 * agent. At {@link MAX_CAP_TABLE_ENTRIES} it is 2,001 issue objects, each
 * carrying its own prose sentence — 342 kB of JSON, re-derived on every read
 * (`withFreshValidation`), sent on every read of the cap-table tab, and drawn as
 * 2,001 list items the reader has to scroll past to reach the summary under
 * them.
 *
 * Two hundred is where a list stops being read line by line. It is well above
 * any table an analyst reconciles by hand and far above every fixture in the
 * tree, so nothing that was reported before is reported differently now — what
 * changes is only the tail of a systematic finding, and `issues_truncated` says
 * how much of it there was.
 */
export const MAX_CAP_TABLE_ISSUES = 200;

export interface CapTableValidation {
  valid: boolean;
  issues: CapTableIssue[];
  /**
   * Issues past {@link MAX_CAP_TABLE_ISSUES}, dropped from `issues`.
   *
   * Zero on every ordinary table. Disclosed rather than silent, for the reason
   * every capped list on this service states its own cap: a list that stops
   * without saying so is read as the whole answer.
   *
   * `valid` is **not** derived from the kept list — it counts errors across the
   * uncapped set — so a table cannot be truncated into validity.
   */
  issues_truncated: number;
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
export function validateCapTable(
  entries: CapTableEntry[],
  /**
   * The totals rows `parseCapTableSheet` set aside, when the caller has them.
   *
   * Optional because most callers do not: `findCapTable` re-derives validation
   * from stored entries alone, and by then the sheet is long gone. The checks
   * below are therefore additive — a validation computed without them says
   * everything it said before, which is what keeps the stored `validation`
   * column reproducible on read.
   */
  totals: readonly CapTableTotalsRow[] = [],
): CapTableValidation {
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

    /*
     * A mapped numeric column that held text.
     *
     * Raised before anything else about the row because it explains the rest:
     * an unreadable share count is *also* a zero share count, an unreadable
     * multiple is also an absent one, and the warnings those would raise
     * describe the defaults rather than the sheet. They are suppressed below,
     * so each bad cell is reported once, as the error it is.
     *
     * Errors rather than warnings. Every one of these otherwise imports as a
     * silent default — 0 shares, a 1x preference, a 1:1 ratio — and every one
     * of those defaults is a number the valuation goes on to divide by. The
     * three shapes this catches in the wild are a column mapped to the wrong
     * place, a row shifted one cell along by an unquoted comma in a company
     * name, and a notation the parser does not know; only the importer can
     * still tell the reader which cell, on which row, said what.
     */
    for (const field of CAP_TABLE_FIELDS) {
      const text = e.unreadable_numbers?.[field as NumericCapTableField];
      if (text === undefined) continue;
      issues.push({
        ...where,
        severity: 'error',
        code: 'unreadable_number',
        message:
          `${at}the ${NUMERIC_FIELD_LABELS[field as NumericCapTableField]} column reads ` +
          `"${text}", which is not a number.`,
      });
    }

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
    } else if (e.shares === 0 && e.unreadable_numbers?.shares === undefined) {
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
    /*
     * A row whose figures are finite and whose *products* are not.
     *
     * Every numeric cell is checked on its own — `bad_shares` refuses a share
     * count that is not finite, `bad_conversion` a ratio at or below zero — and
     * each of those checks passes for a row like `1e300` shares converting
     * 1e300:1. The multiplication is what overflows, and the figures that
     * overflow are the ones the whole valuation is quoted against:
     *
     *   - `asConvertedShares` is the fully-diluted denominator. An infinite one
     *     makes every ownership percentage `Infinity / Infinity` — the workbook
     *     writes NaN into the "% fully diluted" column, and the cap-table graph
     *     draws every holder at NaN%.
     *   - `liquidationPreference` is what preferred is paid before common. An
     *     infinite one is a preference stack that consumes any exit.
     *
     * Both were persisted as `valid: true`, and both serialise through JSONB as
     * `null` — `JSON.stringify(Infinity)` is `null` — so the stored summary came
     * back from the database with a null where its own type declares a number,
     * and the next reader divided by it.
     *
     * Only asked of rows whose inputs were readable: an unreadable or
     * non-finite cell has already been reported as itself, and saying the
     * product of it does not compute adds nothing.
     */
    if (Number.isFinite(e.shares)) {
      for (const [what, value] of [
        ['as-converted share count', asConvertedShares(e)],
        ['liquidation preference', liquidationPreference(e)],
      ] as const) {
        if (Number.isFinite(value)) continue;
        issues.push({
          ...where,
          severity: 'error',
          code: 'figure_overflows',
          message:
            `${at}"${e.security_class}" has figures too large to compute with — its ${what} ` +
            'overflows. Check the share count, price and multiples on this row.',
        });
      }
    }

    summary.total_shares += Math.max(0, e.shares);
    if (e.class_type === 'common') summary.common_shares += e.shares;
    else if (e.class_type === 'preferred') summary.preferred_shares += e.shares;
    else if (e.class_type === 'option') summary.option_shares += e.shares;
    else if (e.class_type === 'warrant') summary.warrant_shares += e.shares;

    if (e.class_type === 'preferred') {
      const mult = e.liquidation_multiple ?? 1;
      if (e.liquidation_multiple === null && e.unreadable_numbers?.liquidation_multiple === undefined) {
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
   * The same overflow one row up, reached by addition rather than
   * multiplication.
   *
   * A table may carry two thousand rows, so totals overflow on figures no
   * single row would be refused for. The per-row check cannot see it and the
   * summary is what the import screen reports back, so it is asked here — of
   * every total this function publishes, not only the denominator, because each
   * of them is read somewhere as a number.
   */
  for (const [what, value] of [
    ['fully diluted share count', summary.fully_diluted_shares],
    ['total share count', summary.total_shares],
    ['preference stack', summary.total_preference_stack],
  ] as const) {
    if (Number.isFinite(value)) continue;
    issues.push({
      severity: 'error',
      code: 'figure_overflows',
      message: `This cap table's ${what} is too large to compute with — it overflows.`,
    });
  }
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

  /*
   * A preference stack whose order nobody stated.
   *
   * Seniority is the one preferred column the platform *has* to supply itself
   * when the sheet leaves it blank, and what it supplies is load-bearing: it
   * decides which class is paid out of the first dollar of an exit. The rule is
   * that an unstated rank sits pari passu behind every stated one
   * (`toWaterfallInputs`, `capTableGraph.stackOrder`), which is the right
   * reading — nothing on a blank column makes one row junior to another — but
   * it is a reading, and the reader should know it is being made.
   *
   * It was said in exactly one place: `graphIssues.partial_seniority`, on the
   * cap-table *graph* endpoint, and only for the mixed case. The wholly blank
   * case — the ordinary one, since the Pulley preset maps no seniority column
   * at all and a Carta sheet often ships it empty — was silent everywhere, and
   * that is the case where the assumption does the most work: every class in
   * the stack sharing rank 1 splits the senior tranche pro-rata by preference
   * instead of paying out in order.
   *
   * Here rather than only there because this is the validation the import
   * screen shows, the PUT stores and `findCapTable` re-derives on every read,
   * so it reaches the analyst who never opens the graph. A warning, like
   * `default_liq_pref` beside it: a defaulted figure is not a broken row.
   */
  const preferredEntries = entries.filter((e) => e.class_type === 'preferred');
  if (preferredEntries.length > 1) {
    const statedSeniority = preferredEntries.filter((e) => e.seniority !== null).length;
    if (statedSeniority === 0) {
      issues.push({
        severity: 'warning',
        code: 'no_seniority',
        message:
          `None of the ${preferredEntries.length} preferred classes states a seniority, so the whole ` +
          'preference stack is treated as pari passu — every class shares the first dollar of an exit ' +
          'pro-rata by preference rather than being paid in order. Map a seniority column, or set the ' +
          'ranks by hand, if the charter says otherwise.',
      });
    } else if (statedSeniority < preferredEntries.length) {
      // The same rule `graphIssues` states, so a reader who never opens the
      // graph is told the same thing in the same words.
      issues.push({
        severity: 'warning',
        code: 'partial_seniority',
        message:
          `${statedSeniority} of ${preferredEntries.length} preferred classes state a seniority. ` +
          'The rest are treated as pari passu behind them, which may not be what the charter says.',
      });
    }
  }

  /*
   * The totals rows the sheet carried, and what they say about this import.
   *
   * Reported at all because a row silently dropped is indistinguishable from a
   * row silently mis-read: whoever uploaded a 40-class sheet and got 39 classes
   * back is owed the reason, in the one place that still knows it.
   */
  for (const t of totals) {
    const at = t.source_row === undefined ? '' : `Row ${t.source_row}: `;
    issues.push({
      severity: 'warning',
      code: 'totals_row_skipped',
      security_class: t.label,
      row: t.source_row,
      message:
        `${at}"${t.label}" states a total rather than a holding, and was not imported ` +
        'as a security class.',
    });
  }

  /*
   * The sheet's own total, used as a checksum over everything above it.
   *
   * This is the one figure in the file that is a statement about the *import*
   * rather than about a holding, and it is free: if the rows that were read sum
   * to something other than what the sheet says they sum to, then either a row
   * was not read, a share count was read wrongly, or the shares column is
   * mapped one column off. All three are silent otherwise — each produces a
   * table of plausible, finite, internally consistent numbers — and all three
   * change the denominator the 409A divides by.
   *
   * Checked against both bases because the column means one of two things
   * depending on who wrote the sheet: the raw sum of the shares column, or the
   * fully-diluted count with conversion applied. Agreeing with either is
   * agreement; a sheet is not asked to say which it meant.
   *
   * A warning rather than an error. The reasons a legitimate total may differ
   * are real — it may cover a class that the mapping deliberately excludes, or
   * be rounded, or be stale in the source sheet — and refusing the import would
   * make this cross-check a liability rather than a safety net. The last totals
   * row carrying a figure is the grand total; earlier ones are subtotals and
   * are not summed over the whole table.
   */
  const grandTotal = [...totals].reverse().find((t) => t.shares !== null);
  if (grandTotal?.shares != null && entries.length > 0) {
    const stated = grandTotal.shares;
    const tolerance = Math.max(0.5, Math.abs(stated) * 1e-9);
    const agrees =
      Math.abs(stated - summary.total_shares) <= tolerance ||
      Math.abs(stated - summary.fully_diluted_shares) <= tolerance;
    if (!agrees) {
      const at = grandTotal.source_row === undefined ? '' : `Row ${grandTotal.source_row}: `;
      issues.push({
        severity: 'warning',
        code: 'totals_row_mismatch',
        security_class: grandTotal.label,
        row: grandTotal.source_row,
        message:
          `${at}the sheet's "${grandTotal.label}" row states ` +
          `${stated.toLocaleString('en-US')} shares, but the ${entries.length} ` +
          `${entries.length === 1 ? 'row' : 'rows'} imported sum to ` +
          `${summary.total_shares.toLocaleString('en-US')} ` +
          `(${summary.fully_diluted_shares.toLocaleString('en-US')} as converted). ` +
          'Check that every row was read and that the shares column is mapped correctly.',
      });
    }
  }

  /*
   * Errors first, then warnings, and the cap applied to the concatenation.
   *
   * The order is `ValidationBanner`'s own — errors are what block the save, so
   * they stay together at the top — and applying the cap after it is what makes
   * the truncation safe to read: a table whose errors alone exceed the cap
   * shows errors, never a page of warnings with the errors cut off behind them.
   *
   * `valid` is computed over the uncapped list. Deriving it from the kept one
   * would let a table with two hundred warnings and one error past the gate,
   * which is the one thing this list is load-bearing for.
   */
  const valid = !issues.some((i) => i.severity === 'error');
  if (issues.length <= MAX_CAP_TABLE_ISSUES) {
    return { valid, issues, issues_truncated: 0, summary };
  }
  const errors = issues.filter((i) => i.severity === 'error');
  const kept = [...errors, ...issues.filter((i) => i.severity !== 'error')].slice(
    0,
    MAX_CAP_TABLE_ISSUES,
  );
  return { valid, issues: kept, issues_truncated: issues.length - kept.length, summary };
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
  const classes = entries.filter((e) => e.class_type === 'preferred');
  /*
   * The rank an unstated seniority stands in: one below every rank the sheet
   * actually named, shared by all of them.
   *
   * This used to be `e.seniority ?? i + 1` — the row's position among the
   * preferred classes — and that is a strict payment order invented out of the
   * order somebody's spreadsheet happened to list its rounds in. The Pulley
   * preset does not even map a seniority column, so the ordinary Pulley export
   * arrives with the column blank on every row and left here as ranks 1, 2,
   * 3…: the auditor workbook's "Preference stack in seniority order" sheet then
   * prints those ranks in an `integer` column beside the classes, which reads
   * as a stack the file stated. A newest-first sheet and an oldest-first sheet
   * of the same cap table came out as exactly opposite stacks.
   *
   * The platform already has a rule for this and states it to the reader:
   * `capTableGraph.stackOrder` sorts stated seniorities ascending and puts
   * every unstated one *after* them as a single pari passu group, and
   * `graphIssues` raises `partial_seniority` saying so in as many words — "the
   * rest are treated as pari passu behind them". The projection the engine
   * consumes disagreed with the picture drawn beside it: on a table where
   * Series B states rank 2 and Series Seed states nothing, the graph paid B
   * first and Seed after, while this handed the engine two classes at rank 2
   * splitting the tranche pro-rata.
   *
   * Positionally distinct ranks were never a reading of the data — nothing on
   * a blank column says the second row is junior to the first. Pari passu is,
   * and it is the reading the rest of the platform already shows.
   */
  const stated = classes.map((e) => e.seniority).filter((s): s is number => s !== null && Number.isFinite(s));
  // Floored so the rank stays a whole number even off a stored row that
  // predates `bad_seniority` and carries a fractional one: the engine's schema
  // is `an integer >= 1`, and a rank the sheet never stated should not be the
  // reason a table is refused.
  const unstatedRank = stated.length > 0 ? Math.max(1, Math.floor(Math.max(...stated))) + 1 : 1;
  const preferred = classes.map((e) => ({
    security_class: e.security_class,
    shares: e.shares,
    invested_amount: investedAmount(e),
    liquidation_multiple: e.liquidation_multiple ?? 1,
    seniority: e.seniority ?? unstatedRank,
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
