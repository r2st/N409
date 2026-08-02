/**
 * Excel (`.xlsx`) reader — pure functions, no external dependency, the import
 * counterpart to the workbook writer in `export/xlsx.ts`.
 *
 * Cap-table exports from Carta, Pulley and most fund administrators are `.xlsx`
 * by default, so requiring a CSV conversion pushed a manual step onto every
 * import. This turns a workbook into the same `Record<string, string>[]` shape
 * `parseCsv` produces, so the existing column mapping, validation and waterfall
 * projection in `domain/capTable.ts` apply unchanged.
 *
 * OOXML is a ZIP of XML parts. Rather than a full XML parser we scan the few
 * elements a sheet actually uses — the schema for `sheetData` is flat and
 * stable, and the alternative is a dependency for one file shape.
 */

import { readZip, ZipReadError } from './zipReader.js';

export class XlsxReadError extends Error {}

export interface XlsxSheetData {
  name: string;
  /** Header-keyed rows, mirroring `parseCsv` output. */
  rows: Record<string, string>[];
  /** Header row in source order, for the column-mapping UI. */
  headers: string[];
}

/** Excel's day 0. 1899-12-30 absorbs the legacy 1900-is-a-leap-year bug. */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

/** Index of XFD, the last column a worksheet has (ECMA-376 §18.3; 16,384 columns). */
export const MAX_COLUMN = 16_383;

/**
 * Total cells the grids for one workbook may occupy, counting the blanks a
 * sparse ref pads through. Generous next to anything the cap-table route will
 * accept — it truncates at 2,000 rows, and real exports run to tens of columns,
 * so this is two orders of magnitude above a large legitimate import — while
 * still bounding the array slots a single upload can allocate.
 */
export const MAX_GRID_CELLS = 2_000_000;

/**
 * Built-in number formats that denote a date or time (ECMA-376 §18.8.30).
 * Anything else numeric is rendered as a plain number.
 */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Is this a code point `String.fromCodePoint` will accept — a Unicode scalar
 * value? Past U+10FFFF it throws a `RangeError` rather than returning anything,
 * and surrogates are the halves of a pair rather than characters in their own
 * right. XML forbids both in a character reference, and a lone surrogate does
 * not survive the trip through UTF-8 into the database either.
 */
function isScalarValue(code: number): boolean {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return false;
  return code < 0xd800 || code > 0xdfff;
}

/** Resolve the five predefined entities plus numeric character references. */
export function decodeXmlText(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      // An out-of-range reference is left as written, like an unknown named
      // entity — the alternative is a RangeError escaping a parser whose whole
      // contract is to raise XlsxReadError so the upload answers 422, not 500.
      return isScalarValue(code) ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES[body] ?? match;
  });
}

/** Read an attribute off a raw element tag (`<c r="A1" t="s">`). */
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? decodeXmlText(m[1]!) : undefined;
}

