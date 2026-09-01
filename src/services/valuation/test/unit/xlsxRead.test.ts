import { describe, expect, it } from 'vitest';
import { buildZip } from '../../src/export/zip.js';
import { expectSubQuadratic } from '../support/complexity.js';
import { buildXlsx } from '../../src/export/xlsx.js';
import {
  columnIndex,
  decodeXmlText,
  excelSerialToIso,
  gridToRows,
  looksLikeXlsx,
  MAX_COLUMN,
  MAX_ROW,
  readXlsx,
  XlsxReadError,
} from '../../src/domain/xlsxRead.js';

/**
 * Assembles a minimal but structurally faithful `.xlsx`: shared strings, a
 * styles part with both a built-in and a custom date format, and sheets whose
 * relationship ids deliberately do not match their file numbering.
 */
const SHARED_STRINGS = [
  'class',
  'shares',
  'price',
  'round closed',
  'Common Stock',
  'Series A Preferred',
  'Option Pool',
  'Series B & C "bridge"',
];

function sharedStringsPart(): string {
  const items = SHARED_STRINGS.map(
    (s) => `<si><t>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')}</t></si>`,
  ).join('');
  return `<?xml version="1.0"?><sst count="${SHARED_STRINGS.length}">${items}</sst>`;
}

/** cellXfs: 0 = general, 1 = built-in date (14), 2 = custom date (164), 3 = money. */
const STYLES = `<?xml version="1.0"?><styleSheet>
  <numFmts count="2">
    <numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>
    <numFmt numFmtId="165" formatCode="&quot;May&quot;#,##0.00"/>
  </numFmts>
  <cellXfs count="4">
    <xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/>
  </cellXfs>
</styleSheet>`;

/** A spacer row, a header row, then sparse data rows — as real exports look. */
const SHEET_CAP_TABLE = `<?xml version="1.0"?><worksheet><sheetData>
  <row r="1"/>
  <row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>1</v></c><c r="C2" t="s"><v>2</v></c><c r="D2" t="s"><v>3</v></c></row>
  <row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><v>8000000</v></c><c r="C3" s="3"><v>0.1</v></c></row>
  <row r="4"><c r="A4" t="s"><v>5</v></c><c r="B4"><v>2000000</v></c><c r="C4"><v>1</v></c><c r="D4" s="1"><v>45352</v></c></row>
  <row r="5"><c r="A5" t="s"><v>7</v></c><c r="B5"><v>500000</v></c><c r="D5" s="2"><v>45383</v></c></row>
  <row r="6"><c r="A6" t="inlineStr"><is><t>Option </t><t>Pool</t></is></c><c r="B6"><v>1000000</v></c></row>
  <row r="7"/>
</sheetData></worksheet>`;

/** Exercises the remaining cell types: formula string, boolean, error. */
const SHEET_TYPES = `<?xml version="1.0"?><worksheet><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
  <row r="2"><c r="A2" t="str"><v>=CONCAT()</v></c><c r="B2" t="b"><v>1</v></c><c r="C2" t="e"><v>#REF!</v></c></row>
</sheetData></worksheet>`;

