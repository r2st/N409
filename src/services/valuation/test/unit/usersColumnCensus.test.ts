import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The subject access request, one level below the table census.
 *
 * `personalDataCensus.test.ts` asks which *tables* hold data about a person
 * and holds each one to being exported or exempted with a reason. That rule
 * cannot see inside a table, and `users` is the one table where the inside is
 * the whole question: it is a single row per person carrying seventeen columns
 * about them, the export names them one at a time, and a column the SELECT
 * does not name is missing from the statutory answer with nothing anywhere
 * recording that it was left out.
 *
 * Enumerating rather than `SELECT *` is the right call and the export says why
 * — a column added later must not be exported by an oversight, because the
 * next one could be a credential. But "absent by default" only fails safe in
 * one direction, and nothing was watching the other. Two columns were missing
 * when this file was written:
 *
 *   * `gclid`, the Google Ads click identifier captured at signup, which is an
 *     online identifier under Art. 4(1) and is held about the person nowhere
 *     else.
 *   * `scim_external_id`, the id their employer's directory knows them by,
 *     written by the SCIM connector. An IdP-provisioned account is exactly the
 *     case where the subject never saw the record being made.
 *
 * Neither was a decision anybody made; both were columns added by a migration
 * whose author had no reason to think about an export in another file. So the
 * rule is stated here instead: every column of `users` is either in the export
 * or has a written reason for not being, and a new one fails this test until
 * somebody classifies it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, '../../migrations');
const EXPORT_SRC = path.resolve(HERE, '../../src/repos/dataExport.ts');

/**
 * Columns deliberately not in the copy, each with the reason read out.
 *
 * Two classes, and the distinction matters to the person asking. A credential
 * is withheld under Art. 15(4) — the copy would be the harm — and the export
 * *says so in its own body* through the `withheld` list, so the answer is
 * "held, not shown" rather than a silence. The rest are not about the person
 * at all: they are the mechanics of how a session or a counter is kept, and
 * naming them in an export would pad it with noise that answers nothing.
 */
const WITHHELD: Record<string, string> = {
  password_digest:
    'A credential. Reported as held in the export’s own `withheld` list rather than omitted ' +
    'silently, and never readable — Art. 15(4): the copy would be the harm.',
  totp_secret:
    'The second-factor seed, likewise reported as held. Exporting it would be exporting the second ' +
    'factor to whoever receives the download.',
  totp_last_counter:
    'The last accepted TOTP step, kept so a code cannot be replayed (migration 0097). It is a ' +
    'position in a counter rather than a fact about the person, and publishing it narrows the ' +
    'window an attacker has to search.',
  session_epoch:
    'An integer bumped to invalidate every issued session at once ("sign out everywhere"). It ' +
    'describes the token-revocation mechanism, not the account holder; what they would want to ' +
    'know — that their sessions were ended — is the audit trail’s answer.',
};

/** Every column `users` has, across CREATE TABLE and every later ALTER. */
function usersColumns(): Set<string> {
  const cols = new Set<string>();
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
    const create =
      /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?users"?\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
    let m: RegExpExecArray | null;
    while ((m = create.exec(sql))) {
      for (const line of m[1]!.split('\n')) {
        const col = /^\s*([a-z0-9_]+)\s+[a-z]/i.exec(line);
        if (col && !/^(primary|unique|constraint|check|foreign)$/i.test(col[1]!))
          cols.add(col[1]!.toLowerCase());
      }
    }
    /*
     * One `ALTER TABLE users` can add several columns, and the estate writes
     * them that way — migration 0082 adds `scim_external_id` and
     * `provisioned_by` in a single statement, 0057 adds three. A regex that
     * matches `add column <name>` once per statement sees only the first, which
     * is how a column can be invisible to a census that reads the same files.
     * So the statement is taken whole and every `ADD COLUMN` inside it read.
     */
    const alter = /alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?users"?\s+([\s\S]*?);/gi;
    while ((m = alter.exec(sql))) {
      for (const add of m[1]!.matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi))
        cols.add(add[1]!.toLowerCase());
      for (const drop of m[1]!.matchAll(/drop\s+column\s+(?:if\s+exists\s+)?([a-z0-9_]+)/gi))
        cols.delete(drop[1]!.toLowerCase());
    }
  }
  return cols;
}

