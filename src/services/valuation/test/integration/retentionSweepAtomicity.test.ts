import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { createValuation } from '../../src/repos/valuations.js';
import { enqueueEmail, markEmail } from '../../src/repos/emailOutbox.js';
import { runRetentionSweep } from '../../src/routes/retention.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const actor = { actorType: 'human' as const, actorId: 'test', source: 'test' };

/** Enough of a Fastify logger to read back what the sweep wrote, with spies. */
function stubLog() {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: 'info',
  };
  (log as unknown as { child: () => unknown }).child = () => log;
  return log as unknown as FastifyBaseLogger & typeof log;
}

/**
 * The retention sweep's action log failing after the archival has landed.
 *
 * The two were separate statements on the pool. `findArchivableValuations`
 * selects on `archived_at IS NULL`, so a row the UPDATE committed is a row no
 * later tick will ever look at again — which makes an INSERT that fails after
 * it the expensive half of the pair, not the cheap one. Those engagements were
 * archived for ever with nothing in `retention_actions` saying so, and
 * `retention_actions` is the evidence that the storage-limitation policy is
 * being enforced at all. The throw also skipped
 * `firePartnerWebhooksForRetirement`, so the partners whose engagements had
 * just been retired were never told, on a surface where a lost announcement
 * has nothing that comes back for it.
 *
 * Driven by a trigger that refuses the INSERT, which is what a deadlock or a
 * statement timeout on a five-hundred-row batch looks like from here. The
 * assertion is not that the sweep survives — it does not, and should not — but
 * that a failed pass leaves every candidate exactly where the next tick can
 * find it.
 */