function buildWorkbook(
  overrides: { sheets?: Array<{ name: string; data: string }>; omitStyles?: boolean } = {},
): Buffer {
  const sheets = overrides.sheets ?? [
    { name: 'Cap Table', data: SHEET_CAP_TABLE },
    { name: 'Types', data: SHEET_TYPES },
  ];
  // rId order is reversed relative to file numbering on purpose: the reader
  // must resolve targets through the rels part, not guess from the index.
  const rid = (i: number) => `rId${sheets.length - i}`;
  const workbook = `<?xml version="1.0"?><workbook><sheets>${sheets
    .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="${rid(i)}"/>`)
    .join('')}</sheets></workbook>`;
  const rels = `<?xml version="1.0"?><Relationships>${sheets
    .map((_, i) => `<Relationship Id="${rid(i)}" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('')}</Relationships>`;

  const parts = [
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/sharedStrings.xml', data: sharedStringsPart() },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.data })),
  ];
  if (!overrides.omitStyles) parts.push({ name: 'xl/styles.xml', data: STYLES });
  return buildZip(parts);
}

describe('xlsxRead', () => {
  describe('helpers', () => {
    it('decodes named and numeric XML entities', () => {
      expect(decodeXmlText('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe(`a & b <c> "d" 'e'`);
      expect(decodeXmlText('&#65;&#x42;')).toBe('AB');
      expect(decodeXmlText('&unknown; stays')).toBe('&unknown; stays');
      // `&constructor;` is letters and nothing else, so it reaches the
      // named-entity branch. The table was a plain object literal, so the
      // lookup was answered from `Object.prototype` with a function — not
      // nullish, so the `?? match` that leaves `&unknown;` alone never ran, and
      // a cell imported as `function Object() { [native code] }`.
      expect(decodeXmlText('Acme &constructor; Inc')).toBe('Acme &constructor; Inc');
      for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
        expect(decodeXmlText(`x&${name};y`)).toBe(`x&${name};y`);
      }
    });

    it('leaves a numeric reference that is not a character as written', () => {
      // String.fromCodePoint throws past U+10FFFF, and that RangeError is not an
      // XlsxReadError — it escaped the parser and turned a bad upload into a 500.
      // Astral characters are real and must still decode.
      expect(decodeXmlText('&#x1F600;')).toBe('😀');
      expect(decodeXmlText('&#1114111;')).toBe('\u{10FFFF}');
      expect(decodeXmlText('Acme &#1114112; Inc')).toBe('Acme &#1114112; Inc');
      expect(decodeXmlText('&#99999999;')).toBe('&#99999999;');
      expect(decodeXmlText('&#x7FFFFFFF;')).toBe('&#x7FFFFFFF;');
      // Half of a surrogate pair is not a character either, and would not
      // survive the trip through UTF-8 into the database.
      expect(decodeXmlText('&#xD800;')).toBe('&#xD800;');
      expect(decodeXmlText('&#xDFFF;')).toBe('&#xDFFF;');
    });

    it('reads a workbook carrying an out-of-range reference rather than throwing', () => {
      const [sheet] = readXlsx(
        buildWorkbook({
          sheets: [
            {
              name: 'S',
              data:
                '<?xml version="1.0"?><worksheet><sheetData>' +
                '<row><c r="A1" t="inlineStr"><is><t>class</t></is></c>' +
                '<c r="B1" t="inlineStr"><is><t>shares</t></is></c></row>' +
                '<row><c r="A2" t="inlineStr"><is><t>Acme &#99999999; Inc</t></is></c>' +
                '<c r="B2"><v>100</v></c></row>' +
                '</sheetData></worksheet>',
            },
          ],
        }),
      );
      expect(sheet!.rows).toEqual([{ class: 'Acme &#99999999; Inc', shares: '100' }]);
    });

    it('converts column references to indices', () => {
      expect(columnIndex('A1')).toBe(0);
      expect(columnIndex('Z9')).toBe(25);
      expect(columnIndex('AA1')).toBe(26);
      expect(columnIndex('AB100')).toBe(27);
      expect(columnIndex('12')).toBeNull();
    });

    it('converts date serials, absorbing the 1900 leap-year offset', () => {
      expect(excelSerialToIso(45292)).toBe('2024-01-01');
      expect(excelSerialToIso(45352)).toBe('2024-03-01');
      expect(excelSerialToIso(1)).toBe('1899-12-31');
      expect(excelSerialToIso(45352.5)).toBe('2024-03-01 12:00:00');
    });

    it('detects the xlsx magic bytes', () => {
      expect(looksLikeXlsx(buildWorkbook())).toBe(true);
      expect(looksLikeXlsx(Buffer.from('class,shares\nCommon,10'))).toBe(false);
      expect(looksLikeXlsx(Buffer.alloc(2))).toBe(false);
    });
  });

  describe('source line numbering', () => {
    it('numbers rows past a preamble by their line in the sheet', () => {
      // A real export: a title line, a blank, then the header. `rows` starts at
      // the first data row, so its indices are three short of the sheet from
      // the outset — before any blank row inside the data widens the gap.
      const { rows, lines } = gridToRows([
        ['Acme Inc — capitalization'],
        [''],
        ['class', 'shares'],
        ['Common', '10'],
        ['', ''],
        ['Series A', '20'],
      ]);
      expect(rows).toHaveLength(2);
      expect(lines).toEqual([4, 6]);
    });

    it('prefers the sheet\u2019s own row numbers when it declares them', () => {
      // `<row r="...">` is sparse: a sheet with nothing on rows 5-8 has no
      // elements for them, so counting positions reports everything after a
      // gap several lines early.
      const grid = [
        ['class', 'shares'],
        ['Common', '10'],
        ['Series A', '20'],
      ];
      expect(gridToRows(grid, [1, 2, 40]).lines).toEqual([2, 40]);
      // Falls back to the position when the file declares none.
      expect(gridToRows(grid).lines).toEqual([2, 3]);
    });
  });

  describe('gridToRows', () => {
    it('skips leading blank rows and keys by the first populated row', () => {
      const { headers, rows } = gridToRows([[], ['', ''], ['class', 'shares'], ['Common', '10']]);
      expect(headers).toEqual(['class', 'shares']);
      expect(rows).toEqual([{ class: 'Common', shares: '10' }]);
    });

    it('drops fully blank rows and columns with no header', () => {
      const { headers, rows } = gridToRows([
        ['class', '', 'shares'],
        ['Common', 'ignored', '10'],
        ['', '', ''],
      ]);
      expect(headers).toEqual(['class', 'shares']);
      expect(rows).toEqual([{ class: 'Common', shares: '10' }]);
    });

    it('skips a single-cell title line above the header', () => {
      const { headers, rows } = gridToRows([
        ['Acme Inc — capitalization as of 2024-03-01'],
        [],
        ['class', 'shares'],
        ['Common', '10'],
      ]);
      expect(headers).toEqual(['class', 'shares']);
      expect(rows).toEqual([{ class: 'Common', shares: '10' }]);
    });

    it('falls back to the first populated row on a one-column sheet', () => {
      const { headers, rows } = gridToRows([['class'], ['Common'], ['Series A']]);
      expect(headers).toEqual(['class']);
      expect(rows).toEqual([{ class: 'Common' }, { class: 'Series A' }]);
    });

    it('returns nothing for an empty grid', () => {
      expect(gridToRows([])).toEqual({ headers: [], rows: [], lines: [] });
      expect(gridToRows([[''], ['']])).toEqual({ headers: [], rows: [], lines: [] });
    });

    /**
     * A repeated header is what Carta writes: a granted "Shares" column beside
     * an outstanding one, or a fund administrator's sheet repeating "Price".
     * Keyed last-wins, the first of the pair is not merely mislabelled — it is
     * gone, and the mapping UI offers the name twice with both entries pointing
     * at the second column. `parseCsvSheet` has suffixed the repeat since the
     * CSV path was fixed; this reader kept the naive mapping, so the same file
     * imported differently depending on which format it was saved in.
     */
    it('suffixes a repeated header instead of letting the last column win', () => {
      const { headers, rows } = gridToRows([
        ['class', 'Shares', 'Shares', 'Price'],
        ['Common', '1000', '900', '0.10'],
      ]);
      expect(headers).toEqual(['class', 'Shares', 'Shares (2)', 'Price']);
      expect(rows).toEqual([{ class: 'Common', Shares: '1000', 'Shares (2)': '900', Price: '0.10' }]);
    });

    it('counts repeats after trimming, and numbers the third one too', () => {
      const { headers, rows } = gridToRows([
        ['Price', ' Price ', 'Price'],
        ['1', '2', '3'],
      ]);
      expect(headers).toEqual(['Price', 'Price (2)', 'Price (3)']);
      expect(rows).toEqual([{ Price: '1', 'Price (2)': '2', 'Price (3)': '3' }]);
    });

    it('does not suffix the blank columns it drops', () => {
      const { headers, rows } = gridToRows([
        ['class', '', '', 'shares'],
        ['Common', 'a', 'b', '10'],
      ]);
      expect(headers).toEqual(['class', 'shares']);
      expect(rows).toEqual([{ class: 'Common', shares: '10' }]);
    });
  });

  describe('readXlsx', () => {
    it('reads sheets in workbook order with relationship-resolved targets', () => {
      const sheets = readXlsx(buildWorkbook());
      expect(sheets.map((s) => s.name)).toEqual(['Cap Table', 'Types']);
      expect(sheets[0]!.headers).toEqual(['class', 'shares', 'price', 'round closed']);
    });

    it('resolves shared strings, including escaped characters', () => {
      const [capTable] = readXlsx(buildWorkbook());
      expect(capTable!.rows.map((r) => r.class)).toEqual([
        'Common Stock',
        'Series A Preferred',
        'Series B & C "bridge"',
        'Option Pool',
      ]);
    });

    it('positions sparse cells by column reference rather than by order', () => {
      const [capTable] = readXlsx(buildWorkbook());
      // Row 5 has no C cell, so its date must still land under "round closed"
      // rather than sliding left into "price".
      expect(capTable!.rows[2]).toEqual({
        class: 'Series B & C "bridge"',
        shares: '500000',
        price: '',
        'round closed': '2024-04-01',
      });
    });

    it('renders date-formatted cells as dates and leaves other numbers alone', () => {
      const [capTable] = readXlsx(buildWorkbook());
      expect(capTable!.rows[1]!['round closed']).toBe('2024-03-01'); // built-in format 14
      expect(capTable!.rows[2]!['round closed']).toBe('2024-04-01'); // custom format 164
      // Format 165 embeds a literal "May" but is currency, not a date.
      expect(capTable!.rows[0]!.price).toBe('0.1');
      expect(capTable!.rows[0]!['round closed']).toBe('');
    });

    it('concatenates inline string runs', () => {
      const [capTable] = readXlsx(buildWorkbook());
      expect(capTable!.rows[3]!.class).toBe('Option Pool');
    });

    it('handles formula, boolean and error cells', () => {
      const [, types] = readXlsx(buildWorkbook());
      expect(types!.rows[0]).toEqual({ class: '=CONCAT()', shares: 'TRUE', price: '' });
    });

    it('falls back to plain serials when there is no styles part', () => {
      const [capTable] = readXlsx(buildWorkbook({ omitStyles: true }));
      expect(capTable!.rows[1]!['round closed']).toBe('45352');
    });

    it('returns an empty sheet rather than throwing when there are no rows', () => {
      const sheets = readXlsx(
        buildWorkbook({
          sheets: [{ name: 'Blank', data: '<?xml version="1.0"?><worksheet><sheetData/></worksheet>' }],
        }),
      );
      expect(sheets).toEqual([{ name: 'Blank', headers: [], rows: [], lines: [] }]);
    });

    it('reads back a workbook written by the exporter', () => {
      // Round-trip against `export/xlsx.ts`, which emits inline strings with
      // xml:space and real date styles — the shapes this reader must accept.
      const workbook = buildXlsx([
        {
          name: 'Cap Table',
          columns: [
            { header: 'class', width: 20 },
            { header: 'shares', width: 14 },
            // The exporter only stamps its date style when the column declares
            // one — an explicit column format wins over the value's type.
            { header: 'round closed', width: 14, format: 'date' },
          ],
          rows: [
            ['Common Stock', 8_000_000, new Date(Date.UTC(2024, 2, 1))],
            ['Series A Preferred', 2_000_000, new Date(Date.UTC(2024, 3, 1))],
          ],
        },
      ]);
      const [sheet] = readXlsx(workbook);
      expect(sheet!.name).toBe('Cap Table');
      expect(sheet!.headers).toEqual(['class', 'shares', 'round closed']);
      expect(sheet!.rows).toEqual([
        { class: 'Common Stock', shares: '8000000', 'round closed': '2024-03-01' },
        { class: 'Series A Preferred', shares: '2000000', 'round closed': '2024-04-01' },
      ]);
    });

    /**
     * Furigana. A workbook typed with a Japanese IME stores, beside the text,
     * the reading the typist entered to produce it — `<rPh>` runs inside the
     * same `<si>`, keyed to a span of the value. Excel prints them above the
     * cell; they are not the cell. Concatenating every `<t>` alike appended the
     * reading to the value, so a shareholder called 山田太郎 arrived as
     * 山田太郎ヤマダタロウ — in the column the cap table is keyed by, matching
     * nothing, with no error anywhere to say why.
     */
    describe('phonetic guides', () => {
      const withStrings = (si: string[], sheet: string) => {
        const workbook =
          '<?xml version="1.0"?><workbook><sheets>' +
          '<sheet name="Cap Table" sheetId="1" r:id="rId1"/></sheets></workbook>';
        const rels =
          '<?xml version="1.0"?><Relationships>' +
          '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
        return readXlsx(
          buildZip([
            { name: 'xl/workbook.xml', data: workbook },
            { name: 'xl/_rels/workbook.xml.rels', data: rels },
            { name: 'xl/sharedStrings.xml', data: `<?xml version="1.0"?><sst>${si.join('')}</sst>` },
            { name: 'xl/worksheets/sheet1.xml', data: sheet },
          ]),
        );
      };

      /** Two shared-string columns: A is the holder, B the header pair's second. */
      const TWO_COLUMN_SHEET = `<?xml version="1.0"?><worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
        <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>100</v></c></row>
      </sheetData></worksheet>`;

      const holderNamed = (si2: string) =>
        withStrings(['<si><t>Holder</t></si>', '<si><t>Shares</t></si>', si2], TWO_COLUMN_SHEET)[0]!.rows[0]!
          .Holder;

      it('drops the reading Excel stores beside East Asian text', () => {
        expect(
          holderNamed(
            '<si><t>山田太郎</t>' +
              '<rPh sb="0" eb="2"><t>ヤマダ</t></rPh>' +
              '<rPh sb="2" eb="4"><t>タロウ</t></rPh>' +
              '<phoneticPr fontId="1" type="Hiragana"/></si>',
          ),
        ).toBe('山田太郎');
      });

      it('keeps the formatting runs, which are the value', () => {
        // `<r>` splits one string across styles; `<rPh>` is a different thing
        // that happens to sit beside it. Only the second is dropped.
        expect(
          holderNamed(
            '<si><r><rPr><b/></rPr><t>Acme</t></r><r><t xml:space="preserve"> Holdings</t></r>' +
              '<rPh sb="0" eb="4"><t>アクメ</t></rPh></si>',
          ),
        ).toBe('Acme Holdings');
      });

      it('reads an inline string the same way', () => {
        const [sheet] = withStrings(
          ['<si><t>Holder</t></si>', '<si><t>Shares</t></si>'],
          `<?xml version="1.0"?><worksheet><sheetData>
            <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
            <row r="2"><c r="A2" t="inlineStr"><is><t>佐藤</t><rPh sb="0" eb="2"><t>サトウ</t></rPh></is></c><c r="B2"><v>5</v></c></row>
          </sheetData></worksheet>`,
        );
        expect(sheet!.rows).toEqual([{ Holder: '佐藤', Shares: '5' }]);
      });

      it('leaves an empty guide and a longer tag name alone', () => {
        expect(holderNamed('<si><t>A</t><rPh sb="0" eb="1"/><t>B</t></si>')).toBe('AB');
        // `<rPhony>` is not `<rPh>`; the scan must not swallow to its close.
        expect(holderNamed('<si><rPhony><t>kept</t></rPhony></si>')).toBe('kept');
      });

      it('treats an unterminated guide as running to the end of the item', () => {
        // Everything after an `<rPh>` that never closes is, per the document,
        // inside it. Reading it as the value is the direction that corrupts.
        expect(holderNamed('<si><t>山田</t><rPh sb="0" eb="2"><t>ヤマダ</t></si>')).toBe('山田');
      });

      it('scans unclosed guides in linear time', () => {
        // The regex form of this cut — `/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g` — is
        // quadratic on a part that opens one it never closes, and this runs over
        // the shared-string table, the largest part of a real workbook.
        const sstOf = (n: number) =>
          buildZip([
            {
              name: 'xl/workbook.xml',
              data:
                '<?xml version="1.0"?><workbook><sheets>' +
                '<sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
            },
            {
              name: 'xl/_rels/workbook.xml.rels',
              data:
                '<?xml version="1.0"?><Relationships>' +
                '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
            },
            {
              name: 'xl/sharedStrings.xml',
              data: `<?xml version="1.0"?><sst><si>${'<rPh sb="0" eb="1">'.repeat(n)}</si></sst>`,
            },
            {
              name: 'xl/worksheets/sheet1.xml',
              data: '<?xml version="1.0"?><worksheet><sheetData/></worksheet>',
            },
          ]);
        expect(() => readXlsx(sstOf(100_000))).not.toThrow();
        expectSubQuadratic({ input: sstOf, run: readXlsx, size: 25_000 });
      });
    });

    it('rejects a file that is not a workbook', () => {
      expect(() => readXlsx(Buffer.from('class,shares\nCommon,10'))).toThrow(XlsxReadError);
      expect(() => readXlsx(buildZip([{ name: 'notes.txt', data: 'hi' }]))).toThrow(/not an excel workbook/i);
    });
  });

  /**
   * A `<c>` with an explicit ref is padded up to from the previous cell, so what
   * a cell costs is set by its *reference*, not by the bytes carrying it. Both
   * fixtures below are small — the first is a few hundred bytes — and before
   * these bounds each one grew the grid until V8 aborted the process outright.
   * That is an uncatchable `FATAL ERROR`, not a 4xx: it takes down the whole
   * service and every in-flight request on it. The ZIP reader's decompression
   * budget does not help, because neither archive is large enough to trip it.
   */
  describe('grid bounds', () => {
    const sheetWith = (cells: string) =>
      `<?xml version="1.0"?><worksheet><sheetData>${cells}</sheetData></worksheet>`;
    const readSheet = (cells: string) =>
      readXlsx(buildWorkbook({ sheets: [{ name: 'S', data: sheetWith(cells) }] }));

    it('refuses a reference past the last column a worksheet has', () => {
      // Eight bytes of ref asking for column 321,272,406.
      expect(() => readSheet('<row><c r="AAAAAAA1" t="s"><v>0</v></c></row>')).toThrow(XlsxReadError);
      expect(() => readSheet('<row><c r="AAAAAAA1" t="s"><v>0</v></c></row>')).toThrow(/past column XFD/i);
    });

    it('refuses a reference whose index is not even finite', () => {
      // Enough letters and the index overflows to Infinity, which padded a grid
      // in a loop that had no end rather than merely a large one.
      const ref = `${'Z'.repeat(300)}1`;
      expect(columnIndex(ref)).toBe(Infinity);
      expect(() => readSheet(`<row><c r="${ref}" t="s"><v>0</v></c></row>`)).toThrow(/past column XFD/i);
    });

    it('accepts XFD itself, which is a real column', () => {
      // The bound is off-by-one sensitive in the direction that breaks files, so
      // pin the boundary itself: XFD is the last legal column and must still read.
      expect(columnIndex('XFD1')).toBe(MAX_COLUMN);

      const [sheet] = readSheet(
        `<row><c r="A1" t="s"><v>0</v></c><c r="XFD1" t="s"><v>1</v></c></row>` +
          `<row><c r="A2" t="s"><v>4</v></c><c r="XFD2" t="s"><v>5</v></c></row>`,
      );
      // The 16,382 blanks padded between them are dropped from the returned
      // headers, so what shows the far cell arrived is its value, keyed by the
      // header that shares its column.
      expect(sheet!.headers).toEqual(['class', 'shares']);
      expect(sheet!.rows).toEqual([{ class: 'Common Stock', shares: 'Series A Preferred' }]);
    });

    it('bounds the total grid, since legal references still multiply per row', () => {
      // Every ref here is XFD — entirely legal, and the per-row cost is why a
      // column bound alone is not enough: each of these rows is ~26 bytes and
      // claims 16,384 slots, so a merely large sheet reaches the same place.
      const rows = '<row><c r="XFD1" t="s"><v>0</v></c></row>'.repeat(200);
      expect(() => readSheet(rows)).toThrow(XlsxReadError);
      expect(() => readSheet(rows)).toThrow(/more than [\d,]+ cells/i);
    });

    it('spends the budget across the workbook, not per sheet', () => {
      // Sheets are parsed into memory together, so a per-sheet budget would let
      // n sheets cost n times the limit. Each of these is inside it; the set is not.
      const sheet = { data: sheetWith('<row><c r="XFD1" t="s"><v>0</v></c></row>'.repeat(80)) };
      expect(() =>
        readXlsx(
          buildWorkbook({
            sheets: Array.from({ length: 4 }, (_, i) => ({ name: `S${i}`, ...sheet })),
          }),
        ),
      ).toThrow(/more than [\d,]+ cells/i);
    });

    it('refuses more rows than a worksheet has', () => {
      // A row costs an array whether or not it holds a cell, so `<row/>` — six
      // bytes, padding no columns — was free against a budget that counted only
      // cells. 17 MB of them, 26 KB on the wire, took 132 MB of heap.
      const rows = '<row/>'.repeat(MAX_ROW + 2);
      expect(() => readSheet(rows)).toThrow(XlsxReadError);
      expect(() => readSheet(rows)).toThrow(/more than [\d,]+ rows/i);
    });

    it('spends the budget on rows too, so sheets of them cannot add up', () => {
      // Each sheet here is inside the per-worksheet row bound; together they are
      // not, and the grids are held in memory together.
      //
      // The rows carry their `r` index, as a real worksheet's do, and that is
      // load-bearing for this fixture rather than decoration: since R330 the
      // writer deflates, and three sheets of a literal repeated `<row/>` come
      // back as an archive of a few kilobytes claiming eighteen megabytes —
      // which is a decompression bomb, and `inflatedBudgetFor` refuses it
      // before any XML is parsed. That refusal is correct and has its own
      // coverage in `zipReader.test.ts`; this test is about the *row* budget,
      // so the fixture has to be compressible the way a real workbook is
      // rather than the way a bomb is.
      const rows = (n: number) => Array.from({ length: n }, (_, i) => `<row r="${i + 1}"/>`).join('');
      const sheet = { data: sheetWith(rows(900_000)) };
      expect(() =>
        readXlsx(
          buildWorkbook({ sheets: Array.from({ length: 3 }, (_, i) => ({ name: `S${i}`, ...sheet })) }),
        ),
      ).toThrow(/more than [\d,]+ cells/i);
    });

    /**
     * The element scan used to be a regex — `<tag\b([^>]*?)(/>|>([\s\S]*?)</tag>)`
     * — which is quadratic on a part that opens elements it never closes: every
     * `<tag` is a candidate and each rescans to the end before failing. This is a
     * different failure from the allocation bounds above, and a worse one. It
     * allocates nothing, so no memory bound sees it; it is synchronous, so no
     * request timeout interrupts it; and it stalls the event loop, so the cost
     * lands on every other request the process is serving, not just this one.
     */
    it('scans a part of unclosed tags in linear time', () => {
      // Measured against the regex: this fixture is 2 KB on the wire and held
      // the event loop for 19 seconds, growing as the square of the input — so a
      // workbook well inside the ZIP reader's decompression budget parked the
      // service for days. The bound below is ~1000x what the scan now takes and
      // ~10x under what it cost before, so it is the collapse being pinned, not
      // a machine's speed.
      expect(() => readSheet('<row r="1">'.repeat(100_000))).not.toThrow();
      expectSubQuadratic({
        input: (n) => '<row r="1">'.repeat(n),
        run: readSheet,
        size: 25_000,
      });
    });

    it('scans a row of unclosed cells in linear time', () => {
      // Same shape one level down: rows are well-formed, the `<c>` inside is not.
      expect(() => readSheet(`<row>${'<c r="A1">'.repeat(100_000)}</row>`)).not.toThrow();
      expectSubQuadratic({
        input: (n) => `<row>${'<c r="A1">'.repeat(n)}</row>`,
        run: readSheet,
        size: 25_000,
      });
    });

    it('still reads the self-closing cells that follow an unclosed one', () => {
      // A missing `</c>` rules out only the paired form — `<c/>` needs a `>` and
      // nothing more, so it still matches. The regex reached that by backtracking
      // to a later start, and dropping it here would have quietly lost cells.
      const [sheet] = readSheet(
        '<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
          '<row><c r="A2" t="s"><v>4</v></c><c r="B2"/></row>',
      );
      expect(sheet!.headers).toEqual(['class', 'shares']);
      expect(sheet!.rows).toEqual([{ class: 'Common Stock', shares: '' }]);
    });

    it('does not mistake a longer element name for the one it scans', () => {
      // `<col>` precedes `sheetData` in every workbook Excel writes, and `<c` is
      // a prefix of it — the `\b` of the pattern this replaced.
      const [sheet] = readSheet(
        '<row><c r="A1" t="s"><v>0</v></c></row><row><c r="A2" t="s"><v>4</v></c></row>',
      );
      expect(sheet!.headers).toEqual(['class']);
      expect(
        readXlsx(
          buildWorkbook({
            sheets: [
              {
                name: 'S',
                data:
                  '<?xml version="1.0"?><worksheet><cols><col min="1" max="1" width="9"/></cols>' +
                  '<sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
                  '<row><c r="A2" t="s"><v>4</v></c><c r="B2"><v>7</v></c></row></sheetData></worksheet>',
              },
            ],
          }),
        )[0]!.rows,
      ).toEqual([{ class: 'Common Stock', shares: '7' }]);
    });

    /**
     * The same quadratic shape survived the iterating scan's rewrite in the three
     * places that reached for a *single* container by regex — `<sheetData>`,
     * `<cellXfs>` and a cell's `<v>`. A lone `.exec` reads like it looks at the
     * input once, which is what hid them; it does not, when the closing tag is
     * never found and every opening one is a candidate start.
     *
     * These are cheaper to reach than the iterating case. Measured against the
     * regex, 2 MB of `<sheetData>` opens held the event loop for 69 seconds and
     * deflate to 4 KB on the wire; the ZIP reader's floor on inflation is 16 MB,
     * which every upload gets whatever its size, and that is a little over an
     * hour. The fixtures below run in single-digit milliseconds now.
     */
    it('finds sheetData in a part of unclosed opens in linear time', () => {
      const workbookOf = (n: number) =>
        buildWorkbook({
          sheets: [{ name: 'S', data: `<?xml version="1.0"?><worksheet>${'<sheetData>'.repeat(n)}` }],
        });
      expect(() => readXlsx(workbookOf(100_000))).not.toThrow();
      expectSubQuadratic({ input: workbookOf, run: readXlsx, size: 25_000 });
    });

    it('reads a cell value past unclosed value opens in linear time', () => {
      // Bounded by the cell's `</c>` rather than the part, so the fixture is one
      // `<c>` — but a sheet may hold as many of them as the budget allows rows.
      expect(() => readSheet(`<row><c r="A1">${'<v>'.repeat(100_000)}</c></row>`)).not.toThrow();
      expectSubQuadratic({
        input: (n) => `<row><c r="A1">${'<v>'.repeat(n)}</c></row>`,
        run: readSheet,
        size: 25_000,
      });
    });

    it('reads the style table past unclosed opens in linear time', () => {
      // styles.xml is a part of the upload like any other, and the date-format
      // classification it drives runs before a single cell is read.
      const styledWorkbookOf = (n: number) =>
        buildZip([
          {
            name: 'xl/workbook.xml',
            data: '<?xml version="1.0"?><workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
          },
          {
            name: 'xl/_rels/workbook.xml.rels',
            data: '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
          },
          {
            name: 'xl/styles.xml',
            data: `<?xml version="1.0"?><styleSheet>${'<cellXfs>'.repeat(n)}`,
          },
          { name: 'xl/worksheets/sheet1.xml', data: sheetWith('<row/>') },
        ]);
      expect(() => readXlsx(styledWorkbookOf(100_000))).not.toThrow();
      expectSubQuadratic({ input: styledWorkbookOf, run: readXlsx, size: 25_000 });
    });

    it('treats an empty value element as empty, not as serial zero', () => {
      // `<v/>` must stay blank rather than become a value, and B2 is date-styled
      // because that is the direction the mistake runs: an empty string read as
      // a held value is `Number('')`, which is serial 0 and renders as
      // 1899-12-30 in a cap table. Both the regex and the scan get this right —
      // the regex found no `</v>` and the scan finds no closed `<v>` — so this
      // pins the agreement rather than a change.
      //
      // Where the two genuinely part is a self-closing `<v/>` followed by a
      // stray `</v>` later in the same cell: `[^>]*` swallows the `/`, so the
      // regex read the empty element as an open tag and paired it with that
      // close, taking the text between as the cell's value. The scan does not.
      // A differential run over both put every other input in agreement.
      const [sheet] = readSheet(
        '<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>3</v></c></row>' +
          '<row><c r="A2" t="s"><v>4</v></c><c r="B2" s="1"><v/></c></row>',
      );
      expect(sheet!.headers).toEqual(['class', 'round closed']);
      expect(sheet!.rows).toEqual([{ class: 'Common Stock', 'round closed': '' }]);

      // The divergence itself, pinned so it stays deliberate. The regex read
      // this cell as the date 2024-03-01; an empty element holds nothing, and
      // text loose in a `<c>` is not a value.
      const [stray] = readSheet(
        '<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>3</v></c></row>' +
          '<row><c r="A2" t="s"><v>4</v></c><c r="B2" s="1"><v/>45352</v></c></row>',
      );
      expect(stray!.rows).toEqual([{ class: 'Common Stock', 'round closed': '' }]);
    });

    it('leaves a realistic cap-table import untouched', () => {
      // 2,000 rows is what the upload route truncates at, and 20 columns is wide
      // for a real export — the guard has to be invisible here or it has broken
      // the feature it protects.
      const rows = Array.from(
        { length: 2000 },
        (_, r) =>
          `<row r="${r + 2}">` +
          Array.from(
            { length: 20 },
            (_, c) => `<c r="${String.fromCharCode(65 + c)}${r + 2}" t="s"><v>${c % 8}</v></c>`,
          ).join('') +
          '</row>',
      ).join('');
      const header =
        '<row r="1">' +
        Array.from(
          { length: 20 },
          (_, c) => `<c r="${String.fromCharCode(65 + c)}1" t="inlineStr"><is><t>h${c}</t></is></c>`,
        ).join('') +
        '</row>';

      const [sheet] = readSheet(header + rows);
      expect(sheet!.headers).toHaveLength(20);
      expect(sheet!.rows).toHaveLength(2000);
    });
  });
});
