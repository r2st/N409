/**
 * CSV export (M4, P2 #-CSV/PDF export). RFC 4180: fields containing commas,
 * quotes, or newlines are quoted; quotes are doubled. Values are prefixed
 * with a quote when they could be interpreted as spreadsheet formulas
 * (CSV-injection hardening).
 */

export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvField).join(',')];
  for (const row of rows) lines.push(row.map(csvField).join(','));
  return lines.join('\r\n') + '\r\n';
}