describe.skipIf(!dbUp)('a retention sweep whose action log fails', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/retention/policies/valuation',
      headers: authHeader(admin.token),
      payload: { archive_after_days: 365, retention_days: 730, enabled: true },
    });
    expect(put.statusCode).toBe(200);
  }, 60_000);
  afterAll(async () => ctx?.teardown());

  const agedValuation = async (company: string, ageDays: number) => {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: company, userId: admin.id },
      { ...actor, actorId: admin.id },
    );
    await ctx.pool.query(
      `UPDATE valuations SET created_at = now() - ($2 || ' days')::interval WHERE id = $1`,
      [v.id, String(ageDays)],
    );
    return v;
  };

  const archivedAt = async (id: string): Promise<Date | null> =>
    (
      await ctx.pool.query<{ archived_at: Date | null }>('SELECT archived_at FROM valuations WHERE id = $1', [
        id,
      ])
    ).rows[0]!.archived_at;

  const actionsFor = async (id: string): Promise<string[]> => {
    const { rows } = await ctx.pool.query<{ action: string }>(
      'SELECT action FROM retention_actions WHERE reference_id = $1',
      [id],
    );
    return rows.map((r) => r.action);
  };

  it('leaves the engagement live when the action log refuses the write', async () => {
    const old = await agedValuation('AtomicCo', 500);

    await ctx.pool.query(
      `CREATE OR REPLACE FUNCTION test_refuse_retention_action() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           RAISE EXCEPTION 'retention_actions unavailable';
         END $$;
       CREATE TRIGGER test_refuse_retention_action BEFORE INSERT ON retention_actions
         FOR EACH ROW EXECUTE FUNCTION test_refuse_retention_action()`,
    );
    try {
      await expect(runRetentionSweep(ctx.pool)).rejects.toThrow(/retention_actions unavailable/);

      // The whole point. Archived here would be archived for ever with no
      // record of it: the next pass selects on `archived_at IS NULL` and would
      // never see this row again.
      expect(await archivedAt(old.id)).toBeNull();
      expect(await actionsFor(old.id)).toEqual([]);
    } finally {
      await ctx.pool.query('DROP TRIGGER IF EXISTS test_refuse_retention_action ON retention_actions');
    }
  });

  it('archives it on the next pass, with its action log', async () => {
    // The other half: the row the failed pass left alone is picked up by the
    // tick after it, which is what "leaves every candidate where the next tick
    // can find it" has to mean to be worth anything.
    const result = await runRetentionSweep(ctx.pool);
    expect(result.archived).toBeGreaterThanOrEqual(1);

    const { rows } = await ctx.pool.query<{ id: string }>(
      "SELECT id FROM valuations WHERE company_name = 'AtomicCo'",
    );
    const id = rows[0]!.id;
    expect(await archivedAt(id)).not.toBeNull();
    expect(await actionsFor(id)).toContain('archived');
  });
  it('deletes no correspondence when the purge log refuses the write', async () => {
    // The irreversible half. Five thousand messages can go in one pass and the
    // INSERT naming them is the only record that they did; there is nothing to
    // re-derive the list from once the rows are gone.
    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/retention/policies/email_outbox',
      headers: authHeader(admin.token),
      payload: { archive_after_days: null, retention_days: 30, enabled: true },
    });
    expect(put.statusCode).toBe(200);

    const row = await enqueueEmail(ctx.pool, {
      toEmail: 'purge@test.example.com',
      toUserId: null,
      valuationId: null,
      templateKey: 'test_template',
      subject: 'Old mail',
      body: 'Body',
    });
    await markEmail(ctx.pool, row.id, 'sent');
    await ctx.pool.query(`UPDATE email_outbox SET created_at = now() - interval '90 days' WHERE id = $1`, [
      row.id,
    ]);

    await ctx.pool.query(
      `CREATE OR REPLACE FUNCTION test_refuse_retention_action() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           RAISE EXCEPTION 'retention_actions unavailable';
         END $$;
       CREATE TRIGGER test_refuse_retention_action BEFORE INSERT ON retention_actions
         FOR EACH ROW EXECUTE FUNCTION test_refuse_retention_action()`,
    );
    try {
      await expect(runRetentionSweep(ctx.pool)).rejects.toThrow(/retention_actions unavailable/);
      const { rows } = await ctx.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM email_outbox WHERE id = $1',
        [row.id],
      );
      expect(rows[0]!.n).toBe(1);
    } finally {
      await ctx.pool.query('DROP TRIGGER IF EXISTS test_refuse_retention_action ON retention_actions');
      await ctx.app.inject({
        method: 'PUT',
        url: '/api/v1/admin/retention/policies/email_outbox',
        headers: authHeader(admin.token),
        payload: { archive_after_days: null, retention_days: 30, enabled: false },
      });
    }
  });

  it('still runs the archival pass when the outbox pass fails', async () => {
    // Two independent policies, and a throw in the first one returned before
    // the second. An outbox policy that cannot be enforced — a batch that keeps
    // timing out, a disk that keeps filling — therefore switched the valuation
    // policy off too, silently, on every tick, for as long as it stayed broken.
    const set = (enabled: boolean) =>
      ctx.app.inject({
        method: 'PUT',
        url: '/api/v1/admin/retention/policies/email_outbox',
        headers: authHeader(admin.token),
        payload: { archive_after_days: null, retention_days: 30, enabled },
      });
    expect((await set(true)).statusCode).toBe(200);

    const row = await enqueueEmail(ctx.pool, {
      toEmail: 'blocked@test.example.com',
      toUserId: null,
      valuationId: null,
      templateKey: 'test_template',
      subject: 'Old mail',
      body: 'Body',
    });
    await markEmail(ctx.pool, row.id, 'sent');
    await ctx.pool.query(`UPDATE email_outbox SET created_at = now() - interval '90 days' WHERE id = $1`, [
      row.id,
    ]);
    const stillLive = await agedValuation('IndependentCo', 500);

    await ctx.pool.query(
      `CREATE OR REPLACE FUNCTION test_refuse_outbox_purge() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           RAISE EXCEPTION 'outbox purge unavailable';
         END $$;
       CREATE TRIGGER test_refuse_outbox_purge BEFORE DELETE ON email_outbox
         FOR EACH ROW EXECUTE FUNCTION test_refuse_outbox_purge()`,
    );
    try {
      // The run still fails, and must: the pass did not do what it was asked.
      // Held rather than swallowed, so the scheduler's alerting still fires and
      // nothing here reports a partial success as a whole one.
      await expect(runRetentionSweep(ctx.pool)).rejects.toThrow(/outbox purge unavailable/);

      // But the other policy had its turn. This is the assertion the early
      // return made impossible.
      expect(await archivedAt(stillLive.id)).not.toBeNull();
      expect(await actionsFor(stillLive.id)).toContain('archived');
    } finally {
      await ctx.pool.query('DROP TRIGGER IF EXISTS test_refuse_outbox_purge ON email_outbox');
      await set(false);
    }
  });
  it('reports the outbox failure when the archival pass fails on top of it', async () => {
    /*
     * The held failure, when the pass it is being held for throws too.
     *
     * `finish` is the only place the outbox error is re-raised, and everything
     * between the catch and it can throw on its own account. When something
     * did, its error propagated and the held one went out of scope
     * unmentioned — an irreversible purge that could not run, on a compliance
     * obligation, with the scheduler reporting only the second failure and
     * nothing anywhere naming the first.
     */
    const set = (enabled: boolean) =>
      ctx.app.inject({
        method: 'PUT',
        url: '/api/v1/admin/retention/policies/email_outbox',
        headers: authHeader(admin.token),
        payload: { archive_after_days: null, retention_days: 30, enabled },
      });
    expect((await set(true)).statusCode).toBe(200);

    const row = await enqueueEmail(ctx.pool, {
      toEmail: 'both@test.example.com',
      toUserId: null,
      valuationId: null,
      templateKey: 'test_template',
      subject: 'Old mail',
      body: 'Body',
    });
    await markEmail(ctx.pool, row.id, 'sent');
    await ctx.pool.query(`UPDATE email_outbox SET created_at = now() - interval '90 days' WHERE id = $1`, [
      row.id,
    ]);
    // A candidate, so the archival pass opens the transaction that will fail.
    await agedValuation('BothFailCo', 500);

    await ctx.pool.query(
      `CREATE OR REPLACE FUNCTION test_refuse_outbox_purge() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           RAISE EXCEPTION 'outbox purge unavailable';
         END $$;
       CREATE TRIGGER test_refuse_outbox_purge BEFORE DELETE ON email_outbox
         FOR EACH ROW EXECUTE FUNCTION test_refuse_outbox_purge();
       CREATE OR REPLACE FUNCTION test_refuse_retention_action() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           RAISE EXCEPTION 'retention_actions unavailable';
         END $$;
       CREATE TRIGGER test_refuse_retention_action BEFORE INSERT ON retention_actions
         FOR EACH ROW EXECUTE FUNCTION test_refuse_retention_action()`,
    );
    const log = stubLog();
    try {
      // The archival failure is the one that comes out, as it must: it is the
      // one that stopped the run where it stopped.
      await expect(runRetentionSweep(ctx.pool, { log })).rejects.toThrow(/retention_actions unavailable/);

      // And the outbox failure is not simply gone. `logFailure` classifies it,
      // so the level says whether a person is needed; either way the line names
      // the pass and carries the error.
      const lines = [...log.warn.mock.calls, ...log.error.mock.calls] as [Record<string, unknown>, string][];
      const held = lines.filter((c) => c[0]?.pass === 'email_outbox');
      expect(held).toHaveLength(1);
      expect(held[0]![0]).toMatchObject({ sweep: 'retention', pass: 'email_outbox' });
      expect(String((held[0]![0] as { err: unknown }).err)).toMatch(/outbox purge unavailable/);
      expect(held[0]![1]).toMatch(/outbox retention pass also failed/);
    } finally {
      await ctx.pool.query('DROP TRIGGER IF EXISTS test_refuse_outbox_purge ON email_outbox');
      await ctx.pool.query('DROP TRIGGER IF EXISTS test_refuse_retention_action ON retention_actions');
      await set(false);
    }
  });

  it('reports the outbox failure once, and only through the throw, when the archival pass works', async () => {
    // The ordinary path is unchanged: the failure is re-raised for the
    // scheduler to classify, and nothing logs it a second time here.
    const set = (enabled: boolean) =>
      ctx.app.inject({
        method: 'PUT',
        url: '/api/v1/admin/retention/policies/email_outbox',
        headers: authHeader(admin.token),
        payload: { archive_after_days: null, retention_days: 30, enabled },
      });
    expect((await set(true)).statusCode).toBe(200);

    const row = await enqueueEmail(ctx.pool, {
      toEmail: 'once@test.example.com',
      toUserId: null,
      valuationId: null,
      templateKey: 'test_template',
      subject: 'Old mail',
      body: 'Body',
    });
    await markEmail(ctx.pool, row.id, 'sent');
    await ctx.pool.query(`UPDATE email_outbox SET created_at = now() - interval '90 days' WHERE id = $1`, [
      row.id,
    ]);

    await ctx.pool.query(
      `CREATE OR REPLACE FUNCTION test_refuse_outbox_purge() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           RAISE EXCEPTION 'outbox purge unavailable';
         END $$;
       CREATE TRIGGER test_refuse_outbox_purge BEFORE DELETE ON email_outbox
         FOR EACH ROW EXECUTE FUNCTION test_refuse_outbox_purge()`,
    );
    const log = stubLog();
    try {
      await expect(runRetentionSweep(ctx.pool, { log })).rejects.toThrow(/outbox purge unavailable/);
      const lines = [...log.warn.mock.calls, ...log.error.mock.calls] as [Record<string, unknown>, string][];
      expect(lines.filter((c) => c[0]?.pass === 'email_outbox')).toHaveLength(0);
    } finally {
      await ctx.pool.query('DROP TRIGGER IF EXISTS test_refuse_outbox_purge ON email_outbox');
      await set(false);
    }
  });
});
