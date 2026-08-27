import { describe, expect, it } from 'vitest';
import { buildZip } from '../../src/export/zip.js';
import {
  CsvReadError,
  MAX_CSV_CELLS,
  MAX_CSV_COLUMNS,
  parseCapTable,
  parseCsvSheet,
  parseMultipleCell,
  parseRatioCell,
  validateCapTable,
  type CapTableIssue,
} from '../../src/domain/capTable.js';
import { decodeSheetText, SheetTextError } from '../../src/domain/sheetText.js';
import { readXlsx } from '../../src/domain/xlsxRead.js';
import { nameColumns, rowByColumn } from '../../src/domain/sheetColumns.js';

/**
 * The import pipeline against files built to break it.
 *
 * Every other cap-table test feeds the importer a sheet somebody meant to
 * write. This one feeds it the sheets people actually have and the sheets an
 * attacker sends: a row shifted by an unquoted comma, a liquidation preference
 * written `2x`, a workbook saved with a password, a header row of ten million
 * commas. The bar is the same for all of them and it is two things — it must
 * not crash, and it must not answer with a *number*. A wrong figure that
 * validates clean is the failure mode this whole file exists to find, because
 * every one of these columns is something a 409A conclusion is divided by.
 *
 * Grouped by the shape of the input rather than by the module that reads it:
 * the same malformed file reaches `parseCsvSheet`, `decodeSheetText`,
 * `readXlsx` and `validateCapTable` in turn, and which of them ought to catch
 * it is the question, not the premise.
 */

const MAPPING = {
  security_class: 'class',
  class_type: 'type',
  shares: 'shares',
  price_per_share: 'price',
  invested_amount: 'invested',
  liquidation_multiple: 'liq',
  seniority: 'sen',
  conversion_ratio: 'conv',
};

/** Parse + validate one CSV through the whole pipeline, as the route does. */
function importCsv(csv: string) {
  const sheet = parseCsvSheet(csv, { maxRows: 2000 });
  const entries = parseCapTable(sheet.rows, MAPPING, sheet.lines);
  return { sheet, entries, validation: validateCapTable(entries) };
}

const codes = (issues: CapTableIssue[]) => issues.map((i) => `${i.severity}/${i.code}`);
const errorsOf = (issues: CapTableIssue[]) => issues.filter((i) => i.severity === 'error');

/** A one-sheet workbook of literal cell XML, for the shapes `buildXlsx` cannot write. */
function workbookOf(sheetData: string): Buffer {
  return buildZip([
    {
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0"?><workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: `<?xml version="1.0"?><worksheet><sheetData>${sheetData}</sheetData></worksheet>`,
    },
  ]);
}

