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

import { nameColumns, rowByColumn } from './sheetColumns.js';
import { readZip, ZipReadError } from './zipReader.js';
import { quoteForMessage } from './displayText.js';

export class XlsxReadError extends Error {}

export interface XlsxSheetData {
  name: string;
  /** Header-keyed rows, mirroring `parseCsv` output. */
  rows: Record<string, string>[];
  /** Header row in source order, for the column-mapping UI. */
  headers: string[];
  /**
   * Worksheet row number each entry of `rows` came from, 1-based as Excel shows
   * it. Parallel to `rows`, and the reason a validation issue can name the line
   * the reader has open: the preamble, the header and every blank spacer are
   * gone from `rows`, so its indices stopped tracking the sheet long before the
   * first data row.
   */
  lines: number[];
}

/** Excel's day 0. 1899-12-30 absorbs the legacy 1900-is-a-leap-year bug. */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

/** Index of XFD, the last column a worksheet has (ECMA-376 §18.3; 16,384 columns). */
export const MAX_COLUMN = 16_383;

/** Index of the last row a worksheet has (ECMA-376 §18.3; 1,048,576 rows). */
export const MAX_ROW = 1_048_575;

/**
 * Total slots the grids for one workbook may occupy — the blanks a sparse ref
 * pads through, and one apiece for the rows that hold them, since a row is an
 * allocation before it has a cell. Generous next to anything the cap-table
 * route will accept — it truncates at 2,000 rows, and real exports run to tens
 * of columns, so this is two orders of magnitude above a large legitimate
 * import — while still bounding the array slots a single upload can allocate.
 */
export const MAX_GRID_CELLS = 2_000_000;

/**
 * Built-in number formats that denote a date or time (ECMA-376 §18.8.30).
 * Anything else numeric is rendered as a plain number.
 */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/**
 * The five predefined entities.
 *
 * Null-prototyped, and read through `Object.hasOwn` in `decodeXmlText`, because
 * the key is a name out of an uploaded workbook. `&constructor;` is letters and
 * nothing else, so it matches the named-entity branch; on a plain object
 * literal that lookup is answered from `Object.prototype` with a function,
 * which is not nullish, so the `?? match` that leaves `&unknown;` alone never
 * ran and the cell imported as `function Object() { [native code] }` — a
 * stakeholder name, a security class, or a share count that then fails to
 * parse as a number.
 */
const XML_ENTITIES: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});

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
  // Every reference this function resolves starts with `&`, so a value without
  // one is already its own answer. Worth the check because of where this is
  // called from: every attribute and every `<v>` of every cell, two million of
  // them at the grid budget, and a spreadsheet's cells are numbers and names
  // that carry no entity at all.
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      // An out-of-range reference is left as written, like an unknown named
      // entity — the alternative is a RangeError escaping a parser whose whole
      // contract is to raise XlsxReadError so the upload answers 422, not 500.
      return isScalarValue(code) ? String.fromCodePoint(code) : match;
    }
    return Object.hasOwn(XML_ENTITIES, body) ? XML_ENTITIES[body]! : match;
  });
}

/**
 * The pattern `attr` uses, one per attribute name rather than one per call.
 *
 * There are ten names in this file and they are all literals; the cell reader
 * asks for two or three of them per `<c>`, so a `new RegExp` inside `attr` was
 * a compile per cell — two hundred thousand of them for a forty-thousand-row
 * import, and the grid budget allows two million cells. Cached by name, which
 * is the only thing the pattern varies by.
 *
 * The map is keyed by a name this module supplies, never by anything off the
 * uploaded part, so it cannot be grown by an upload. `Map` rather than an
 * object literal for the reason `prototypeChainLookups` gives: a plain object
 * answers `__proto__` with something that is not a RegExp.
 */
const ATTR_PATTERNS = new Map<string, RegExp>();

