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

/**
 * Generic over the row so a caller can pass the rows it already has.
 *
 * `Array<Record<string, unknown>>` looked like the permissive choice and was
 * the opposite: a TypeScript *interface* has no index signature, so every row
 * type declared as one — which is all of the repo row types — had to be
 * laundered through `as unknown as` to be passed here, and that assertion also
 * erased any check that the column names exist on the row. Constraining the
 * columns to `keyof T` restores it: a column renamed in the row type but not
 * in the export list is now a compile error rather than a silently empty
 * column in a file someone opens in Excel.
 */
export function toCsv<T extends object>(
  columns: ReadonlyArray<Extract<keyof T, string>>,
  rows: readonly T[],
): string {
  const header = columns.map(csvEscape).join(',');
  const lines = rows.map((row) => columns.map((c) => csvEscape(row[c])).join(','));
  return UTF8_BOM + [header, ...lines].join('\r\n') + '\r\n';
}

/**
 * Leads every CSV this codebase writes, so Excel decodes it as UTF-8.
 *
 * `charset=utf-8` on the response settles how a *browser* renders the bytes and
 * says nothing about what Excel does with the saved file: without a BOM it
 * decodes in the system codepage, and a company named "Ångström Robotics AB"
 * reaches the auditor as "Ã…ngstrÃ¶m Robotics AB". Every CSV here is an
 * `attachment` download or a member of the evidence bundle — a file somebody
 * opens in a spreadsheet, never an API payload — so there is no consumer this
 * trades against.
 *
 * It also closes the round trip. `domain/capTable.ts` already strips a leading
 * BOM on import, put there by Excel's own "Save as CSV UTF-8"; an export can now
 * be read straight back in by the same parser.
 */
export const UTF8_BOM = '﻿';
