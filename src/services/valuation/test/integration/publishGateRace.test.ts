import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasMainSignature } from '../../src/repos/signatures.js';
import { createCalculation, latestSucceededCalculation } from '../../src/repos/calculations.js';
import { createQaReview, latestQaReviewForCalculation } from '../../src/repos/qaReviews.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The publish gate under concurrency.
 *
 * `assertPublishGate` is the one thing standing between a 409A engagement and
 * `published`, and its first rule is that a Signature (main) must be on file.
 * Every path that can set the state calls it: the workflow routes, bulk
 * actions, review decisions and the direct PATCH.
 *
 * It called it *outside* the write. The gate ran its reads on the pool, the
 * caller then wrote `state` in a separate statement on a separate connection,
 * and nothing held the signature still in between. `DELETE
 * /valuations/:id/signatures/main` refuses only once a valuation is already
 * published — which, at the moment it reads that, the publishing request has
 * not finished making true. So the two interleave into exactly the outcome the
 * gate exists to forbid: the gate sees the signature, the signature is deleted,
 * the publish lands. The engagement ends up `published` with no main signature
 * at all, and the report it stands behind goes out over a sign-off that is not
 * in the database.
 *
 * That is a compliance artifact, not a UI glitch. A 409A's defensibility rests
 * on a named reviewer having signed the conclusion; "published, unsigned" is a
 * state a firm cannot explain to an auditor, and nothing downstream re-checks
 * it — the evidence pack and the auditor portal both read the signature list as
 * given.
 *
 * Two overlapping `inject`s reproduce it because both handlers begin with a
 * query on their own pooled connection (see the testing notes on when
 * `fastify.inject` races for real): the delete's write genuinely lands between
 * the gate's read and the publish's write.
 *
 * The fix serialises the two on the valuation row — the publish transition
 * takes `SELECT ... FOR UPDATE` on `valuations` and re-asserts the gate inside
 * the same transaction that writes the state, and the signature mutations take
 * the same lock and re-read the state under it. Whichever arrives second waits,
 * then sees what the first actually did.
 */
