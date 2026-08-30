import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildXlsx,
  cellRef,
  columnLetter,
  MAX_CELL_CHARS,
  sanitizeSheetName,
  toExcelSerial,
  type XlsxSheet,
} from '../../src/export/xlsx.js';

/**
 * The writer emits a real ZIP, so the tests read the parts back out with the
 * system `unzip` rather than trusting the bytes we just wrote. That is what
 * catches an archive Excel would reject but a string assertion would not.
 *
 * The archive goes to a temp file rather than unzip's stdin: the format is read
 * back-to-front from the end-of-central-directory record, so the reader must be
 * able to seek and a pipe cannot.
 */
const dir = mkdtempSync(path.join(tmpdir(), 'n409-xlsx-'));
let seq = 0;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(zip: Buffer): string {
  const file = path.join(dir, `wb-${seq++}.xlsx`);
  writeFileSync(file, zip);
  return file;
}

function unzipEntry(zip: Buffer, name: string): string {
  // unzip globs its name arguments, so [Content_Types].xml needs escaping.
  const pattern = name.replace(/([[\]*?])/g, '\\$1');
  return execFileSync('unzip', ['-p', write(zip), pattern], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function listEntries(zip: Buffer): string[] {
  return execFileSync('unzip', ['-Z1', write(zip)], { encoding: 'utf8' })
    .trim()
    .split('\n');
}

/** `unzip -t` is the closest cheap proxy for "a reader will accept this". */
function assertArchiveIntact(zip: Buffer): void {
  const out = execFileSync('unzip', ['-t', write(zip)], { encoding: 'utf8' });
  expect(out).toContain('No errors detected');
}

const simpleSheet: XlsxSheet = {
  name: 'Data',
  columns: [
    { header: 'Company', format: 'text' },
    { header: 'Shares', format: 'integer' },
    { header: 'Price', format: 'currency' },
  ],
  rows: [
    ['Acme, Inc.', 1_000_000, 1.25],
    ['Globex', 250_000, null],
  ],
};

describe('columnLetter / cellRef', () => {
  it('maps the single-letter range', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
  });

  it('rolls over into two letters at the right boundary', () => {
    // The off-by-one here is the classic bug: column 26 is AA, not BA or Z1.
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(27)).toBe('AB');
    expect(columnLetter(51)).toBe('AZ');
    expect(columnLetter(52)).toBe('BA');
    expect(columnLetter(701)).toBe('ZZ');
    expect(columnLetter(702)).toBe('AAA');
  });

  it('combines column and 1-based row', () => {
    expect(cellRef(0, 1)).toBe('A1');
    expect(cellRef(2, 14)).toBe('C14');
  });
});

describe('sanitizeSheetName', () => {
  it('passes an ordinary name through', () => {
    expect(sanitizeSheetName('Cap table', new Set())).toBe('Cap table');
  });

  it('strips the characters Excel refuses', () => {
    expect(sanitizeSheetName('P&L: 2026 [draft]/v2', new Set())).toBe('P&L  2026  draft  v2');
  });

  it('truncates to 31 characters', () => {
    const name = sanitizeSheetName('a'.repeat(50), new Set());
    expect(name).toHaveLength(31);
  });

  it('de-duplicates case-insensitively and stays within the limit', () => {
    const taken = new Set<string>();
    expect(sanitizeSheetName('Grants', taken)).toBe('Grants');
    expect(sanitizeSheetName('grants', taken)).toBe('grants (2)');
    expect(sanitizeSheetName('GRANTS', taken)).toBe('GRANTS (3)');

    const long = 'b'.repeat(31);
    expect(sanitizeSheetName(long, taken)).toHaveLength(31);
    expect(sanitizeSheetName(long, taken)).toHaveLength(31);
  });

  it('falls back to a placeholder when nothing survives', () => {
    expect(sanitizeSheetName('///', new Set())).toBe('Sheet');
    expect(sanitizeSheetName("'", new Set())).toBe('Sheet');
  });
});

describe('toExcelSerial', () => {
  it('places the Unix epoch on the 1900-system serial', () => {
    expect(toExcelSerial(new Date('1970-01-01T00:00:00Z'))).toBe(25569);
  });

  it('matches a known date', () => {
    // 2026-07-29 is 20663 days after the epoch.
    expect(toExcelSerial(new Date('2026-07-29T00:00:00Z'))).toBe(25569 + 20663);
  });

  it('carries the time of day as a fraction', () => {
    expect(toExcelSerial(new Date('1970-01-01T12:00:00Z'))).toBe(25569.5);
  });
});

