import { describe, expect, it } from 'vitest';
import {
  CURSOR_AT_RE,
  type Cursor,
  cursorAtSql,
  cursorParam,
  decodeCursor,
  encodeCursor,
  keysetAfterSql,
  pageFrom,
} from '../../src/domain/pagination.js';

/**
 * The cursor half of `domain/pagination.ts`.
 *
 * Two properties carry the whole scheme and neither is visible in a passing
 * page: that a cursor round-trips *exactly* (a cursor that decodes to a
 * fractionally different instant silently skips rows), and that a cursor we did
 * not write is refused rather than handed to the driver. The behavioural half —
 * that walking the cursor actually reaches every row, under concurrent
 * insertion — is in `test/integration/cursorPagination.test.ts`, which needs a
 * database to say anything.
 */

const AT = '2026-08-15T12:00:00.123456Z';
const ID = '01J0000000000000000000000A';

describe('cursor encoding', () => {
  it('round-trips a cursor exactly', () => {
    const cursor: Cursor = { at: AT, id: ID };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('does not look like its two fields', () => {
    const encoded = encodeCursor({ at: AT, id: ID });
    expect(encoded).not.toContain(AT);
    expect(encoded).not.toContain(ID);
  });

  it('is URL-safe, so it survives a query string unescaped', () => {
    // base64url over any (at, id) pair can only produce these; a `+` or `/`
    // would be re-read as a space or a path separator by something in between.
    for (const id of [ID, '0123456789ABCDEFGHJKMNPQRS', 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ']) {
      expect(encodeCursor({ at: AT, id })).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('preserves microseconds — the digits a JS Date would drop', () => {
    // The failure this guards is not "the cursor is wrong" but "the cursor is
    // 456 microseconds early", which excludes rows that were never served.
    const decoded = decodeCursor(encodeCursor({ at: '2026-08-15T12:00:00.000456Z', id: ID }));
    expect(decoded?.at).toBe('2026-08-15T12:00:00.000456Z');
    expect(new Date(decoded!.at).toISOString()).not.toBe(decoded!.at);
  });
});

describe('cursor rejection', () => {
  /** Each of these must be `null` — a 400 — rather than reaching the driver. */
  const rejected: Record<string, string> = {
    'not base64 at all': 'not a cursor!!',
    'base64 of nothing structured': Buffer.from('hello', 'utf8').toString('base64url'),
    'no separator': Buffer.from(`${AT}${ID}`, 'utf8').toString('base64url'),
    'timestamp missing microseconds': Buffer.from(`2026-08-15T12:00:00Z.${ID}`, 'utf8').toString('base64url'),
    'timestamp with a millisecond tail': Buffer.from(`2026-08-15T12:00:00.123Z.${ID}`, 'utf8').toString(
      'base64url',
    ),
    'timestamp in a session zone': Buffer.from(`2026-08-15 08:00:00.123456-04.${ID}`, 'utf8').toString(
      'base64url',
    ),
    'SQL where a timestamp goes': Buffer.from(`now()).${ID}`, 'utf8').toString('base64url'),
    'lowercase ulid': Buffer.from(`${AT}.${ID.toLowerCase()}`, 'utf8').toString('base64url'),
    'ulid with an excluded letter': Buffer.from(`${AT}.01J000000000000000000000IL`, 'utf8').toString(
      'base64url',
    ),
    'ulid of the wrong length': Buffer.from(`${AT}.01J00000000000000000000`, 'utf8').toString('base64url'),
    'empty id': Buffer.from(`${AT}.`, 'utf8').toString('base64url'),
    'empty string': '',
    /*
     * A shape is not a calendar.
     *
     * `CURSOR_AT_RE` is `\d{2}` for the month and `\d{2}` for the day, so each
     * of these matched it and was handed to the driver. Bound to
     * `keysetAfterSql`'s `$n::timestamptz` they raise `22008 date/time field
     * value out of range` — measured against the deployment's own Postgres —
     * which is not the 22007 the regex closes and is an uncaught 500 out of a
     * partner's `?cursor=`, on the one function whose docstring promises that
     * "every field is re-validated rather than trusted, because the alternative
     * is a 500".
     *
     * 2026-02-31 is the interesting one: JavaScript does not refuse it, it
     * *normalises* it to 2026-03-03, so only re-rendering and comparing catches
     * it. Year 0000 is a real `Date` and not a year Postgres has.
     */
    'a day February does not have': Buffer.from(`2026-02-31T12:00:00.123456Z.${ID}`, 'utf8').toString(
      'base64url',
    ),
    'a thirteenth month': Buffer.from(`2026-13-01T12:00:00.123456Z.${ID}`, 'utf8').toString('base64url'),
    'an impossible clock': Buffer.from(`2026-08-15T25:61:61.123456Z.${ID}`, 'utf8').toString('base64url'),
    'the zeroth of the zeroth': Buffer.from(`0000-00-00T00:00:00.000000Z.${ID}`, 'utf8').toString(
      'base64url',
    ),
    'a year Postgres does not have': Buffer.from(`0000-01-01T00:00:00.000000Z.${ID}`, 'utf8').toString(
      'base64url',
    ),
  };

  for (const [name, raw] of Object.entries(rejected)) {
    it(`refuses ${name}`, () => {
      expect(decodeCursor(raw)).toBeNull();
    });
  }

  it('refuses a cursor mangled in transit rather than decoding it elsewhere', () => {
    // Buffer.from(_, 'base64url') skips characters outside the alphabet instead
    // of failing, so a mangled cursor decodes to *something*. Accepting it would
    // resume the walk from a position nobody asked for.
    const valid = encodeCursor({ at: AT, id: ID });
    expect(decodeCursor(`${valid}!`)).toBeNull();
    expect(decodeCursor(`${valid.slice(0, -1)}`)).toBeNull();
  });

  /** The leap day the calendar does have, so the check is not simply strict. */
  it('accepts 29 February in a leap year', () => {
    const at = '2024-02-29T12:00:00.123456Z';
    expect(decodeCursor(encodeCursor({ at, id: ID }))).toEqual({ at, id: ID });
  });

  it('refuses an over-long cursor without decoding it', () => {
    expect(decodeCursor('A'.repeat(5_000))).toBeNull();
  });

  it('bounds the query parameter at the same length', () => {
    const param = cursorParam();
    expect(param.safeParse(encodeCursor({ at: AT, id: ID })).success).toBe(true);
    expect(param.safeParse('A'.repeat(5_000)).success).toBe(false);
    // Absent is the first page, not an error.
    expect(param.safeParse(undefined).success).toBe(true);
  });
});

describe('keyset SQL', () => {
  it('renders the timestamp in UTC rather than the session zone', () => {
    // `d.created_at::text` would be correct until someone changed the server's
    // TimeZone, at which point every cursor in flight would mean a different
    // instant. The rendering must not depend on a setting no client can see.
    const sql = cursorAtSql('d.created_at');
    expect(sql).toContain("AT TIME ZONE 'UTC'");
    expect(sql).toContain('US'); // microseconds
    expect(sql).not.toMatch(/::text/);
  });

  it('produces the shape decodeCursor accepts', () => {
    // Belt-and-braces on the pairing: the SQL format string and the regex are
    // written in two places and have to agree, and integration is where that is
    // proved end to end. Here we at least pin the format literal.
    expect(cursorAtSql('c')).toContain('YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
    expect(CURSOR_AT_RE.test(AT)).toBe(true);
  });

  it('matches the ORDER BY it pages: older, or same instant and a higher id', () => {
    const sql = keysetAfterSql('d.created_at', 'd.id', '$2', '$3');
    // Strictly-less on the DESC column…
    expect(sql).toContain('d.created_at < $2::timestamptz');
    // …and strictly-greater on the ASC tiebreaker, for the tie.
    expect(sql).toContain('d.created_at = $2::timestamptz AND d.id > $3');
    // Never `<=` on the timestamp: that would re-serve the whole tied group.
    expect(sql).not.toContain('<=');
  });
});

describe('pageFrom', () => {
  const cursorOf = (row: { at: string; id: string }) => ({ at: row.at, id: row.id });
  // Crockford base32 skips I, L, O and U, so the suffix comes from the domain's
  // own alphabet rather than from ASCII — a fixture that is not a ULID would be
  // rejected by decodeCursor and read as a pageFrom bug.
  const SUFFIX = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ at: AT, id: `01J00000000000000000000${SUFFIX[i]!}0A` }));

  it('reports more when the over-fetched row arrived, and drops it from the page', () => {
    const page = pageFrom(rows(4), 3, cursorOf);
    expect(page.items).toHaveLength(3);
    expect(page.hasMore).toBe(true);
    // The cursor names the last row *served*, not the one that proved there
    // were more — otherwise the next page starts one row late.
    expect(decodeCursor(page.nextCursor!)?.id).toBe(rows(4)[2]!.id);
  });

  it('reports no more on an exactly-full final page', () => {
    // The subtle one: `limit` rows back is not "there is another page". Only
    // `limit + 1` is, which is why the query asks for one extra.
    const page = pageFrom(rows(3), 3, cursorOf);
    expect(page.items).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('reports no more on an empty page', () => {
    const page = pageFrom([], 3, cursorOf);
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('never disagrees with itself about whether the walk continues', () => {
    // A client may loop on either field; they must be the same predicate.
    for (const n of [0, 1, 2, 3, 4, 10]) {
      const page = pageFrom(rows(n), 3, cursorOf);
      expect(page.nextCursor !== null).toBe(page.hasMore);
    }
  });

  it('does not alias the caller´s array', () => {
    const source = rows(2);
    const page = pageFrom(source, 3, cursorOf);
    page.items.push({ at: AT, id: ID });
    expect(source).toHaveLength(2);
  });
});
