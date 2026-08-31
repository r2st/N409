import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { runRetentionSweep } from '../../src/routes/retention.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const actor = { actorType: 'human' as const, actorId: 'test', source: 'test' };

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
});
