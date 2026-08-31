import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * One engagement's reminder failing, in a sweep that has more rows behind it.
 *
 * `overdueSweepRetirementRace` proves the run declines a withdrawn row and says
 * so instead of dropping it into a count that reads as a clean run. That rule
 * is stated on `isRetiredNow` itself — "a sweep that raised on the first
 * withdrawn row would abandon every row behind it" — and the loop obeyed it for
 * the one case it had thought about and for no other. There was no per-row
 * catch, so anything that threw took the whole run with it: a statement timeout
 * on the enqueue, a pool checkout that waited out its ceiling, the spine INSERT
 * losing a deadlock.
 *
 * The cost is not the lost reminder. It is that the 500 carries no `reminded`
 * list, so the operator's obvious next move — run it again — mails every
 * analyst already chased a second time, on the surface whose own worst case is
 * that mail cannot be un-sent; and every overdue engagement behind the failing
 * one was never reached, with nothing saying which.
 *
 * Driven with a trigger that raises on the *first* row's outbox INSERT, so the
 * assertion that the second was still chased is the whole point rather than a
 * coincidence of ordering.
 */
describe.skipIf(!dbUp)('one row failing inside the overdue sweep', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let analyst: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  /** valuation ids, in the order the sweep's `ORDER BY e.id ASC` walks them. */
  let firstId: string;
  let secondId: string;
  /** The failing engagement's company name — the subject carries it. */
  let firstName: string;
  let secondName: string;

  const seedOverdue = async (name: string): Promise<string> => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: name },
    });
    const id = created.json().valuation.id as string;
    const view = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/engagement`,
      headers: authHeader(ops.token),
    });
    expect(view.statusCode).toBe(200);
    const assigned = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/engagement/assign`,
      headers: authHeader(ops.token),
      payload: { analyst_id: analyst.id },
    });
    expect(assigned.statusCode).toBe(200);
    await pool.query(
      `UPDATE engagements SET stage_entered_at = now() - interval '400 days' WHERE valuation_id = $1`,
      [id],
    );
    return id;
  };

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    analyst = await seedUser(ctx, { roles: ['data'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });

    const a = await seedOverdue('Sweep Fail A');
    const b = await seedOverdue('Sweep Fail B');
    // The sweep orders by `engagements.id`, not by the valuation id, so which
    // of the two it reaches first is a question for the database.
    const { rows } = await pool.query<{ valuation_id: string; company_name: string }>(
      `SELECT e.valuation_id, v.company_name
         FROM engagements e JOIN valuations v ON v.id = e.valuation_id
        WHERE e.valuation_id = ANY($1::ulid[]) ORDER BY e.id ASC`,
      [[a, b]],
    );
    firstId = rows[0]!.valuation_id;
    firstName = rows[0]!.company_name;
    secondId = rows[1]!.valuation_id;
    secondName = rows[1]!.company_name;
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  const queued = async (name: string): Promise<number> => {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM email_outbox
        WHERE template_key = 'engagement_overdue' AND subject LIKE $1`,
      [`%${name}%`],
    );
    return rows[0]!.n;
  };

  it('reports the failed row and keeps chasing the ones behind it', async () => {
    await pool.query(
      `CREATE OR REPLACE FUNCTION test_fail_one_reminder() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           RAISE EXCEPTION 'outbox unavailable for this row';
         END $$;
       CREATE TRIGGER test_fail_one_reminder BEFORE INSERT ON email_outbox
         FOR EACH ROW WHEN (NEW.template_key = 'engagement_overdue'
                            AND NEW.subject LIKE '%${firstName}%')
         EXECUTE FUNCTION test_fail_one_reminder()`,
    );
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/engagements/remind-overdue',
        headers: authHeader(ops.token),
      });

      // A run in which one row failed is still a run that did work, and the
      // work it did is the part an operator has to know about before deciding
      // whether to press the button again.
      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.failed).toEqual([
        { valuation_id: firstId, failure_reason: expect.stringMatching(/^pg\./) },
      ]);
      expect(body.failed_count).toBe(1);
      expect(body.reminded).not.toContain(firstId);

      // The row behind the failure. Before the per-row catch the loop stopped
      // at the first throw, so this engagement was never reached at all — and
      // nothing in the 500 said so.
      expect(body.reminded).toContain(secondId);
      expect(await queued(secondName)).toBe(1);
      // And the failing row really did fail: no outbox row, so `failed` is
      // reporting a lost reminder rather than decorating a successful one.
      expect(await queued(firstName)).toBe(0);

      // Nor a spine event claiming the analyst was chased. It is written after
      // the send for exactly this reason, and 0001's immutability trigger means
      // a wrong one could never be taken back off.
      const { rows: events } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM valuation_events
          WHERE valuation_id = $1 AND type = 'engagement_overdue_reminded'`,
        [firstId],
      );
      expect(events[0]!.n).toBe(0);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS test_fail_one_reminder ON email_outbox');
    }
  });

  it('reports nothing failed on an ordinary run', async () => {
    // The other side of the pair: `failed` must be the interleaving and not a
    // list this sweep populates whenever it feels like it.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/engagements/remind-overdue',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.failed).toEqual([]);
    expect(body.failed_count).toBe(0);
    expect(body.reminded).toEqual(expect.arrayContaining([firstId, secondId]));
  });
});