/**
 * The columns the account section actually selects, read out of its SQL.
 *
 * Off the source rather than off a list beside it, for the reason the table
 * census gives: a hand-kept copy of the truth is the copy that goes stale.
 * `u.<name>` is the one spelling the account query uses, and the alias makes
 * it unambiguous against the `partners` join in the same statement.
 *
 * Narrowed to the `accountRows` statement, and that narrowing is load-bearing
 * rather than tidiness. The `held` query two statements below reads
 * `u.password_digest IS NOT NULL` and `u.totp_secret IS NOT NULL` — it exists
 * precisely to report those two as *withheld* — so a scan of the whole file
 * counts both credentials as exported, and the census would then reject the
 * written reasons for withholding them as stale. Reading a predicate as a
 * projection is the specific way this check could have looked green while
 * describing the opposite of what the export does.
 */
function exportedUserColumns(): Set<string> {
  const src = readFileSync(EXPORT_SRC, 'utf8');
  const start = src.indexOf('const { rows: accountRows }');
  if (start < 0) throw new Error('the account query is no longer spelled `const { rows: accountRows }`');
  const open = src.indexOf('`', start);
  const close = src.indexOf('`', open + 1);
  if (open < 0 || close < 0) throw new Error('the account query is no longer a template literal');
  const sql = src.slice(open + 1, close);
  const names = new Set<string>();
  for (const m of sql.matchAll(/\bu\.([a-z0-9_]+)/gi)) names.add(m[1]!.toLowerCase());
  return names;
}

const columns = usersColumns();
const exported = exportedUserColumns();

describe('the personal data export accounts for every column of `users`', () => {
  it('reads the schema and the export at all', () => {
    // Vacuity guard, both halves. Every assertion below passes trivially
    // against an empty scan, and both scans are regexes over files written in
    // a style they have to keep matching.
    expect(columns.size).toBeGreaterThan(15);
    for (const c of ['email', 'first_name', 'gclid', 'scim_external_id', 'password_digest'])
      expect(columns, c).toContain(c);
    expect(exported.size).toBeGreaterThan(10);
    for (const c of ['email', 'created_at']) expect(exported, c).toContain(c);
  });

  it('exports or explains every column', () => {
    const unaccounted = [...columns].filter((c) => !exported.has(c) && !(c in WITHHELD)).sort();
    // A new column on `users` is a decision about a subject access request.
    // Add it to the account SELECT in `repos/dataExport.ts`, or to WITHHELD
    // above with a reason somebody could read out to the person asking.
    expect(unaccounted).toEqual([]);
  });

  it('exports the two identifiers this census was written for', () => {
    // Stated in their own right rather than left to the rule above: both are
    // identifiers the subject cannot see anywhere else in the product, and a
    // future edit that drops one from the SELECT would otherwise only fail as
    // an anonymous entry in the list.
    expect(exported).toContain('gclid');
    expect(exported).toContain('scim_external_id');
  });

  it('keeps no withholding for a column that is exported anyway', () => {
    // A stale reason reads as a considered decision to hold something back
    // that is in fact in the copy — the registry lying in the direction that
    // makes it worthless.
    expect(Object.keys(WITHHELD).filter((c) => exported.has(c))).toEqual([]);
  });

  it('keeps no withholding for a column that no longer exists', () => {
    expect(Object.keys(WITHHELD).filter((c) => !columns.has(c))).toEqual([]);
  });

  it('gives every withholding a reason somebody could read out', () => {
    const thin = Object.entries(WITHHELD).filter(([, why]) => why.trim().length < 60);
    expect(thin.map(([c]) => c)).toEqual([]);
  });

  it('names every credential it withholds in the export body', () => {
    // The two credentials are not merely absent — the export reports them as
    // held, which is what makes the omission honest rather than a silence.
    // Their `withheld` entries are what this census is relying on.
    const src = readFileSync(EXPORT_SRC, 'utf8');
    for (const field of ['password_digest', 'totp_secret']) expect(src, field).toContain(`field: '${field}'`);
  });
});
