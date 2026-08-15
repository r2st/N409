import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The window the batched read opened in the bulk executor.
 *
 * `executeBulk` used to load each valuation immediately before writing it. It
 * now loads the whole selection in one query at the top and writes across the
 * length of the batch, which is the right shape for the reads and moves every
 * row's read arbitrarily far from its write — up to two hundred iterations of
 * publish gate, transaction, partner webhook and outbox.
 *
 * The damage in that window is not a lost edit. `canTransition`, `nextState` and
 * `canRestart` are judged against the prefetched row, so an engagement somebody
 * moved while the batch was running gets a transition that was legal from where
 * it *was* — including one that walks it backwards — recorded as an ordinary
 * transition with its own client emails, over a concurrent change that leaves no
 * trace of having happened.
 *
 * The interleaving is forced rather than raced: the tap below runs the competing
 * transition at the moment the batched read resolves, which is exactly the
 * window, and makes the test deterministic instead of a timing bet.
 */

/** The batched selection read — the statement that opens the window. */
const BATCH_READ = /SELECT \* FROM valuations WHERE id = ANY\(\$1\)/i;

/**
 * Run `hook` once, immediately after the batched read resolves.
 *
 * Returns a restore function. The `fired` latch is set before awaiting so the
 * hook's own queries — it drives the real HTTP routes — cannot re-enter it.
 */
function afterBatchRead(pool: pg.Pool, hook: () => Promise<void>): () => void {
  const original = pool.query.bind(pool);
  let fired = false;
  const patched = async (...args: unknown[]) => {
    const first = args[0];
    const text = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
    const result = await (original as (...a: unknown[]) => Promise<unknown>)(...args);
    if (!fired && BATCH_READ.test(text.replace(/\s+/g, ' '))) {
      fired = true;
      await hook();
    }
    return result;
  };
  (pool as unknown as { query: unknown }).query = patched;
  return () => {
    (pool as unknown as { query: unknown }).query = original;
  };
}

describe.skipIf(!dbUp)('a bulk action against a row that moved under it', () => {
  let ctx: TestApp;
  let ops: { id: string; token: string };

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
  }, 60_000);
  afterAll(async () => ctx?.teardown());

  async function createValuation(name: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  }

  /** The single-id route, i.e. the competing operator. */
  async function advance(id: string): Promise<void> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/workflow/advance`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  }

  async function stateOf(id: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().valuation.state as string;
  }

  async function bulk(payload: unknown) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations/bulk',
      headers: authHeader(ops.token),
      payload,
    });
    expect(res.statusCode).toBe(200);
    return res.json().results as Array<{ id: string; ok: boolean; error?: string; state?: string }>;
  }

  it('refuses the one id that moved, and applies the rest', async () => {
    const quiet = await createValuation('Bulk Quiet');
    const moved = await createValuation('Bulk Moved');

    // Two steps while the batch is in flight, so the row ends up *ahead* of
    // where the bulk action would put it: pending → started → onboarding_completed.
    // `advance` on the prefetched row targets 'started', which from
    // onboarding_completed is not a legal transition at all — it is the batch
    // walking a live engagement backwards.
    const restore = afterBatchRead(ctx.pool, async () => {
      await advance(moved);
      await advance(moved);
    });
    let results;
    try {
      results = await bulk({ ids: [quiet, moved], action: 'advance' });
    } finally {
      restore();
    }

    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get(quiet)).toMatchObject({ ok: true, state: 'started' });

    const failed = byId.get(moved)!;
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('changed by someone else');

    // The concurrent progress survives, rather than being reversed by a
    // transition judged against a state that had already been left.
    expect(await stateOf(moved)).toBe('onboarding_completed');
    expect(await stateOf(quiet)).toBe('started');
  });

  it('refuses a set_state that was legal only from where the row used to be', async () => {
    const moved = await createValuation('Bulk Set State');

    const restore = afterBatchRead(ctx.pool, async () => {
      await advance(moved); // pending → started
    });
    let results;
    try {
      // Legal from 'pending', which is what the prefetch holds. Illegal from
      // 'started', which is where the row actually is.
      results = await bulk({ ids: [moved], action: 'set_state', state: 'ignored' });
    } finally {
      restore();
    }

    expect(results[0]!.ok).toBe(false);
    expect(await stateOf(moved)).toBe('started');
  });

  it('does not manufacture a conflict when nothing else is writing', async () => {
    // The guard has to be invisible in the ordinary case, or a bulk action
    // becomes a coin toss.
    const ids = await Promise.all(
      ['Bulk Calm A', 'Bulk Calm B', 'Bulk Calm C'].map((n) => createValuation(n)),
    );
    const results = await bulk({ ids, action: 'advance' });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.state)).toEqual(['started', 'started', 'started']);
  });

  it('still assigns a reviewer over a concurrent state change', async () => {
    // assign_reviewer is deliberately unguarded: it sets a column to a value
    // the operator named rather than deriving one from the row's state, so a
    // stale read cannot make it wrong. It must not start failing because
    // somebody else moved the engagement, and it must not drag the state back.
    const moved = await createValuation('Bulk Reassign');
    const reviewer = await seedUser(ctx, { roles: ['analyst'] });

    const restore = afterBatchRead(ctx.pool, async () => {
      await advance(moved);
    });
    let results;
    try {
      results = await bulk({ ids: [moved], action: 'assign_reviewer', reviewer_id: reviewer.id });
    } finally {
      restore();
    }

    expect(results[0]!.ok).toBe(true);
    expect(await stateOf(moved)).toBe('started');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${moved}`,
      headers: authHeader(ops.token),
    });
    expect(res.json().valuation.assigned_reviewer_id).toBe(reviewer.id);
  });
});
