/**
 * The columns the paste path offers, against the columns the server will find.
 *
 * `csvColumns` exists to give the same answer as the valuation service's
 * `parseCsvSheet(...).headers`, because the mapping the user builds in the
 * browser is keyed by column name and resolved by the server. A name only one
 * of them believes in is a column the user can select and the import cannot
 * find — which shows up as a cap table that imported no rows, not as an error.
 *
 * FIXTURES below is the contract. The same list is asserted against the real
 * parser in the valuation service's `test/unit/capTableCsvParity.test.ts`; if
 * you add a case here, add it there.
 */
import { describe, expect, it } from 'vitest';
import { csvColumns } from '../src/lib/csvColumns';

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
  {
    name: 'CRLF line endings',
    csv: 'Class,Units\r\nCommon,100\r\n',
    headers: ['Class', 'Units'],
  },
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

describe('csvColumns', () => {
  for (const { name, csv, headers } of FIXTURES) {
    it(`names the columns of ${name}`, () => {
      expect(csvColumns(csv)).toEqual(headers);
    });
  }

  it('does not let a comma inside quotes outvote the real delimiter', () => {
    // Two semicolons against one comma: the comma is inside a quoted cell and
    // gets no vote, so this is a semicolon file with a comma in a name.
    expect(csvColumns('"Class, long";Units;Price\na;1;2')).toEqual(['Class, long', 'Units', 'Price']);
  });
});