describe('buildXlsx', () => {
  it('rejects an empty workbook', () => {
    expect(() => buildXlsx([])).toThrow(/at least one sheet/);
  });

  it('writes the parts an OOXML reader requires', () => {
    const zip = buildXlsx([simpleSheet]);
    assertArchiveIntact(zip);
    const entries = listEntries(zip);
    expect(entries).toContain('[Content_Types].xml');
    expect(entries).toContain('_rels/.rels');
    expect(entries).toContain('xl/workbook.xml');
    expect(entries).toContain('xl/_rels/workbook.xml.rels');
    expect(entries).toContain('xl/styles.xml');
    expect(entries).toContain('xl/worksheets/sheet1.xml');
  });

  it('declares one worksheet part and relationship per sheet', () => {
    const zip = buildXlsx([
      { ...simpleSheet, name: 'One' },
      { ...simpleSheet, name: 'Two' },
      { ...simpleSheet, name: 'Three' },
    ]);
    const entries = listEntries(zip);
    expect(entries).toContain('xl/worksheets/sheet3.xml');

    const workbook = unzipEntry(zip, 'xl/workbook.xml');
    expect(workbook).toContain('<sheet name="One" sheetId="1" r:id="rId2"/>');
    expect(workbook).toContain('<sheet name="Three" sheetId="3" r:id="rId4"/>');

    // rId1 is the style part; a sheet that reused it would open with no styles
    // or not at all, depending on the reader.
    const rels = unzipEntry(zip, 'xl/_rels/workbook.xml.rels');
    expect(rels).toContain(
      'Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"',
    );
    expect(rels).toContain(
      'Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"',
    );

    const types = unzipEntry(zip, '[Content_Types].xml');
    expect(types).toContain('PartName="/xl/worksheets/sheet3.xml"');
  });

  it('writes numbers as numbers and strings as inline strings', () => {
    const sheet = unzipEntry(buildXlsx([simpleSheet]), 'xl/worksheets/sheet1.xml');
    // Header row 1, first data row 2.
    expect(sheet).toContain(
      '<c r="A2" s="3" t="inlineStr"><is><t xml:space="preserve">Acme, Inc.</t></is></c>',
    );
    expect(sheet).toContain('<c r="B2" s="5"><v>1000000</v></c>');
    expect(sheet).toContain('<c r="C2" s="6"><v>1.25</v></c>');
  });

  it('omits empty cells rather than writing blank ones', () => {
    const sheet = unzipEntry(buildXlsx([simpleSheet]), 'xl/worksheets/sheet1.xml');
    expect(sheet).not.toContain('r="C3"');
    expect(sheet).toContain('<row r="3">');
  });

  it('escapes XML metacharacters in values and sheet names', () => {
    const zip = buildXlsx([
      {
        name: 'A & B',
        columns: [{ header: '<hdr>', format: 'text' }],
        rows: [['5 < 6 & "quoted"']],
      },
    ]);
    const sheet = unzipEntry(zip, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('5 &lt; 6 &amp; &quot;quoted&quot;');
    expect(sheet).toContain('&lt;hdr&gt;');
    expect(unzipEntry(zip, 'xl/workbook.xml')).toContain('name="A &amp; B"');
  });

  it('drops control characters that would make the file unopenable', () => {
    const sheet = unzipEntry(
      buildXlsx([{ name: 'S', columns: [{ header: 'h', format: 'text' }], rows: [['Ac\u0000m\u0001e']] }]),
      'xl/worksheets/sheet1.xml',
    );
    expect(sheet).toContain('>Acme<');
    expect(sheet).not.toContain('\u0000');
    expect(sheet).not.toContain('\u0001');
  });

  /*
   * Excel refuses a workbook holding a cell over its own 32,767-character
   * limit — the file opens as "unreadable content" and is offered for repair —
   * and nothing upstream bounds the text that reaches a cell. A cap-table
   * security class is whatever the imported sheet said, and the import body
   * carries two megabytes of pasted CSV, so one long holder name took every
   * sheet of the workbook down with it.
   */
  it('cuts a cell to the most characters Excel will open, and marks the cut', () => {
    const long = 'A'.repeat(MAX_CELL_CHARS + 5000);
    const sheet = unzipEntry(
      buildXlsx([{ name: 'S', columns: [{ header: 'h', format: 'text' }], rows: [[long]] }]),
      'xl/worksheets/sheet1.xml',
    );
    const cell = /<is><t xml:space="preserve">([^<]*)<\/t><\/is>/.exec(
      sheet.slice(sheet.indexOf('r="A2"')),
    )![1]!;
    expect(cell.length).toBeLessThanOrEqual(MAX_CELL_CHARS);
    expect(cell.endsWith('\u2026')).toBe(true);
  });

  it('leaves a cell at the limit whole', () => {
    const exact = 'A'.repeat(MAX_CELL_CHARS);
    const sheet = unzipEntry(
      buildXlsx([{ name: 'S', columns: [{ header: 'h', format: 'text' }], rows: [[exact]] }]),
      'xl/worksheets/sheet1.xml',
    );
    expect(sheet).toContain(exact);
  });

  /*
   * The cut is on a code point. An emoji straddling the boundary would
   * otherwise leave a lone surrogate, which XML has no production for and
   * which reaches the file as U+FFFD — see domain/textSlice.ts.
   */
  it('does not cut an astral character in half at the boundary', () => {
    const sheet = unzipEntry(
      buildXlsx([
        {
          name: 'S',
          columns: [{ header: 'h', format: 'text' }],
          rows: [['A'.repeat(MAX_CELL_CHARS - 4) + '\u{1F680}'.repeat(10)]],
        },
      ]),
      'xl/worksheets/sheet1.xml',
    );
    expect(sheet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(sheet).not.toContain('\uFFFD');
  });

  it('writes a formula with its cached value', () => {
    const sheet = unzipEntry(
      buildXlsx([
        {
          name: 'S',
          columns: [
            { header: 'a', format: 'currency' },
            { header: 'b', format: 'currency' },
            { header: 'total', format: 'currency' },
          ],
          rows: [[2, 3, { formula: 'A2+B2', value: 5 }]],
        },
      ]),
      'xl/worksheets/sheet1.xml',
    );
    expect(sheet).toContain('<c r="C2" s="6"><f>A2+B2</f><v>5</v></c>');
  });

  it('writes a formula without a cached value when there is none', () => {
    const sheet = unzipEntry(
      buildXlsx([
        {
          name: 'S',
          columns: [{ header: 'a', format: 'percent' }],
          rows: [[{ formula: 'IFERROR(A2/B2,"")', value: null }]],
        },
      ]),
      'xl/worksheets/sheet1.xml',
    );
    expect(sheet).toContain('<f>IFERROR(A2/B2,&quot;&quot;)</f>');
    expect(sheet).not.toContain('<f>IFERROR(A2/B2,&quot;&quot;)</f><v>');
  });

  it('degrades a non-finite number to an error cell instead of corrupting the file', () => {
    const sheet = unzipEntry(
      buildXlsx([
        { name: 'S', columns: [{ header: 'n', format: 'number' }], rows: [[Number.NaN], [Infinity]] },
      ]),
      'xl/worksheets/sheet1.xml',
    );
    expect(sheet).toContain('<c r="A2" s="4" t="e"><v>#NUM!</v></c>');
    expect(sheet).toContain('<c r="A3" s="4" t="e"><v>#NUM!</v></c>');
    expect(sheet).not.toContain('<v>NaN</v>');
    expect(sheet).not.toContain('<v>Infinity</v>');
  });

  it('writes dates as serial numbers with the date style', () => {
    const sheet = unzipEntry(
      buildXlsx([
        { name: 'S', columns: [{ header: 'd', format: 'date' }], rows: [[new Date('2026-07-29T00:00:00Z')]] },
      ]),
      'xl/worksheets/sheet1.xml',
    );
    expect(sheet).toContain('<c r="A2" s="8"><v>46232</v></c>');
  });

  it('skips an invalid date rather than writing NaN', () => {
    const sheet = unzipEntry(
      buildXlsx([{ name: 'S', columns: [{ header: 'd', format: 'date' }], rows: [[new Date('nope')]] }]),
      'xl/worksheets/sheet1.xml',
    );
    expect(sheet).not.toContain('r="A2"');
  });

  it('freezes the header row by default and honours titleLines offsets', () => {
    const plain = unzipEntry(buildXlsx([simpleSheet]), 'xl/worksheets/sheet1.xml');
    expect(plain).toContain('<pane ySplit="1" topLeftCell="A2"');

    const titled = unzipEntry(
      buildXlsx([{ ...simpleSheet, titleLines: ['Acme 409A', 'Generated 2026-07-29'] }]),
      'xl/worksheets/sheet1.xml',
    );
    // Two title lines push the header to row 3 and the first data row to row 4.
    expect(titled).toContain('<pane ySplit="3" topLeftCell="A4"');
    expect(titled).toContain('<row r="1">');
    expect(titled).toContain(
      '<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Acme 409A</t></is></c>',
    );
    expect(titled).toContain(
      '<c r="A3" s="2" t="inlineStr"><is><t xml:space="preserve">Company</t></is></c>',
    );
    expect(titled).toContain(
      '<c r="A4" s="3" t="inlineStr"><is><t xml:space="preserve">Acme, Inc.</t></is></c>',
    );
  });

  it('can opt out of the frozen header', () => {
    const sheet = unzipEntry(
      buildXlsx([{ ...simpleSheet, freezeHeader: false }]),
      'xl/worksheets/sheet1.xml',
    );
    expect(sheet).not.toContain('<pane');
  });

  it('adds an autofilter only for a plain header sheet', () => {
    expect(unzipEntry(buildXlsx([simpleSheet]), 'xl/worksheets/sheet1.xml')).toContain(
      '<autoFilter ref="A1:C3"/>',
    );
    // Title lines mean the header is not row 1, where a filter would confuse readers.
    expect(
      unzipEntry(buildXlsx([{ ...simpleSheet, titleLines: ['T'] }]), 'xl/worksheets/sheet1.xml'),
    ).not.toContain('autoFilter');
    expect(unzipEntry(buildXlsx([{ ...simpleSheet, rows: [] }]), 'xl/worksheets/sheet1.xml')).not.toContain(
      'autoFilter',
    );
  });

  it('stamps a fixed mtime when asked, so a run is reproducible', () => {
    const at = new Date('2026-07-29T10:00:00Z');
    const a = buildXlsx([simpleSheet], { mtime: at });
    const b = buildXlsx([simpleSheet], { mtime: at });
    expect(a.equals(b)).toBe(true);
  });

  it('declares as many style records as it references', () => {
    const styles = unzipEntry(buildXlsx([simpleSheet]), 'xl/styles.xml');
    const declared = Number(/<cellXfs count="(\d+)"/.exec(styles)?.[1]);
    const actual = (styles.match(/<xf [^>]*xfId="0"/g) ?? []).length;
    expect(actual).toBe(declared);
  });
});

/**
 * Per-share money, at the precision the opinion states it to.
 *
 * `currency` is `#,##0.00`, which is right for an invested amount and wrong for
 * the figure a §409A exists to conclude: the report states $1.4947 and a
 * two-decimal cell shows $1.49. The value in the file is exact either way — this
 * is about what the sheet *reads as*, which is what an auditor reconciles.
 */
describe('per-share money', () => {
  const numFmtOf = (zip: Buffer, styleIndex: number): string => {
    const styles = unzipEntry(zip, 'xl/styles.xml');
    const cellXfs = styles.slice(styles.indexOf('<cellXfs'), styles.indexOf('</cellXfs>'));
    const xf = [...cellXfs.matchAll(/<xf [^>]*\/>/g)][styleIndex];
    if (!xf) throw new Error(`no cellXfs entry at index ${styleIndex}`);
    const id = /numFmtId="(\d+)"/.exec(xf[0])?.[1];
    const fmt = new RegExp(`<numFmt numFmtId="${id}" formatCode="([^"]+)"`).exec(styles);
    return fmt?.[1] ?? `builtin:${id}`;
  };

  it('renders a pershare cell to four decimals', () => {
    const zip = buildXlsx([
      { name: 'S', columns: [{ header: 'FMV', format: 'pershare' }], rows: [[1.4947]] },
    ]);
    const sheet = unzipEntry(zip, 'xl/worksheets/sheet1.xml');
    const style = /<c r="A2" s="(\d+)"><v>1.4947<\/v><\/c>/.exec(sheet)?.[1];
    expect(style, `A2 was not written as a styled number: ${sheet}`).toBeDefined();
    expect(numFmtOf(zip, Number(style))).toBe('#,##0.0000');
  });

  /**
   * The concluded figure shares a column with invested amounts on the waterfall
   * sheet and with engine version strings on the calculation sheet, so it can
   * only carry its own format if a cell may override the column's.
   */
  it('lets a cell override the format its column declares', () => {
    const zip = buildXlsx([
      {
        name: 'S',
        columns: [{ header: 'Amount', format: 'currency' }],
        rows: [[2_000_000], [{ value: 1.4947, format: 'pershare' }]],
      },
    ]);
    const sheet = unzipEntry(zip, 'xl/worksheets/sheet1.xml');
    const plain = /<c r="A2" s="(\d+)"><v>2000000<\/v><\/c>/.exec(sheet)?.[1];
    const overridden = /<c r="A3" s="(\d+)"><v>1.4947<\/v><\/c>/.exec(sheet)?.[1];
    expect(numFmtOf(zip, Number(plain))).toBe('#,##0.00');
    expect(numFmtOf(zip, Number(overridden))).toBe('#,##0.0000');
  });

  it('still opens as a valid archive with the added style', () => {
    assertArchiveIntact(
      buildXlsx([{ name: 'S', columns: [{ header: 'FMV', format: 'pershare' }], rows: [[1.4947]] }]),
    );
  });
});
