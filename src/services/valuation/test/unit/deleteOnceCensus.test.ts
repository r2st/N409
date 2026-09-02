import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A repo write that reports whether it moved the row, and the caller that acts
 * on the answer.
 *
 * R356 found four instances of one shape and named the census it could not
 * write. `deleteDocument`, `deleteRound`, `deleteScenario` and
 * `deleteBoardMember` each ask whether their DELETE matched anything before
 * recording the removal beside it, because the route's existence check is a
 * statement earlier and on another connection — so a double-clicked control
 * reaches the write twice, and the second press told an append-only trail that
 * something was removed which had already gone. That round's gap note says
 * exactly what was missing: `terminalStatusWrites` reads `status` columns, so a
 * `revoked_at`/`deleted_at`/plain-DELETE door is invisible to it, and "the
 * question a census would have to ask is not about SQL but about the call
 * site: which repo functions return `boolean` and which callers ignore it".
 *
 * This is that question. The roster is derived rather than listed — every
 * exported repo function whose declared return type is `Promise<boolean>` — so
 * a writer added tomorrow is in the sweep the moment it is written, and a call
 * site that drops the answer has to be acknowledged here with the reason it is
 * allowed to.
 *
 * Discarding the boolean is not wrong on its own. It is wrong when something
 * downstream of the call assumes the write happened: an event, an audit row, a
 * notification, a counter. The acknowledgements below are the call sites where
 * nothing follows the write, and each says so.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.resolve(HERE, '../..');

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
 * Exported functions declared `Promise<boolean>`.
 *
 * Both signature layouts Prettier produces — the one-line one and the one it
 * breaks across lines when the parameters do not fit — because which one a
 * function gets is decided by the length of its name and nothing else.
 */
export function booleanWriters(text: string): string[] {
  const oneLine = /export async function (\w+)\([^\n]*\): Promise<boolean>/g;
  const wrapped = /export async function (\w+)\(\s*\n(?:[^)]*\n)*?\)\s*:\s*Promise<boolean>/g;
  return [...[...text.matchAll(oneLine)].map((m) => m[1]!), ...[...text.matchAll(wrapped)].map((m) => m[1]!)];
}

/**
 * Call sites that await one of `names` as a bare statement — the answer is
 * computed and dropped.
 *
 * A line-level match, because that is the shape being looked for: `await f(...)`
 * opening a statement is a discard whatever its arguments run on to do, while
 * every consuming form (`const x = await f`, `if (await f`, `return await f`,
 * `expect(await f`) puts something before the `await` on the same line.
 */
export function discardedCalls(text: string, names: ReadonlySet<string>): string[] {
  return text.split('\n').flatMap((line) => {
    const m = /^(?:void )?await (\w+)\(/.exec(line.trim());
    return m && names.has(m[1]!) ? [m[1]!] : [];
  });
}

/**
 * The call sites that drop the answer on purpose, and why each may.
 *
 * Listed exhaustively rather than excluded by a rule, so that the next one
 * lands here as a decision somebody made rather than as one the sweep quietly
 * made for them — the same reading `retiredEngagementWrites.test.ts` gives its
 * `UNGUARDED_DELETES`.
 */
const ACKNOWLEDGED: Record<string, string> = {
  'src/routes/comments.ts:deleteComment':
    'Nothing follows the delete: the route answers 204 and writes no event, so there is no ' +
    'transition for the boolean to gate.',
  'src/routes/savedViews.ts:deleteSavedView':
    'Same — a saved view is one person’s own list state and its removal is not on any trail.',
  'src/repos/emailDelivery.ts:recordDeliveryEvent':
    'The `false` here means the provider redelivered an event the ledger already had, and this ' +
    'caller passes `providerEventId: null` — a relay rejection inside the send, which the ' +
    'ON CONFLICT target cannot dedupe and which two rejections of one message legitimately write ' +
    'twice. See `recordSendFailure`.',
};

describe('a write that reports whether it moved the row', () => {
  const roster = new Set(
    SOURCES.filter(({ file }) => file.startsWith('src/repos/')).flatMap(({ text }) => booleanWriters(text)),
  );

  it('is reading the service', () => {
    expect(SOURCES.length).toBeGreaterThan(100);
    // Forty-six at the time of writing; the floor guards against a refactor
    // that renames the idiom out from under the sweep.
    expect(roster.size).toBeGreaterThanOrEqual(40);
    for (const known of ['deleteValuationTag', 'revokeApiToken', 'revokeInvitation', 'restoreUser'])
      expect([...roster]).toContain(known);
  });

  it('has every caller either using the answer or saying why it does not', () => {
    const dropped = SOURCES.flatMap(({ file, text }) =>
      discardedCalls(text, roster).map((name) => `${file}:${name}`),
    );
    expect(dropped.filter((site) => !(site in ACKNOWLEDGED))).toEqual([]);
  });

  it('keeps the acknowledgements pointed at call sites that still exist', () => {
    const dropped = new Set(
      SOURCES.flatMap(({ file, text }) => discardedCalls(text, roster).map((name) => `${file}:${name}`)),
    );
    expect([...Object.keys(ACKNOWLEDGED)].filter((site) => !dropped.has(site))).toEqual([]);
  });

  it('reads the shapes these calls are actually spelled in', () => {
    // The vacuity guard: the discard the sweep is for, and the four consuming
    // forms it must not report. All five are real spellings from this service.
    const names = new Set(['deletePost']);
    expect(discardedCalls('    await deletePost(deps.pool, id);', names)).toEqual(['deletePost']);
    expect(discardedCalls('    const removed = await deletePost(deps.pool, id);', names)).toEqual([]);
    expect(discardedCalls('    if (!(await deletePost(deps.pool, id))) return;', names)).toEqual([]);
    expect(discardedCalls('    return await deletePost(deps.pool, id);', names)).toEqual([]);
    expect(discardedCalls('    expect(await deletePost(pool, id)).toBe(true);', names)).toEqual([]);

    // And the roster reader sees both signature layouts.
    expect(
      booleanWriters('export async function deletePost(pool: pg.Pool, id: string): Promise<boolean> {'),
    ).toEqual(['deletePost']);
    expect(
      booleanWriters(
        'export async function deleteComparableItem(\n  pool: pg.Pool,\n  valuationId: string,\n  itemId: string,\n): Promise<boolean> {',
      ),
    ).toEqual(['deleteComparableItem']);
  });
});
