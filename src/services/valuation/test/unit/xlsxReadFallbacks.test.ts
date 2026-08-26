import { describe, expect, it } from 'vitest';
import { buildZip } from '../../src/export/zip.js';
import {
  columnIndex,
  excelSerialToIso,
  looksLikeDateFormat,
  looksLikeXlsx,
  readXlsx,
  XlsxReadError,
} from '../../src/domain/xlsxRead.js';

/**
 * The workbook shapes `xlsxRead.test.ts` does not build: a missing
 * relationships part, a target rooted at the package root or written with a
 * `./` prefix, a `<sheet>` with no name or an `id` attribute instead of `r:id`,
 * a shared-string index that is not one, and a styles part whose custom number
 * formats are not dates.
 *
 * These are not hypothetical variants. The reader's job is to accept a workbook
 * an analyst uploaded, and the file came out of whatever wrote it — Excel,
 * Numbers, a Python script, an export from a cap-table vendor. Every fallback
 * here is the difference between reading that file and refusing an upload the
 * user can see is fine.
 */

const SHARED = ['alpha', 'beta'];
const sharedStringsPart = () =>
  `<?xml version="1.0"?><sst count="${SHARED.length}">${SHARED.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`;

const SIMPLE_SHEET = `<?xml version="1.0"?><worksheet><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
  <row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>2</v></c></row>
</sheetData></worksheet>`;

interface WorkbookParts {
  workbook: string;
  rels?: string;
  styles?: string;
  sheets: Array<{ path: string; data: string }>;
}

function build(parts: WorkbookParts): Buffer {
  const entries = [
    { name: 'xl/workbook.xml', data: parts.workbook },
    { name: 'xl/sharedStrings.xml', data: sharedStringsPart() },
    ...parts.sheets.map((s) => ({ name: s.path, data: s.data })),
  ];
  if (parts.rels !== undefined) entries.push({ name: 'xl/_rels/workbook.xml.rels', data: parts.rels });
  if (parts.styles !== undefined) entries.push({ name: 'xl/styles.xml', data: parts.styles });
  return buildZip(entries);
}

describe('column references', () => {
  it('returns null for a reference with no letters in it', () => {
    for (const ref of ['', '12', '-A1', ' A1']) expect(columnIndex(ref), ref).toBeNull();
  });

  it('reads single and multi-letter references, case-insensitively', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('z9')).toBe(25);
    expect(columnIndex('AA1')).toBe(26);
    expect(columnIndex('XFD1048576')).toBe(16383);
  });
});

describe('date serials', () => {
  it('renders a whole-day serial as a date and a fractional one with its time', () => {
    // A whole-day serial carries no meaningful time, and printing 00:00:00
    // beside every date would read as a precision the file does not have.
    expect(excelSerialToIso(45352)).toBe('2024-03-01');
    expect(excelSerialToIso(45352.5)).toMatch(/^2024-03-01 12:00:00$/);
  });

  it('hands back the serial itself when it cannot be a date', () => {
    // Better a visibly odd cell than an Invalid Date rendered as text.
    for (const serial of [Number.POSITIVE_INFINITY, Number.NaN, 1e15]) {
      expect(String(excelSerialToIso(serial))).not.toContain('Invalid');
    }
  });
});

describe('the magic bytes', () => {
  it('accepts a zip and rejects anything else', () => {
    expect(looksLikeXlsx(Buffer.from('PKrest'))).toBe(true);
    expect(looksLikeXlsx(Buffer.from('%PDF-1.7'))).toBe(false);
    expect(looksLikeXlsx(Buffer.alloc(0))).toBe(false);
    expect(looksLikeXlsx(Buffer.from('PK'))).toBe(false);
  });
});

