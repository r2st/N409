/**
 * RFC 4180 CSV serialisation for list exports (M3 feature 16).
 * Pure — unit-tested without a database.
 */

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (Array.isArray(value)) s = value.join(';');
  else s = String(value);
  // Excel formula-injection guard for cells starting with = + - @ \t (OWASP CSV Injection)
  if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const header = columns.map(csvEscape).join(',');
  const lines = rows.map((row) => columns.map((c) => csvEscape(row[c])).join(','));
  return [header, ...lines].join('\r\n') + '\r\n';
}