function attrPattern(name: string): RegExp {
  let re = ATTR_PATTERNS.get(name);
  if (re === undefined) {
    re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`);
    ATTR_PATTERNS.set(name, re);
  }
  return re;
}

/** Read an attribute off a raw element tag (`<c r="A1" t="s">`). */
function attr(tag: string, name: string): string | undefined {
  // Not a `g` pattern, so there is no `lastIndex` to reset between calls — a
  // cached regex is safe to share only because of that.
  const m = attrPattern(name).exec(tag);
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

/**
 * A word character, so `\b` does not hold after the tag name — the test that
 * keeps `<c>` from matching the `<col>` that precedes every `sheetData`.
 */
function continuesName(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x5f // _
  );
}

/**
 * Iterate raw `<tag ...>inner</tag>` and `<tag ... />` occurrences.
 *
 * Scanned by hand rather than by regex. The pattern this replaces —
 * `<tag\b([^>]*?)(/>|>([\s\S]*?)</tag>)` — is quadratic on a part that opens
 * elements it never closes: every `<tag` is a candidate, and each one rescans
 * to the end of the part before failing, so the work is the square of the
 * input. Measured, 100,000 unclosed `<row r="1">` held the event loop for 19
 * seconds, and they cost 2 KB on the wire — a workbook sitting well inside the
 * decompression budget of `readZip` parks the process for days.
 *
 * That is worse than the allocation bounds above it rather than more of the
 * same. The scan is synchronous, so no request timeout interrupts it, nothing
 * throws, and the stall is not confined to the request that bought it: one
 * upload takes every other request on the process down with it.
 *
 * Scanning forward makes those failures terminal instead of repeated. `>` and
 * `</tag>` only ever move later in the part, so a search that comes back empty
 * has settled the question for every `<tag` after it too, and is not run again.
 * Each step consumes what it reads, which is what makes the pass linear.
 *
 * Note that a missing `</tag>` rules out only the paired form: a self-closing
 * element still matches on `>` alone, so the scan continues looking for those.
 * The regex arrived at that by backtracking to a later start; here it is the
 * `closable` flag, and a differential run over both settled the parity.
 *
 * `closed` distinguishes the two forms, which callers that want a container's
 * contents need: `<v/>` is an empty element, not a `<v>` holding nothing.
 */
function* elements(xml: string, tag: string): Generator<{ tag: string; inner: string; closed: boolean }> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let at = 0;
  let closable = true;

  while ((at = xml.indexOf(open, at)) !== -1) {
    const nameEnd = at + open.length;
    if (continuesName(xml.charCodeAt(nameEnd))) {
      at = nameEnd; // a longer name that merely starts the same way
      continue;
    }

    // Attributes cannot hold a `>`, so the first one ends the tag either way.
    const tagEnd = xml.indexOf('>', nameEnd);
    if (tagEnd === -1) return; // left open at the end of the part, as is all that follows
    if (xml.charCodeAt(tagEnd - 1) === 0x2f) {
      yield { tag: xml.slice(nameEnd, tagEnd - 1), inner: '', closed: false }; // <tag ... />
      at = tagEnd + 1;
      continue;
    }

    // Every `<tag` between here and `tagEnd` shares this `>`, and shares that it
    // is not the `/` of a self-closing form — so skipping them costs no match.
    if (!closable) {
      at = tagEnd + 1;
      continue;
    }
    const closeAt = xml.indexOf(close, tagEnd + 1);
    if (closeAt === -1) {
      closable = false; // no `</tag>` remains for this one or for any after it
      at = tagEnd + 1;
      continue;
    }
    yield { tag: xml.slice(nameEnd, tagEnd), inner: xml.slice(tagEnd + 1, closeAt), closed: true };
    at = closeAt + close.length;
  }
}

/**
 * Contents of the first `<tag>...</tag>` in the part, or undefined when the
 * part holds no closed one.
 *
 * This is the single-element counterpart to `elements`, and it exists for the
 * same reason. Reaching for one container by regex — `<tag\b[^>]*>([\s\S]*?)
 * </tag>` — is quadratic exactly as the iterating form was: every `<tag` is a
 * candidate start, and with no `</tag>` to be found each one rescans to the end
 * of the part before failing. The shape hid here longer because a lone `.exec`
 * reads like it looks at the input once.
 *
 * It is the cheaper of the two to reach. Measured, 2 MB of `<sheetData>` opens
 * held the event loop for 69 seconds, and deflate to 4 KB on the wire; at the
 * ZIP reader's 16 MB floor on inflation — which every upload gets, whatever its
 * size — that is a little over an hour, and at its 128 MB ceiling, days.
 *
 * The generator is lazy, so returning at the first closed element reads no
 * further than that element's `</tag>`, and an absent one costs a single pass.
 */
function pairedInner(xml: string, tag: string): string | undefined {
  for (const el of elements(xml, tag)) {
    if (el.closed) return el.inner;
  }
  return undefined;
}

/**
 * A rich-text item with its phonetic guides removed.
 *
 * `<si>` and `<is>` hold two kinds of `<t>`. The formatting runs — `<r><t>` —
 * are the value, split only because parts of it are bold or coloured. The
 * phonetic runs — `<rPh sb=".." eb=".."><t>` — are *not* the value: they are
 * the furigana Excel stores beside East Asian text, keyed to a span of it, and
 * Excel shows them above the cell rather than in it. Every workbook typed with
 * a Japanese IME carries them, on names in particular, and concatenating every
 * `<t>` alike turned a shareholder called 山田太郎 into 山田太郎ヤマダタロウ on
 * import — a name that matches nothing, in the column the whole cap table is
 * keyed by.
 *
 * Removed by a forward scan for the same reason `elements` is one: cutting the
 * spans with `/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g` is quadratic on a part that
 * opens one it never closes, and this runs over the shared-string table, which
 * is the largest part of a real workbook. Each `indexOf` resumes where the last
 * finished, so the pass is linear whatever the input claims.
 *
 * An `<rPh` with no `</rPh>` after it takes the rest of the item with it: the
 * document says everything from there on is inside a phonetic run, and reading
 * it as the value is the direction this function exists to avoid.
 */
function withoutPhoneticRuns(xml: string): string {
  if (!xml.includes('<rPh')) return xml;
  const CLOSE = '</rPh>';
  let out = '';
  let at = 0;
  for (;;) {
    const open = xml.indexOf('<rPh', at);
    if (open === -1) return out + xml.slice(at);
    const nameEnd = open + '<rPh'.length;
    if (continuesName(xml.charCodeAt(nameEnd))) {
      // A longer name that merely starts the same way (`<rPhX`), kept as text.
      out += xml.slice(at, nameEnd);
      at = nameEnd;
      continue;
    }
    const tagEnd = xml.indexOf('>', nameEnd);
    if (tagEnd === -1) return out + xml.slice(at, open);
    out += xml.slice(at, open);
    if (xml.charCodeAt(tagEnd - 1) === 0x2f) {
      at = tagEnd + 1; // `<rPh/>` — an empty guide, nothing to skip past
      continue;
    }
    const closeAt = xml.indexOf(CLOSE, tagEnd + 1);
    if (closeAt === -1) return out;
    at = closeAt + CLOSE.length;
  }
}

/** Concatenate the `<t>` runs inside a shared-string or inline-string item. */
function textRuns(xml: string): string {
  let out = '';
  for (const { inner } of elements(withoutPhoneticRuns(xml), 't')) out += decodeXmlText(inner);
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
 * A bracketed section that is a *token* rather than a modifier.
 *
 * Square brackets in a format code carry two unrelated things. One is elapsed
 * time — `[h]`, `[mm]`, `[ss]` — which is a genuine time token and the reason
 * the brackets cannot simply be discarded. Everything else in brackets is a
 * modifier attached to a format that is not a date at all: a colour
 * (`[Red]`), a condition (`[>1000]`), or a locale/currency (`[$-409]`,
 * `[$USD]`).
 */
const ELAPSED_TIME_SECTION = /^(h+|m+|s+)$/i;

/**
 * Does this custom format code render its cell as a date or a time?
 *
 * The test is "does a date token survive the literal text", and the literal
 * text is three things, not one. Quoted runs and backslash escapes were both
 * stripped; the bracketed modifiers were not, and they are the ones that spell
 * ordinary words:
 *
 *   `#,##0.00;[Red]-#,##0.00`   → the `d` of "Red"
 *   `[Yellow]#,##0`             → the `y` of "Yellow"
 *   `[Magenta]0`                → the `m` of "Magenta"
 *   `[White]0.0000`             → the `h` of "White"
 *   `[$USD]#,##0.00`            → the `d` and the `s` of "USD"
 *
 * Every one of those is a *currency or number* format, and every one of them
 * was classified as a date — so `cellText` handed the cell to
 * `excelSerialToIso` and a share count of 45,352 arrived in the import as
 * "2024-03-01". The red-negative pair is the one that matters: it is what a
 * spreadsheet reaches for on exactly the columns this reader exists to read,
 * the money and share columns of a cap table, and the corruption is silent —
 * the column mapper sees a well-formed string and the row fails validation
 * (or worse, coerces) for a reason nothing on the page can explain.
 *
 * Brackets are therefore dropped like the other literals, with the elapsed-time
 * sections kept because those are real tokens. Order matters: quoted runs go
 * first so a `[` inside one cannot open a section, and escapes before brackets
 * so an escaped `\[` is not read as one.
 *
 * An unterminated `[` runs to the end of the code rather than being left as
 * text. Nothing writes one on purpose, so the question is only which way to be
 * wrong about a malformed code — and reading `0.00[Red` as a date is the
 * expensive direction, since that is the failure this function exists to stop.
 */
export function looksLikeDateFormat(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[([^\]]*)(?:\]|$)/g, (_match, body: string) => (ELAPSED_TIME_SECTION.test(body) ? body : ''));
  return /[dmyhs]/i.test(bare);
}