/** `<row>`s of inline-string / numeric cells from a plain grid of text. */
function sheetRows(grid: string[][]): string {
  return grid
    .map((cells, r) => {
      const inner = cells
        .map((cell, c) => {
          const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
          if (cell === '') return '';
          return /^-?\d+(\.\d+)?$/.test(cell)
            ? `<c r="${ref}"><v>${cell}</v></c>`
            : `<c r="${ref}" t="inlineStr"><is><t>${cell}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${inner}</row>`;
    })
    .join('');
}

describe('adversarial imports — malformed CSV', () => {
  it('drops the cells of a row that has more of them than the header', () => {
    // Not an error: the extra cells belong to no column, so no mapping can
    // reach them. What matters is that the row's *named* cells still line up
    // with the header rather than sliding along by one.
    const { sheet } = importCsv('class,shares\nCommon,1000,ignored,also ignored\n');
    expect(sheet.rows).toEqual([{ class: 'Common', shares: '1000' }]);
  });

  it('reads a row with fewer cells than the header as blanks, not as a shift', () => {
    const { sheet } = importCsv('class,shares,price\nCommon,1000\n');
    expect(sheet.rows).toEqual([{ class: 'Common', shares: '1000', price: '' }]);
  });

  it('refuses a row shifted one cell along by an unquoted comma in a name', () => {
    // `Series A, Inc` is one company written as two cells, so the share count
    // column holds ` Inc` and the price column holds the share count. This is
    // the single most common malformed cap table there is, and it used to
    // import as a class holding zero shares at a price of 1,000 — clean, with
    // a warning, and wrong by every figure on the row.
    const { validation } = importCsv('class,shares,price\nSeries A, Inc,1000,2.50\nCommon,5000,0.10\n');
    expect(validation.valid).toBe(false);
    const [issue] = errorsOf(validation.issues);
    expect(issue?.code).toBe('unreadable_number');
    expect(issue?.row).toBe(2);
    expect(issue?.message).toContain('share count');
    expect(issue?.message).toContain('"Inc"');
  });

  it('reads a file whose first row is data as a file whose first row is a header', () => {
    // Delimited text carries no way to say "there is no header row", so the
    // first record is one by definition. The outcome has to be an empty import
    // rather than a plausible one: the class name becomes a column name, the
    // mapping matches nothing, and the table is refused as empty.
    const { entries, validation } = importCsv('Common Stock,8000000\nSeries A,2000000\n');
    expect(entries).toHaveLength(0);
    expect(codes(validation.issues)).toContain('error/empty');
  });

  it('sniffs the delimiter from the header, and says so when the body disagrees', () => {
    // A header written with semicolons and a body written with commas is not a
    // file with two delimiters; it is a file assembled by hand. The sniffer
    // votes on the header, so the whole data row arrives as one cell — which
    // fails, and fails by naming the mapping, rather than half-parsing into
    // columns that look right.
    const { sheet, validation } = importCsv('class;shares;price\nCommon,1000,0.10\n');
    expect(sheet.rows[0]).toEqual({ class: 'Common,1000,0.10', shares: '', price: '' });
    expect(validation.valid).toBe(false);
    expect(codes(validation.issues)).toContain('error/no_shares');
  });

  it('keeps a quoted field that spans lines whole, and numbers the rows after it correctly', () => {
    const { sheet, entries } = importCsv('class,shares\n"Series A\nPreferred",1000\nCommon,5000\n');
    expect(sheet.rows[0]?.class).toBe('Series A\nPreferred');
    expect(entries.map((e) => e.source_row)).toEqual([2, 4]);
  });

  it('reads an unterminated quote as running to the end of the file', () => {
    // There is no other reading available, and the alternative — dropping the
    // record — loses data silently. One long class name is visible in the
    // preview; a missing row is not.
    const { sheet } = importCsv('class,shares\n"Common,1000\nSeries A,2000\n');
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0]?.class).toContain('Series A');
  });
});

describe('adversarial imports — duplicate headers', () => {
  it('keeps both of two identically named columns reachable', () => {
    const { sheet } = importCsv('class,Shares,Shares\nCommon,1000,900\n');
    expect(sheet.headers).toEqual(['class', 'Shares', 'Shares (2)']);
    expect(sheet.rows[0]).toEqual({ class: 'Common', Shares: '1000', 'Shares (2)': '900' });
  });

  it('does not mint a suffix a column of the sheet already answers to', () => {
    // `Shares (2), Shares, Shares` is what a sheet looks like once somebody has
    // disambiguated one pair of columns by hand, or once an export of this same
    // import is re-exported. Counting uses of each name gave the third column
    // `Shares (2)` as well, and the last one written won — which is exactly the
    // silent column loss the suffixing was added to prevent.
    expect(nameColumns(['Shares (2)', 'Shares', 'Shares'])).toEqual([
      'Shares (2)',
      'Shares',
      'Shares (3)',
    ]);
    expect(rowByColumn(nameColumns(['Shares (2)', 'Shares', 'Shares']), ['a', 'b', 'c'])).toEqual({
      'Shares (2)': 'a',
      Shares: 'b',
      'Shares (3)': 'c',
    });
  });

  it('names a repeat the same way in a workbook as in a CSV', () => {
    const grid = [
      ['class', 'Shares (2)', 'Shares', 'Shares'],
      ['Common', '1', '2', '3'],
    ];
    const [sheet] = readXlsx(workbookOf(sheetRows(grid)));
    expect(sheet?.headers).toEqual(parseCsvSheet(grid.map((r) => r.join(',')).join('\n')).headers);
    expect(sheet?.rows[0]).toEqual({ class: 'Common', 'Shares (2)': '1', Shares: '2', 'Shares (3)': '3' });
  });
});

