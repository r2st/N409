import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, forceState, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Two reviewers, one engagement, from assignment to countersigned.
 *
 * The pieces each have coverage: reviewerAssignment.test.ts checks that an
 * unknown reviewer is refused, reviews.test.ts checks that a decision moves the
 * state, and the publish gate is asserted at the end of valuationLifecycle.
 * What none of them exercises is the shape a real engagement actually takes —
 * two people, a round trip, and a handover.
 *
 * That shape is where the interesting failures live. A queue filter that
 * ignores reassignment leaves the first reviewer holding work that is no longer
 * theirs. A "request changes" note that is visible to the client turns an
 * internal criticism into something the client reads. A second signature that
 * satisfies the publish gate lets one person sign their own work off. None of
 * those break a per-endpoint test, and all three break the review process.
 *
 * So: assign, reject with a note, hand over, approve, countersign, publish —
 * asserting at each step both what the actor may do and what the other people
 * on the engagement can see.
 */

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('the multi-reviewer workflow', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  /** Signs main. */
  let mira: Awaited<ReturnType<typeof seedUser>>;
  /** Countersigns second. */
  let cass: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;
  let clientChatId: string;

  const as = (
    token: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => ctx.app.inject({ method, url, headers: authHeader(token), ...(payload ? { payload } : {}) });

  const stateOf = async (id: string) =>
    (await as(ops.token, 'GET', `/api/v1/valuations/${id}`)).json().valuation.state as string;

  const queueIds = async (token: string, query = '') =>
    ((await as(token, 'GET', `/api/v1/reviews${query}`)).json().reviews as Array<{ id: string }>).map(
      (r) => r.id,
    );

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    ops = await seedUser(ctx, { roles: ['supervisor'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    mira = await seedUser(ctx, { roles: ['main_reviewer'] });
    cass = await seedUser(ctx, { roles: ['contributing_reviewer'] });

    const created = await as(client.token, 'POST', '/api/v1/valuations', {
      kind: '409a',
      company_name: 'Two Reviewers, Inc.',
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;
    // Where this story starts: the client has finished and the file is ready to
    // be picked up. The five transitions in front of that are onboarding's
    // story, not this one — but `completed` rather than `review`, because
    // "into review" is the first thing the flow below actually asserts.
    await forceState(ctx, valuationId, 'completed');
  });
  afterAll(async () => ctx?.teardown());

  // ── 1. Into review, and onto somebody's desk ──────────────────────────────

  it('puts the engagement in review and assigns the first reviewer', async () => {
    expect(
      (await as(ops.token, 'PATCH', `/api/v1/valuations/${valuationId}`, { state: 'review' })).statusCode,
    ).toBe(200);

    const assigned = await as(ops.token, 'POST', `/api/v1/valuations/${valuationId}/workflow/reassign`, {
      reviewer_id: mira.id,
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().valuation.assigned_reviewer_id).toBe(mira.id);
  });

  it('shows the work to the reviewer holding it and to nobody else', async () => {
    expect(await queueIds(mira.token, '?assignee=me')).toContain(valuationId);
    expect(await queueIds(cass.token, '?assignee=me')).not.toContain(valuationId);
    // The unfiltered queue is the whole desk — every reviewer sees the backlog.
    expect(await queueIds(cass.token)).toContain(valuationId);
  });

  it('reports it as unsigned while it waits', async () => {
    const row = (
      (await as(mira.token, 'GET', '/api/v1/reviews?assignee=me')).json().reviews as Array<{
        id: string;
        signed_main: boolean;
        signed_second: boolean;
      }>
    ).find((r) => r.id === valuationId)!;
    expect(row.signed_main).toBe(false);
    expect(row.signed_second).toBe(false);
  });

  // ── 2. The round trip ─────────────────────────────────────────────────────

  it('sends it back with a note the client never sees', async () => {
    const sentBack = await as(mira.token, 'POST', `/api/v1/valuations/${valuationId}/review/decision`, {
      decision: 'request_changes',
      comment: 'The 2025 SAFE is missing from the cap table — rerun once it is in.',
    });
    expect(sentBack.statusCode).toBe(200);
    // Back to the analyst, not held in review — 'draft_changes' is where an
    // engagement waits for the work the reviewer asked for.
    expect(await stateOf(valuationId)).toBe('draft_changes');

    const internal = (
      await as(ops.token, 'GET', `/api/v1/valuations/${valuationId}/comments?kind=note`)
    ).json().comments as Array<{ id: string; body: string; author_id: string }>;
    const note = internal.find((c) => c.body.includes('2025 SAFE'))!;
    expect(note).toBeTruthy();
    expect(note.author_id).toBe(mira.id);

    // The client's view of the same thread: chat only. A reviewer's criticism
    // of the analyst's work is not correspondence with the client.
    const seen = await as(client.token, 'GET', `/api/v1/valuations/${valuationId}/comments`);
    expect(seen.statusCode).toBe(200);
    expect((seen.json().comments as Array<{ id: string }>).map((c) => c.id)).not.toContain(note.id);
  });

  it('takes it off the review desk while the analyst works on it', async () => {
    // The queue is what a reviewer works from. An engagement sitting in it
    // while it is back with the analyst is work that gets picked up twice.
    expect(await queueIds(ops.token)).not.toContain(valuationId);
    expect(await queueIds(mira.token, '?assignee=me')).not.toContain(valuationId);
  });

  it('refuses the client the internal thread even when they ask for it by name', async () => {
    const res = await as(client.token, 'GET', `/api/v1/valuations/${valuationId}/comments?kind=note`);
    expect(res.statusCode).toBe(403);
  });

  it('refuses the client a note of their own', async () => {
    const res = await as(client.token, 'POST', `/api/v1/valuations/${valuationId}/comments`, {
      kind: 'note',
      body: 'Trying to write on the internal thread.',
    });
    expect(res.statusCode).toBe(403);
  });

  it('carries the client’s answer back up the same engagement', async () => {
    const posted = await as(client.token, 'POST', `/api/v1/valuations/${valuationId}/comments`, {
      kind: 'chat',
      body: 'The SAFE converted in March — documents uploaded.',
    });
    expect(posted.statusCode).toBe(201);
    clientChatId = posted.json().comment.id as string;

    const asReviewer = (await as(mira.token, 'GET', `/api/v1/valuations/${valuationId}/comments`)).json()
      .comments as Array<{ id: string }>;
    expect(asReviewer.map((c) => c.id)).toContain(clientChatId);
  });

  it('lets the author edit their own message and nobody else’s', async () => {
    const mine = await as(client.token, 'PATCH', `/api/v1/comments/${clientChatId}`, {
      body: 'The SAFE converted in March 2025 — documents uploaded.',
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().comment.body).toContain('March 2025');

    const notMine = await as(cass.token, 'POST', `/api/v1/valuations/${valuationId}/comments`, {
      kind: 'chat',
      body: 'Noted.',
    });
    expect(notMine.statusCode).toBe(201);
    const theirs = notMine.json().comment.id as string;

    const stranger = await as(client.token, 'PATCH', `/api/v1/comments/${theirs}`, { body: 'edited' });
    expect(stranger.statusCode).toBe(403);
  });

  // ── 3. The handover ───────────────────────────────────────────────────────

  it('moves the work to the second reviewer’s queue and off the first’s', async () => {
    // The analyst has done the work; it goes back up for review, to somebody else.
    expect(
      (await as(ops.token, 'PATCH', `/api/v1/valuations/${valuationId}`, { state: 'review' })).statusCode,
    ).toBe(200);

    const moved = await as(ops.token, 'POST', `/api/v1/valuations/${valuationId}/workflow/reassign`, {
      reviewer_id: cass.id,
    });
    expect(moved.statusCode).toBe(200);

    expect(await queueIds(cass.token, '?assignee=me')).toContain(valuationId);
    // The failure this exists for: a queue that still shows Mira work she has
    // handed over, so both reviewers assume the other is on it.
    expect(await queueIds(mira.token, '?assignee=me')).not.toContain(valuationId);
  });

  it('refuses a handover to somebody who is not a user', async () => {
    const res = await as(ops.token, 'POST', `/api/v1/valuations/${valuationId}/workflow/reassign`, {
      reviewer_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors?.[0]?.path).toEqual(['reviewer_id']);
  });

  it('refuses a review decision from the client whose engagement it is', async () => {
    const res = await as(client.token, 'POST', `/api/v1/valuations/${valuationId}/review/decision`, {
      decision: 'approve',
    });
    expect(res.statusCode).toBe(403);
  });

  it('approves, and records who decided it', async () => {
    const approved = await as(cass.token, 'POST', `/api/v1/valuations/${valuationId}/review/decision`, {
      decision: 'approve',
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().valuation.state).toBe('reviewed');

    const events = (await as(ops.token, 'GET', `/api/v1/valuations/${valuationId}/events`)).json()
      .events as Array<{ type: string; actor_id: string; payload: Record<string, unknown> }>;
    const decisions = events.filter((e) => e.type === 'review_decision');
    // Both decisions are on the spine, in order, each against its own actor —
    // "who approved this" is the first question asked of a published 409A.
    expect(decisions.map((d) => d.payload.decision)).toEqual(['request_changes', 'approve']);
    expect(decisions[0]!.actor_id).toBe(mira.id);
    expect(decisions[1]!.actor_id).toBe(cass.id);
  });

  it('treats the next approval as the next decision, not a repeat of the last', async () => {
    // 'reviewed' is itself awaiting a decision — the draft release. So a second
    // approve is not a no-op and not a conflict: it advances one more step, and
    // a reviewer clicking twice has released the draft, which is worth knowing.
    const again = await as(cass.token, 'POST', `/api/v1/valuations/${valuationId}/review/decision`, {
      decision: 'approve',
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().valuation.state).toBe('drafted');
  });

  it('refuses a decision on an engagement that is not awaiting one', async () => {
    const fresh = await as(client.token, 'POST', '/api/v1/valuations', {
      kind: '409a',
      company_name: 'Not In Review, Inc.',
    });
    const res = await as(
      ops.token,
      `POST`,
      `/api/v1/valuations/${fresh.json().valuation.id}/review/decision`,
      {
        decision: 'approve',
      },
    );
    expect(res.statusCode).toBe(409);
  });

  // ── 4. Sign-off ───────────────────────────────────────────────────────────

  it('will not publish on a review decision alone', async () => {
    // drafted → draft_accepted, then the gate.
    expect(
      (await as(ops.token, 'POST', `/api/v1/valuations/${valuationId}/workflow/advance`)).statusCode,
    ).toBe(200);
    const blocked = await as(ops.token, 'POST', `/api/v1/valuations/${valuationId}/workflow/advance`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().detail).toMatch(/main signature is required/i);
  });

  it('refuses a signature from outside operations', async () => {
    const res = await as(client.token, 'POST', `/api/v1/valuations/${valuationId}/signatures`, {
      role: 'main',
      signer_name: 'The Client',
      signature_text: 'The Client',
    });
    expect(res.statusCode).toBe(403);
  });

  it('records both signatures against the people who typed them', async () => {
    const main = await as(mira.token, 'POST', `/api/v1/valuations/${valuationId}/signatures`, {
      role: 'main',
      signer_name: 'Mira Main',
      signer_title: 'Managing Director',
      signature_text: 'Mira Main',
    });
    expect(main.statusCode).toBe(201);

    const second = await as(cass.token, 'POST', `/api/v1/valuations/${valuationId}/signatures`, {
      role: 'second',
      signer_name: 'Cass Contributing',
      signature_text: 'Cass Contributing',
    });
    expect(second.statusCode).toBe(201);

    const rows = (await as(ops.token, 'GET', `/api/v1/valuations/${valuationId}/signatures`)).json()
      .signatures as Array<{ role: string; signer_user_id: string; signer_name: string }>;
    const byRole = Object.fromEntries(rows.map((s) => [s.role, s]));
    // Two roles, two people. A countersignature recorded against the same user
    // as the main one is a review that reviewed itself.
    expect(byRole.main!.signer_user_id).toBe(mira.id);
    expect(byRole.second!.signer_user_id).toBe(cass.id);
    expect(byRole.main!.signer_name).toBe('Mira Main');
  });

  it('refuses a signature naming nobody', async () => {
    const res = await as(mira.token, 'POST', `/api/v1/valuations/${valuationId}/signatures`, {
      role: 'main',
      signer_name: '',
      signature_text: '',
    });
    expect(res.statusCode).toBe(422);
  });

  it('publishes once the main signature is on file', async () => {
    const published = await as(ops.token, 'POST', `/api/v1/valuations/${valuationId}/workflow/advance`);
    expect(published.statusCode).toBe(200);
    expect(published.json().valuation.state).toBe('published');
  });

  it('freezes the signatures a published engagement was signed off on', async () => {
    // Both directions: neither adding to nor removing from the signature block
    // of a delivered valuation, or the file no longer says who signed it.
    const resign = await as(mira.token, 'POST', `/api/v1/valuations/${valuationId}/signatures`, {
      role: 'main',
      signer_name: 'Somebody Else',
      signature_text: 'Somebody Else',
    });
    expect(resign.statusCode).toBe(409);

    const removed = await as(ops.token, 'DELETE', `/api/v1/valuations/${valuationId}/signatures/second`);
    expect(removed.statusCode).toBe(409);
  });

  it('drops a published engagement out of the review queue', async () => {
    expect(await queueIds(ops.token)).not.toContain(valuationId);
  });

  // ── 5. Assigning a batch, which is how a queue is actually cleared ────────

  describe('assigning in bulk', () => {
    let ids: string[];

    beforeAll(async () => {
      ids = [];
      for (const name of ['Batch One, Inc.', 'Batch Two, Inc.']) {
        const created = await as(client.token, 'POST', '/api/v1/valuations', {
          kind: '409a',
          company_name: name,
        });
        const id = created.json().valuation.id as string;
        // Arrangement — what these two assert is the assignment, not the route in.
        await forceState(ctx, id, 'review');
        ids.push(id);
      }
    });

    it('assigns every engagement in the selection exactly once', async () => {
      const res = await as(ops.token, 'POST', '/api/v1/valuations/bulk-action', {
        action: 'assign_reviewer',
        // The first id twice: an export-and-reimport round trip produces this,
        // and applying it twice leaves two audit events for one decision.
        valuation_ids: [ids[0]!, ids[0]!, ids[1]!],
        params: { reviewer_id: mira.id },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().succeeded).toBe(2);
      expect(res.json().failed).toBe(0);

      const queue = await queueIds(mira.token, '?assignee=me');
      expect(queue).toEqual(expect.arrayContaining(ids));
    });

    it('refuses the whole batch when the reviewer does not exist', async () => {
      const res = await as(ops.token, 'POST', '/api/v1/valuations/bulk-action', {
        action: 'assign_reviewer',
        valuation_ids: ids,
        params: { reviewer_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
      });
      // Rejected before anything is written, rather than half-applied.
      expect(res.statusCode).toBe(422);
      expect(await queueIds(mira.token, '?assignee=me')).toEqual(expect.arrayContaining(ids));
    });

    it('is refused to a client, however many ids they send', async () => {
      const res = await as(client.token, 'POST', '/api/v1/valuations/bulk-action', {
        action: 'assign_reviewer',
        valuation_ids: ids,
        params: { reviewer_id: mira.id },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
