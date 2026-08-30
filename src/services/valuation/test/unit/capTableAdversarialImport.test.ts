import { describe, expect, it } from 'vitest';
import { buildZip } from '../../src/export/zip.js';
import {
  CsvReadError,
  MAX_CSV_CELLS,
  MAX_CSV_COLUMNS,
  parseCapTable,
  parseCapTableSheet,
  parseCsvSheet,
  parseMultipleCell,
  parseRatioCell,
  validateCapTable,
  fullyDilutedShares,
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
  const { entries, totals } = parseCapTableSheet(sheet.rows, MAPPING, sheet.lines);
  return { sheet, entries, totals, validation: validateCapTable(entries, totals) };
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
    expect(nameColumns(['Shares (2)', 'Shares', 'Shares'])).toEqual(['Shares (2)', 'Shares', 'Shares (3)']);
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
      [
        'class,type,shares,price,invested,liq',
        'Common,common,5000,,,',
        'Founders,common,1000,N/A,-,#N/A',
      ].join('\n'),
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

  /*
   * The rest of this module is built for a non-US sheet — the delimiter
   * sniffer for its semicolons, the separator rule for its decimal comma — and
   * the strip set privileged the one symbol those files do not use.
   */
  /*
   * `rows` on the import body is `z.record(z.string(), z.unknown())`, so any
   * JSON value at all reaches the reader — and `String()` reads a figure out of
   * some shapes. The provider reader one file away has refused exactly this on
   * exactly these fields since it was written; this reader stringified.
   */
  describe('a cell holding a shape rather than a value', () => {
    const mapping = { security_class: 'class', shares: 'shares', price_per_share: 'price' };

    it('refuses a share count read out of a list rather than importing it', () => {
      const [entry] = parseCapTable([{ class: 'Common', shares: [1000] }], mapping);
      expect(entry!.shares).toBe(0);
      expect(entry!.unreadable_numbers).toEqual({ shares: 'a list' });
      expect(validateCapTable([entry!]).valid).toBe(false);
    });

    it('names an object cell as an object rather than quoting [object Object]', () => {
      const [entry] = parseCapTable([{ class: 'Common', shares: '10', price: { usd: 2 } }], mapping);
      expect(entry!.unreadable_numbers).toEqual({ price_per_share: 'an object' });
      const issue = validateCapTable([entry!]).issues.find((i) => i.code === 'unreadable_number')!;
      expect(issue.message).toContain('"an object"');
      expect(issue.message).not.toContain('[object Object]');
    });

    it('does not mint a security class out of an object or a list', () => {
      const entries = parseCapTable(
        [
          { class: { name: 'Series A' }, shares: '1000' },
          { class: ['Series', 'B'], shares: '2000' },
        ],
        mapping,
      );
      expect(entries.map((e) => e.security_class)).toEqual(['', '']);
      const codes = validateCapTable(entries).issues.map((i) => i.code);
      expect(codes.filter((c) => c === 'missing_class')).toHaveLength(2);
    });

    it('keeps reading an ordinary numeric cell that arrives as a JSON number', () => {
      const [entry] = parseCapTable([{ class: 'Common', shares: 1000, price: 1.25 }], mapping);
      expect(entry!.shares).toBe(1000);
      expect(entry!.price_per_share).toBe(1.25);
      expect(entry!.unreadable_numbers).toBeUndefined();
    });
  });

  it('reads a money cell in the currency the sheet was written in', () => {
    const { rows } = parseCsvSheet(
      'class;shares;price\n' +
        'Euro;1000;€1,00\n' +
        'Sterling;1000;£1.50\n' +
        'Yen;1000;¥100\n' +
        'Rupee;1000;₹1,00,000\n' +
        'Trailing;1000;1 234,56 €\n' +
        'Dollar;1000;$1.50\n',
    );
    const entries = parseCapTable(rows, {
      security_class: 'class',
      shares: 'shares',
      price_per_share: 'price',
    });
    expect(entries.map((e) => e.price_per_share)).toEqual([1, 1.5, 100, 100_000, 1234.56, 1.5]);
    expect(entries.some((e) => e.unreadable_numbers)).toBe(false);
  });

  /*
   * A currency *code* is letters beside a figure, which is as often a row
   * shifted by an unquoted comma as it is a price — and `2x` in the multiple
   * column is a notation this file reads for meaning. It stays reported rather
   * than guessed at.
   */
  it('still refuses a figure written with a currency code rather than a symbol', () => {
    const entries = parseCapTable([{ class: 'Common', shares: '1000', price: 'USD 1.50' }], {
      security_class: 'class',
      shares: 'shares',
      price_per_share: 'price',
    });
    expect(entries[0]!.price_per_share).toBeNull();
    expect(entries[0]!.unreadable_numbers).toEqual({ price_per_share: 'USD 1.50' });
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
      `\ufeff${csv}`,
    );
    // The BOM is stripped once, by the parser, on every path into it.
    expect(parseCsvSheet(`\ufeff${csv}`).headers).toEqual(['class', 'shares']);
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

describe('adversarial imports — the totals row every real export carries', () => {
  /**
   * A cap table is a list of holdings with a sum printed under it, and the sum
   * is not a holding. Carta writes one, Pulley writes one, and the workbook
   * this platform exports writes `Total (fully diluted)` with `SUM(C..)` beside
   * it — so the round trip of downloading the workbook, editing a share count
   * and uploading it again went through this path too.
   *
   * Imported as a security class, that row holds by construction the sum of
   * every real class: the fully-diluted count doubles, so every ownership
   * percentage halves and so does the per-share price the 409A concludes. It is
   * the exact failure this file exists to find — a finite, plausible, clean-
   * validating wrong number — and the unit test guarding it was called "skips
   * blank/total rows" while asserting that the total row was kept.
   */
  const withTotal = [
    'class,shares,price',
    'Common,6000000,0.10',
    'Series A,4000000,1.00',
    'Total,10000000,',
  ].join('\n');

  it('does not import the sum of the table as a holding in the table', () => {
    const { entries, validation } = importCsv(withTotal);
    expect(entries.map((e) => e.security_class)).toEqual(['Common', 'Series A']);
    // The figure the whole thing is for: 10,000,000, not the 20,000,000 that
    // counting the total row as a class produced.
    expect(validation.summary.fully_diluted_shares).toBe(10_000_000);
    expect(validation.summary.total_shares).toBe(10_000_000);
    expect(validation.summary.class_count).toBe(2);
  });

  it('says it dropped the row rather than dropping it silently', () => {
    const { validation } = importCsv(withTotal);
    const issue = validation.issues.find((i) => i.code === 'totals_row_skipped');
    expect(issue?.severity).toBe('warning');
    expect(issue?.row).toBe(4);
    expect(issue?.message).toContain('"Total" states a total rather than a holding');
    // A warning, so an ordinary export still imports.
    expect(validation.valid).toBe(true);
  });

  it("recognises the spellings a real export writes, and the platform's own", () => {
    for (const label of [
      'Total',
      'TOTAL',
      'Totals',
      'Total:',
      'Total (fully diluted)',
      'Total [FD]',
      'Total shares',
      'Total Shares Outstanding',
      'Total fully diluted',
      'Grand Total',
      'Grand total shares',
      'Subtotal',
      'Sub-total',
      'Total Preferred',
      'Total common',
      'Sum',
      'Total *',
    ]) {
      const { entries } = importCsv(`class,shares,price\nCommon,6000000,0.10\n${label},6000000,`);
      expect(
        entries.map((e) => e.security_class),
        label,
      ).toEqual(['Common']);
    }
  });

  /**
   * The other half of the rule, and the more important one: a tail of ordinary
   * words is what makes a label a total, so a security class that merely begins
   * with the word is still a security class. Dropping a real holding would be a
   * worse bug than the one being fixed — it would understate the denominator
   * instead of overstating it, just as silently.
   */
  it('keeps a security class whose name merely starts with the word', () => {
    for (const label of [
      'Total Return Preferred',
      'Total Access Series B',
      'Totality Holdings LLC',
      'Sumitomo Series C',
      'Subtotal Systems Inc Common',
    ]) {
      const { entries } = importCsv(`class,shares,price\nCommon,6000000,0.10\n${label},1000,0.5`);
      expect(
        entries.map((e) => e.security_class),
        label,
      ).toEqual(['Common', label]);
    }
  });

  it('uses the stated total as a checksum, and says so when it disagrees', () => {
    // The sheet totals 10,000,000; the rows read sum to 9,000,000. Either a row
    // was not read or a share count was — both are otherwise silent.
    const { validation } = importCsv(
      ['class,shares,price', 'Common,6000000,0.10', 'Series A,3000000,1.00', 'Total,10000000,'].join('\n'),
    );
    const issue = validation.issues.find((i) => i.code === 'totals_row_mismatch');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('states 10,000,000 shares');
    expect(issue?.message).toContain('sum to 9,000,000');
  });

  it('raises no mismatch when the total agrees on either basis', () => {
    // Raw sum: 6,000,000 + 4,000,000. As-converted: the Series A converts 2:1,
    // so 6,000,000 + 8,000,000. A sheet may total either, and is asked to
    // declare neither.
    const raw = importCsv(
      [
        'class,shares,price,conv',
        'Common,6000000,0.10,',
        'Series A,4000000,1.00,2:1',
        'Total,10000000,,',
      ].join('\n'),
    );
    expect(raw.validation.summary.fully_diluted_shares).toBe(14_000_000);
    expect(codes(raw.validation.issues)).not.toContain('warning/totals_row_mismatch');

    const converted = importCsv(
      [
        'class,shares,price,conv',
        'Common,6000000,0.10,',
        'Series A,4000000,1.00,2:1',
        'Total (fully diluted),14000000,,',
      ].join('\n'),
    );
    expect(codes(converted.validation.issues)).not.toContain('warning/totals_row_mismatch');
  });

  it('checks against the grand total rather than the last subtotal', () => {
    const { validation } = importCsv(
      [
        'class,shares,price',
        'Common,6000000,0.10',
        'Total common,6000000,',
        'Series A,4000000,1.00',
        'Total preferred,4000000,',
        'Grand Total,10000000,',
      ].join('\n'),
    );
    expect(validation.summary.fully_diluted_shares).toBe(10_000_000);
    expect(codes(validation.issues)).not.toContain('warning/totals_row_mismatch');
    expect(validation.issues.filter((i) => i.code === 'totals_row_skipped')).toHaveLength(3);
  });

  it('does not invent a checksum for a table that has no totals row', () => {
    const { totals, validation } = importCsv('class,shares,price\nCommon,6000000,0.10');
    expect(totals).toEqual([]);
    expect(codes(validation.issues)).not.toContain('warning/totals_row_mismatch');
    expect(codes(validation.issues)).not.toContain('warning/totals_row_skipped');
  });

  it('reads the workbook this platform exports back into the table it came from', () => {
    /*
     * The round trip the export exists for: download the valuation workbook,
     * change a share count, upload it again. The Cap table sheet's headers and
     * its `Total (fully diluted)` footer are written by
     * `export/valuationWorkbook.ts`; this reproduces that shape rather than
     * importing the exporter, because what is being tested is that the importer
     * survives the *file*, whatever wrote it.
     */
    const [sheet] = readXlsx(
      workbookOf(
        sheetRows([
          ['class', 'type', 'shares', 'price', 'invested', 'liq', 'sen', 'conv'],
          ['Common', 'common', '6000000', '0.0001', '', '', '', ''],
          ['Series A Preferred', 'preferred', '4000000', '1.25', '5000000', '1', '1', '1'],
          ['Total (fully diluted)', '', '10000000', '', '5000000', '', '', ''],
        ]),
      ),
    );
    const { entries, totals } = parseCapTableSheet(sheet?.rows ?? [], MAPPING, sheet?.lines);
    const validation = validateCapTable(entries, totals);
    expect(entries.map((e) => e.security_class)).toEqual(['Common', 'Series A Preferred']);
    expect(fullyDilutedShares(entries)).toBe(10_000_000);
    expect(validation.valid).toBe(true);
    expect(codes(validation.issues)).not.toContain('warning/totals_row_mismatch');
  });
});

describe('adversarial imports — importing the same file twice', () => {
  const csv = [
    'class,type,shares,price,invested,liq,sen,conv',
    'Common,common,6000000,0.0001,,,,',
    'Série A,preferred,4000000,"1,25","5.000.000","2x",1,"2:1"',
    'Total,,10000000,,,,,',
  ].join('\n');

  /**
   * The importer is a pure function of the bytes, and the reason to pin that is
   * that it stopped being obvious once it grew state to be wrong about: a
   * `Map` of column-name uses, a `Set` of names already minted, running cell
   * and record counters, and a list of totals rows. Any of those leaking across
   * a call — or any dependence on `Date`, iteration order or a module-level
   * accumulator — makes the second import of a file differ from the first,
   * which for a cap table is a silently different denominator.
   */
  it('reads identically however many times it is read', () => {
    const once = importCsv(csv);
    const twice = importCsv(csv);
    const thrice = importCsv(csv);
    expect(twice.entries).toEqual(once.entries);
    expect(thrice.entries).toEqual(once.entries);
    expect(twice.validation).toEqual(once.validation);
    expect(twice.totals).toEqual(once.totals);
  });

  it('is unaffected by another file having been read in between', () => {
    const before = importCsv(csv);
    importCsv('shares,shares,shares\n1,2,3\nTotal,9,');
    importCsv('class,shares\nOnly,1');
    expect(importCsv(csv).entries).toEqual(before.entries);
  });

  /**
   * Duplicate-header suffixing is the state most likely to leak, because it is
   * the only part of the reader that mints names rather than reading them.
   */
  it('names duplicate columns the same way on every pass', () => {
    const header = ['Shares (2)', 'Shares', 'Shares', 'Shares (3)'];
    const first = nameColumns(header);
    expect(nameColumns(header)).toEqual(first);
    expect(new Set(first).size).toBe(header.length);
  });

  /**
   * Re-importing what a previous import produced. The entries are round-tripped
   * through JSON because that is how they are stored and read back, and a
   * validation re-derived from them has to agree with the one computed at
   * import time — `findCapTable` recomputes it on every read, so the two
   * disagreeing means the number on the screen changes when nothing did.
   */
  it('re-derives the stored validation from the entries alone', () => {
    const { entries, validation, totals } = importCsv(csv);
    const stored = JSON.parse(JSON.stringify(entries)) as typeof entries;
    const rederived = validateCapTable(stored);
    expect(rederived.summary).toEqual(validation.summary);
    // The totals issues are the whole of the difference, and they are the ones
    // that cannot survive: they are statements about the uploaded file, not
    // about the entries. The route persists the re-derived form for exactly
    // this reason.
    const fileOnly = new Set(['totals_row_skipped', 'totals_row_mismatch']);
    expect(codes(rederived.issues)).toEqual(codes(validation.issues.filter((i) => !fileOnly.has(i.code))));
    expect(rederived.valid).toBe(validation.valid);
    expect(validateCapTable(stored, totals).issues).toEqual(validation.issues);
  });
});

/**
 * A header, or a column mapping, that names something `Object.prototype` has.
 *
 * `renderTemplate` in domain/communications.ts already carries this bug's twin:
 * `{{constructor}}` rendered as `function Object() { [native code] }` because a
 * plain lookup finds the names on the prototype, and none of them is ever
 * `undefined`, so none of them could reach the "unknown placeholder" answer
 * that was the truth about all of them. The import pipeline had the same two
 * spellings — `header in row` in `readCell`, and `obj[name] = …` in
 * `rowByColumn` — and the mapping that reaches `readCell` is
 * `z.record(z.string(), z.string())` on the request body, so the header being
 * looked up is a string the caller chose.
 */
describe('a column named after something every object already has', () => {
  const PROTO_NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'] as const;

  const CSV = 'class,type,shares\nSeries A,preferred,100\n';
  const withShareColumn = (name: string) => {
    const sheet = parseCsvSheet(CSV);
    return parseCapTableSheet(sheet.rows, { ...MAPPING, shares: name }, sheet.lines);
  };

  it.each(PROTO_NAMES)('reads %s exactly like a column that is simply not there', (name) => {
    // The control is a name nothing could match. The property is that the two
    // are the *same* answer: before this, one of them resolved to a function,
    // and the importer complained about the quantity rather than the mapping.
    const absent = withShareColumn('no-such-column');
    const named = withShareColumn(name);
    expect(named.entries).toEqual(absent.entries);
    expect(codes(validateCapTable(named.entries, named.totals).issues)).toEqual(
      codes(validateCapTable(absent.entries, absent.totals).issues),
    );
    // And the control is not vacuous: an unmapped share count is an error, so
    // both sides are being held to a real complaint rather than to silence.
    expect(codes(validateCapTable(absent.entries, absent.totals).issues).length).toBeGreaterThan(0);
  });

  it('never lets a function reach a text field', () => {
    const sheet = parseCsvSheet('class,type,shares\nSeries A,preferred,100\n');
    const { entries } = parseCapTableSheet(
      sheet.rows,
      { ...MAPPING, security_class: 'toString' },
      sheet.lines,
    );
    // `String(row.toString)` is `function toString() { [native code] }`, which
    // is a security class name that would have been persisted verbatim.
    expect(entries[0]?.security_class ?? '').not.toMatch(/native code/);
  });

  it('keeps a column actually headed __proto__ rather than losing it silently', () => {
    // `obj.__proto__ = '100'` runs the accessor every object inherits, which
    // ignores a string — so the assignment did nothing at all: no error, no
    // key, and a whole column gone from an import that reported success.
    const row = rowByColumn(['__proto__', 'shares'], ['kept', '100']);
    expect(Object.keys(row)).toEqual(['__proto__', 'shares']);
    expect(row['__proto__']).toBe('kept');
  });

  it('leaves the row an ordinary object, so what is stored round-trips', () => {
    const row = rowByColumn(['__proto__', 'shares'], ['kept', '100']);
    // Written back out and read in again — `{ __proto__: … }` as an object
    // literal sets the prototype rather than a key, so the expectation has to
    // be built the same way the row is.
    const back = JSON.parse(JSON.stringify(row)) as Record<string, string>;
    expect(Object.keys(back).sort()).toEqual(['__proto__', 'shares']);
    expect(back['__proto__']).toBe('kept');
    expect(back['shares']).toBe('100');
  });

  it('does not pollute Object.prototype along the way', () => {
    rowByColumn(['__proto__'], ['{"polluted":true}']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('still reads a real column, case-insensitively, as it always did', () => {
    const sheet = parseCsvSheet('CLASS,type,Shares\nSeries A,preferred,100\n');
    const { entries } = parseCapTableSheet(sheet.rows, MAPPING, sheet.lines);
    expect(entries[0]?.shares).toBe(100);
    expect(entries[0]?.security_class).toBe('Series A');
  });
});
