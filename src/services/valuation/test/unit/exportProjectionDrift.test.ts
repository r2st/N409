import { describe, expect, it } from 'vitest';
import { CSV_COLUMNS, XLSX_LIST_COLUMNS } from '../../src/routes/exports.js';

/**
 * The two list projections name the same fields (R169).
 *
 * `GET /valuations/export` serves one query through three formatters, and two
 * of them carry their own column list. The XLSX list is documented as "the CSV
 * projection, but typed", which is a claim nothing checked — and it had already
 * lapsed: `workflow_id` was in the CSV and not in the spreadsheet, so the same
 * export taken in the format an auditor actually opens was missing the column
 * that joins a row back to its workflow.
 *
 * That is the whole failure mode of a column list. A wrong value is visible; an
 * absent column is not, because a reader who only ever takes the XLSX has never
 * seen the column that is missing from it. So the guard is a set comparison in
 * both directions rather than a spot check on the field that went astray.
 *
 * Order is deliberately excluded. The CSV leads with identifiers for programs,
 * the sheet leads with the number and company for people, and pinning either
 * would be pinning a layout rather than a contract. What must not differ is
 * *which* fields each one carries.
 */
describe('export projection drift', () => {
  const csv = new Set<string>(CSV_COLUMNS);
  const xlsx = new Set(XLSX_LIST_COLUMNS.map((c) => c.key));

  it('every CSV column has a spreadsheet column', () => {
    expect([...csv].filter((k) => !xlsx.has(k))).toEqual([]);
  });

  it('every spreadsheet column has a CSV column', () => {
    expect([...xlsx].filter((k) => !csv.has(k))).toEqual([]);
  });

  it('carries the workflow id, which joins a row back to its workflow', () => {
    expect(csv.has('workflow_id')).toBe(true);
    expect(xlsx.has('workflow_id')).toBe(true);
  });

  /**
   * Neither list may repeat a field. A duplicated key is two columns of the
   * same values in the delivered file, and in the CSV's case a header a parser
   * resolves by position — silently reading one of the two.
   */
  it('names each field once per format', () => {
    expect(csv.size).toBe(CSV_COLUMNS.length);
    expect(xlsx.size).toBe(XLSX_LIST_COLUMNS.length);
  });

  /**
   * Every spreadsheet column states a format. Without one the writer falls back
   * to `text`, which is right for most of these and silently wrong for the
   * dates — a date written as text sorts lexically, which is the bug the XLSX
   * export exists to avoid.
   */
  it('gives every spreadsheet column an explicit format', () => {
    expect(XLSX_LIST_COLUMNS.filter((c) => !c.format).map((c) => c.key)).toEqual([]);
  });
});
