/**
 * RFC 4180 CSV serialisation for list exports (M3 feature 16).
 * Pure — unit-tested without a database.
 */

/**
 * A plain negative number — the one thing a leading `-` can be that is not a
 * formula.
 *
 * The injection guard below prefixes anything starting with `-`, which for a
 * negative figure is not a quote a spreadsheet strips: apostrophes only have
 * that meaning when *typed* into a cell, so an imported CSV shows the literal
 * `'-1200000` and holds it as text. Negative figures are ordinary here — a
 * pre-revenue company's EBITDA and net income are negative, and the audit
 * change log exports exactly those, from and to — so a column of them arrived
 * unsummable and unsortable with visible junk in every cell.
 *
 * Anchored end-to-end, so only a bare numeric literal is exempt: `-2+3+cmd|…`,
 * the actual DDE vector, still starts with `-` and is still quoted.
 */
const PLAIN_NEGATIVE_NUMBER = /^-\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (Array.isArray(value)) s = value.join(';');
  else s = String(value);
  // Excel formula-injection guard for cells starting with = + - @ \t (OWASP CSV Injection)
  if (/^[=+\-@\t]/.test(s) && !PLAIN_NEGATIVE_NUMBER.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const header = columns.map(csvEscape).join(',');
  const lines = rows.map((row) => columns.map((c) => csvEscape(row[c])).join(','));
  return [header, ...lines].join('\r\n') + '\r\n';
}
