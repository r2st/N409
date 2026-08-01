import { describe, expect, it } from 'vitest';
import { buildZip } from '../../src/export/zip.js';
import { buildXlsx } from '../../src/export/xlsx.js';
import {
  columnIndex,
  decodeXmlText,
  excelSerialToIso,
  gridToRows,
  looksLikeXlsx,
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
      expect(gridToRows([])).toEqual({ headers: [], rows: [] });
      expect(gridToRows([[''], ['']])).toEqual({ headers: [], rows: [] });
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
      expect(sheets).toEqual([{ name: 'Blank', headers: [], rows: [] }]);
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

    it('rejects a file that is not a workbook', () => {
      expect(() => readXlsx(Buffer.from('class,shares\nCommon,10'))).toThrow(XlsxReadError);
      expect(() => readXlsx(buildZip([{ name: 'notes.txt', data: 'hi' }]))).toThrow(
        /not an excel workbook/i,
      );
    });
  });
});
