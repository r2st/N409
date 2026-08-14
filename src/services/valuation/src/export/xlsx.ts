/**
 * Dependency-free XLSX (SpreadsheetML) writer for the auditor export
 * (feature-improvements §4 "XLSX export").
 *
 * Reuses the ZIP writer already built for the evidence bundle — an .xlsx *is* a
 * ZIP of a handful of XML parts — so this adds no dependency to a service that
 * deliberately has few. The subset written here is the minimum a spreadsheet
 * needs to open a formatted, multi-sheet workbook: content types, one workbook
 * part, one worksheet part per sheet, a shared style table, and inline strings
 * (no shared-string table, which costs a second pass for no benefit at export
 * sizes).
 *
 * Numbers are written as numbers and dates as serial dates, so an auditor can
 * sum a column without retyping it — the whole reason CSV was not enough. Cells
 * may also carry a formula, which is what makes the exported workbook a model
 * rather than a picture of one.
 */

import { buildZip, type ZipEntry } from './zip.js';

/** Number format applied to a column. Indexes into STYLE_FORMATS. */
/**
 * `pershare` is `currency` at four decimals rather than two.
 *
 * Not a cosmetic variant: the report states every per-share figure — the
 * concluded FMV, an option strike — to four decimals, because that is the
 * precision a §409A opinion concludes to and a grant's strike is set at. Shown
 * through `currency`, $1.4947 reads as $1.49 in the one file an auditor
 * reconciles against the opinion.
 */
export type XlsxFormat = 'text' | 'number' | 'integer' | 'currency' | 'percent' | 'date' | 'pershare';

/** A formula cell: `formula` is the A1-style expression without a leading '='. */
export interface XlsxFormula {
  formula: string;
  /** Last computed value, cached so viewers that do not recalculate still show it. */
  value?: number | null;
}

/**
 * A cell that carries its own format, overriding the column's.
 *
 * Needed because the figures whose precision matters most do not get a column
 * to themselves. The concluded FMV per share sits in the waterfall's invested
 * column, and on the calculation and summary sheets it shares a single "value"
 * column with engine version strings and timestamps — so there is no column
 * format that is right for it and right for its neighbours.
 */
export interface XlsxStyledValue {
  value: string | number | boolean | Date | null | undefined;
  format: XlsxFormat;
}

export type XlsxValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | XlsxFormula
  | XlsxStyledValue;

export interface XlsxColumn {
  header: string;
  /** Width in characters. Defaults to a width derived from the header. */
  width?: number;
  format?: XlsxFormat;
}

export interface XlsxSheet {
  /** Sheet tab name; sanitised and de-duplicated by buildXlsx. */
  name: string;
  columns: XlsxColumn[];
  rows: XlsxValue[][];
  /**
   * Optional lines written above the header (title, provenance). They shift the
   * header down, which is why cellRef() below takes the offset into account.
   */
  titleLines?: string[];
  /** Freeze the header row so long sheets stay readable. Defaults to true. */
  freezeHeader?: boolean;
}

function xmlEscape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * XML 1.0 forbids most control characters outright — no escape exists for them.
 * Company names arriving from cap-table imports have carried stray control
 * bytes, and a single one makes the whole workbook unopenable, so they are
 * dropped rather than escaped.
 */
function stripInvalidXmlChars(s: string): string {
  // Tab, LF and CR are the only control characters XML 1.0 permits.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function text(value: string): string {
  return xmlEscape(stripInvalidXmlChars(value));
}

