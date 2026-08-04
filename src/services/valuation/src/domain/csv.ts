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
  // Excel formula-injection guard (OWASP CSV Injection). The trigger set is
  // = + - @ and the two control characters the spreadsheet strips before it
  // decides what the cell is: tab (0x09) and carriage return (0x0D).
  //
  // CR was missing, and quoting is not what stops this — `"\r=cmd|'/c calc'!A1"`
  // is a well-formed quoted field that Excel unquotes, strips the CR from, and
  // then reads as a formula, so the value sailed through both halves of this
  // function untouched. It reaches here the same way every other vector does:
  // a company name, a note, an audit change-log value — user text that someone
  // else opens as a spreadsheet. LF is included on the same reasoning; it costs
  // a prefix on a value no column legitimately starts with.
  if (/^[=+\-@\t\r\n]/.test(s) && !PLAIN_NEGATIVE_NUMBER.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const header = columns.map(csvEscape).join(',');
  const lines = rows.map((row) => columns.map((c) => csvEscape(row[c])).join(','));
  return [header, ...lines].join('\r\n') + '\r\n';
}
