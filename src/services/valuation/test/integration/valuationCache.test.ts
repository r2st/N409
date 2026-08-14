/**
 * The read-through cache in front of `findValuationById` (repos/valuations.ts).
 *
 * The point of these tests is not that the endpoints return correct data —
 * that is covered everywhere else — but that the cache's two obligations hold:
 * it must actually save the query, and it must never outlive a write. The
 * second is the one that would hurt: a client PATCHes a valuation, the page
 * reloads, and the old value comes back.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearValuationCache, findValuationById, invalidateValuation } from '../../src/repos/valuations.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The pool members these tests replace, as one declared seam.
 *
 * `pg.Pool.query` and `pg.Pool.connect` are overloaded across callback and
 * promise forms and typed generically over the row, so a monkey-patch never
 * satisfies the declaration and every patch site was reaching for `as any`.
 * Six of those is six places the compiler stopped checking anything at all —
 * including the calls *through* the patched member, where a wrong argument
 * count would have compiled. One narrow, named assertion instead: the patched
 * members are stated once, and every use of them is checked against it.
 */
interface PatchablePool {
  query: (...args: unknown[]) => unknown;
  connect: (...args: unknown[]) => unknown;
}

/** A pooled client, in the one shape these hooks touch. */
interface PatchableClient {
  query: (...args: unknown[]) => Promise<unknown>;
}

const patchable = (pool: TestApp['pool']): PatchablePool => pool as unknown as PatchablePool;

