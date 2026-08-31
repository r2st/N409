/**
 * A fixture cannot name an event type that does not exist.
 *
 * `recordEvent` and `recordAdminEvent` both take their catalog's key union, so
 * a type with no descriptor is a compile error — in `src`. This service's
 * tsconfig includes `src` only, and vitest transpiles without checking, so no
 * test file is typechecked at all: `eventSpineBounds.test.ts` spent R127
 * writing 120 `note_added` events, with a comment calling it "a real type",
 * and nothing anywhere disagreed. The union is worth exactly as much as the
 * files it is enforced over.
 *
 * So the same question is asked of the test tree by reading it, and of the
 * catalogs by reading `src`: every type a fixture writes has a descriptor, and
 * every descriptor is one something actually writes. The second half matters
 * because a catalog is also where a retired type goes to be forgotten — an
 * entry nothing writes is a label for an event that can no longer happen, and
 * the next reader takes it for the vocabulary.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_EVENT_CATALOG, EVENT_CATALOG } from '../../src/domain/auditTrail.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.resolve(HERE, '../..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.ts$/.test(full) ? [full] : [];
  });
}

const read = (dir: string) =>
  walk(path.join(SERVICE, dir)).map((file) => ({
    file: path.relative(SERVICE, file).split(path.sep).join('/'),
    text: readFileSync(file, 'utf8'),
  }));

const SRC = read('src');
/**
 * Every test file but this one. The vacuity guard below writes a `note_added`
 * fixture on purpose — the census found it on the first run, which is the
 * proof it works and also the reason it has to stand outside its own sweep.
 */
const CENSUS = 'test/unit/eventVocabularyCensus.test.ts';
const TESTS = read('test').filter(({ file }) => file !== CENSUS);

/**
 * The `type: '…'` literal inside each `recorder(` call. Whitespace is
 * collapsed first so a call the formatter broke across lines still matches,
 * and the window stops at the closing brace of the argument object so a later
 * `type:` on an unrelated literal cannot be picked up.
 */
