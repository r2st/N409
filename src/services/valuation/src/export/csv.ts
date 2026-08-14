/**
 * CSV export (M4, P2 #-CSV/PDF export). RFC 4180: fields containing commas,
 * quotes, or newlines are quoted; quotes are doubled. Values are prefixed
 * with a quote when they could be interpreted as spreadsheet formulas
 * (CSV-injection hardening).
 *
 * The field encoder is domain/csv.ts's — this file had its own copy, and the
 * copies drifted: only one of them ever learned that a negative number is not
 * a formula. Two encoders for one wire format is one more than the number of
 * places that fix can land.
 */

import { csvEscape, UTF8_BOM } from '../domain/csv.js';

export const csvField = csvEscape;

/** Leads with the same BOM the other serializer writes — see `UTF8_BOM`. */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvField).join(',')];
  for (const row of rows) lines.push(row.map(csvField).join(','));
  return UTF8_BOM + lines.join('\r\n') + '\r\n';
}
