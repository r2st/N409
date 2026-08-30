import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { authHeader, forceState, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { VALUATION_STATES, stateLabel, type ValuationState } from '../../src/domain/valuation.js';
import { canRestart, decisionTarget, nextState, RESTART_STATE } from '../../src/domain/workflow.js';
import { clearValuationCache } from '../../src/repos/valuations.js';

const dbUp = await isDbAvailable();

/**
 * The four doors a valuation's `state` can be moved through, asked the four
 * questions a state machine has to answer: which transitions are refused, what
 * a repeat does, what a concurrent attempt does, and what the spine records.
 *
 * `transitionGuard.test.ts` sweeps the legality table through `PATCH` and
 * `m4.test.ts` walks the happy path; neither asks about repeats or contention,
 * and the doors that *derive* their target — advance, restart, review decision
 * — were not swept at all.
 *
 * ## Two holders of one read
 *
 * The contention here is not a contrived interleaving. `findValuationById`
 * caches a row for five seconds and collapses concurrent lookups into a single
 * load, so two requests arriving together share one read of the row by
 * construction — a double-clicked button, an operator and a webhook, two
 * reviewers on the same queue. The transition each of them then applies was
 * derived from that shared read.
 *
 * Before R189 that bought two outcomes, both of which looked like success. Two
 * callers writing the same move left the row where it should be and the spine
 * holding the transition twice, with the client emailed twice; and a caller
 * whose read had been overtaken wrote its target over a row further on, walking
 * the workflow backwards under a `from` two moves stale.
 *
 * `betweenReadAndWrite` stages it deterministically rather than betting on
 * timing: the competing request runs at the instant the request under test has
 * read the row and not yet judged it, which is exactly the window.
 */

/** The read every door makes before it judges the transition. */
const VALUATION_READ = /SELECT \* FROM valuations WHERE id = \$1$/i;

/**
 * Run `hook` once, in the window between a door's read of the row and its write.
 *
 * The tap is on the read's own statement rather than on the clock: the hook runs
 * after that SELECT has come back and before the route has seen it, so whatever
 * the hook does lands while the request under test is still holding a reading
 * taken before it. The latch is set before awaiting, so the hook's own requests
 * — which read the same row — cannot re-enter it.
 *
 * `clearValuationCache` first, and it is not tidiness. `getOrLoad` hands a
 * concurrent caller the in-flight load rather than starting a second one, so a
 * hook that read the row would await the very load it is suspended inside.
 * Clearing marks that load stale, which both frees the hook to read for itself
 * and stops the outer load from publishing its now-superseded row — the same
 * thing an ordinary concurrent write would have done through `invalidateValuation`.
 */
function betweenReadAndWrite(pool: pg.Pool, hook: () => Promise<void>): () => void {
  const original = pool.query.bind(pool);
  let armed = true;
  const patched = async (...args: unknown[]) => {
    const first = args[0];
    const text = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
    const result = await (original as (...a: unknown[]) => Promise<unknown>)(...args);
    if (armed && VALUATION_READ.test(text.replace(/\s+/g, ' ').trim())) {
      armed = false;
      clearValuationCache();
      await hook();
    }
    return result;
  };
  (pool as unknown as { query: unknown }).query = patched;
  return () => {
    (pool as unknown as { query: unknown }).query = original;
  };
}

describe.skipIf(!dbUp)('the doors into a valuation state', () => {
  let ctx: TestApp;
  let ops: { id: string; token: string };

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
  }, 60_000);
  afterAll(async () => ctx?.teardown());

  /** A fresh engagement parked in `state`, without walking the workflow to it. */
  async function engagementIn(state: ValuationState): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'State Machine Co' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().valuation.id as string;
    if (state !== 'pending') await forceState(ctx, id, state);
    return id;
  }

  const advance = (id: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/workflow/advance`,
      headers: authHeader(ops.token),
      payload: {},
    });

  const restart = (id: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/workflow/restart`,
      headers: authHeader(ops.token),
      payload: {},
    });

  const decide = (id: string, decision: 'approve' | 'request_changes') =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/review/decision`,
      headers: authHeader(ops.token),
      payload: { decision },
    });

  const patchState = (id: string, state: string) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}`,
      headers: authHeader(ops.token),
      payload: { state },
    });

  async function stateOf(id: string): Promise<ValuationState> {
    const { rows } = await ctx.pool.query<{ state: ValuationState }>(
      'SELECT state FROM valuations WHERE id = $1',
      [id],
    );
    return rows[0]!.state;
  }

  /** Every `state_changed` on the spine, oldest first, as `from → to`. */
  async function transitions(id: string): Promise<string[]> {
    const { rows } = await ctx.pool.query<{ payload: { from: string; to: string } }>(
      `SELECT payload FROM valuation_events
        WHERE valuation_id = $1 AND type = 'state_changed' ORDER BY seq`,
      [id],
    );
    return rows.map((r) => `${r.payload.from} → ${r.payload.to}`);
  }

  // ── advance ────────────────────────────────────────────────────────────────

  describe('POST /workflow/advance', () => {
    it('moves exactly one step, from every state that has a next one', async () => {
      for (const from of VALUATION_STATES) {
        const next = nextState(from);
        // `published` needs a signature as well as an edge, which is the publish
        // gate's business and is asserted on its own below.
        if (!next || next === 'published') continue;
        const id = await engagementIn(from);
        const res = await advance(id);
        expect(res.statusCode, `advance from ${from}`).toBe(200);
        expect(res.json().valuation.state).toBe(next);
        expect(await transitions(id)).toEqual([`${from} → ${next}`]);
      }
    });

    it('is still stopped by the publish gate on the last step', async () => {
      // The one legal edge that a legal edge is not enough for. Advance is not a
      // way around the signature requirement, and a refused advance leaves the
      // engagement where it was with nothing on the spine.
      const id = await engagementIn('draft_accepted');
      const res = await advance(id);
      expect(res.statusCode).toBe(409);
      expect(res.json().detail).toContain('main signature');
      expect(await stateOf(id)).toBe('draft_accepted');
      expect(await transitions(id)).toEqual([]);
    });

    it('refuses from every state that has none, and does not move the row', async () => {
      for (const from of VALUATION_STATES) {
        if (nextState(from)) continue;
        const id = await engagementIn(from);
        const res = await advance(id);
        expect(res.statusCode, `advance from ${from}`).toBe(409);
        // The label, not the column value — round 255. Asserted through
        // `stateLabel` rather than by quoting the words, so this stays true
        // when a state is renamed and false if a refusal goes back to the key.
        expect(res.json().detail).toContain(`from “${stateLabel(from)}”`);
        expect(res.json().detail).not.toContain(`'${from}'`);
        expect(await stateOf(id)).toBe(from);
        expect(await transitions(id)).toEqual([]);
      }
    });

    it('takes one step per click when the clicks are sequential', async () => {
      // Not idempotent, and correctly so: "advance" names a step, not a state.
      // Pinned because the alternative reading — a second click doing nothing —
      // is the one an operator might expect, and the spine has to be able to
      // show two deliberate steps as two steps.
      const id = await engagementIn('completed');
      expect((await advance(id)).json().valuation.state).toBe('review');
      expect((await advance(id)).json().valuation.state).toBe('reviewed');
      expect(await transitions(id)).toEqual(['completed → review', 'review → reviewed']);
    });

    it('refuses the second of two clicks that share one read', async () => {
      const id = await engagementIn('completed');
      const restore = betweenReadAndWrite(ctx.pool, async () => {
        expect((await advance(id)).statusCode).toBe(200);
      });
      const res = await advance(id);
      restore();

      expect(res.statusCode).toBe(409);
      expect(res.json().detail).toContain('changed by someone else');
      // One move, recorded once. The duplicate used to land as a second
      // `completed → review` with its own client email.
      expect(await stateOf(id)).toBe('review');
      expect(await transitions(id)).toEqual(['completed → review']);
    });

    it('refuses a read that has been overtaken rather than walking the file back', async () => {
      const id = await engagementIn('completed');
      const restore = betweenReadAndWrite(ctx.pool, async () => {
        // Two steps while this request holds its read of `completed`.
        expect((await advance(id)).statusCode).toBe(200);
        expect((await advance(id)).statusCode).toBe(200);
      });
      const res = await advance(id);
      restore();

      expect(res.statusCode).toBe(409);
      expect(await stateOf(id)).toBe('reviewed');
      expect(await transitions(id)).toEqual(['completed → review', 'review → reviewed']);
    });
  });

  // ── restart ────────────────────────────────────────────────────────────────

  describe('POST /workflow/restart', () => {
    it('lands on started from every state it is allowed out of', async () => {
      for (const from of VALUATION_STATES) {
        if (!canRestart(from)) continue;
        const id = await engagementIn(from);
        const res = await restart(id);
        expect(res.statusCode, `restart from ${from}`).toBe(200);
        expect(res.json().valuation.state).toBe(RESTART_STATE);
        expect(await transitions(id)).toEqual([`${from} → ${RESTART_STATE}`]);
      }
    });

    it('refuses from published and from started, and does not move the row', async () => {
      for (const from of VALUATION_STATES) {
        if (canRestart(from)) continue;
        const id = await engagementIn(from);
        const res = await restart(id);
        expect(res.statusCode, `restart from ${from}`).toBe(409);
        expect(res.json().detail).toContain(`in “${stateLabel(from)}” cannot be restarted`);
        expect(res.json().detail).not.toContain(`'${from}'`);
        expect(await stateOf(id)).toBe(from);
      }
    });

    it('is idempotent on a repeat, because started cannot be restarted', async () => {
      // The second call is refused by `canRestart`, which is the right answer
      // and not an accident of the version guard: a restarted file is already
      // where a restart would put it.
      const id = await engagementIn('cancelled');
      expect((await restart(id)).statusCode).toBe(200);
      const again = await restart(id);
      expect(again.statusCode).toBe(409);
      expect(await transitions(id)).toEqual(['cancelled → started']);
    });

    it('refuses the second of two restarts that share one read', async () => {
      const id = await engagementIn('cancelled');
      const restore = betweenReadAndWrite(ctx.pool, async () => {
        expect((await restart(id)).statusCode).toBe(200);
      });
      const res = await restart(id);
      restore();

      expect(res.statusCode).toBe(409);
      expect(await stateOf(id)).toBe('started');
      expect(await transitions(id)).toEqual(['cancelled → started']);
    });
  });

  // ── review decision ────────────────────────────────────────────────────────

  describe('POST /review/decision', () => {
    it('sends each decidable state where decisionTarget says, for both decisions', async () => {
      for (const from of VALUATION_STATES) {
        for (const decision of ['approve', 'request_changes'] as const) {
          const target = decisionTarget(from, decision);
          if (!target) continue;
          const id = await engagementIn(from);
          const res = await decide(id, decision);
          expect(res.statusCode, `${from} / ${decision}`).toBe(200);
          expect(res.json().valuation.state).toBe(target);
          expect(await transitions(id)).toEqual([`${from} → ${target}`]);
        }
      }
    });

    it('refuses every state that is not awaiting a decision', async () => {
      for (const from of VALUATION_STATES) {
        if (decisionTarget(from, 'approve')) continue;
        const id = await engagementIn(from);
        for (const decision of ['approve', 'request_changes'] as const) {
          const res = await decide(id, decision);
          expect(res.statusCode, `${from} / ${decision}`).toBe(409);
          expect(res.json().detail).toContain(
            `is “${stateLabel(from)}”, which is not awaiting a review decision`,
          );
          expect(res.json().detail).not.toContain(`'${from}'`);
        }
        expect(await stateOf(id)).toBe(from);
      }
    });

    it('refuses a repeated approval, because the state it decided has moved on', async () => {
      const id = await engagementIn('drafted');
      expect((await decide(id, 'approve')).json().valuation.state).toBe('draft_accepted');
      const again = await decide(id, 'approve');
      expect(again.statusCode).toBe(409);
      expect(again.json().detail).toContain('is “Draft accepted”, which is not awaiting a review decision');
    });

    it('records one decision when two reviewers approve off one read', async () => {
      const id = await engagementIn('drafted');
      const restore = betweenReadAndWrite(ctx.pool, async () => {
        expect((await decide(id, 'approve')).statusCode).toBe(200);
      });
      const res = await decide(id, 'approve');
      restore();

      expect(res.statusCode).toBe(409);
      expect(await stateOf(id)).toBe('draft_accepted');
      expect(await transitions(id)).toEqual(['drafted → draft_accepted']);
      const { rows } = await ctx.pool.query(
        `SELECT 1 FROM valuation_events WHERE valuation_id = $1 AND type = 'review_decision'`,
        [id],
      );
      expect(rows).toHaveLength(1);
    });

    it('refuses the later of two reviewers who disagree, rather than overwriting', async () => {
      // The sharp version: an approve and a request-changes crossing on one
      // read. The loser used to win, silently, from whatever state the winner
      // had already reached.
      const id = await engagementIn('review');
      const restore = betweenReadAndWrite(ctx.pool, async () => {
        expect((await decide(id, 'approve')).statusCode).toBe(200);
      });
      const res = await decide(id, 'request_changes');
      restore();

      expect(res.statusCode).toBe(409);
      expect(await stateOf(id)).toBe('reviewed');
      expect(await transitions(id)).toEqual(['review → reviewed']);
    });
  });

  // ── PATCH ──────────────────────────────────────────────────────────────────

  describe('PATCH /valuations/:id with a state', () => {
    it('says so when someone else has already made the move', async () => {
      // The one refusal the legality table cannot give: `review` is where this
      // caller asked to go and where the row already is, so there is no illegal
      // edge to name. It used to be written a second time.
      const id = await engagementIn('completed');
      const restore = betweenReadAndWrite(ctx.pool, async () => {
        expect((await patchState(id, 'review')).statusCode).toBe(200);
      });
      const res = await patchState(id, 'review');
      restore();

      expect(res.statusCode).toBe(409);
      expect(res.json().detail).toContain("already 'review'");
      expect(await transitions(id)).toEqual(['completed → review']);
    });

    it('refuses a stale write that names an edge still legal from where the row got to', async () => {
      // `reviewed → review` is a legal edge, so neither the table check nor the
      // already-there check refuses this. What makes it wrong is the `from` it
      // would record: a `completed → review` for a row that left `completed`
      // two moves ago.
      const id = await engagementIn('completed');
      const restore = betweenReadAndWrite(ctx.pool, async () => {
        expect((await advance(id)).statusCode).toBe(200);
        expect((await advance(id)).statusCode).toBe(200);
      });
      const res = await patchState(id, 'review');
      restore();

      expect(res.statusCode).toBe(409);
      expect(await stateOf(id)).toBe('reviewed');
      expect(await transitions(id)).toEqual(['completed → review', 'review → reviewed']);
    });

    it('still lets a no-op PATCH through', async () => {
      // Unchanged by the guard above: `patchValuation` drops a field that does
      // not move from the diff before a transaction is opened, so an idempotent
      // retry does not become a conflict.
      const id = await engagementIn('review');
      const res = await patchState(id, 'review');
      expect(res.statusCode).toBe(200);
      expect(await transitions(id)).toEqual([]);
    });
  });

  // ── the spine ──────────────────────────────────────────────────────────────

  it('records a from that the row was actually in, across a full walk', async () => {
    // The property all of the above serve. Every `state_changed`'s `from` is the
    // previous one's `to`, with no gap and no repeat — which is what makes the
    // spine readable as a path rather than as a list of claims.
    const id = await engagementIn('pending');
    for (let i = 0; i < 8; i += 1) {
      const res = await advance(id);
      if (res.statusCode !== 200) break;
    }
    const walked = await transitions(id);
    expect(walked.length).toBeGreaterThan(4);
    for (let i = 1; i < walked.length; i += 1) {
      expect(walked[i]!.split(' → ')[0], `gap before step ${i}`).toBe(walked[i - 1]!.split(' → ')[1]);
    }
    expect(walked[0]!.startsWith('pending → ')).toBe(true);
  });
});