describe('resolving where a sheet lives', () => {
  it('falls back to sheetN.xml when there is no relationships part at all', () => {
    // Some writers omit it. The positional guess is wrong in general, which is
    // why it is a fallback — but it is right for the single-sheet file that
    // omitting it usually accompanies.
    const wb = build({
      workbook: `<?xml version="1.0"?><workbook><sheets><sheet name="Only" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      sheets: [{ path: 'xl/worksheets/sheet1.xml', data: SIMPLE_SHEET }],
    });
    const sheets = readXlsx(wb);
    expect(sheets.map((s) => s.name)).toEqual(['Only']);
    expect(sheets[0]!.rows.length).toBeGreaterThan(0);
  });

  it('resolves a target rooted at the package root', () => {
    const wb = build({
      workbook: `<?xml version="1.0"?><workbook><sheets><sheet name="Rooted" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      rels: `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="/xl/worksheets/odd.xml"/></Relationships>`,
      sheets: [{ path: 'xl/worksheets/odd.xml', data: SIMPLE_SHEET }],
    });
    expect(readXlsx(wb).map((s) => s.name)).toEqual(['Rooted']);
  });

  it('resolves a target written with a ./ prefix', () => {
    const wb = build({
      workbook: `<?xml version="1.0"?><workbook><sheets><sheet name="Dotted" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      rels: `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="./worksheets/dotted.xml"/></Relationships>`,
      sheets: [{ path: 'xl/worksheets/dotted.xml', data: SIMPLE_SHEET }],
    });
    expect(readXlsx(wb).map((s) => s.name)).toEqual(['Dotted']);
  });

  it('accepts a bare id attribute where the namespace prefix was dropped', () => {
    const wb = build({
      workbook: `<?xml version="1.0"?><workbook><sheets><sheet name="Bare" sheetId="1" id="rId1"/></sheets></workbook>`,
      rels: `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/bare.xml"/></Relationships>`,
      sheets: [{ path: 'xl/worksheets/bare.xml', data: SIMPLE_SHEET }],
    });
    expect(readXlsx(wb).map((s) => s.name)).toEqual(['Bare']);
  });

  it('names an unnamed sheet by its position rather than leaving it blank', () => {
    const wb = build({
      workbook: `<?xml version="1.0"?><workbook><sheets><sheet sheetId="1" r:id="rId1"/></sheets></workbook>`,
      rels: `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      sheets: [{ path: 'xl/worksheets/sheet1.xml', data: SIMPLE_SHEET }],
    });
    expect(readXlsx(wb).map((s) => s.name)).toEqual(['Sheet1']);
  });

  it('refuses a zip that is not a workbook at all', () => {
    const notAWorkbook = buildZip([{ name: 'readme.txt', data: 'hello' }]);
    expect(() => readXlsx(notAWorkbook)).toThrow(XlsxReadError);
    expect(() => readXlsx(notAWorkbook)).toThrow(/xl\/workbook\.xml/);
  });

  it('refuses bytes that are not a zip, naming the failure', () => {
    expect(() => readXlsx(Buffer.from('not a zip at all'))).toThrow(XlsxReadError);
    expect(() => readXlsx(Buffer.from('not a zip at all'))).toThrow(/could not read the workbook/i);
  });
});

describe('number formats', () => {
  const workbook = `<?xml version="1.0"?><workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`;
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" s="1"><v>45352</v></c><c r="B2"><v>7</v></c></row>
  </sheetData></worksheet>`;

  const read = (styles: string | undefined) =>
    readXlsx(
      build({ workbook, rels, styles, sheets: [{ path: 'xl/worksheets/sheet1.xml', data: sheet }] }),
    )[0]!;

  it('treats a custom format containing date tokens as a date', () => {
    const styles = `<?xml version="1.0"?><styleSheet>
      <numFmts><numFmt numFmtId="180" formatCode="dd mmm yyyy"/></numFmts>
      <cellXfs><xf numFmtId="0"/><xf numFmtId="180"/></cellXfs>
    </styleSheet>`;
    expect(read(styles).rows[0]!.alpha).toBe('2024-03-01');
  });

  it('does not mistake a currency format for a date because of its literal text', () => {
    // The quoted literal is stripped before the token test, so a format like
    // `"May"#,##0.00` is money — a serial rendered as a date here would turn a
    // dollar figure into a day.
    const styles = `<?xml version="1.0"?><styleSheet>
      <numFmts><numFmt numFmtId="181" formatCode="&quot;May&quot;#,##0.00"/></numFmts>
      <cellXfs><xf numFmtId="0"/><xf numFmtId="181"/></cellXfs>
    </styleSheet>`;
    expect(read(styles).rows[0]!.alpha).toBe('45352');
  });

  it('leaves an escaped token alone as well', () => {
    // `\d` is a literal `d`, not a day token.
    const styles = `<?xml version="1.0"?><styleSheet>
      <numFmts><numFmt numFmtId="182" formatCode="0\\d"/></numFmts>
      <cellXfs><xf numFmtId="0"/><xf numFmtId="182"/></cellXfs>
    </styleSheet>`;
    expect(read(styles).rows[0]!.alpha).toBe('45352');
  });

  it('falls back to plain serials when the styles part is missing', () => {
    expect(read(undefined).rows[0]!.alpha).toBe('45352');
  });

  /**
   * A bracketed section is literal text as often as the quoted runs beside it,
   * and the words it spells are the colour names — every one of which carries a
   * letter the date-token test looks for. `[Red]` is the one that matters: it
   * is half of the red-negatives currency format a finance spreadsheet reaches
   * for on exactly the columns a cap table is made of, so the serial 45,352 —
   * a share count, a price, a valuation — arrived in the import as the string
   * "2024-03-01" and there was nothing in the file to explain it.
   */
  const NOT_DATE_FORMATS: Array<[label: string, code: string]> = [
    ['red negatives', '#,##0.00;[Red]-#,##0.00'],
    ['a yellow number', '[Yellow]#,##0'],
    ['a magenta number', '[Magenta]0'],
    ['a white number', '[White]0.0000'],
    ['a bracketed currency code', '[$USD]#,##0.00'],
    ['a locale-qualified currency', '[$-409]#,##0.00'],
    ['a conditional format', '[&gt;1000]0,&quot;K&quot;;0'],
  ];

  it.each(NOT_DATE_FORMATS)('does not read %s as a date format', (_label, code) => {
    const styles = `<?xml version="1.0"?><styleSheet>
      <numFmts><numFmt numFmtId="190" formatCode="${code}"/></numFmts>
      <cellXfs><xf numFmtId="0"/><xf numFmtId="190"/></cellXfs>
    </styleSheet>`;
    expect(read(styles).rows[0]!.alpha).toBe('45352');
  });

  /**
   * The other half: dropping every bracketed section outright would lose the
   * elapsed-time tokens, which are the one thing brackets legitimately hold —
   * `[h]` is hours-past-24, not a modifier, and a cell carrying it is a time.
   */
  const DATE_FORMATS: Array<[label: string, code: string]> = [
    ['elapsed hours', '[h]:mm:ss'],
    ['elapsed minutes', '[mm]:ss'],
    ['a coloured date', '[Red]dd/mm/yyyy'],
    ['a locale-qualified date', '[$-409]d mmm yyyy'],
  ];

  it.each(DATE_FORMATS)('still reads %s as a date format', (_label, code) => {
    const styles = `<?xml version="1.0"?><styleSheet>
      <numFmts><numFmt numFmtId="191" formatCode="${code}"/></numFmts>
      <cellXfs><xf numFmtId="0"/><xf numFmtId="191"/></cellXfs>
    </styleSheet>`;
    expect(read(styles).rows[0]!.alpha).not.toBe('45352');
  });
});

/**
 * `looksLikeDateFormat` directly, for the cases a whole workbook cannot express
 * cleanly — an unterminated bracket, and a bracket that only *looks* like an
 * elapsed-time token.
 */
describe('format-code classification', () => {
  it('keeps only a pure h/m/s run inside brackets as a token', () => {
    expect(looksLikeDateFormat('[hh]:mm')).toBe(true);
    expect(looksLikeDateFormat('[ss].0')).toBe(true);
    // Not a run of one token letter — a modifier that happens to start with one.
    expect(looksLikeDateFormat('[hms]0')).toBe(false);
    expect(looksLikeDateFormat('[h2]0')).toBe(false);
  });

  it('treats an unterminated bracket as ordinary text', () => {
    expect(looksLikeDateFormat('0.00[')).toBe(false);
    expect(looksLikeDateFormat('0.00[Red')).toBe(false);
  });

  it('strips quoted runs before it looks at brackets', () => {
    expect(looksLikeDateFormat('"[dd]"#,##0')).toBe(false);
    expect(looksLikeDateFormat('0"[Red]"')).toBe(false);
  });

  it('strips escapes, so an escaped token letter is still literal', () => {
    expect(looksLikeDateFormat('\\d\\d0')).toBe(false);
    // `\[` is a literal bracket, so what follows it is a real day token.
    expect(looksLikeDateFormat('\\[dd\\]0')).toBe(true);
  });
});

describe('cell contents', () => {
  const wrap = (rows: string) =>
    build({
      workbook: `<?xml version="1.0"?><workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      rels: `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      sheets: [
        {
          path: 'xl/worksheets/sheet1.xml',
          data: `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`,
        },
      ],
    });

  it('reads a shared-string index that does not resolve as blank', () => {
    // A corrupt or truncated sharedStrings part must leave a blank cell, not
    // the string "undefined" rendered into a spreadsheet column. One index is
    // past the end of the table and the other is not a number at all.
    const sheets = readXlsx(
      wrap(`<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
            <row r="2"><c r="A2" t="s"><v>99</v></c><c r="B2" t="s"><v>x</v></c></row>`),
    );
    expect(sheets[0]!.headers).toEqual(['alpha', 'beta']);
    expect(sheets[0]!.rows).toEqual([]);
  });

  it('reads a boolean cell as TRUE or FALSE', () => {
    const sheets = readXlsx(
      wrap(`<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
            <row r="2"><c r="A2" t="b"><v>1</v></c><c r="B2" t="b"><v>0</v></c></row>`),
    );
    expect(sheets[0]!.rows[0]).toEqual({ alpha: 'TRUE', beta: 'FALSE' });
  });

  it('treats an error cell as blank rather than as the text of the error', () => {
    // `#REF!` in a shares column would parse as a company name.
    const sheets = readXlsx(
      wrap(`<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
            <row r="2"><c r="A2" t="e"><v>#REF!</v></c><c r="B2"><v>5</v></c></row>`),
    );
    expect(sheets[0]!.rows[0]!.alpha).toBe('');
    expect(sheets[0]!.rows[0]!.beta).toBe('5');
  });

  it('reads a formula cell with no cached value as blank, and one with a value', () => {
    const sheets = readXlsx(
      wrap(`<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
            <row r="2"><c r="A2" t="str"><f>CONCAT()</f></c><c r="B2" t="str"><v>done</v></c></row>`),
    );
    expect(sheets[0]!.rows[0]).toEqual({ alpha: '', beta: 'done' });
  });

  it('positions a cell with no reference after the one before it', () => {
    const sheets = readXlsx(
      wrap(`<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
            <row r="2"><c><v>7</v></c><c><v>8</v></c></row>`),
    );
    expect(sheets[0]!.rows[0]).toEqual({ alpha: '7', beta: '8' });
  });
});