/**
 * `xl/styles.xml` → for each cell format index, whether it renders as a date.
 * Custom formats (numFmtId ≥ 164) are classified by looking for date tokens in
 * the format code, ignoring anything the code carries as literal text — see
 * {@link looksLikeDateFormat}.
 */
function parseDateStyles(part: Buffer | undefined): boolean[] {
  if (!part) return [];
  const xml = part.toString('utf8');

  const dateFormatIds = new Set(BUILTIN_DATE_FORMATS);
  for (const { tag } of elements(xml, 'numFmt')) {
    const id = Number(attr(tag, 'numFmtId'));
    const code = attr(tag, 'formatCode') ?? '';
    if (Number.isFinite(id) && looksLikeDateFormat(code)) dateFormatIds.add(id);
  }

  const cellXfs = pairedInner(xml, 'cellXfs') ?? '';
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
 *
 * THE POSITION THE GUESS COUNTS FROM (R429, methodology M5). When a `<sheet>`
 * carries no resolvable `r:id` — no relationships part at all, which is a
 * simple workbook, or a damaged one — the path is guessed as the Nth
 * worksheet. `N` was `sheets.length + 1`: the number of sheets *paired so far*,
 * not the position of the sheet being read. Those two are the same number only
 * while nothing is missing, and this fallback exists precisely for files where
 * something is.
 *
 * So a workbook declaring `Cap Table`, `Budget`, `P&L` whose package holds
 * `sheet1.xml` and `sheet3.xml` — a partial download, a repair, an exporter
 * that skipped a tab — paired `Cap Table` and then looked for `sheet2.xml`
 * twice, and the P&L was dropped without a word. The route above only speaks
 * up when *nothing* pairs; a picker one tab short is indistinguishable from a
 * workbook that has one tab fewer. Reorder the missing part and it is worse
 * than a loss: the name of one tab arrives over the rows of another, which is
 * the failure R390 fixed in the AI tier's reader ("confidently pulled share
 * classes out of a P&L") standing here in the tier where an analyst then picks
 * a tab by its name and imports it as the cap table.
 *
 * Counting from the declared position makes the guess mean what it says — the
 * Nth sheet of the workbook is `sheetN.xml` — and it is unchanged for every
 * intact file, where the two counts agree.
 *
 * The second half is the same rule from the other side: a guessed path that
 * another `<sheet>` has already claimed through a *relationship* is not this
 * sheet's, and taking it would put one part's rows under two tab names, one of
 * them wrong. It is dropped rather than duplicated.
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

  // Two passes, because a stated pairing outranks a positional one wherever the
  // two collide — and a one-pass walk decides that by which tab happens to come
  // first in the XML.
  const declared: Array<{ name: string; path: string; stated: boolean }> = [];
  for (const { tag } of elements(workbook.toString('utf8'), 'sheet')) {
    const position = declared.length + 1;
    const name = attr(tag, 'name') ?? `Sheet${position}`;
    const rid = attr(tag, 'r:id') ?? attr(tag, 'id');
    const target = rid ? rels.get(rid) : undefined;
    // Targets are relative to xl/ unless rooted at the package root.
    const path = target
      ? target.startsWith('/')
        ? target.slice(1)
        : `xl/${target.replace(/^\.\//, '')}`
      : `xl/worksheets/sheet${position}.xml`;
    declared.push({ name, path, stated: target !== undefined });
  }

  const claimed = new Set(declared.filter((d) => d.stated).map((d) => d.path));
  const sheets: Array<{ name: string; path: string }> = [];
  const taken = new Set<string>();
  for (const { name, path, stated } of declared) {
    if (!parts.has(path)) continue;
    // One part cannot be two tabs: a guess never takes a path a relationship
    // names, and no path is emitted twice under two names.
    if (!stated && claimed.has(path)) continue;
    if (taken.has(path)) continue;
    taken.add(path);
    sheets.push({ name, path });
  }
  return sheets;
}

