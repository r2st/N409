/**
 * The browser and the server have to name a pasted file's columns identically.
 *
 * The paste path in the cap-table importer has no round trip before the mapping
 * is built: the raw text sits in a textarea, the browser works out the column
 * names to populate the dropdowns, the user maps them, and only then does the
 * text reach `parseCsvSheet`. The mapping is keyed by column name. A name only
 * one side believes in is a column the user can select and the import cannot
 * find, and the result is an import that reports zero entries rather than an
 * error.
 *
 * The browser's half is `web-frontend/src/lib/csvColumns.ts` — a deliberate
 * duplicate, since this module lives in a service the browser bundle cannot
 * import. This file is the other end of that contract: the FIXTURES here are
 * the same list as in `web-frontend/test/csvColumns.test.ts`, and both halves
 * assert the same expected names. If you add a case there, add it here.
 */
import { describe, expect, it } from 'vitest';
import { parseCsvSheet } from '../../src/domain/capTable.js';

const FIXTURES: Array<{ name: string; csv: string; headers: string[] }> = [
  {
    name: 'a plain comma file',
    csv: 'Security Class,Units,Price\nCommon,100,1.00',
    headers: ['Security Class', 'Units', 'Price'],
  },
  {
    name: 'the semicolon file Excel writes outside the US',
    csv: 'Security Class;Units;Price\nCommon;100;1,00',
    headers: ['Security Class', 'Units', 'Price'],
  },
  {
    name: 'a tab-delimited paste straight out of a spreadsheet',
    csv: 'Security Class\tUnits\tPrice\nCommon\t100\t1.00',
    headers: ['Security Class', 'Units', 'Price'],
  },
  {
    name: 'the BOM that "Save as CSV UTF-8" leads with',
    csv: '﻿Security Class,Units\nCommon,100',
    headers: ['Security Class', 'Units'],
  },
  {
    name: 'a quoted header holding the delimiter',
    csv: '"Class, long name",Units\nCommon,100',
    headers: ['Class, long name', 'Units'],
  },
  {
    name: 'a quoted header holding a doubled quote',
    csv: '"Class ""A""",Units\nCommon,100',
    headers: ['Class "A"', 'Units'],
  },
  {
    name: 'a quoted header spanning two lines',
    csv: '"Security\nClass",Units\nCommon,100',
    headers: ['Security\nClass', 'Units'],
  },
  {
    name: 'repeated names, which the server disambiguates',
    csv: 'Shares,Shares,Price\n1,2,3',
    headers: ['Shares', 'Shares (2)', 'Price'],
  },
  {
    name: 'a repeat whose suffix a column of the sheet already answers to',
    csv: 'Shares (2),Shares,Shares\n1,2,3',
    headers: ['Shares (2)', 'Shares', 'Shares (3)'],
  },
  {
    name: 'a blank column between two real ones',
    csv: 'Class,,Units\nCommon,,100',
    headers: ['Class', 'Units'],
  },
  {
    name: 'leading blank lines before the header',
    csv: '\n\nClass,Units\nCommon,100',
    headers: ['Class', 'Units'],
  },
  { name: 'CRLF line endings', csv: 'Class,Units\r\nCommon,100\r\n', headers: ['Class', 'Units'] },
  {
    name: 'surrounding whitespace on each name',
    csv: ' Class , Units \nCommon,100',
    headers: ['Class', 'Units'],
  },
  { name: 'nothing at all', csv: '', headers: [] },
  { name: 'only blank lines', csv: '\n \n', headers: [] },
  {
    name: 'a header row and no data — the mapping UI still needs the columns',
    csv: 'Class,Units',
    headers: ['Class', 'Units'],
  },
];

describe('the column names the browser has to agree with', () => {
  for (const { name, csv, headers } of FIXTURES) {
    it(`names the columns of ${name}`, () => {
      expect(parseCsvSheet(csv).headers).toEqual(headers);
    });
  }

  it('does not let a comma inside quotes outvote the real delimiter', () => {
    expect(parseCsvSheet('"Class, long";Units;Price\na;1;2').headers).toEqual([
      'Class, long',
      'Units',
      'Price',
    ]);
  });
});
