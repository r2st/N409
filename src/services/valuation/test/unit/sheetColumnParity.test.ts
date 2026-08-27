import { describe, expect, it } from 'vitest';
import { buildZip } from '../../src/export/zip.js';
import { parseCsvSheet } from '../../src/domain/capTable.js';
import { readXlsx } from '../../src/domain/xlsxRead.js';
import { nameColumns } from '../../src/domain/sheetColumns.js';

/**
 * The same sheet, saved twice, must import as the same columns.
 *
 * There are two readers of one file format family — `parseCsvSheet` in
 * `domain/capTable.ts` for delimited text, `readXlsx` in `domain/xlsxRead.ts`
 * for the workbook — and one column-mapping UI keyed by the names either of
 * them returns. They had drifted: the CSV reader grew `nameColumns` (blank
 * headers dropped, repeats suffixed) and the workbook reader kept mapping
 * `headers[i]` straight, so a header row of `Shares, Shares, Price` produced
 * three reachable columns as CSV and two as `.xlsx` — with the first "Shares"
 * column's numbers silently unreachable, which is the format every provider
 * exports by default.
 *
 * Both now call the same function. This file is what says so: each fixture is
 * rendered into both containers and the two results are compared to each other,
 * so a fix that reaches one reader and not the other fails here rather than in
 * a customer's cap table.
 */

/** Header cells and one data row, chosen to avoid CSV quoting entirely. */
const FIXTURES: Array<{ name: string; header: string[]; data: string[] }> = [
  {
    name: 'ordinary distinct headers',
    header: ['Security Class', 'Shares', 'Price'],
    data: ['Common', '1000', '0.10'],
  },
  {
    name: "Carta's granted and outstanding Shares columns",
    header: ['Security Class', 'Shares', 'Shares', 'Price'],
    data: ['Common', '1000', '900', '0.10'],
  },
  {
    name: 'a name repeated three times',
    header: ['Class', 'Price', 'Price', 'Price'],
    data: ['Common', '1', '2', '3'],
  },
  {
    // The suffix has to dodge the names already in the header as well as the
    // ones it has minted: counting uses of each name alone gave this sheet two
    // columns called `Shares (2)`, and the second silently overwrote the first.
    name: 'a repeat whose suffix a column of the sheet already answers to',
    header: ['Shares (2)', 'Shares', 'Shares'],
    data: ['1', '2', '3'],
  },
  {
    name: 'a repeat that only matches after trimming',
    header: ['Class', 'Price', ' Price '],
    data: ['Common', '1', '2'],
  },
  {
    name: 'a spacer column between two blocks',
    header: ['Class', '', 'Shares'],
    data: ['Common', 'ignored', '10'],
  },
  {
    name: 'two spacer columns, which must not be suffixed into existence',
    header: ['Class', '', '', 'Shares'],
    data: ['Common', 'a', 'b', '10'],
  },
  {
    name: 'a trailing empty header, as a trailing delimiter leaves',
    header: ['Class', 'Shares', ''],
    data: ['Common', '10', ''],
  },
];

const csvOf = (rows: string[][]) => rows.map((r) => r.join(',')).join('\n');

/** The same rows as a one-sheet workbook of inline strings. */
function xlsxOf(rows: string[][]): Buffer {
  const sheet =
    '<?xml version="1.0"?><worksheet><sheetData>' +
    rows
      .map(
        (cells, r) =>
          `<row r="${r + 1}">` +
          cells
            .map(
              (cell, c) =>
                `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr">` +
                `<is><t xml:space="preserve">${cell.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</t></is></c>`,
            )
            .join('') +
          '</row>',
      )
      .join('') +
    '</sheetData></worksheet>';
  return buildZip([
    {
      name: 'xl/workbook.xml',
      data:
        '<?xml version="1.0"?><workbook><sheets>' +
        '<sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0"?><Relationships>' +
        '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

describe('CSV and XLSX name a sheet’s columns identically', () => {
  for (const { name, header, data } of FIXTURES) {
    it(name, () => {
      const grid = [header, data];
      const csv = parseCsvSheet(csvOf(grid));
      const [xlsx] = readXlsx(xlsxOf(grid));

      // Asserted against each other first: that is the property, and it fails
      // whichever of the two readers moved.
      expect(xlsx!.headers).toEqual(csv.headers);
      expect(xlsx!.rows).toEqual(csv.rows);

      // Then against the rule itself, so a change that breaks both the same way
      // cannot pass by agreeing with itself.
      expect(csv.headers).toEqual(nameColumns(header).filter((c) => c !== null));
    });
  }

  /**
   * The one place the two readers legitimately differ, pinned so it is not
   * mistaken for drift. A workbook carries spacer and title rows above the
   * header, so `gridToRows` looks for the first row with two populated cells;
   * a pasted CSV has no such preamble and its first row is the header.
   */
  it('differ only in where they look for the header row', () => {
    const grid = [['Acme Inc — capitalization'], [], ['Class', 'Shares'], ['Common', '10']];
    const [xlsx] = readXlsx(xlsxOf(grid));
    expect(xlsx!.headers).toEqual(['Class', 'Shares']);
    expect(parseCsvSheet(csvOf(grid)).headers).toEqual(['Acme Inc — capitalization']);
  });
});