describe('adversarial imports — wrong types in numeric columns', () => {
  it('treats an empty cell, a dash and "N/A" alike, as a figure that was not given', () => {
    // All three mean the same thing on a real export — a common-stock row has
    // no issue price and no liquidation preference — and refusing them would
    // refuse the most ordinary cap table there is.
    const { entries, validation } = importCsv(
      ['class,type,shares,price,invested,liq', 'Common,common,5000,,,', 'Founders,common,1000,N/A,-,#N/A'].join(
        '\n',
      ),
    );
    expect(entries.every((e) => e.unreadable_numbers === undefined)).toBe(true);
    expect(errorsOf(validation.issues)).toEqual([]);
  });

  it('refuses a share count that is words, rather than importing it as zero', () => {
    const { validation } = importCsv('class,shares\nCommon,five thousand\n');
    const issue = errorsOf(validation.issues).find((i) => i.code === 'unreadable_number');
    expect(issue?.message).toContain('the share count column reads "five thousand"');
    // The row is not *also* reported as holding no shares: that warning would
    // be describing the default this error exists to stop being applied.
    expect(codes(validation.issues)).not.toContain('warning/zero_shares');
  });

  it('reads a liquidation preference written "2x" as two, not as the 1x default', () => {
    // The silent one. `Number('2x')` is NaN, a null multiple defaults to 1x,
    // and the warning raised said the row "has no liquidation preference" —
    // about a cell that plainly had one. Every figure the waterfall pays out
    // was halved for that class and the table validated clean.
    const { entries, validation } = importCsv(
      'class,type,shares,price,liq\nSeries A,preferred,1000,1.00,2x\n',
    );
    expect(entries[0]?.liquidation_multiple).toBe(2);
    expect(validation.summary.total_preference_stack).toBe(2000);
    expect(codes(validation.issues)).not.toContain('warning/default_liq_pref');
    expect(parseMultipleCell('1.5X')).toBe(1.5);
    expect(parseMultipleCell('2 ×')).toBe(2);
    expect(parseMultipleCell('x')).toBeNull();
  });

  it('reads a conversion ratio written "2:1" as two, not as the 1:1 default', () => {
    const { entries, validation } = importCsv(
      'class,type,shares,price,conv\nSeries A,preferred,1000,1.00,2:1\n',
    );
    expect(entries[0]?.conversion_ratio).toBe(2);
    expect(validation.summary.fully_diluted_shares).toBe(2000);
    expect(parseRatioCell('1:1')).toBe(1);
    // A zero denominator is not a ratio, and must not become an Infinity.
    expect(parseRatioCell('1:0')).toBeNull();
    expect(parseRatioCell('1:2:3')).toBeNull();
  });

  it('refuses a preference and a ratio it cannot read rather than defaulting them', () => {
    const { validation } = importCsv(
      'class,type,shares,price,liq,conv\nSeries A,preferred,1000,1.00,two times,ordinary\n',
    );
    expect(validation.valid).toBe(false);
    const messages = errorsOf(validation.issues).map((i) => i.message);
    expect(messages.some((m) => m.includes('liquidation preference column reads "two times"'))).toBe(true);
    expect(messages.some((m) => m.includes('conversion ratio column reads "ordinary"'))).toBe(true);
  });

  it('names the row, the column and the text of every cell it could not read', () => {
    const { validation } = importCsv(
      ['class,shares,price,sen', 'Common,1000,0.10,1', 'Series A,2000,about a dollar,first'].join('\n'),
    );
    const reported = errorsOf(validation.issues)
      .filter((i) => i.code === 'unreadable_number')
      .map((i) => ({ row: i.row, message: i.message }));
    expect(reported).toHaveLength(2);
    expect(reported.every((r) => r.row === 3)).toBe(true);
    expect(reported[0]?.message).toContain('price per share column reads "about a dollar"');
    expect(reported[1]?.message).toContain('seniority column reads "first"');
  });

  it('keeps a row whose only content is an unreadable cell rather than dropping it', () => {
    // A row with no class name and no share count is a spacer or a totals line
    // and is skipped. A row whose share count is unreadable is not blank — it
    // just looks blank once the parse has failed, which is how it used to
    // vanish without a word.
    const { entries, validation } = importCsv('class,shares\n,not a number\nCommon,1000\n');
    expect(entries).toHaveLength(2);
    expect(validation.valid).toBe(false);
  });

  it('still reads the number formats a real export writes', () => {
    const { entries } = importCsv(
      [
        'class,type,shares,price,invested,liq',
        'Common,common,"1,234,567",$0.10,"(500)",1',
        'Indian,common,"1,00,000",,,',
        'European,common,1.234,"1,00",,',
      ].join('\n'),
    );
    expect(entries.map((e) => e.shares)).toEqual([1234567, 100000, 1.234]);
    expect(entries[0]?.invested_amount).toBe(-500);
    expect(entries[2]?.price_per_share).toBe(1);
  });
});