describe.skipIf(!dbUp)('publish gate under concurrency', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  const advance = (id: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/workflow/advance`,
      headers: authHeader(ops.token),
    });

  const stateOf = async (id: string): Promise<string> => {
    const { rows } = await ctx.pool.query<{ state: string }>(
      'SELECT state FROM valuations WHERE id = $1',
      [id],
    );
    return rows[0]!.state;
  };

  /**
   * A signed engagement parked one step below `published`.
   *
   * No calculation is run: `assertPublishGate` returns after the signature
   * check when there is nothing calculated, which isolates this test on the
   * signature rule rather than on the QA rule stacked behind it.
   */
  async function signedAtDraftAccepted(name: string): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().valuation.id as string;

    // Walk up to the last state before `published`. Guarded rather than
    // counted: a new state in the machine must not silently turn this into a
    // test of some other transition.
    for (let i = 0; i < 20 && (await stateOf(id)) !== 'draft_accepted'; i++) {
      expect(await advance(id)).toMatchObject({ statusCode: 200 });
    }
    expect(await stateOf(id)).toBe('draft_accepted');

    const sign = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/signatures`,
      headers: authHeader(ops.token),
      payload: { role: 'main', signer_name: 'Alice Analyst', signature_text: 'Alice Analyst' },
    });
    expect(sign.statusCode).toBe(201);
    return id;
  }

  /**
   * Repeated, because one run is not a test of this.
   *
   * The very first race in a fresh process reliably went the *benign* way —
   * connections still being established stretch the publish's first read far
   * enough ahead of the delete that they serialise by accident. From the second
   * onwards the pool is warm and the bug appears: on the original code this
   * loop reported `published/unsigned` on runs 1 through 5 and only run 0 was
   * clean. A single-shot version of this test passed against the bug.
   */
  const RUNS = 6;

  it('never publishes over a signature deleted while the gate was reading', async () => {
    const outcomes: string[] = [];

    for (let run = 0; run < RUNS; run++) {
      const id = await signedAtDraftAccepted(`GateRace ${run}, Inc.`);

      const [published, deleted] = await Promise.all([
        advance(id),
        ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/valuations/${id}/signatures/main`,
          headers: authHeader(ops.token),
        }),
      ]);

      const state = await stateOf(id);
      const signed = await hasMainSignature(ctx.pool, id);
      outcomes.push(`run ${run}: ${state}/${signed ? 'signed' : 'unsigned'}`);

      // Either order is a legitimate outcome; the pair is not. What must never
      // hold is "published" and "no main signature" at the same time.
      expect(
        { state, signed },
        `run ${run}: advance=${published.statusCode} delete=${deleted.statusCode}`,
      ).not.toEqual({ state: 'published', signed: false });

      if (state === 'published') {
        // The publish won: the signature it was judged against is still on
        // file, and the delete was refused for the reason the route gives.
        expect(signed, `run ${run}`).toBe(true);
        expect(deleted.statusCode, `run ${run}`).toBe(409);
      } else {
        // The delete won: the publish was refused by the gate rather than
        // silently dropped, and the engagement stayed where it was.
        expect(state, `run ${run}`).toBe('draft_accepted');
        expect(published.statusCode, `run ${run}`).toBe(409);
        expect(published.json().detail).toContain('main signature');
      }
    }

    // Both orderings are acceptable, but a run where the publish never won at
    // all would mean the lock had serialised the pair into one fixed order and
    // this stopped being a test of the interleaving.
    expect(outcomes.some((o) => o.includes('published'))).toBe(true);
  });

  it('refuses to unsign a valuation published a moment earlier', async () => {
    // The ordering the lock alone would not fix. Taking turns is not the
    // property wanted: a signature removed just *after* the publish commits
    // leaves the same published-and-unsigned row as one removed during it, so
    // the delete has to re-read the state under the lock rather than trust the
    // row the route loaded.
    const id = await signedAtDraftAccepted('AfterTheFact, Inc.');
    expect(await advance(id)).toMatchObject({ statusCode: 200 });

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/valuations/${id}/signatures/main`,
      headers: authHeader(ops.token),
    });
    expect(deleted.statusCode).toBe(409);
    expect(await hasMainSignature(ctx.pool, id)).toBe(true);
  });

  it('never publishes over a calculation that landed while the gate was reading', async () => {
    // The gate's second rule: when a valuation has a successful calculation,
    // its *latest* one must carry a non-failing QA review — a recalculation
    // invalidates the previous review by construction, because the review is
    // keyed to the calculation it examined.
    //
    // So a calculation committing during a publish defeats the rule without
    // touching anything the publisher looked at: the gate reads C1's passing
    // review, C2 lands, and the engagement publishes with its latest
    // calculation ungraded. The numbers in the report are then from a run no
    // reviewer ever saw.
    //
    // Driven through the repos rather than `POST /calculations` on purpose —
    // that route's work is an engine round trip, and stubbing one would put the
    // stub's timing, not the database's, in the window under test.
    const actor = { actorType: 'human' as const, actorId: ops.id, source: 'test' };
    const newRun = (valuationId: string) =>
      createCalculation(
        ctx.pool,
        {
          valuationId,
          engineVersion: 'py-test',
          status: 'succeeded',
          inputs: {},
          results: {},
          equityValue: 20_000_000,
          fmvPerShare: 2,
          createdBy: ops.id,
        },
        actor,
      );

    for (let run = 0; run < RUNS; run++) {
      const id = await signedAtDraftAccepted(`RecalcRace ${run}, Inc.`);
      const first = await newRun(id);
      await createQaReview(
        ctx.pool,
        {
          valuationId: id,
          calculationId: first.id,
          status: 'pass',
          checks: [{ key: 'k', label: 'l', status: 'pass', detail: 'd' }],
          createdBy: ops.id,
        },
        actor,
      );
      // The gate is satisfied right now — this is the state the race starts
      // from, and without it the test would prove only that an unpublishable
      // valuation stays unpublished.
      expect(await latestSucceededCalculation(ctx.pool, id)).toMatchObject({ id: first.id });
      expect(await latestQaReviewForCalculation(ctx.pool, first.id)).not.toBeNull();

      const [published] = await Promise.all([advance(id), newRun(id)]);

      const state = await stateOf(id);
      if (state === 'published') {
        const latest = await latestSucceededCalculation(ctx.pool, id);
        const review = await latestQaReviewForCalculation(ctx.pool, latest!.id);
        expect(review, `run ${run}: published over an ungraded calculation`).not.toBeNull();
        expect(review!.status).not.toBe('fail');
      } else {
        // The recalculation won the lock; the publish was refused by the rule
        // that now applies, and said which one.
        expect(state, `run ${run}`).toBe('draft_accepted');
        expect(published.statusCode, `run ${run}`).toBe(409);
        expect(published.json().detail).toContain('QA review');
      }
    }
  });

  it('publishes normally when nothing races it', async () => {
    // The vacuity guard: the walk-up, the signature and the gate all work, so a
    // failure above is the interleaving and not a broken fixture.
    const id = await signedAtDraftAccepted('QuietCo, Inc.');
    expect(await advance(id)).toMatchObject({ statusCode: 200 });
    expect(await stateOf(id)).toBe('published');
    expect(await hasMainSignature(ctx.pool, id)).toBe(true);
  });
});
