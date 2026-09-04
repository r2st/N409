import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, forceState, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/** P1 #6 — review queue + approve/request-changes decisions. */
describe.skipIf(!dbUp)('review workflow API', () => {
  let ctx: TestApp;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let reviewer: Awaited<ReturnType<typeof seedUser>>;

  const createValuation = async (state?: string) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'ReviewCo' },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().valuation.id as string;
    // Arranged, not transitioned: what these tests are about is the decision
    // taken *from* a review state, not the six steps it takes to reach one.
    if (state) await forceState(ctx, id, state);
    return id;
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    ops = await seedUser(ctx, { roles: ['admin'] });
    reviewer = await seedUser(ctx, { roles: ['reviewer'] });
  });
  afterAll(async () => ctx?.teardown());

  describe('GET /reviews', () => {
    it('lists valuations in review states with signature rollups', async () => {
      const id = await createValuation('review');
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/reviews',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const row = res.json().reviews.find((r: { id: string }) => r.id === id);
      expect(row).toBeTruthy();
      expect(row.signed_main).toBe(false);
      expect(row.signed_second).toBe(false);
    });

    it('reflects a main signature in the rollup', async () => {
      const id = await createValuation('review');
      const sign = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/signatures`,
        headers: authHeader(ops.token),
        payload: { role: 'main', signer_name: 'Alex Ops', signature_text: 'Alex Ops' },
      });
      expect(sign.statusCode).toBe(201);

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/reviews',
        headers: authHeader(ops.token),
      });
      const row = res.json().reviews.find((r: { id: string }) => r.id === id);
      expect(row.signed_main).toBe(true);
    });

    it('filters to the acting reviewer with assignee=me', async () => {
      const mineId = await createValuation('review');
      const otherId = await createValuation('review');
      const assign = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${mineId}/workflow/reassign`,
        headers: authHeader(ops.token),
        payload: { reviewer_id: reviewer.id },
      });
      expect(assign.statusCode).toBe(200);

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/reviews?assignee=me',
        headers: authHeader(reviewer.token),
      });
      const ids = res.json().reviews.map((r: { id: string }) => r.id);
      expect(ids).toContain(mineId);
      expect(ids).not.toContain(otherId);
    });

    /*
     * An empty queue is a meaningful answer here — it is what "this reviewer
     * has nothing outstanding" looks like — so a filter that silently matches
     * nothing is the worst possible way for a malformed id to fail (R419, M19).
     * `= $1` against a `ulid` column does not apply the domain's CHECK to the
     * parameter, so nothing below this route was ever going to notice.
     */
    it('refuses an assignee filter that is neither "me" nor a user id', async () => {
      for (const bad of ['Me', 'alex@example.com', '01J', '']) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/reviews?assignee=${encodeURIComponent(bad)}`,
          headers: authHeader(ops.token),
        });
        expect(res.statusCode, `${JSON.stringify(bad)} → ${res.body}`).toBe(400);
        expect(res.json().detail).toContain('assignee');
      }
    });

    it('still takes a real user id', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/reviews?assignee=${reviewer.id}`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode, res.body).toBe(200);
    });

    it('is operations-only', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/reviews',
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /valuations/:id/review/decision', () => {
    it('approve advances review → reviewed and records the audit event', async () => {
      const id = await createValuation('review');
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/review/decision`,
        headers: authHeader(reviewer.token),
        payload: { decision: 'approve' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().valuation.state).toBe('reviewed');

      const events = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/events`,
        headers: authHeader(ops.token),
      });
      const decision = events.json().events.find((e: { type: string }) => e.type === 'review_decision');
      expect(decision).toBeTruthy();
      expect(decision.actor_id).toBe(reviewer.id);
      expect(decision.payload).toMatchObject({ decision: 'approve', from: 'review', to: 'reviewed' });
    });

    it('request_changes sends the valuation back and threads the comment as a note', async () => {
      const id = await createValuation('reviewed');
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/review/decision`,
        headers: authHeader(reviewer.token),
        payload: { decision: 'request_changes', comment: 'Cap table is missing the 2025 SAFE.' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().valuation.state).toBe('review');

      const comments = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/comments?kind=note`,
        headers: authHeader(ops.token),
      });
      const note = comments.json().comments.find((c: { body: string }) => c.body.includes('2025 SAFE'));
      expect(note).toBeTruthy();

      const events = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/events`,
        headers: authHeader(ops.token),
      });
      const decision = events.json().events.find((e: { type: string }) => e.type === 'review_decision');
      expect(decision.payload).toMatchObject({
        decision: 'request_changes',
        from: 'reviewed',
        to: 'review',
        comment_id: note.id,
      });
    });

    it('request_changes from drafted lands on draft_changes', async () => {
      const id = await createValuation('drafted');
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/review/decision`,
        headers: authHeader(ops.token),
        payload: { decision: 'request_changes' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().valuation.state).toBe('draft_changes');
    });

    it('409s when the state is not awaiting a decision', async () => {
      const id = await createValuation(); // stays 'pending'
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/review/decision`,
        headers: authHeader(ops.token),
        payload: { decision: 'approve' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('is operations-only', async () => {
      const id = await createValuation('review');
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/review/decision`,
        headers: authHeader(client.token),
        payload: { decision: 'approve' },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
