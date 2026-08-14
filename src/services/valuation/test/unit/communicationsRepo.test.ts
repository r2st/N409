import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { updateAutoEmail, updateCommunicationTemplate } from '../../src/repos/communications.js';

/**
 * The two UPDATE builders in `repos/communications.ts` interpolate the patch's
 * *keys* into SQL, because a column name cannot be a bound parameter. Every
 * other repo that builds an UPDATE this way names its columns in the repo;
 * these two took whatever `Object.entries(patch)` yielded.
 *
 * That was safe only by accident of one call site: the routes pass
 * `TemplatePatch.safeParse(...).data`, and a plain Zod object strips unknown
 * keys. A `.passthrough()`, a second caller, or a hand-built object each turn
 * the key into attacker-chosen SQL, and the `Partial<Pick<…>>` annotation that
 * looks like the guard is erased before any of it runs.
 *
 * These tests call the repo directly — which is exactly the access a second
 * caller would have — so they fail if the allow-list is removed, and would
 * still pass if the route schema changed. A fake pool rather than Postgres:
 * what is being asserted is the SQL text, and a database that rejected the
 * injected column would hide the fact that it was ever built.
 */

interface Captured {
  sql: string;
  params: unknown[];
}

function capturingPool(): { pool: pg.Pool; calls: Captured[] } {
  const calls: Captured[] = [];
  const pool = {
    query: (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return Promise.resolve({ rows: [{ id: 'row' }], rowCount: 1 });
    },
  };
  return { pool: pool as unknown as pg.Pool, calls };
}

/** A patch a caller could build that the route's Zod schema would have stripped. */
const HOSTILE = {
  body: 'legitimate',
  // Not a column. If it reaches the SET list it is SQL, not data.
  "enabled = true, body = 'owned' --": 'x',
} as never;

describe('updateCommunicationTemplate column allow-list', () => {
  it('writes the columns it is given', async () => {
    const { pool, calls } = capturingPool();
    await updateCommunicationTemplate(pool, 'tpl-1', { subject: 'Hello', enabled: false }, 'user-1');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('subject = $1');
    expect(calls[0]!.sql).toContain('enabled = $2');
    expect(calls[0]!.params).toEqual(['Hello', false, 'user-1', 'tpl-1']);
  });

  it('drops a key that is not a column, whatever the caller passes', async () => {
    const { pool, calls } = capturingPool();
    await updateCommunicationTemplate(pool, 'tpl-1', HOSTILE, 'user-1');

    const { sql, params } = calls[0]!;
    expect(sql).not.toContain('--');
    expect(sql).not.toContain("'owned'");
    // The legitimate half still lands, and the placeholders still line up with
    // the values — a filter that skipped a key without skipping its parameter
    // would shift every $n after it.
    expect(sql).toContain('body = $1');
    expect(params).toEqual(['legitimate', 'user-1', 'tpl-1']);
  });

  it('ignores an explicitly undefined field rather than writing NULL', async () => {
    const { pool, calls } = capturingPool();
    await updateCommunicationTemplate(pool, 'tpl-1', { subject: undefined, body: 'kept' }, 'user-1');

    expect(calls[0]!.sql).not.toContain('subject');
    expect(calls[0]!.params).toEqual(['kept', 'user-1', 'tpl-1']);
  });

  it('still issues a well-formed statement when every key is rejected', async () => {
    // The `updated_at`/`updated_by` sets are unconditional, so an all-rejected
    // patch must not produce `SET , updated_by = …`.
    const { pool, calls } = capturingPool();
    await updateCommunicationTemplate(pool, 'tpl-1', { nope: 1 } as never, 'user-1');

    expect(calls[0]!.sql).toContain('SET updated_at = now(), updated_by = $1');
    expect(calls[0]!.params).toEqual(['user-1', 'tpl-1']);
  });
});

describe('updateAutoEmail column allow-list', () => {
  it('writes the columns it is given', async () => {
    const { pool, calls } = capturingPool();
    await updateAutoEmail(pool, 'ae-1', { delay_hours: 12, enabled: true });

    expect(calls[0]!.sql).toContain('delay_hours = $1');
    expect(calls[0]!.sql).toContain('enabled = $2');
    expect(calls[0]!.params).toEqual([12, true, 'ae-1']);
  });

  it('drops a key that is not a column', async () => {
    const { pool, calls } = capturingPool();
    await updateAutoEmail(pool, 'ae-1', {
      enabled: true,
      "promotional = true WHERE id IS NOT NULL --": 'x',
    } as never);

    const { sql, params } = calls[0]!;
    expect(sql).not.toContain('--');
    expect(sql).not.toContain('IS NOT NULL');
    expect(sql).toContain('enabled = $1');
    expect(params).toEqual([true, 'ae-1']);
  });

  it('does not let a patch reach columns the campaign form never offers', async () => {
    // `id` and `name` are not in the patch set: a campaign's identity is not
    // editable through the same door as its schedule.
    const { pool, calls } = capturingPool();
    await updateAutoEmail(pool, 'ae-1', { id: 'other', name: 'renamed', max_sends: 3 } as never);

    // Match the SET list only — `WHERE id = $2` is the row selector and is
    // supposed to be there.
    const setList = /SET (.*) WHERE/.exec(calls[0]!.sql)![1]!;
    expect(setList).not.toContain('id = $');
    expect(setList).not.toContain('name = $');
    expect(setList).toBe('updated_at = now(), max_sends = $1');
    expect(calls[0]!.params).toEqual([3, 'ae-1']);
  });
});