/** One `<c>` element → its display string. */
function cellText(tag: string, inner: string, shared: string[], dateStyles: boolean[]): string {
  const type = attr(tag, 't') ?? 'n';

  if (type === 'inlineStr') return textRuns(inner).trim();
  if (type === 'e') return ''; // #REF!, #N/A — treated as blank, not as text

  const raw = pairedInner(inner, 'v');
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

const overGridBudget = () =>
  new XlsxReadError(`Worksheet needs more than ${MAX_GRID_CELLS.toLocaleString('en-US')} cells to lay out`);

/**
 * Rows of raw cell strings, positioned by column reference.
 *
 * A `<c>` with an explicit ref jumps past the empty columns before it, and the
 * grid is padded to reach it — so the cost of a cell is set by the *reference*,
 * not by the bytes that carry it. The bounds below exist because of that gap;
 * none is redundant, and the ZIP reader's decompression budget catches none of
 * them, because every one of these attacks fits comfortably inside it.
 *
 * `budget` is spent across the whole workbook rather than per sheet, since the
 * sheets are parsed into memory together. Rows spend from it too: a row is an
 * array whether or not it holds a cell.
 */
function parseSheetGrid(
  xml: string,
  shared: string[],
  dateStyles: boolean[],
  budget: { remaining: number },
): { grid: string[][]; rowNumbers: number[] } {
  const sheetData = pairedInner(xml, 'sheetData') ?? '';
  const grid: string[][] = [];
  /** The `r` of each `<row>`, so a sheet that omits rows entirely keeps its numbering. */
  const rowNumbers: number[] = [];

  for (const { tag: rowTag, inner: rowXml } of elements(sheetData, 'row')) {
    // A row is an allocation before any cell is, and `<row/>` is six bytes that
    // pads no columns — so a budget counting only cells counts it free, and 17 MB
    // of them (26 KB on the wire) took 132 MB of heap having spent nothing. The
    // bounds mirror the two on columns for the same reasons: past the last row a
    // worksheet has is not a workbook, and the budget is what holds when every
    // row is individually legal.
    if (grid.length > MAX_ROW) {
      throw new XlsxReadError(
        `Worksheet has more than ${(MAX_ROW + 1).toLocaleString('en-US')} rows, the most a worksheet has`,
      );
    }
    if (budget.remaining < 1) throw overGridBudget();
    budget.remaining -= 1;

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
          // Quoted through the same bound the ZIP entry names use: `ref` is an
          // attribute value out of the uploaded XML, so its length and its
          // characters are the caller's, and this sentence becomes a 422
          // `detail` a person reads.
          `Cell reference "${quoteForMessage(ref ?? '')}" is past column XFD, the last column a worksheet has`,
        );
      }

      // Refs within XFD are still not self-limiting: one legal `<c r="XFD1"/>` costs a
      // row 16,384 slots for ~26 bytes of XML, so a merely large sheet of them multiplies
      // to the same place. What bounds the grid is its total width across every row.
      const growth = Math.max(0, column + 1 - cells.length);
      if (growth > budget.remaining) throw overGridBudget();
      budget.remaining -= growth;

      while (cells.length < column) cells.push('');
      cells[column] = cellText(tag, inner, shared, dateStyles);
      nextColumn = column + 1;
    }
    grid.push(cells);
    // `<row>` is sparse the same way `<c>` is: a sheet with nothing on rows
    // 5-8 simply has no elements for them, so counting positions would report
    // every row after a gap several lines too early. The `r` attribute is the
    // sheet's own numbering; falling back to the position keeps a file that
    // omits it readable.
    const declared = Number(attr(rowTag, 'r'));
    rowNumbers.push(Number.isInteger(declared) && declared > 0 ? declared : grid.length);
  }
  return { grid, rowNumbers };
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
 *
 * The header row is named through `nameColumns`, the same call `parseCsvSheet`
 * makes, because "matching `parseCsv`" was only true of the blank-header half.
 * Duplicates were still keyed last-wins here: a Carta workbook with a granted
 * and an outstanding "Shares" column reported the name twice in the mapping UI,
 * both entries resolved to the second column, and the first column's numbers
 * were unreachable — no error, a cap table short by one holding per row. The
 * CSV path suffixes the repeat to `Shares (2)`; exported as `.xlsx`, which is
 * what every provider writes by default, the same file did not.
 */