describe('adversarial imports — encoding', () => {
  const csv = 'class,shares\nSérie A,1000\n';

  it('reads UTF-8 with and without a byte-order mark', () => {
    expect(decodeSheetText(Buffer.from(csv, 'utf8'))).toBe(csv);
    expect(decodeSheetText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv, 'utf8')]))).toBe(
      `﻿${csv}`,
    );
    // The BOM is stripped once, by the parser, on every path into it.
    expect(parseCsvSheet(`﻿${csv}`).headers).toEqual(['class', 'shares']);
  });

  it('reads UTF-16 in both byte orders, with a mark and without one', () => {
    const le = Buffer.from(csv, 'utf16le');
    const be = Buffer.from(le);
    for (let i = 0; i + 1 < be.length; i += 2) [be[i], be[i + 1]] = [be[i + 1]!, be[i]!];
    expect(decodeSheetText(Buffer.concat([Buffer.from([0xff, 0xfe]), le]))).toBe(csv);
    expect(decodeSheetText(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe(csv);
    expect(decodeSheetText(le)).toBe(csv);
    // Read as UTF-8 the header row is `c\0l\0a\0s\0s\0`, which matches no mapping.
    expect(parseCsvSheet(le.toString('utf8')).headers[0]).not.toBe('class');
  });

  it('reads Windows-1252 rather than filling the name with replacement characters', () => {
    const ansi = Buffer.from([...Buffer.from('class,shares\nS'), 0xe9, ...Buffer.from('rie A,1000\n')]);
    expect(decodeSheetText(ansi)).toBe(csv);
    // A security class is the key the whole table is grouped and reconciled by,
    // so `S�rie A` is a class that will match nothing on the next import.
    expect(ansi.toString('utf8')).toContain('�');
  });

  it('keeps astral characters, which UTF-8 and UTF-16 both carry', () => {
    const emoji = 'class,shares\nCommon 🚀,1000\n';
    expect(decodeSheetText(Buffer.from(emoji, 'utf8'))).toBe(emoji);
    expect(decodeSheetText(Buffer.from(emoji, 'utf16le'))).toBe(emoji);
    expect(parseCsvSheet(emoji).rows[0]?.class).toBe('Common 🚀');
  });

  it('names a password-protected workbook instead of reading it as text', () => {
    // Encrypted OOXML is an OLE2 compound file, not a ZIP — so `looksLikeXlsx`
    // says no — and its extension is `.xlsx`, which the legacy-format branch
    // does not list. It fell through to being read as delimited text, and the
    // answer was "No cap-table rows were found": a statement about a sheet,
    // made about a file that was never opened.
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(600),
    ]);
    expect(() => decodeSheetText(ole)).toThrow(SheetTextError);
    expect(() => decodeSheetText(ole)).toThrow(/password-protected or legacy/);
  });

  it('names the other containers people upload by mistake', () => {
    expect(() => decodeSheetText(Buffer.from('%PDF-1.7\nstream'))).toThrow(/PDF/);
    expect(() => decodeSheetText(Buffer.from('{\\rtf1\\ansi'))).toThrow(/RTF/);
    expect(() => decodeSheetText(Buffer.from([0xff, 0xfe, 0x00, 0x00, 65, 0, 0, 0]))).toThrow(/UTF-32/);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    expect(() => decodeSheetText(png)).toThrow(/not a spreadsheet or a text file/);
  });
});

