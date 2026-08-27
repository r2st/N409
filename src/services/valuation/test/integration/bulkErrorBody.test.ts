import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ApiProblem } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * A 200 body is still a body a client reads (round 175, methodology M5).
 *
 * `POST /api/v1/valuations/bulk` reports per row, so one row's failure is
 * carried inside a successful response rather than thrown. That put
 * `err.message` in the client's hands with none of the care every problem
 * document gets — and every transition in the loop writes to Postgres, so what
 * a refused row actually produced was the driver's wording, its constraint
 * name, and on `err.detail` the values it rejected.
 *
 * `errorBodyDisclosure.test.ts` could not have caught it: that census scans
 * `problems.*` calls, and this leak is not in a problem document at all. It is
 * in the ordinary shape of the answer. The census grew a second half in the
 * same round; this is the behavioural one.
 *
 * The messages that *do* survive are the ones written to be read — an
 * `ApiProblem` from the optimistic-lock refusal is the whole reason the results
 * array carries an `error` field, and `bulkStaleWrite.test.ts` asserts it.
 */

/**
 * Make the next matching statement fail, wherever it runs.
 *
 * Patches `connect` as well as `query`: the transitions write inside
 * `withTransaction`, so their `UPDATE` is issued on a checked-out client and a
 * tap on `pool.query` alone never sees it.
 */
function failNextMatching(pool: pg.Pool, pattern: RegExp, err: Error): () => void {
  const originalQuery = pool.query.bind(pool);
  const originalConnect = pool.connect.bind(pool);
  let fired = false;
  const matches = (first: unknown) => {
    const text = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
    return pattern.test(text.replace(/\s+/g, ' '));
  };
  (pool as unknown as { query: unknown }).query = async (...args: unknown[]) => {
    if (!fired && matches(args[0])) {
      fired = true;
      throw err;
    }
    return (originalQuery as (...a: unknown[]) => Promise<unknown>)(...args);
  };
  (pool as unknown as { connect: unknown }).connect = (...args: unknown[]) => {
    // pg's callback form returns undefined rather than a promise; leave it be.
    if (typeof args[0] === 'function') {
      return (originalConnect as (...a: unknown[]) => unknown)(...args);
    }
    return wrapClient(args);
  };
  const wrapClient = async (args: unknown[]) => {
    const client = await (originalConnect as (...a: unknown[]) => Promise<pg.PoolClient>)(...args);
    const clientQuery = client.query.bind(client);
    (client as unknown as { query: unknown }).query = async (...inner: unknown[]) => {
      if (!fired && matches(inner[0])) {
        fired = true;
        throw err;
      }
      return (clientQuery as (...a: unknown[]) => Promise<unknown>)(...inner);
    };
    return client;
  };
  return () => {
    (pool as unknown as { query: unknown }).query = originalQuery;
    (pool as unknown as { connect: unknown }).connect = originalConnect;
  };
}

describe.skipIf(!dbUp)('a bulk result carries no wording the route did not author', () => {
  let ctx: TestApp;
  let ops: { id: string; token: string };

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    ops = await seedUser(ctx, { roles: ['admin'] });
  }, 60_000);
  afterAll(async () => ctx?.teardown());

  const createValuation = async (name: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  it('reports a driver failure without quoting the driver', async () => {
    const id = await createValuation('Bulk Leak');
    // The shape `pg` hands a route: a message naming the index, the constraint
    // on its own field, and the offending values on `detail`.
    const pgErr = Object.assign(
      new Error('duplicate key value violates unique constraint "valuations_number_key"'),
      {
        code: '23505',
        severity: 'ERROR',
        constraint: 'valuations_number_key',
        table: 'valuations',
        detail: 'Key (valuation_number)=(409A-2026-0007) already exists.',
      },
    );
    const restore = failNextMatching(ctx.pool, /UPDATE valuations/i, pgErr);
    let results;
    try {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations/bulk',
        headers: authHeader(ops.token),
        payload: { ids: [id], action: 'advance' },
      });
      expect(res.statusCode).toBe(200);
      results = res.json().results as Array<{ id: string; ok: boolean; error?: string }>;
    } finally {
      restore();
    }

    expect(results[0]!.ok).toBe(false);
    const body = JSON.stringify(results);
    expect(body).not.toContain('valuations_number_key');
    expect(body).not.toContain('409A-2026-0007');
    expect(body).not.toContain('duplicate key');
    // Not silence either: the row is named failed, and the single-id route is
    // where the real problem document lives.
    expect(results[0]!.error).toBe('This engagement could not be updated.');
  });

  it('keeps the refusals that were written to be read', async () => {
    // The other direction, and the reason this field exists at all: an
    // `ApiProblem` is a sentence composed for the operator who pressed the
    // button, and narrowing must not have flattened those too.
    // `bulkStaleWrite.test.ts` asserts the same thing through a real
    // optimistic-lock race; this drives it deterministically.
    const id = await createValuation('Bulk Conflict');
    const problem = new ApiProblem({
      status: 409,
      title: 'Conflict',
      type: 'urn:n409:problem:conflict',
      detail: 'This engagement was changed by someone else — reload and try again.',
    });
    const restore = failNextMatching(ctx.pool, /UPDATE valuations/i, problem);
    let results;
    try {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations/bulk',
        headers: authHeader(ops.token),
        payload: { ids: [id], action: 'advance' },
      });
      results = res.json().results as Array<{ ok: boolean; error?: string }>;
    } finally {
      restore();
    }
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toBe('This engagement was changed by someone else — reload and try again.');
  });
});
