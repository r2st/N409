import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Every list endpoint reads a fixed number of statements, whatever the page holds.
 *
 * `batchedReads.test.ts` pins the bulk *action* paths — the ones that take a
 * selection of ids and were reading one row at a time. This is the other half,
 * and the one with no id list to give it away: a GET that returns a collection
 * and enriches each row as it goes. The lexical shape is unremarkable — a repo
 * call in a `.map`, a per-row lookup behind a helper two files away — so the
 * audit that finds it is not a search, it is a count.
 *
 * The measurement is a differential rather than an absolute. Asserting "this
 * endpoint runs 4 statements" pins an implementation detail and breaks the next
 * time somebody legitimately splits a query in two; asserting "it runs the same
 * number for twenty rows as for two" pins the property that actually matters
 * and says nothing about how the endpoint is written. A handler that adds a
 * constant read stays green. One that adds a read per row cannot.
 *
 * Seeded through the API rather than with INSERTs so the rows carry whatever
 * associated state the real create path gives them — the joins a list endpoint
 * makes are exactly the ones a hand-built fixture tends not to exercise.
 */
interface QueryTap {
  statements: string[];
  restore: () => void;
}

function tapQueries(pool: pg.Pool): QueryTap {
  const statements: string[] = [];
  const original = pool.query.bind(pool);
  const patched = (...args: unknown[]) => {
    const first = args[0];
    const text = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
    statements.push(text.replace(/\s+/g, ' ').trim());
    return (original as (...a: unknown[]) => unknown)(...args);
  };
  (pool as unknown as { query: unknown }).query = patched;
  return {
    statements,
    restore: () => {
      (pool as unknown as { query: unknown }).query = original;
    },
  };
}

describe.skipIf(!dbUp)('list endpoints do not scale their reads with the page', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  /** Small and large page sizes; the gap has to be wide enough to be unambiguous. */
  const FEW = 2;
  const MANY = 20;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  const createValuation = async (name: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().valuation.id as string;
  };

  /** Statements issued while `run` executes. */
  const countFor = async (run: () => Promise<void>): Promise<number> => {
    const tap = tapQueries(ctx.pool);
    try {
      await run();
      return tap.statements.length;
    } finally {
      tap.restore();
    }
  };

  /**
   * Seeds up to `n` rows, then reports how many statements the GET issued.
   *
   * `seed` is cumulative — it is called with the shortfall, so the second
   * measurement adds to the first population rather than rebuilding it.
   */
  async function readsAt(url: string, token: string, seeded: number): Promise<number> {
    let status = 0;
    let returned = 0;
    const n = await countFor(async () => {
      const res = await ctx.app.inject({ method: 'GET', url, headers: authHeader(token) });
      status = res.statusCode;
      const body = res.json() as Record<string, unknown>;
      const list = Object.values(body).find((v) => Array.isArray(v)) as unknown[] | undefined;
      returned = list?.length ?? 0;
    });
    expect(status, `${url} at ${seeded} rows`).toBe(200);
    // A guard on the guard: if the endpoint returns nothing, a flat statement
    // count proves nothing about how it enriches rows.
    expect(returned, `${url} returned no rows at ${seeded} seeded`).toBeGreaterThan(0);
    return n;
  }

  describe('the valuation worklist', () => {
    it('reads the same number of statements for twenty engagements as for two', async () => {
      for (let i = 0; i < FEW; i += 1) await createValuation(`Worklist Few ${i}`);
      const few = await readsAt('/api/v1/valuations?limit=100', ops.token, FEW);

      for (let i = FEW; i < MANY; i += 1) await createValuation(`Worklist Many ${i}`);
      const many = await readsAt('/api/v1/valuations?limit=100', ops.token, MANY);

      expect(many, `${few} statements for ${FEW} rows, ${many} for ${MANY}`).toBe(few);
    });

    it('holds for the list a client sees, which filters by owner', async () => {
      const few = await readsAt('/api/v1/valuations?limit=100', client.token, MANY);
      for (let i = 0; i < 10; i += 1) await createValuation(`Owned ${i}`);
      const many = await readsAt('/api/v1/valuations?limit=100', client.token, MANY + 10);
      expect(many).toBe(few);
    });
  });

  describe('the admin user directory', () => {
    it('does not read roles one user at a time', async () => {
      const few = await readsAt('/api/v1/users?limit=100', ops.token, 2);
      for (let i = 0; i < MANY; i += 1) await seedUser(ctx, { roles: ['valuation_user'] });
      const many = await readsAt('/api/v1/users?limit=100', ops.token, MANY);
      expect(many, `${few} statements before, ${many} after adding ${MANY} users`).toBe(few);
    });
  });

  describe('the notification feed', () => {
    const notify = async (n: number) => {
      for (let i = 0; i < n; i += 1) {
        await ctx.pool.query(
          `INSERT INTO notifications (id, user_id, valuation_id, type, title, body)
           VALUES ($1, $2, NULL, 'state_change', $3, NULL)`,
          [newUlid(), client.id, `Notice ${i}`],
        );
      }
    };

    it('reads the feed and the unread tally without touching a row twice', async () => {
      await notify(FEW);
      const few = await readsAt('/api/v1/notifications?limit=100', client.token, FEW);
      await notify(MANY - FEW);
      const many = await readsAt('/api/v1/notifications?limit=100', client.token, MANY);
      expect(many, `${few} statements for ${FEW}, ${many} for ${MANY}`).toBe(few);
    });
  });
});