export function recordedTypes(text: string, recorder: string): string[] {
  const flat = text.replace(/\s+/g, ' ');
  const found: string[] = [];
  const callRe = new RegExp(`\\b${recorder}\\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(flat))) {
    const window = flat.slice(match.index, match.index + 400);
    const type = /[{,] ?type: '([a-z0-9_]+)'/.exec(window);
    if (type) found.push(type[1]!);
  }
  return found;
}

/**
 * The event types a SQL string in a test *reads* — the `type = '…'`,
 * `type IN (…)` and `type = ANY(ARRAY[…])` literals inside a query against
 * `table`.
 *
 * {@link recordedTypes} covers the fixtures that write the spine. It says
 * nothing about the assertions that read it, and those are where a misspelling
 * is silent rather than loud: a test that counts rows of a type nothing writes
 * counts zero of everything and passes. R284's overdue-retirement race and
 * R285's row-failure test each asserted "no `engagement_overdue_reminded` on
 * this engagement's spine" against a spelling of `engagement_overdue_reminder`
 * that does not exist, and the load-bearing half of both — that a withdrawn
 * engagement got no immutable row saying its analyst was chased — was asking a
 * question with no possible answer.
 *
 * A window rather than a parse: whitespace is collapsed, and each mention of
 * the table takes the text that follows it up to the next `FROM` of a
 * different table or the end of the literal, which is where its own predicates
 * live.
 */
export function assertedTypes(text: string, table: string): string[] {
  const flat = text.replace(/\s+/g, ' ');
  const found: string[] = [];
  const tableRe = new RegExp(`\\b${table}\\b`, 'g');
  let match: RegExpExecArray | null;
  while ((match = tableRe.exec(flat))) {
    const rest = flat.slice(match.index + table.length, match.index + table.length + 400);
    const window = rest.split(/`|FROM [a-z_]+/)[0] ?? '';
    for (const m of window.matchAll(
      /(?<!SET )\btype (?:=|IN|= ANY ?\(ARRAY)\s*\(?\s*'([a-z0-9_]+)'((?:\s*,\s*'[a-z0-9_]+')*)/g,
    )) {
      found.push(m[1]!);
      for (const more of (m[2] ?? '').matchAll(/'([a-z0-9_]+)'/g)) found.push(more[1]!);
    }
  }
  return found;
}

const collect = (files: typeof SRC, recorder: string) =>
  files.flatMap(({ file, text }) => recordedTypes(text, recorder).map((type) => ({ file, type })));

describe('event vocabulary', () => {
  it('is looking at both trees, and at itself only to exclude it', () => {
    expect(SRC.length).toBeGreaterThan(100);
    expect(TESTS.length).toBeGreaterThan(100);
    expect(TESTS.map(({ file }) => file)).not.toContain(CENSUS);
  });

  it('has every fixture writing a valuation event the catalog carries', () => {
    const unknown = collect(TESTS, 'recordEvent')
      .filter(({ type }) => !(type in EVENT_CATALOG))
      .map(({ file, type }) => `${file} writes ${type}`);
    expect(unknown).toEqual([]);
  });

  it('has every fixture writing an admin event the catalog carries', () => {
    const unknown = collect(TESTS, 'recordAdminEvent')
      .filter(({ type }) => !(type in ADMIN_EVENT_CATALOG))
      .map(({ file, type }) => `${file} writes ${type}`);
    expect(unknown).toEqual([]);
  });

  it('has every assertion reading a valuation event the catalog carries', () => {
    /*
     * The other half of the vocabulary, and the half a misspelling is silent
     * in. A fixture that writes an unknown type is loud — the row is there
     * under the wrong name and something downstream reads it. An *assertion*
     * that reads one is not: `count(*) WHERE type = 'engagement_overdue_reminded'`
     * is zero however the sweep behaved, so the guard passes by having nothing
     * left to ask.
     */
    const unknown = TESTS.flatMap(({ file, text }) =>
      assertedTypes(text, 'valuation_events')
        .filter((type) => !(type in EVENT_CATALOG))
        .map((type) => `${file} asserts on ${type}`),
    );
    expect(unknown).toEqual([]);
  });

  it('has every assertion reading an admin event the catalog carries', () => {
    const unknown = TESTS.flatMap(({ file, text }) =>
      assertedTypes(text, 'admin_events')
        .filter((type) => !(type in ADMIN_EVENT_CATALOG))
        .map((type) => `${file} asserts on ${type}`),
    );
    expect(unknown).toEqual([]);
  });

  it('reads the shapes those assertions are actually written in', () => {
    // The vacuity guard for the guard. `engagement_overdue_reminded` is the
    // spelling R284 and R285 both asserted on; the catalog has never carried it.
    expect(
      assertedTypes(
        "`SELECT count(*)::int AS n FROM valuation_events WHERE valuation_id = $1 AND type = 'engagement_overdue_reminded'`",
        'valuation_events',
      ),
    ).toEqual(['engagement_overdue_reminded']);
    expect('engagement_overdue_reminded' in EVENT_CATALOG).toBe(false);

    // A list, and a query the formatter broke across lines.
    expect(
      assertedTypes(
        "`SELECT 1 FROM valuation_events WHERE type IN ('auto_pipeline_started', 'auto_pipeline_completed')`",
        'valuation_events',
      ),
    ).toEqual(['auto_pipeline_started', 'auto_pipeline_completed']);
    expect(
      assertedTypes(
        "`SELECT type FROM valuation_events\n         WHERE valuation_id = $1\n           AND type = 'state_changed'`",
        'valuation_events',
      ),
    ).toEqual(['state_changed']);

    // `SET type = '…'` is a write, and the two that exist are deliberate
    // nonsense: the append-only triggers are proved by an UPDATE that has to be
    // refused, and refusing it is the assertion.
    expect(
      assertedTypes("`UPDATE valuation_events SET type = 'tampered' WHERE id = $1`", 'valuation_events'),
    ).toEqual([]);

    // And it does not reach past its own table into the next query's predicate.
    expect(
      assertedTypes(
        "`SELECT 1 FROM valuation_events WHERE valuation_id = $1` + `SELECT 1 FROM admin_events WHERE type = 'user_login'`",
        'valuation_events',
      ),
    ).toEqual([]);
  });

  it('has no admin descriptor for a type nothing writes', () => {
    // Read over `src` as text rather than as types: the routes name their types
    // at the call site of a local `audit(...)` helper, several frames from the
    // `recordAdminEvent` the compiler checks, so an entry can be orphaned by
    // deleting a route without the union noticing.
    const written = new Set(SRC.flatMap(({ text }) => text.match(/'[a-z0-9_]+'/g) ?? []));
    const orphans = Object.keys(ADMIN_EVENT_CATALOG).filter((type) => !written.has(`'${type}'`));
    expect(orphans).toEqual([]);
  });

  it('would catch the fixture R127 left behind', () => {
    // The vacuity guard. `note_added` is the type `eventSpineBounds.test.ts`
    // wrote 120 of; nothing in the catalog has ever described it.
    const fixture = `await recordEvent(ctx.pool, {
        valuationId,
        type: 'note_added',
        actor: { actorType: 'human', actorId: ops.id },
      });`;
    expect(recordedTypes(fixture, 'recordEvent')).toEqual(['note_added']);
    expect('note_added' in EVENT_CATALOG).toBe(false);

    // And it reads a call the formatter left on one line, and an admin one.
    expect(recordedTypes("recordEvent(c, { valuationId, type: 'comment_added' })", 'recordEvent')).toEqual([
      'comment_added',
    ]);
    expect(
      recordedTypes("recordAdminEvent(pool, { type: 'user_login', actor })", 'recordAdminEvent'),
    ).toEqual(['user_login']);
  });

  it('names every admin type the ops feed can show', () => {
    // 64 types across ten route files, none of which had a descriptor before
    // R128 — the activity log printed the raw string and the dashboard feed
    // word-split it.
    expect(Object.keys(ADMIN_EVENT_CATALOG).length).toBeGreaterThanOrEqual(64);
    for (const descriptor of Object.values(ADMIN_EVENT_CATALOG)) {
      expect(descriptor.label).toMatch(/^[A-Z]/);
      expect(descriptor.visibility).toBe('internal');
    }
  });

  it('keeps the two vocabularies from colliding', () => {
    // One label per type across both tables: the activity log unions them and
    // filters on a single `type` column, so a string meaning two things would
    // make the filter mean two things too.
    const shared = Object.keys(ADMIN_EVENT_CATALOG).filter((type) => type in EVENT_CATALOG);
    expect(shared).toEqual([]);
  });
});
