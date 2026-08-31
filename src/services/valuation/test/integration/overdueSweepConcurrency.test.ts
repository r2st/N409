import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/** `SWEEP_LOCKS.overdueReminders` in `db/sweepLock.ts` — 'n4OR'. */
const OVERDUE_LOCK_KEY = 0x6e34_4f52;

/**
 * Two overdue-reminder sweeps at once.
 *
 * The drip scan next door has been serialized since it was written, and its
 * comment states the argument in full: a pass that decides whether to act by
 * reading committed rows is a stale-read-then-write in the large, so two
 * overlapping passes both read "not done yet" and both act. This sweep made
 * every part of that true and held no lock at all — worse than the drip, in
 * fact, because nothing here records that a row has been chased in a way a
 * second pass consults. `slaStatus` is a function of `current_stage` and
 * `stage_entered_at`, and neither moves because a reminder went out, so two
 * overlapping runs do not race over one row: they both send the *whole* set.
 *
 * Overlapping is the ordinary case. This is a POST an operator presses and a
 * scheduler can fire; the pass awaits a transport per overdue row and pages the
 * whole active book, so it is minutes long on a real deployment and a
 * double-click or a tick landing on a run still going is all it takes. What it
 * does twice is mail a named person about a named client's engagement — the
 * harm `routes/engagements.ts` names three times over, on the surface whose own
 * worst case is that mail cannot be un-sent.
 *
 * Driven by holding the advisory lock on a connection of the test's own, so
 * "the second sweep arrived while the first was running" is an assertion rather
 * than two requests raced against each other and hoped to overlap.
 */
describe.skipIf(!dbUp)('a second overdue sweep while one is running', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let analyst: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let companyName: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    analyst = await seedUser(ctx, { roles: ['data'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });

    companyName = 'Overlap Sweep Co';
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().valuation.id as string;
    const assigned = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/engagement/assign`,
      headers: authHeader(ops.token),
      payload: { analyst_id: analyst.id },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    await pool.query(
      `UPDATE engagements SET stage_entered_at = now() - interval '400 days' WHERE valuation_id = $1`,
      [id],
    );
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  const queued = async (): Promise<number> => {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM email_outbox
        WHERE template_key = 'engagement_overdue' AND subject LIKE $1`,
      [`%${companyName}%`],
    );
    return rows[0]!.n;
  };

  const sweep = () =>
    app.inject({
      method: 'POST',
      url: '/api/v1/admin/engagements/remind-overdue',
      headers: authHeader(ops.token),
    });

  it('refuses rather than mailing every overdue analyst a second time', async () => {
    const first = await sweep();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().reminded_count).toBe(1);
    expect(await queued()).toBe(1);

    // A pass in flight, from a connection the request cannot be handed.
    const holder = await pool.connect();
    try {
      const { rows } = await holder.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
        OVERDUE_LOCK_KEY,
      ]);
      expect(rows[0]!.locked).toBe(true);

      const second = await sweep();
      // 409 rather than the drip's silent zero-run: somebody pressed the
      // button, and `reminded_count: 0, scanned: 0` is indistinguishable from
      // "nothing is overdue".
      expect(second.statusCode, second.body).toBe(409);
      expect(second.json().detail).toMatch(/already running/i);
      // The whole point: no second message about the same engagement.
      expect(await queued()).toBe(1);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [OVERDUE_LOCK_KEY]);
      holder.release();
    }
  });

  it('runs again once the lock is free, so the refusal is not a permanent stop', async () => {
    // The other half of a `try` lock: a refusal has to be about contention and
    // nothing else, or the sweep quietly stops for the life of the process —
    // which is the leak `autoEmailScanLock` exists to prove cannot happen.
    const again = await sweep();
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().scanned).toBeGreaterThan(0);
  });
});