export function gridToRows(
  grid: string[][],
  rowNumbers?: readonly number[],
): { headers: string[]; rows: Record<string, string>[]; lines: number[] } {
  const multiCell = grid.findIndex((row) => populatedCells(row) >= 2);
  const headerIndex = multiCell === -1 ? grid.findIndex((row) => populatedCells(row) > 0) : multiCell;
  if (headerIndex === -1) return { headers: [], rows: [], lines: [] };

  const columns = nameColumns(grid[headerIndex]!);
  const rows: Record<string, string>[] = [];
  const lines: number[] = [];
  for (const [offset, row] of grid.slice(headerIndex + 1).entries()) {
    if (!row.some((cell) => cell.trim() !== '')) continue;
    rows.push(rowByColumn(columns, row));
    const index = headerIndex + 1 + offset;
    // Without the sheet's own numbering the grid position is all there is, and
    // it is right for every sheet that declares no gaps.
    lines.push(rowNumbers?.[index] ?? index + 1);
  }
  return { headers: columns.filter((c): c is string => c !== null), rows, lines };
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
    const { grid, rowNumbers } = parseSheetGrid(
      parts.get(path)!.toString('utf8'),
      shared,
      dateStyles,
      budget,
    );
    const { headers, rows, lines } = gridToRows(grid, rowNumbers);
    return { name, headers, rows, lines };
  });
}

/** The `.xlsx` magic bytes — a ZIP local file header. */
export function looksLikeXlsx(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}
