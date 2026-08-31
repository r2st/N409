import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { restoreValuations } from '../../src/repos/valuationPurge.js';

const dbUp = await isDbAvailable();

/**
 * An engagement withdrawn *while the overdue sweep is running*.
 *
 * `engagementsArchived` proves the sweep never picks up an engagement that was
 * already retired when its page was read — `ACTIVE_ENGAGEMENT_WHERE` carries
 * `v.archived_at IS NULL`. That predicate is a fact about selection time and
 * this sweep is not instantaneous: it pages up to `ENGAGEMENT_PAGE_LIMIT` rows
 * at once and then walks them one at a time, awaiting a transactional email per
 * overdue row. For a row late in a page the gap between "was live when we
 * looked" and "we are sending now" is minutes.
 *
 * What goes out in that gap is mail — R89's worst case, "mail cannot be
 * un-sent" — telling the assigned analyst to move forward a file the firm has
 * withdrawn, plus an `engagement_overdue_reminder` on a spine whose 0001
 * trigger refuses every UPDATE and DELETE afterwards. Retirement is reversible
 * (R90), so the row comes back with the engagement.
 *
 * Driven by making the retirement a *consequence* of the first send rather than
 * a race the test hopes to win: a trigger on `email_outbox` archives the second
 * engagement when the first one's reminder is queued. The same technique
 * `measurementSpineAtomicity` uses, and for the same reason — the interleaving
 * is the thing under test, so it has to be the thing that happens.
 */
describe.skipIf(!dbUp)('an engagement withdrawn mid-sweep', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let analyst: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  /** valuation ids, in the order the sweep's `ORDER BY e.id ASC` walks them. */
  let firstId: string;
  let secondId: string;
  /**
   * The withdrawn engagement's company name, because that is what the outbox
   * row can be found by. `sendTransactionalEmail` cannot set
   * `email_outbox.valuation_id` — the column is not in its input type — so a
   * `WHERE valuation_id = …` assertion over an `engagement_overdue` row is
   * true of every engagement, withdrawn or not, and would pass on a sweep that
   * mailed about all of them. The subject carries the name.
   */
  let secondName: string;

  const seedOverdue = async (name: string): Promise<string> => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: name },
    });
    const id = created.json().valuation.id as string;
    // First view is what creates the engagement row at `kickoff`.
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

    const a = await seedOverdue('Sweep Race A');
    const b = await seedOverdue('Sweep Race B');
    // The sweep orders by `engagements.id`, which is not the valuation id, so
    // which of the two it reaches first is a question for the database.
    const { rows } = await pool.query<{ valuation_id: string; company_name: string }>(
      `SELECT e.valuation_id, v.company_name
         FROM engagements e JOIN valuations v ON v.id = e.valuation_id
        WHERE e.valuation_id = ANY($1::ulid[]) ORDER BY e.id ASC`,
      [[a, b]],
    );
    firstId = rows[0]!.valuation_id;
    secondId = rows[1]!.valuation_id;
    secondName = rows[1]!.company_name;
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  it('does not mail about an engagement retired after its page was read', async () => {
    // Retire the *second* engagement the moment the first one's reminder is
    // queued — i.e. after the sweep has already selected both. Keyed on the
    // template rather than on `NEW.valuation_id`, which is null: see the note
    // on `secondName`.
    await pool.query(
      `CREATE OR REPLACE FUNCTION test_retire_midsweep() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           UPDATE valuations SET archived_at = now() WHERE id = '${secondId}';
           RETURN NEW;
         END $$;
       CREATE TRIGGER test_retire_midsweep BEFORE INSERT ON email_outbox
         FOR EACH ROW WHEN (NEW.template_key = 'engagement_overdue')
         EXECUTE FUNCTION test_retire_midsweep()`,
    );
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/engagements/remind-overdue',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      // The control: the first engagement was live throughout and is chased.
      // Without it a sweep that simply crashed would pass the assertions below.
      expect(body.reminded).toContain(firstId);
      // The second was live when the page was read and withdrawn before its
      // turn came, so it is skipped — and said so rather than being dropped
      // into a count that still reads as a clean run.
      expect(body.reminded).not.toContain(secondId);
      expect(body.withdrawn).toEqual([secondId]);
      expect(body.withdrawn_count).toBe(1);

      // Mail cannot be un-sent, so this is the assertion that matters.
      const queued = async (name: string): Promise<number> => {
        const { rows } = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM email_outbox
            WHERE template_key = 'engagement_overdue' AND subject LIKE $1`,
          [`%${name}%`],
        );
        return rows[0]!.n;
      };
      expect(await queued(secondName)).toBe(0);
      // The control again, one level down: the sweep did queue the mail it was
      // supposed to, so the zero above is a refusal and not an outbox nobody
      // wrote to.
      expect(await queued('Sweep Race')).toBe(1);

      // Nor an immutable row on the withdrawn engagement's spine.
      const reminders = async (id: string): Promise<number> => {
        const { rows } = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM valuation_events
            WHERE valuation_id = $1 AND type = 'engagement_overdue_reminder'`,
          [id],
        );
        return rows[0]!.n;
      };
      expect(await reminders(secondId)).toBe(0);
      // And the control, because this assertion was written against
      // `engagement_overdue_reminded` — a type nothing writes, so it counted
      // zero of everything and would have passed over a sweep that wrote the
      // row on the withdrawn engagement after all.
      expect(await reminders(firstId)).toBe(1);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS test_retire_midsweep ON email_outbox');
    }
  });

  it('reports nothing withdrawn on an ordinary run', async () => {
    // The other side of the pair: `withdrawn` must be the interleaving and not
    // a list this sweep populates whenever it feels like it. Restored first, so
    // both engagements are live and both are chased again.
    await restoreValuations(pool, [secondId]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/engagements/remind-overdue',
      headers: authHeader(ops.token),
    });
    const body = res.json();
    expect(body.reminded).toEqual(expect.arrayContaining([firstId, secondId]));
    expect(body.withdrawn).toEqual([]);
  });
});
