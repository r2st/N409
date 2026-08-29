import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { retireValuations } from '../../src/repos/valuationPurge.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The bulk door, against a retired engagement.
 *
 * `retiredEngagementWrites.test.ts` is the census for this rule and it drives
 * every mutating route **under a valuation id**, live twin against archived
 * twin. `POST /valuations/bulk` names its engagements in the *body*, so it is
 * not a valuation-scoped route, the route table never offered it, and the whole
 * set of refusals R89 installed at the single-id door was reachable through it:
 * `set_state` writes any legal transition onto a withdrawn file, `advance` and
 * `restart` walk it through the pipeline, and every one of those fires
 * `onStateChanged` — the client's email about work the firm has withdrawn, and
 * the partner's webhook announcing it.
 *
 * The pairing is the same design as the census: the live id in each request
 * proves the batch was well-formed and reached the executor, so the archived
 * id's `ok: false` can only have come from the guard. A one-sided test would
 * pass on a batch that failed for any reason at all.
 */
describe.skipIf(!dbUp)('bulk actions against a retired engagement', () => {
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

  async function bulk(body: Record<string, unknown>) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations/bulk',
      headers: authHeader(ops.token),
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      results: Array<{ id: string; ok: boolean; error?: string; state?: string }>;
      succeeded: number;
      failed: number;
    };
  }

  /** Both ids in one batch, so the live row is the control for the archived one. */
  async function pair(name: string): Promise<{ live: string; archived: string }> {
    const live = await createValuation(`Live ${name}`);
    const archived = await createValuation(`Retired ${name}`);
    const retired = await retireValuations(ctx.pool, [archived]);
    expect(retired.retired).toEqual([archived]);
    return { live, archived };
  }

  for (const action of ['set_state', 'advance', 'restart', 'assign_reviewer'] as const) {
    it(`refuses '${action}' for the retired id and runs the live one`, async () => {
      const { live, archived } = await pair(action);
      const body: Record<string, unknown> = { action, ids: [live, archived] };
      // Each action's own required field, with a value legal from 'pending'.
      if (action === 'set_state') body.state = 'started';
      if (action === 'assign_reviewer') body.reviewer_id = ops.id;
      if (action === 'restart') {
        // 'pending' cannot be restarted (RESTART_STATE is 'started'), so move
        // both rows on first — through the repo, since the door under test is
        // the one that would refuse the archived row.
        await ctx.pool.query(`UPDATE valuations SET state = 'onboarding_completed' WHERE id = ANY($1)`, [
          [live, archived],
        ]);
      }

      const out = await bulk(body);
      const byId = new Map(out.results.map((r) => [r.id, r]));

      expect(byId.get(live)?.ok).toBe(true);
      expect(byId.get(archived)?.ok).toBe(false);
      expect(byId.get(archived)?.error).toMatch(/retired/i);
      expect(out.succeeded).toBe(1);
      expect(out.failed).toBe(1);
    });
  }

  it('leaves the retired row where it was', async () => {
    const { live, archived } = await pair('unmoved');
    await bulk({ action: 'set_state', state: 'started', ids: [live, archived] });
    const { rows } = await ctx.pool.query<{ id: string; state: string; version: number }>(
      'SELECT id, state, version FROM valuations WHERE id = ANY($1)',
      [[live, archived]],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(live)?.state).toBe('started');
    // Not merely "not started": a refused row must not have been written at
    // all, which the lock counter is the only witness to.
    expect(byId.get(archived)?.state).toBe('pending');
    expect(byId.get(archived)?.version).toBe(byId.get(live)!.version - 1);
  });
});