describe('adversarial imports — files too big to hold', () => {
  it('counts every row of an oversized file but builds only the ones it will keep', () => {
    // 10 MB is what the upload endpoint accepts, and it is 300,000 rows of
    // which 2,000 are ever returned. Building the other 298,000 to count them
    // cost 138 MB of heap, per concurrent request, for a number.
    const header = 'class,shares\n';
    const rows = Array.from({ length: 5000 }, (_, i) => `Class ${i},1000`).join('\n');
    const sheet = parseCsvSheet(header + rows, { maxRows: 2000 });
    expect(sheet.rows).toHaveLength(2000);
    expect(sheet.totalRows).toBe(5000);
    // Unbounded by default, so nothing that does not ask for a cap loses rows.
    expect(parseCsvSheet(header + rows).rows).toHaveLength(5000);
  });

  it('refuses one record wider than a worksheet instead of laying it out', () => {
    // A header line of commas is one byte per column. Ten million of them fit
    // inside the upload cap, build a ten-million-entry array, and return no
    // rows at all — 247 MB of heap and a blocked event loop for a file the
    // importer then reports as empty.
    const wide = ','.repeat(MAX_CSV_COLUMNS + 10);
    expect(() => parseCsvSheet(wide)).toThrow(CsvReadError);
    expect(() => parseCsvSheet(wide)).toThrow(/more than 16,384 columns/);
    // One column short of the limit is still a file, however strange.
    expect(() => parseCsvSheet(','.repeat(MAX_CSV_COLUMNS - 1))).not.toThrow();
  });

  it('refuses a sheet whose rows and columns are each legal but whose product is not', () => {
    // 1,200 rows of 2,000 columns passes both bounds and is 2.4M cells.
    const row = Array.from({ length: 2000 }, (_, i) => `c${i}`).join(',');
    const text = Array.from({ length: 1200 }, () => row).join('\n');
    expect(() => parseCsvSheet(text, { maxRows: 2000 })).toThrow(CsvReadError);
    expect(() => parseCsvSheet(text, { maxRows: 2000 })).toThrow(/cells to lay out/);
    expect(MAX_CSV_CELLS).toBeGreaterThan(2000 * 100); // a large real sheet is far under
  });

  it('parses a large but legitimate sheet without complaint', () => {
    const wide = Array.from({ length: 40 }, (_, i) => `col${i}`).join(',');
    const text = [wide, ...Array.from({ length: 2000 }, () => wide)].join('\n');
    const sheet = parseCsvSheet(text, { maxRows: 2000 });
    expect(sheet.rows).toHaveLength(2000);
    expect(sheet.headers).toHaveLength(40);
  });
});

describe('adversarial imports — partial failures are not partial', () => {
  it('reports every bad row of a mixed file, and refuses the whole of it', () => {
    // All-or-nothing on purpose. A cap table is one document: importing the
    // eight rows that parsed and dropping the two that did not produces a
    // table whose fully-diluted count is wrong by the rows that are missing,
    // and nothing downstream can tell that anything was left out. The route
    // refuses the PUT on any error, so the operator fixes the sheet and
    // re-imports it whole.
    const good = Array.from({ length: 8 }, (_, i) => `Class ${i},common,1000,0.10`);
    const csv = [
      'class,type,shares,price',
      ...good.slice(0, 4),
      'Bad One,common,lots,0.10',
      ...good.slice(4),
      'Bad Two,common,1000,free',
    ].join('\n');
    const { entries, validation } = importCsv(csv);
    expect(entries).toHaveLength(10);
    expect(validation.valid).toBe(false);
    const reported = errorsOf(validation.issues).filter((i) => i.code === 'unreadable_number');
    expect(reported.map((i) => i.row)).toEqual([6, 11]);
  });

  it('reports the good rows in the summary anyway, so the preview shows what read', () => {
    const { validation } = importCsv(
      ['class,type,shares,price', 'Common,common,5000,0.10', 'Series A,preferred,1000,lots'].join('\n'),
    );
    expect(validation.valid).toBe(false);
    expect(validation.summary.total_shares).toBe(6000);
    expect(validation.summary.class_count).toBe(2);
  });
});

