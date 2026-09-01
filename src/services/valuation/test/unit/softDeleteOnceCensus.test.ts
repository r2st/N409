import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A soft delete happens once, and the date it records is the first one.
 *
 * Every tombstone column in this schema is written by a statement of the same
 * shape — `SET <col> = now()` — and every one of them is read back as a *date*
 * somewhere that matters: `personalDataExport` hands `users.deleted_at` and
 * `documents.deleted_at` to the subject under Article 15, `analystAvailability`
 * reads the first to call an assignment `closed`, the retention console prints
 * `valuations.archived_at`, and the API-token screen prints `revoked_at`.
 *
 * So restating one is the failure `cancelSubscription` already carries a
 * COALESCE for, in the words it uses there: "a transition into a state the row
 * is already in must not restate when it happened". Most of these writers ask
 * the question. Three did not, and each had a caller that reaches them twice in
 * the ordinary course:
 *
 *   * `setUserActive` — the SCIM toggle. Its own route says an IdP "resyncs its
 *     whole directory on a schedule and re-asserts `active` for everybody each
 *     pass", and guards the admin event on that basis; the column was left
 *     moving forward every pass, forever.
 *   * `deleteDocument` — a double-clicked button, off one read taken on another
 *     connection. It also wrote a second `document_deleted` for one deletion.
 *   * `retireValuations` — the seeder's `--replace`, whose "already archived"
 *     filter is a SELECT taking no row lock one statement earlier.
 *
 * ## Why a census
 *
 * The rule is invisible at the call site: a re-stamped timestamp writes
 * successfully, answers 200, and is wrong only to a reader who comes back
 * later. Nothing fails, so nothing draws attention to the writer that forgot.
 * Asking it of the source is the only way it stays asked, and the next
 * tombstone column added is covered by naming it in {@link TOMBSTONE_COLUMNS}.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.resolve(HERE, '../..');

/** The columns that record *when* something was retired, not merely that it was. */
const TOMBSTONE_COLUMNS = ['deleted_at', 'archived_at', 'revoked_at'] as const;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.ts$/.test(full) ? [full] : [];
  });
}

const SOURCES = walk(path.join(SERVICE, 'src')).map((file) => ({
  file: path.relative(SERVICE, file).split(path.sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

/**
 * Every string literal in a file, as its contents.
 *
 * The unit a predicate belongs to is the SQL literal it is written in, so that
 * is the unit this reads — not a fixed window forward from the match. The first
 * spelling of this test *was* a window, ending at the next quote character, and
 * `retireValuations` walked through it: its statement carries `LIKE ('%' || …)`
 * before the `WHERE`, so the window closed on the wildcard and the predicate
 * that follows was never read. A guard that stops at the first apostrophe in
 * the estate's SQL is one that mostly does not run.
 *
 * A scanner rather than a regex because a literal's delimiter is decided by
 * where it opened: an apostrophe inside a backticked query is data, and the
 * same character ends a single-quoted one. Comments are skipped so prose about
 * SQL is never mistaken for SQL — several of these writers are documented in a
 * block comment directly above themselves.
 */
export function stringLiterals(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    if (ch === '`' || ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      out.push(text.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * Each `SET <tombstone> = now()` in a file, with the whole SQL literal that
 * carries it. Whitespace is collapsed so a statement the formatter broke across
 * lines reads as one line.
 */
export function tombstoneWrites(text: string): Array<{ column: string; statement: string }> {
  // `= now()` and `= COALESCE(<col>, now())` both, because the second is one of
  // the two ways of passing this census and a writer that adopts it must stay
  // visible to it — otherwise removing the COALESCE later removes the statement
  // from the sweep instead of failing it.
  const cols = TOMBSTONE_COLUMNS.join('|');
  const re = new RegExp(`\\b(${cols})\\s*=\\s*(?:COALESCE\\(\\s*(?:${cols})\\s*,\\s*)?now\\(\\)`);
  return stringLiterals(text)
    .map((literal) => literal.replace(/\s+/g, ' '))
    .flatMap((statement) => {
      const match = re.exec(statement);
      return match ? [{ column: match[1]!, statement }] : [];
    });
}

/**
 * Whether a statement writing `column` can only be the first such write.
 *
 * Two spellings, and they are equivalent in effect rather than merely both
 * acceptable: `AND <col> IS NULL` refuses the second write outright (and lets
 * the caller see that it matched nothing), while `COALESCE(<col>, now())` lets
 * it proceed and keeps the first date. `setUserActive` takes the second because
 * a SCIM deprovision has other work to do in the same transaction — revoking
 * the account's outstanding invitations — which must still run on a re-assert.
 */
export function writesOnce(column: string, statement: string): boolean {
  return (
    new RegExp(`${column}\\s+IS NULL`).test(statement) ||
    new RegExp(`COALESCE\\(\\s*${column}\\s*,`, 'i').test(statement)
  );
}

describe('soft deletes are written once', () => {
  it('is reading the service', () => {
    expect(SOURCES.length).toBeGreaterThan(100);
    const all = SOURCES.flatMap(({ text }) => tombstoneWrites(text));
    // Thirteen writers at the time of writing; the floor guards against a
    // refactor that renames the idiom out from under the sweep.
    expect(all.length).toBeGreaterThanOrEqual(12);
  });

  it('has every tombstone write refusing to restate its own date', () => {
    const unguarded = SOURCES.flatMap(({ file, text }) =>
      tombstoneWrites(text)
        .filter(({ column, statement }) => !writesOnce(column, statement))
        .map(({ column, statement }) => `${file} sets ${column} in: ${statement.trim()}`),
    );
    expect(unguarded).toEqual([]);
  });

  it('reads the shapes those writes are actually spelled in', () => {
    // The vacuity guard. Each of the three below is a real spelling from this
    // service, and the middle one is what all three looked like before R296.
    expect(
      writesOnce(
        'revoked_at',
        'UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      ),
    ).toBe(true);
    expect(writesOnce('deleted_at', 'UPDATE users SET deleted_at = now() WHERE id = $1')).toBe(false);
    expect(
      writesOnce('deleted_at', 'UPDATE users SET deleted_at = COALESCE(deleted_at, now()) WHERE id = $1'),
    ).toBe(true);

    // And it does not let the *next* statement's predicate answer for this one.
    const two =
      '`UPDATE documents SET deleted_at = now() WHERE id = $1`, x);\n' +
      'await q(`UPDATE api_tokens SET revoked_at = now() WHERE revoked_at IS NULL`';
    const [first] = tombstoneWrites(two);
    expect(first?.column).toBe('deleted_at');
    expect(writesOnce('deleted_at', first!.statement)).toBe(false);
  });

  it('does not mistake a clearing write for a stamping one', () => {
    // Reactivation sets the column back to NULL. It is not a tombstone write
    // and must not be asked to guard itself, or the sweep would demand a
    // predicate that makes reactivating an account impossible.
    expect(tombstoneWrites('UPDATE users SET deleted_at = NULL WHERE id = $1')).toEqual([]);
  });
});