/** `A` → 0, `Z` → 25, `AA` → 26. Returns null when the ref has no letters. */
export function columnIndex(ref: string): number | null {
  const letters = /^([A-Za-z]+)/.exec(ref)?.[1];
  if (!letters) return null;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Render an Excel date serial as `YYYY-MM-DD`, or with a time component when
 * the serial has a fractional part. Serials are naive local dates in Excel, so
 * they are read and written in UTC to avoid a timezone shifting the day.
 */
export function excelSerialToIso(serial: number): string {
  const ms = EXCEL_EPOCH_MS + Math.round(serial * MS_PER_DAY);
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return String(serial);
  const iso = date.toISOString();
  // A whole-day serial carries no meaningful time — keep the date alone.
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}

/** Iterate raw `<tag ...>inner</tag>` and `<tag ... />` occurrences. */
function* elements(xml: string, tag: string): Generator<{ tag: string; inner: string }> {
  const re = new RegExp(`<${tag}\\b([^>]*?)(/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    yield { tag: m[1] ?? '', inner: m[2] === '/>' ? '' : (m[3] ?? '') };
  }
}

/** Concatenate the `<t>` runs inside a shared-string or inline-string item. */
function textRuns(xml: string): string {
  let out = '';
  for (const { inner } of elements(xml, 't')) out += decodeXmlText(inner);
  return out;
}

/** `xl/sharedStrings.xml` → the string table cells index into. */
function parseSharedStrings(part: Buffer | undefined): string[] {
  if (!part) return [];
  const xml = part.toString('utf8');
  const strings: string[] = [];
  for (const { inner } of elements(xml, 'si')) strings.push(textRuns(inner));
  return strings;
}

/**
 * `xl/styles.xml` → for each cell format index, whether it renders as a date.
 * Custom formats (numFmtId ≥ 164) are classified by looking for date tokens in
 * the format code, ignoring anything inside a literal quoted section.
 */
function parseDateStyles(part: Buffer | undefined): boolean[] {
  if (!part) return [];
  const xml = part.toString('utf8');

  const dateFormatIds = new Set(BUILTIN_DATE_FORMATS);
  for (const { tag } of elements(xml, 'numFmt')) {
    const id = Number(attr(tag, 'numFmtId'));
    const code = attr(tag, 'formatCode') ?? '';
    const bare = code.replace(/"[^"]*"/g, '').replace(/\\./g, '');
    if (Number.isFinite(id) && /[dmyhs]/i.test(bare)) dateFormatIds.add(id);
  }

  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  const isDate: boolean[] = [];
  for (const { tag } of elements(cellXfs, 'xf')) {
    isDate.push(dateFormatIds.has(Number(attr(tag, 'numFmtId') ?? '0')));
  }
  return isDate;
}

/**
 * Sheet name → part path, in workbook order. The `r:id` on each `<sheet>` is
 * resolved through the workbook relationships part; sheet order in the XML is
 * not guaranteed to match `worksheets/sheetN.xml` numbering.
 */
function parseSheetIndex(parts: Map<string, Buffer>): Array<{ name: string; path: string }> {
  const workbook = parts.get('xl/workbook.xml');
  if (!workbook) throw new XlsxReadError('Not an Excel workbook (xl/workbook.xml is missing)');

  const rels = new Map<string, string>();
  const relsXml = parts.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  for (const { tag } of elements(relsXml, 'Relationship')) {
    const id = attr(tag, 'Id');
    const target = attr(tag, 'Target');
    if (id && target) rels.set(id, target);
  }

  const sheets: Array<{ name: string; path: string }> = [];
  for (const { tag } of elements(workbook.toString('utf8'), 'sheet')) {
    const name = attr(tag, 'name') ?? `Sheet${sheets.length + 1}`;
    const rid = attr(tag, 'r:id') ?? attr(tag, 'id');
    const target = rid ? rels.get(rid) : undefined;
    // Targets are relative to xl/ unless rooted at the package root.
    const path = target
      ? target.startsWith('/')
        ? target.slice(1)
        : `xl/${target.replace(/^\.\//, '')}`
      : `xl/worksheets/sheet${sheets.length + 1}.xml`;
    if (parts.has(path)) sheets.push({ name, path });
  }
  return sheets;
}

/** One `<c>` element → its display string. */
function cellText(tag: string, inner: string, shared: string[], dateStyles: boolean[]): string {
  const type = attr(tag, 't') ?? 'n';

  if (type === 'inlineStr') return textRuns(inner).trim();
  if (type === 'e') return ''; // #REF!, #N/A — treated as blank, not as text

  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
  if (raw === undefined) return type === 'str' ? textRuns(inner).trim() : '';
  const value = decodeXmlText(raw).trim();

  if (type === 's') {
    const index = Number(value);
    return (Number.isInteger(index) ? shared[index] : undefined)?.trim() ?? '';
  }
  if (type === 'str') return value;
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE';

  // Numeric: a date-formatted cell is rendered as a date so downstream parsing
  // sees `2024-03-01` rather than the serial `45352`.
  const styleIndex = Number(attr(tag, 's') ?? '0');
  const num = Number(value);
  if (Number.isFinite(num) && dateStyles[styleIndex] === true) return excelSerialToIso(num);
  return value;
}

/**
 * Rows of raw cell strings, positioned by column reference.
 *
 * A `<c>` with an explicit ref jumps past the empty columns before it, and the
 * grid is padded to reach it — so the cost of a cell is set by the *reference*,
 * not by the bytes that carry it. Both bounds below exist because of that gap;
 * neither is redundant, and the ZIP reader's decompression budget catches
 * neither, because both attacks fit comfortably inside it.
 *
 * `budget` is spent across the whole workbook rather than per sheet, since the
 * sheets are parsed into memory together.
 */
function parseSheetGrid(
  xml: string,
  shared: string[],
  dateStyles: boolean[],
  budget: { remaining: number },
): string[][] {
  const sheetData = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml)?.[1] ?? '';
  const grid: string[][] = [];

  for (const { inner: rowXml } of elements(sheetData, 'row')) {
    const cells: string[] = [];
    let nextColumn = 0;
    for (const { tag, inner } of elements(rowXml, 'c')) {
      // `<c>` elements are sparse: an explicit ref jumps past empty columns.
      const ref = attr(tag, 'r');
      const column = (ref ? columnIndex(ref) : null) ?? nextColumn;

      // A ref is just letters, and nothing in the format bounds how many. `AAAAAAA1`
      // is eight bytes asking for column 321,272,406; enough letters and the index is
      // Infinity. Excel cannot write past XFD, so anything beyond it is not a workbook
      // that lost precision — it is a file that was never one.
      if (column > MAX_COLUMN) {
        throw new XlsxReadError(
          `Cell reference "${ref}" is past column XFD, the last column a worksheet has`,
        );
      }

      // Refs within XFD are still not self-limiting: one legal `<c r="XFD1"/>` costs a
      // row 16,384 slots for ~26 bytes of XML, so a merely large sheet of them multiplies
      // to the same place. What bounds the grid is its total width across every row.
      const growth = Math.max(0, column + 1 - cells.length);
      if (growth > budget.remaining) {
        throw new XlsxReadError(
          `Worksheet needs more than ${MAX_GRID_CELLS.toLocaleString('en-US')} cells to lay out`,
        );
      }
      budget.remaining -= growth;

      while (cells.length < column) cells.push('');
      cells[column] = cellText(tag, inner, shared, dateStyles);
      nextColumn = column + 1;
    }
    grid.push(cells);
  }
  return grid;
}

/** Count of cells in a row that hold something other than whitespace. */
function populatedCells(row: string[]): number {
  return row.reduce((n, cell) => (cell.trim() === '' ? n : n + 1), 0);
}

/**
 * Turn a grid into header-keyed rows.
 *
 * Real exports rarely start at A1: they carry blank spacer rows and a title or
 * provenance line ("Acme Inc — capitalization as of 2024-03-01") above the
 * header. Those preamble lines occupy a single cell, so the header is taken as
 * the first row with at least two populated cells — a cap table always has at
 * least a class and a share count. A one-column sheet has no such row, so that
 * falls back to the first populated row. Rows where every cell is blank are
 * dropped, matching `parseCsv`.
 */
export function gridToRows(grid: string[][]): { headers: string[]; rows: Record<string, string>[] } {
  const multiCell = grid.findIndex((row) => populatedCells(row) >= 2);
  const headerIndex = multiCell === -1 ? grid.findIndex((row) => populatedCells(row) > 0) : multiCell;
  if (headerIndex === -1) return { headers: [], rows: [] };

  const headers = grid[headerIndex]!.map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (const row of grid.slice(headerIndex + 1)) {
    if (!row.some((cell) => cell.trim() !== '')) continue;
    const obj: Record<string, string> = {};
    headers.forEach((header, i) => {
      if (header !== '') obj[header] = (row[i] ?? '').trim();
    });
    rows.push(obj);
  }
  return { headers: headers.filter((h) => h !== ''), rows };
}

/**
 * Read every worksheet in an `.xlsx` file. Throws `XlsxReadError` for anything
 * that is not a readable workbook so the route can answer with a 422 rather
 * than a 500.
 */
export function readXlsx(buf: Buffer): XlsxSheetData[] {
  let parts: Map<string, Buffer>;
  try {
    parts = readZip(buf);
  } catch (err) {
    if (err instanceof ZipReadError) throw new XlsxReadError(`Could not read the workbook: ${err.message}`);
    throw err;
  }

  const shared = parseSharedStrings(parts.get('xl/sharedStrings.xml'));
  const dateStyles = parseDateStyles(parts.get('xl/styles.xml'));

  const budget = { remaining: MAX_GRID_CELLS };
  return parseSheetIndex(parts).map(({ name, path }) => {
    const grid = parseSheetGrid(parts.get(path)!.toString('utf8'), shared, dateStyles, budget);
    const { headers, rows } = gridToRows(grid);
    return { name, headers, rows };
  });
}

/** The `.xlsx` magic bytes — a ZIP local file header. */
export function looksLikeXlsx(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}