describe('adversarial imports — workbook shapes', () => {
  it('reads every sheet of a workbook, so the caller picks rather than the reader', () => {
    const sheets = readXlsx(
      buildZip([
        {
          name: 'xl/workbook.xml',
          data:
            '<?xml version="1.0"?><workbook><sheets>' +
            '<sheet name="Notes" sheetId="1" r:id="rId1"/><sheet name="Cap Table" sheetId="2" r:id="rId2"/>' +
            '</sheets></workbook>',
        },
        {
          name: 'xl/_rels/workbook.xml.rels',
          data:
            '<?xml version="1.0"?><Relationships>' +
            '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
            '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
        },
        {
          name: 'xl/worksheets/sheet1.xml',
          data: `<?xml version="1.0"?><worksheet><sheetData>${sheetRows([['read me first']])}</sheetData></worksheet>`,
        },
        {
          name: 'xl/worksheets/sheet2.xml',
          data: `<?xml version="1.0"?><worksheet><sheetData>${sheetRows([
            ['class', 'shares'],
            ['Common', '1000'],
          ])}</sheetData></worksheet>`,
        },
      ]),
    );
    expect(sheets.map((s) => s.name)).toEqual(['Notes', 'Cap Table']);
    expect(sheets[1]?.rows).toEqual([{ class: 'Common', shares: '1000' }]);
  });

  it('reads a merged header cell as the one cell it is', () => {
    // A merge stores the value in the top-left cell and leaves the rest of the
    // span empty, so a header merged across two columns names one column and
    // drops the other — which is what the sheet says, and what dropping a blank
    // header does everywhere else.
    const [sheet] = readXlsx(
      workbookOf(
        '<row r="1"><c r="A1" t="inlineStr"><is><t>Holdings</t></is></c></row>' +
          sheetRows([[], ['class', 'shares'], ['Common', '1000']]).replace('<row r="1"></row>', ''),
      ),
    );
    expect(sheet?.headers).toEqual(['class', 'shares']);
    expect(sheet?.rows).toEqual([{ class: 'Common', shares: '1000' }]);
  });

  it("reads a formula's cached result and does not try to evaluate the formula", () => {
    const [sheet] = readXlsx(
      workbookOf(
        '<row r="1"><c r="A1" t="inlineStr"><is><t>class</t></is></c>' +
          '<c r="B1" t="inlineStr"><is><t>shares</t></is></c>' +
          '<c r="C1" t="inlineStr"><is><t>note</t></is></c></row>' +
          '<row r="2"><c r="A2" t="inlineStr"><is><t>Common</t></is></c>' +
          '<c r="B2"><f>SUM(Sheet2!A1:A9)</f><v>8000000</v></c>' +
          '<c r="C2" t="str"><f>CONCAT("a","b")</f><v>ab</v></c></row>',
      ),
    );
    expect(sheet?.rows[0]).toEqual({ class: 'Common', shares: '8000000', note: 'ab' });
  });

  it('reads a formula with no cached result as blank, and the row is then refused', () => {
    // A workbook written by a generator rather than by Excel carries formulas
    // with no `<v>`. There is no value to read and evaluating the formula is
    // not something this reader does, so the cell is blank — and a blank share
    // count is a table with no denominator, which the validator refuses by
    // name rather than dividing by.
    const [sheet] = readXlsx(
      workbookOf(
        '<row r="1"><c r="A1" t="inlineStr"><is><t>class</t></is></c>' +
          '<c r="B1" t="inlineStr"><is><t>shares</t></is></c></row>' +
          '<row r="2"><c r="A2" t="inlineStr"><is><t>Common</t></is></c>' +
          '<c r="B2"><f>SUM(Sheet2!A1:A9)</f></c></row>',
      ),
    );
    expect(sheet?.rows[0]).toEqual({ class: 'Common', shares: '' });
    const validation = validateCapTable(parseCapTable(sheet?.rows ?? [], MAPPING, sheet?.lines));
    expect(codes(validation.issues)).toContain('error/no_shares');
  });

  it('reads an error cell as blank rather than as the text of the error', () => {
    const [sheet] = readXlsx(
      workbookOf(
        '<row r="1"><c r="A1" t="inlineStr"><is><t>class</t></is></c>' +
          '<c r="B1" t="inlineStr"><is><t>shares</t></is></c></row>' +
          '<row r="2"><c r="A2" t="inlineStr"><is><t>Common</t></is></c>' +
          '<c r="B2" t="e"><v>#DIV/0!</v></c></row>',
      ),
    );
    expect(sheet?.rows[0]?.shares).toBe('');
  });

  it('refuses a ZIP that is not a workbook by saying which part is missing', () => {
    expect(() => readXlsx(buildZip([{ name: 'readme.txt', data: 'not a workbook' }]))).toThrow(
      /xl\/workbook\.xml is missing/,
    );
  });
});
