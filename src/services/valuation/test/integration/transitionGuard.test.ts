import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, forceState, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { VALUATION_STATES, type ValuationState } from '../../src/domain/valuation.js';
import { canTransition } from '../../src/domain/workflow.js';

/**
 * `PATCH /valuations/:id` may only move an engagement along an edge the
 * lifecycle table actually has.
 *
 * `WORKFLOW_TRANSITIONS` has described the legal edges since M4, and until
 * `domain/transitionGuard.ts` exactly one caller consulted it: the `set_state`
 * arm of the bulk executor. The single-engagement door never did — `state` sat
 * in `OPS_PATCH_FIELDS` validated only against the enum — so any of the fifteen
 * states could be written over any other in one request.
 *
 * The two that matter most are asserted by name below. `pending → published`
 * skips onboarding, the client's own inputs, payment, review, QA and drafting
 * and lands the file in the one state with no way out; `published → started`
 * walks back out of that state, which the table deliberately leaves with no
 * outgoing edges and which `canRestart` separately refuses. Both were reachable
 * with one PATCH by anyone holding the ops role.
 *
 * m4.test.ts covers the bulk executor's half of this. What is pinned here is
 * the door it went around.
 */

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('PATCH state is held to the lifecycle table', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  /** A fresh engagement parked in `state`, without walking the workflow to it. */
  async function engagementIn(state: ValuationState): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'Transition Guard Co' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().valuation.id as string;
    if (state !== 'pending') await forceState(ctx, id, state);
    return id;
  }

  const patchState = (id: string, state: string) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}`,
      headers: authHeader(ops.token),
      payload: { state },
    });

  it('refuses a jump from pending straight to published', async () => {
    const id = await engagementIn('pending');
    const res = await patchState(id, 'published');
    expect(res.statusCode).toBe(409);
    /*
     * The refusal names the edge and what was legal instead, because the
     * caller's next move is to pick one of them.
     *
     * IN LABELS, NOT COLUMN VALUES (round 273, methodology M11). This asserted
     * `pending → published` and a lowercase `started`, a spelling the guard has
     * never produced: R255 had already established that `detail` is the only
     * field a user sees and that eight lifecycle refusals answering with the
     * column value was the defect, so `assertTransition` was written in
     * `stateLabel` terms from its first line. The assertions were written
     * against the change's own prose instead, and both have been red on main
     * since the guard landed. The property is the same one either way — the
     * edge, and the way out — so it is stated in the vocabulary the reader
     * actually gets.
     */
    expect(res.json().detail).toContain('“Pending” to “Published”');
    expect(res.json().detail).toContain('“Started”');
    // And not the column values, which is the thing R255 removed.
    expect(res.json().detail).not.toContain('pending → published');

    // And it is a refusal, not a warning: the row did not move.
    const after = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}`,
      headers: authHeader(ops.token),
    });
    expect(after.json().valuation.state).toBe('pending');
  });

  it('refuses a walk back out of published, which is terminal', async () => {
    const id = await engagementIn('published');
    const res = await patchState(id, 'started');
    expect(res.statusCode).toBe(409);
    // `legalStatesFrom` says this in words rather than in the word "terminal",
    // which is the vocabulary of the table and not of the person reading it.
    expect(res.json().detail).toContain('nowhere — this is a final state');
  });

  it('still allows every edge the table does have', async () => {
    // Not a sample: each legal edge is walked, so a guard that over-refuses is
    // as visible as one that under-refuses. `published` is excluded as a
    // destination because reaching it legally also needs a signature, which is
    // the publish gate's business and has its own coverage.
    for (const from of VALUATION_STATES) {
      for (const to of VALUATION_STATES) {
        if (from === to || !canTransition(from, to) || to === 'published') continue;
        const id = await engagementIn(from);
        const res = await patchState(id, to);
        expect(res.statusCode, `${from} → ${to} is a legal edge`).toBe(200);
        expect(res.json().valuation.state).toBe(to);
      }
    }
  });

  it('refuses every edge the table does not have', async () => {
    // The mirror sweep. One engagement per illegal pair is too slow to be worth
    // it, so this walks the pairs out of a handful of states that between them
    // cover the shapes: a terminal state, a mid-pipeline state, and the two
    // ends of the review round trip.
    for (const from of ['pending', 'review', 'draft_accepted', 'published'] as ValuationState[]) {
      for (const to of VALUATION_STATES) {
        if (from === to || canTransition(from, to)) continue;
        const id = await engagementIn(from);
        const res = await patchState(id, to);
        expect(res.statusCode, `${from} → ${to} is not an edge`).toBe(409);
      }
    }
  });

  it('lets a no-op PATCH through rather than reading it as leaving the state', async () => {
    // `{ state: 'published' }` on a published engagement is not an attempt to
    // leave a terminal state, it is a PATCH that changes nothing — and
    // `patchValuation` drops it from the diff anyway. Refusing it would make
    // an idempotent retry fail the second time.
    const id = await engagementIn('published');
    const res = await patchState(id, 'published');
    expect(res.statusCode).toBe(200);
    expect(res.json().valuation.state).toBe('published');
  });
});
