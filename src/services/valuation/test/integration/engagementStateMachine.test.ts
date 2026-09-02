import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { advanceStage, ensureEngagement } from '../../src/repos/engagements.js';
import { invalidateValuation } from '../../src/repos/valuations.js';
import { ULID_FIELD_MESSAGE } from '../../src/domain/ulidField.js';

const dbUp = await isDbAvailable();

/**
 * R199 — the engagement stage machine, verified as a state machine rather than
 * as a set of endpoints: what guards each transition, what else changes when it
 * fires, what happens when it fires twice, and which of them can be undone.
 *
 * `test/unit/engagement.test.ts` enumerates the transition table itself, which
 * is pure. What needs a database is everything the table cannot see: that the
 * guards are decided by the same act that performs the write, that a refused
 * transition leaves no trail behind it, and that a read does not start an
 * engagement on work the firm has withdrawn.
 */
describe.skipIf(!dbUp)('engagement state machine', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let analyst: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    analyst = await seedUser(ctx, { roles: ['data'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  /** A fresh valuation whose engagement has been started at kickoff. */
  const startEngagement = async (companyName: string): Promise<string> => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: companyName },
    });
    const id = created.json().valuation.id as string;
    await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/engagement`,
      headers: authHeader(ops.token),
    });
    return id;
  };

  const advance = (id: string, body: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/engagement/advance`,
      headers: authHeader(ops.token),
      payload: body,
    });

  const trail = async (valuationId: string) => {
    const { rows: stages } = await pool.query<{ stage: string }>(
      'SELECT stage FROM engagement_stage_history WHERE valuation_id = $1 ORDER BY entered_at, id',
      [valuationId],
    );
    const { rows: events } = await pool.query<{ type: string; payload: Record<string, string> }>(
      `SELECT type, payload FROM valuation_events
        WHERE valuation_id = $1 AND type LIKE 'engagement%' ORDER BY seq`,
      [valuationId],
    );
    const { rows: current } = await pool.query<{ current_stage: string; stage_entered_at: Date }>(
      'SELECT current_stage, stage_entered_at FROM engagements WHERE valuation_id = $1',
      [valuationId],
    );
    return { stages: stages.map((r) => r.stage), events, row: current[0] };
  };

  /**
   * THE RACE THE GUARDS USED TO LOSE.
   *
   * Every refusal the advance route can produce is computed from a row read on
   * one connection, and the UPDATE ran on another keyed by primary key alone.
   * Two operators working the same engagement off the pipeline board is not an
   * exotic case — it is what the board is for.
   *
   * Driven at the repo, because that is where the window is: both callers hold
   * the row as they read it, which is exactly the state two concurrent HTTP
   * requests are in between `ensureEngagement` and `advanceStage`.
   */
  describe('two writers off one read', () => {
    it('lets one transition through and refuses the other', async () => {
      const id = await startEngagement('RaceCo');
      const engagement = await ensureEngagement(pool, id, { actorType: 'human', actorId: ops.id });
      const actor = { actorType: 'human' as const, actorId: ops.id };

      const settled = await Promise.allSettled([
        advanceStage(pool, engagement, 'analysis', actor),
        advanceStage(pool, engagement, 'client_review', actor),
      ]);
      const won = settled.filter((r) => r.status === 'fulfilled');
      const lost = settled.filter((r) => r.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);

      const { stages, events, row } = await trail(id);
      // The loser wrote nothing — not the row, not the history, not the event.
      expect(stages).toEqual([
        'kickoff',
        (won[0] as PromiseFulfilledResult<{ current_stage: string }>).value.current_stage,
      ]);
      expect(events.filter((e) => e.type === 'engagement_stage_advanced')).toHaveLength(1);
      // And the winner was told where the engagement actually is.
      expect(row!.current_stage).toBe(
        (won[0] as PromiseFulfilledResult<{ current_stage: string }>).value.current_stage,
      );
    });

    /**
     * The event payload is the part a compliance reader cannot check for
     * themselves. A blind UPDATE let the loser record `from: kickoff` for a
     * move out of `analysis` — a transition into an append-only log that never
     * happened.
     */
    it('never records a transition out of a stage the engagement had already left', async () => {
      const id = await startEngagement('TrailCo');
      const engagement = await ensureEngagement(pool, id, { actorType: 'human', actorId: ops.id });
      const actor = { actorType: 'human' as const, actorId: ops.id };
      await Promise.allSettled([
        advanceStage(pool, engagement, 'analysis', actor),
        advanceStage(pool, engagement, 'final_report', actor),
      ]);

      const { events, stages } = await trail(id);
      // Replaying the recorded transitions must reproduce the recorded trail.
      let at = 'kickoff';
      for (const e of events.filter((x) => x.type !== 'engagement_started')) {
        expect(e.payload.from).toBe(at);
        at = e.payload.to!;
      }
      expect(stages[stages.length - 1]).toBe(at);
    });

    it('tells the loser where the engagement went, not just that there was a conflict', async () => {
      const id = await startEngagement('MessageCo');
      const engagement = await ensureEngagement(pool, id, { actorType: 'human', actorId: ops.id });
      await advanceStage(pool, engagement, 'board_approval', { actorType: 'human', actorId: ops.id });
      // `engagement` is now the stale read a second request would be holding.
      await expect(
        advanceStage(pool, engagement, 'analysis', { actorType: 'human', actorId: ops.id }),
      ).rejects.toMatchObject({ detail: expect.stringContaining('Board approval') });
    });

    /**
     * Firing the same transition twice is the double-click, and the guard that
     * was supposed to catch it — "already at that stage" — is read off the
     * stale row, so under concurrency it saw the old stage and let both
     * through. Both resetting `stage_entered_at` is the consequential half: it
     * is the SLA clock the overdue sweep reads.
     */
    it('does not let a repeated transition restart the SLA clock', async () => {
      const id = await startEngagement('DoubleCo');
      const engagement = await ensureEngagement(pool, id, { actorType: 'human', actorId: ops.id });
      const actor = { actorType: 'human' as const, actorId: ops.id };
      const settled = await Promise.allSettled([
        advanceStage(pool, engagement, 'analysis', actor),
        advanceStage(pool, engagement, 'analysis', actor),
      ]);
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

      const { stages, events } = await trail(id);
      expect(stages).toEqual(['kickoff', 'analysis']);
      expect(events.filter((e) => e.type === 'engagement_stage_advanced')).toHaveLength(1);
    });
  });

  /**
   * What the three terse refusals say now (R350, methodology M19).
   *
   * `refuseTransition` answered `reopen_required` with a paragraph naming the
   * consequence and the exact field to send, and the other three with a
   * category noun apiece — "Unknown engagement stage", "already at its final
   * stage", "already at that stage" — none of which named a stage. All three
   * are things an operator with a board open in front of them cannot resolve
   * by looking: the unknown one is the only answer to a typo, since
   * `AdvanceBody` deliberately types `stage` as a string so the transition
   * table stays the one place a stage is decided; and `same_stage` is a lost
   * race rather than a mistake, so the missing fact is where the engagement
   * *is*.
   */
  describe('what a refused transition says', () => {
    it('names what was sent and what would have been accepted', async () => {
      const id = await startEngagement('TypoCo');
      const res = await advance(id, { stage: 'analysys' });
      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.detail).toContain('analysys');
      expect(body.detail).toContain('data_collection');
      // Where it is now, which is the other half of choosing a target.
      expect(body.detail).toContain('Kickoff');
      // The extension is for the integration; the prose is for the person.
      expect(body.allowed_stages).toContain('board_approval');
    });

    it('names the stage the engagement is actually at on a lost race', async () => {
      const id = await startEngagement('RaceCo');
      expect((await advance(id, { stage: 'analysis' })).statusCode).toBe(200);
      const res = await advance(id, { stage: 'analysis' });
      expect(res.statusCode).toBe(409);
      expect(res.json().detail).toContain('Analysis');
      expect(res.json().detail).toMatch(/reload/i);
    });

    it('names the final stage, and the way back out of it', async () => {
      const id = await startEngagement('EndCo');
      await advance(id, { stage: 'complete' });
      const res = await advance(id, {});
      expect(res.statusCode).toBe(409);
      expect(res.json().detail).toContain('Complete');
      expect(res.json().detail).toContain('reopen');
    });

    it('does not let a stage name reorder the sentence it is quoted in', async () => {
      // `stage` is caller-supplied and lands in prose a terminal draws.
      const id = await startEngagement('BidiCo');
      const res = await advance(id, { stage: 'analysis\u202egnp.exe' });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).not.toContain('\u202e');
    });
  });

  /**
   * `terminal: true` on `complete` was honoured by the unnamed-target path and
   * ignored by the named one. Reopening is legitimate; doing it by choosing a
   * line in a select box, and recording it as an ordinary forward step, is not.
   */
  describe('leaving the terminal stage', () => {
    it('refuses a reopen that does not say it is one, and writes nothing', async () => {
      const id = await startEngagement('DoneCo');
      expect((await advance(id, { stage: 'complete' })).statusCode).toBe(200);
      const before = await trail(id);

      const refused = await advance(id, { stage: 'kickoff' });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().detail).toContain('reopen');

      const after = await trail(id);
      expect(after.stages).toEqual(before.stages);
      expect(after.events).toHaveLength(before.events.length);
      expect(after.row!.current_stage).toBe('complete');
    });

    it('still refuses an unnamed advance past the final stage, flag or not', async () => {
      const id = await startEngagement('FinalCo');
      await advance(id, { stage: 'complete' });
      for (const body of [{}, { reopen: true }]) {
        const res = await advance(id, body);
        expect(res.statusCode).toBe(409);
        expect(res.json().detail).toContain('final stage');
      }
    });

    it('reopens when asked to, and records it as a reopen rather than an advance', async () => {
      const id = await startEngagement('ReopenCo');
      await advance(id, { stage: 'complete' });
      const reopened = await advance(id, { stage: 'auditor_queries', reopen: true });
      expect(reopened.statusCode).toBe(200);
      expect(reopened.json().engagement.current_stage).toBe('auditor_queries');

      const { events } = await trail(id);
      const last = events[events.length - 1]!;
      expect(last.type).toBe('engagement_reopened');
      expect(last.payload).toMatchObject({ from: 'complete', to: 'auditor_queries' });
    });

    /**
     * The reopen is what puts the engagement back where the SLA machinery can
     * see it — which is the reason it has to be asked for.
     */
    it('puts the reopened engagement back on the pipeline board', async () => {
      const id = await startEngagement('BoardCo');
      await advance(id, { stage: 'complete' });
      const onBoard = async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/engagements',
          headers: authHeader(ops.token),
        });
        return res.json().engagements.some((e: { valuation_id: string }) => e.valuation_id === id);
      };
      expect(await onBoard()).toBe(false);
      await advance(id, { stage: 'analysis', reopen: true });
      expect(await onBoard()).toBe(true);
    });

    it('does not require the flag for a move that is not leaving a terminal stage', async () => {
      const id = await startEngagement('ForwardCo');
      // Backwards between working stages stays free: review bouncing to drafting.
      expect((await advance(id, { stage: 'client_review' })).statusCode).toBe(200);
      const back = await advance(id, { stage: 'draft_report' });
      expect(back.statusCode).toBe(200);
      const { events } = await trail(id);
      expect(events.some((e) => e.type === 'engagement_reopened')).toBe(false);
    });
  });

  /**
   * Who the analyst may be. The sweep emails whoever is assigned, on a timer,
   * with the company name and the internal SLA state in the body — so this is
   * an outbound-disclosure guard, not a tidiness one.
   */
  describe('analyst assignment', () => {
    const assign = (id: string, analystId: string | null) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/engagement/assign`,
        headers: authHeader(ops.token),
        payload: { analyst_id: analystId },
      });

    it('accepts an operations user', async () => {
      const id = await startEngagement('AssignCo');
      const res = await assign(id, analyst.id);
      expect(res.statusCode).toBe(200);
      expect(res.json().engagement.assigned_analyst_id).toBe(analyst.id);
    });

    it('clears the assignment', async () => {
      const id = await startEngagement('ClearCo');
      await assign(id, analyst.id);
      expect((await assign(id, null)).json().engagement.assigned_analyst_id).toBeNull();
    });

    /**
     * A client cannot be the analyst. Before this the row was written, and the
     * next overdue sweep mailed them "Overdue: <company> is past SLA in
     * <stage>" — one client's engagement status, sent to an unrelated one.
     */
    it('refuses a user who is not on the operations team, and sends them nothing', async () => {
      const id = await startEngagement('LeakCo');
      const res = await assign(id, client.id);
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain('operations team');

      const { rows } = await pool.query(
        'SELECT assigned_analyst_id FROM engagements WHERE valuation_id = $1',
        [id],
      );
      expect(rows[0].assigned_analyst_id).toBeNull();

      await pool.query(
        "UPDATE engagements SET stage_entered_at = now() - interval '30 days' WHERE valuation_id = $1",
        [id],
      );
      const swept = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/engagements/remind-overdue',
        headers: authHeader(ops.token),
      });
      expect(swept.json().reminded).not.toContain(id);
      const outbox = await pool.query('SELECT 1 FROM email_outbox WHERE to_email = $1', [client.email]);
      expect(outbox.rowCount).toBe(0);
    });

    /**
     * A ULID that names nobody reached the `assigned_analyst_id` foreign key
     * and came back as a bare 500 — a well-signalled failure answered with
     * nothing the caller can act on.
     */
    it('answers an id that names nobody with a validation refusal, not a 500', async () => {
      const id = await startEngagement('GhostCo');
      const res = await assign(id, newUlid());
      expect(res.statusCode).toBe(422);
      // R350: `Unknown analyst` named no field and no remedy, in a function
      // whose third refusal is a full sentence. The extension is unchanged and
      // still not what the reader sees.
      expect(res.json().detail).toContain('no user with that id');
      expect(res.json().detail).toMatch(/reload/i);
      expect(res.json().errors).toEqual([{ path: ['analyst_id'] }]);
    });

    /**
     * This assertion has been wrong since R333, which put `ulidField()` on
     * `AssignBody` and so moved the refusal from `assertAssignableAnalyst` to
     * the schema — the detail became `Invalid analyst — analyst_id: …` and the
     * test went on asserting the handler's old string. Left failing on main
     * until R350, the same shape R347 found on the fund-link assertion.
     *
     * The answer it asserts now is the reachable one. The handler's own
     * `isUlid` branch stays as the guard for a direct caller, but nothing on
     * the wire reaches it.
     */
    it('answers a malformed id the same way, from the schema', async () => {
      const id = await startEngagement('MalformedCo');
      const res = await assign(id, 'not-a-ulid');
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain('analyst_id');
      expect(res.json().detail).toContain(ULID_FIELD_MESSAGE);
      expect(res.json().errors[0].path).toEqual(['analyst_id']);
    });
  });

  /**
   * A GET that starts an engagement. On a live valuation that is deliberate —
   * the kickoff clock should start when somebody opens the panel. On a retired
   * one it is a write to withdrawn work, reached by a read: the shape
   * `refuseIfRetired` exists for, and one R89's sweep of the *mutating* routes
   * could not have found.
   */
  describe('reading a retired engagement', () => {
    const retire = async (id: string) => {
      await pool.query('UPDATE valuations SET archived_at = now() WHERE id = $1', [id]);
      // `findValuationById` caches for five seconds and every production writer
      // drops the entry through `invalidateValuationAfter`; this UPDATE goes
      // around them, so it has to do that part itself.
      invalidateValuation(id);
    };

    it('does not bring an engagement into being on work the firm has withdrawn', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(client.token),
        payload: { kind: '409a', company_name: 'WithdrawnCo' },
      });
      const id = created.json().valuation.id as string;
      await retire(id);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/engagement`,
        headers: authHeader(ops.token),
      });
      // The read stays open — a firm that withdrew work can still look at it.
      expect(res.statusCode).toBe(200);
      // It just says there is no engagement, rather than inventing a kickoff.
      expect(res.json().engagement).toBeNull();
      expect(res.json().sla).toBeNull();
      expect(res.json().durations).toEqual([]);
      expect(res.json().stages.length).toBeGreaterThan(0);

      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM engagements WHERE valuation_id = $1',
        [id],
      );
      expect(rows[0].n).toBe(0);
      const { rows: ev } = await pool.query(
        "SELECT count(*)::int AS n FROM valuation_events WHERE valuation_id = $1 AND type = 'engagement_started'",
        [id],
      );
      expect(ev[0].n).toBe(0);
    });

    it('still serves an engagement that was started before the valuation was retired', async () => {
      const id = await startEngagement('LateRetireCo');
      await advance(id, { stage: 'analysis' });
      await retire(id);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/engagement`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().engagement.current_stage).toBe('analysis');
      expect(res.json().durations.length).toBeGreaterThan(0);
    });

    it('refuses every write to it', async () => {
      const id = await startEngagement('FrozenCo');
      await retire(id);
      for (const [url, payload] of [
        [`/api/v1/valuations/${id}/engagement/advance`, { stage: 'analysis' }],
        [`/api/v1/valuations/${id}/engagement/assign`, { analyst_id: analyst.id }],
      ] as const) {
        const res = await app.inject({ method: 'POST', url, headers: authHeader(ops.token), payload });
        expect(res.statusCode).toBe(409);
      }
    });
  });
});