/** 0-based column index → spreadsheet column letters (0 → A, 26 → AA). */
export function columnLetter(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** A1 reference from 0-based column and 1-based row. */
export function cellRef(colIndex: number, rowNumber: number): string {
  return `${columnLetter(colIndex)}${rowNumber}`;
}

/**
 * Sheet names are more constrained than they look: 31 characters, no
 * []:*?/\ and no leading/trailing apostrophe. Excel refuses to open a file
 * that breaks any of these, and silently truncating to a duplicate name is
 * just as fatal, so names are also de-duplicated with a numeric suffix.
 */
export function sanitizeSheetName(name: string, taken: Set<string>): string {
  let base = stripInvalidXmlChars(name)
    .replace(/[[\]:*?/\\]/g, ' ')
    .trim();
  base = base.replace(/^'+/, '').replace(/'+$/, '').trim();
  if (base === '') base = 'Sheet';
  base = base.slice(0, 31);

  let candidate = base;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    const suffix = ` (${n})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
    n += 1;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Style indexes, in the order they are declared in styles.xml below.
 * 0 must be the default style — Excel requires it.
 */
const STYLE = {
  default: 0,
  title: 1,
  header: 2,
  text: 3,
  number: 4,
  integer: 5,
  currency: 6,
  percent: 7,
  date: 8,
  pershare: 9,
} as const;

const FORMAT_STYLE: Record<XlsxFormat, number> = {
  text: STYLE.text,
  number: STYLE.number,
  integer: STYLE.integer,
  currency: STYLE.currency,
  percent: STYLE.percent,
  date: STYLE.date,
  pershare: STYLE.pershare,
};

/**
 * The 1900 date system Excel uses: day 1 is 1900-01-01, and day 60 is the
 * non-existent 1900-02-29 that Lotus 1-2-3 believed in and Excel preserves for
 * compatibility. 25569 is the offset for the Unix epoch, which already accounts
 * for the phantom day, so dates at or after 1970 need no further correction.
 */
const EPOCH_DAY_OFFSET = 25569;
const MS_PER_DAY = 86_400_000;

export function toExcelSerial(d: Date): number {
  return d.getTime() / MS_PER_DAY + EPOCH_DAY_OFFSET;
}

function isFormula(v: XlsxValue): v is XlsxFormula {
  return typeof v === 'object' && v !== null && !(v instanceof Date) && 'formula' in v;
}

function isStyled(v: XlsxValue): v is XlsxStyledValue {
  return typeof v === 'object' && v !== null && !(v instanceof Date) && 'format' in v;
}

function cellXml(ref: string, value: XlsxValue, styleIndex: number): string {
  // Resolved before anything else, so the wrapper is transparent: the cell it
  // carries is written by exactly the rules below, only against its own style.
  if (isStyled(value)) return cellXml(ref, value.value, FORMAT_STYLE[value.format]);

  const s = styleIndex === 0 ? '' : ` s="${styleIndex}"`;

  if (value === null || value === undefined || value === '') return '';

  if (isFormula(value)) {
    const cached =
      typeof value.value === 'number' && Number.isFinite(value.value) ? `<v>${value.value}</v>` : '';
    return `<c r="${ref}"${s}><f>${text(value.formula)}</f>${cached}</c>`;
  }

  if (typeof value === 'number') {
    // NaN/Infinity have no numeric representation in the format; writing them
    // raw produces a corrupt file, so they degrade to an error literal.
    if (!Number.isFinite(value)) {
      return `<c r="${ref}"${s} t="e"><v>#NUM!</v></c>`;
    }
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }

  if (typeof value === 'boolean') {
    return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return `<c r="${ref}"${s === '' ? ` s="${STYLE.date}"` : s}><v>${toExcelSerial(value)}</v></c>`;
  }

  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${text(value)}</t></is></c>`;
}

function sheetXml(sheet: XlsxSheet): string {
  const titleLines = sheet.titleLines ?? [];
  const headerRowNumber = titleLines.length + 1;
  const freeze = sheet.freezeHeader !== false;

  const cols = sheet.columns
    .map((c, i) => {
      const width = c.width ?? Math.min(40, Math.max(10, c.header.length + 2));
      return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
    })
    .join('');

  const rows: string[] = [];

  titleLines.forEach((line, i) => {
    rows.push(
      `<row r="${i + 1}">${cellXml(cellRef(0, i + 1), line, i === 0 ? STYLE.title : STYLE.text)}</row>`,
    );
  });

  rows.push(
    `<row r="${headerRowNumber}">${sheet.columns
      .map((c, i) => cellXml(cellRef(i, headerRowNumber), c.header, STYLE.header))
      .join('')}</row>`,
  );

  sheet.rows.forEach((row, r) => {
    const rowNumber = headerRowNumber + 1 + r;
    const cells = sheet.columns
      .map((col, i) => cellXml(cellRef(i, rowNumber), row[i], FORMAT_STYLE[col.format ?? 'text']))
      .join('');
    rows.push(`<row r="${rowNumber}">${cells}</row>`);
  });

  // A pane split is expressed in whole rows below the frozen boundary.
  const paneRef = cellRef(0, headerRowNumber + 1);
  const pane = freeze
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRowNumber}" topLeftCell="${paneRef}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';

  const lastCol = columnLetter(Math.max(0, sheet.columns.length - 1));
  const lastRow = headerRowNumber + sheet.rows.length;
  const autoFilter =
    sheet.columns.length > 0 && sheet.rows.length > 0 && titleLines.length === 0
      ? `<autoFilter ref="A${headerRowNumber}:${lastCol}${lastRow}"/>`
      : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}<cols>${cols}</cols><sheetData>${rows.join('')}</sheetData>${autoFilter}</worksheet>`;
}

/**
 * Number formats start at 164 — anything below that is a built-in id reserved
 * by the format, and reusing one silently changes its meaning.
 */
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="5">
<numFmt numFmtId="164" formatCode="#,##0.00"/>
<numFmt numFmtId="165" formatCode="#,##0"/>
<numFmt numFmtId="166" formatCode="0.00%"/>
<numFmt numFmtId="167" formatCode="yyyy\\-mm\\-dd"/>
<numFmt numFmtId="168" formatCode="#,##0.0000"/>
</numFmts>
<fonts count="3">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEFEFEF"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="10">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

export interface XlsxOptions {
  /** Stamped into the archive entries so exports are byte-stable per run. */
  mtime?: Date;
}

/** Builds a complete .xlsx workbook. At least one sheet is required. */
export function buildXlsx(sheets: XlsxSheet[], opts: XlsxOptions = {}): Buffer {
  if (sheets.length === 0) throw new Error('buildXlsx requires at least one sheet');

  const taken = new Set<string>();
  const named = sheets.map((s) => ({ ...s, name: sanitizeSheetName(s.name, taken) }));

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`;

  // Sheet relationship ids start at rId2 — rId1 is the style part.
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
${named.map((s, i) => `<sheet name="${text(s.name)}" sheetId="${i + 1}" r:id="rId${i + 2}"/>`).join('\n')}
</sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
${named.map((_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
</Relationships>`;

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: RELS_XML },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: STYLES_XML },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];

  const mtime = opts.mtime;
  if (mtime) for (const e of entries) e.mtime = mtime;

  return buildZip(entries);
}

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