describe.skipIf(!dbUp)('valuation read cache', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  /** Counts the point lookups the cache is meant to absorb. */
  function countPointLookups(): { calls: () => number; restore: () => void } {
    const pool = patchable(ctx.pool);
    const original = pool.query.bind(ctx.pool);
    let calls = 0;

    pool.query = (...args: unknown[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : '';
      if (sql.includes('FROM valuations WHERE id = $1')) calls += 1;

      return original(...args);
    };
    return {
      calls: () => calls,

      restore: () => void (pool.query = original),
    };
  }

  const create = async (companyName: string) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation as { id: string };
  };

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  it('serves a repeated lookup without going back to the database', async () => {
    const v = await create('Cached Holdings');
    clearValuationCache();

    const spy = countPointLookups();
    try {
      await findValuationById(ctx.pool, v.id);
      await findValuationById(ctx.pool, v.id);
      await findValuationById(ctx.pool, v.id);
      expect(spy.calls()).toBe(1);
    } finally {
      spy.restore();
    }
  });

  it('collapses concurrent lookups of the same id into one query', async () => {
    // This is the case that actually matters: opening a valuation fans out to
    // several routes at once, each authorizing against the same row.
    const v = await create('Stampede Inc');
    clearValuationCache();

    const spy = countPointLookups();
    try {
      await Promise.all(Array.from({ length: 8 }, () => findValuationById(ctx.pool, v.id)));
      expect(spy.calls()).toBe(1);
    } finally {
      spy.restore();
    }
  });

  it('does not confuse one valuation for another', async () => {
    const a = await create('Distinct A');
    const b = await create('Distinct B');
    clearValuationCache();

    expect((await findValuationById(ctx.pool, a.id))?.company_name).toBe('Distinct A');
    expect((await findValuationById(ctx.pool, b.id))?.company_name).toBe('Distinct B');
  });

  it('shows a PATCH immediately on the next read', async () => {
    const v = await create('Renamed Co');
    // Warm the cache the way a real page load would.
    const before = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${v.id}`,
      headers: authHeader(client.token),
    });
    expect(before.json().valuation.company_name).toBe('Renamed Co');

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${v.id}`,
      headers: authHeader(client.token),
      payload: { company_name: 'Renamed Later Co' },
    });
    expect(patched.statusCode).toBe(200);

    const after = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${v.id}`,
      headers: authHeader(client.token),
    });
    expect(after.json().valuation.company_name).toBe('Renamed Later Co');
  });

  it('shows a state change immediately, including to a different reader', async () => {
    // Ops publishes; the owner must not keep seeing the previous state.
    const v = await create('Transitioning Co');
    await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${v.id}`,
      headers: authHeader(client.token),
    });

    const moved = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${v.id}`,
      headers: authHeader(ops.token),
      payload: { state: 'started' },
    });
    expect(moved.statusCode).toBe(200);

    const seen = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${v.id}`,
      headers: authHeader(client.token),
    });
    expect(seen.json().valuation.state).toBe('started');
  });

  it('reflects a write made through another repo', async () => {
    // repos/organizations.ts writes the valuations row directly; it has to
    // invalidate too, or the entity type stays stale for the whole TTL.
    const v = await create('Subsidiary Co');
    await findValuationById(ctx.pool, v.id);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${v.id}/entity`,
      headers: authHeader(client.token),
      payload: { entity_type: 'subsidiary' },
    });
    expect(patched.statusCode).toBe(200);

    expect((await findValuationById(ctx.pool, v.id))?.entity_type).toBe('subsidiary');
  });

  it('re-reads after an explicit invalidation', async () => {
    const v = await create('Manual Invalidation Co');
    await findValuationById(ctx.pool, v.id);

    await ctx.pool.query('UPDATE valuations SET company_name = $2 WHERE id = $1', [
      v.id,
      'Renamed Behind The Cache',
    ]);
    invalidateValuation(v.id);

    expect((await findValuationById(ctx.pool, v.id))?.company_name).toBe('Renamed Behind The Cache');
  });

  it('caches a miss without turning it into a false hit for a real id', async () => {
    const absent = '01ZZZZZZZZZZZZZZZZZZZZZZZZ';
    expect(await findValuationById(ctx.pool, absent)).toBeNull();
    const v = await create('Exists After A Miss');
    expect((await findValuationById(ctx.pool, v.id))?.id).toBe(v.id);
  });

  /**
   * The writes above all invalidate, and all of them used to do it from *inside*
   * the transaction — after the UPDATE but before the COMMIT. `TtlCache` marks
   * an already-running load stale so its result is not published, but that only
   * covers a load that had started before the drop. A read arriving in the
   * window between the drop and the commit starts a fresh load, reads the
   * pre-commit row on its own pooled connection, and caches it — and no
   * invalidation follows, so the superseded row is then served for a full TTL.
   *
   * `patchValuation` records one or two events between its UPDATE and its
   * commit, so the window is a real one, and every state transition on the
   * platform goes through it.
   */
  describe('a read that lands mid-transaction', () => {
    /**
     * Runs `duringTransaction` once, at the last possible moment before a
     * transaction that has written the `valuations` row commits.
     *
     * That instant is the whole point: it is *after* the writer has done
     * whatever invalidating it is going to do and *before* the row it wrote is
     * visible to anyone else, so a read taken here is guaranteed to load the
     * superseded row. If the invalidation happened inside the transaction, this
     * read is the one that republishes it for a full TTL; if it happens after
     * the commit, this read is harmless because the drop is still to come.
     */
    function onWriteBeforeCommit(duringTransaction: () => Promise<unknown>): { restore: () => void } {
      const pool = patchable(ctx.pool);
      const originalConnect = pool.connect.bind(ctx.pool);
      // Clients are pooled and handed out again, so every one we wrap has to be
      // put back exactly as it was — otherwise the hook outlives this test.
      const unwrap: Array<() => void> = [];
      let fired = false;

      pool.connect = (...args: unknown[]) => {
        // pg's connect is callback-or-promise; only the promise form is ours to
        // wrap, and it is the form `withTransaction` uses.
        if (args.length > 0) return originalConnect(...args);
        return (originalConnect() as Promise<PatchableClient>).then((client) => {
          const originalQuery = client.query.bind(client);
          unwrap.push(() => void (client.query = originalQuery));
          let wroteValuation = false;
          client.query = async (...qargs: unknown[]) => {
            const sql = typeof qargs[0] === 'string' ? qargs[0] : '';
            if (/^\s*UPDATE valuations SET/i.test(sql)) wroteValuation = true;
            if (wroteValuation && !fired && /^\s*COMMIT\s*$/i.test(sql)) {
              fired = true;
              await duringTransaction();
            }
            return originalQuery(...qargs);
          };
          return client;
        });
      };
      return {
        restore: () => {
          pool.connect = originalConnect;
          for (const undo of unwrap) undo();
        },
      };
    }

    it('does not leave the pre-commit row cached after the commit', async () => {
      const v = await create('Mid Transaction Co');
      await findValuationById(ctx.pool, v.id); // warm, as a page load would

      // Reads the row on another connection while the PATCH is still open, so
      // it necessarily sees the old name and repopulates the cache with it.
      let seenDuring: string | undefined;
      const hook = onWriteBeforeCommit(async () => {
        seenDuring = (await findValuationById(ctx.pool, v.id))?.company_name;
      });
      try {
        const patched = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/valuations/${v.id}`,
          headers: authHeader(client.token),
          payload: { company_name: 'Committed Co' },
        });
        expect(patched.statusCode).toBe(200);
      } finally {
        hook.restore();
      }

      // The interleaving actually happened — otherwise the assertion below
      // would pass for the trivial reason that nothing raced.
      expect(seenDuring).toBe('Mid Transaction Co');
      expect((await findValuationById(ctx.pool, v.id))?.company_name).toBe('Committed Co');
    });

    it('does not pin the old state for the reader the transition is about', async () => {
      // The damaging shape of the same race: `state` is what `canReadReport`
      // and the whole publication gate read, so a stale one is not cosmetic.
      const v = await create('Racing Transition Co');
      await findValuationById(ctx.pool, v.id);

      const hook = onWriteBeforeCommit(() => findValuationById(ctx.pool, v.id));
      try {
        const moved = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/valuations/${v.id}`,
          headers: authHeader(ops.token),
          payload: { state: 'drafted' },
        });
        expect(moved.statusCode).toBe(200);
      } finally {
        hook.restore();
      }

      const seen = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${v.id}`,
        headers: authHeader(client.token),
      });
      expect(seen.json().valuation.state).toBe('drafted');
    });

    it('holds for a comment, which bumps the row from its own transaction too', async () => {
      const v = await create('Commented Co');
      await findValuationById(ctx.pool, v.id);
      const before = (await findValuationById(ctx.pool, v.id))?.last_comment_at ?? null;

      const hook = onWriteBeforeCommit(() => findValuationById(ctx.pool, v.id));
      try {
        const posted = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${v.id}/comments`,
          headers: authHeader(ops.token),
          payload: { kind: 'chat', body: 'Racing the cache' },
        });
        expect(posted.statusCode).toBe(201);
      } finally {
        hook.restore();
      }

      expect((await findValuationById(ctx.pool, v.id))?.last_comment_at).not.toEqual(before);
    });
  });
});
