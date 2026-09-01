import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { runDueAutoEmails } from '../../src/hooks/autoEmails.js';
import { createAutoEmail } from '../../src/repos/communications.js';
import { createValuation } from '../../src/repos/valuations.js';

const dbUp = await isDbAvailable();

/**
 * The drip scan is the one place in the platform where a soft delete has to
 * hold, because the thing on the other side of it leaves the building.
 *
 * Every other leak of this class found so far — the search box, the firm
 * console, the reviewer queue, the pay-now list — showed a retired engagement
 * on a screen. This one writes to the client. `dueCandidates` builds its own
 * WHERE, so it inherited neither `v.archived_at IS NULL` (which
 * `buildValuationWhere` applies to the list, the counts and the export) nor
 * `u.deleted_at IS NULL` (which every other reader of `users` applies), and
 * nothing between that query and `transport.send` re-checks either.
 *
 * So the two failures asserted here were: a firm that retired an engagement
 * kept nudging its client about it on a cadence, for as many sends as
 * `max_sends` allowed; and a deactivated account kept receiving automated mail,
 * which is the one thing deactivating it was supposed to stop.
 *
 * Each case is asserted against a live control seeded in the same pass, so the
 * test cannot pass by the scan simply having queued nothing.
 */
describe.skipIf(!dbUp)('drip campaigns skip retired engagements and deactivated users', () => {
  let ctx: TestApp;
  let seq = 0;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  afterAll(async () => ctx?.teardown());

  beforeEach(async () => {
    await ctx.pool.query('DELETE FROM auto_email_sends');
    await ctx.pool.query('DELETE FROM auto_emails');
    await ctx.pool.query('DELETE FROM email_outbox');
    // Park everything already seeded out of the trigger state, so each case
    // only ever sees the rows it created.
    await ctx.pool.query(`UPDATE valuations SET state = 'ignored'`);
  });

  /** A campaign that is due the instant a valuation enters `pending`. */
  const seedCampaign = () =>
    createAutoEmail(ctx.pool, {
      name: `soft_delete_${seq++}`,
      channel: 'email',
      trigger_state: 'pending',
      condition: 'always',
      delay_hours: 0,
      repeat_hours: null,
      max_sends: 1,
      template_key: 'valuation_started',
      enabled: true,
    });

  const seedValuation = (companyName: string, userId: string) =>
    createValuation(ctx.pool, { kind: '409a', companyName, userId }, { actorType: 'human', actorId: userId });

  /** Outbox rows the scan queued for this valuation. */
  const queuedFor = async (valuationId: string): Promise<number> => {
    const { rows } = await ctx.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM email_outbox WHERE valuation_id = $1',
      [valuationId],
    );
    return rows[0]!.n;
  };

  it('does not write to the client about an engagement the firm retired', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    await seedCampaign();
    const retired = await seedValuation('Retired Engagement Inc', user.id);
    const live = await seedValuation('Live Engagement Inc', user.id);

    // Archiving is the soft delete `retireValuations` and the retention sweep
    // both stamp. It does not disable the campaign or the valuation's state —
    // which is exactly why the scan kept finding it.
    await ctx.pool.query('UPDATE valuations SET archived_at = now() WHERE id = $1', [retired.id]);

    const result = await runDueAutoEmails({ pool: ctx.pool });

    expect(await queuedFor(retired.id)).toBe(0);
    // The control proves the campaign was firing at all in this pass.
    expect(await queuedFor(live.id)).toBe(1);
    expect(result.queued).toBe(1);
  });

  it('does not write to an account that was deactivated', async () => {
    const deactivated = await seedUser(ctx, { roles: ['valuation_user'] });
    const active = await seedUser(ctx, { roles: ['valuation_user'] });
    await seedCampaign();
    const theirs = await seedValuation('Deactivated Owner Inc', deactivated.id);
    const live = await seedValuation('Active Owner Inc', active.id);

    await ctx.pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [deactivated.id]);

    const result = await runDueAutoEmails({ pool: ctx.pool });

    expect(await queuedFor(theirs.id)).toBe(0);
    expect(await queuedFor(live.id)).toBe(1);
    expect(result.queued).toBe(1);
  });

  /**
   * Neither exclusion is a consent decision, so neither may be counted as one.
   * `suppressed` is the tally of recipients who opted out of marketing — a
   * decision about a real candidate — and folding "we should not be writing at
   * all" into it would make an unsubscribe report that has to be read around.
   */
  it('counts a skipped retired engagement as neither queued nor suppressed', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    await seedCampaign();
    const retired = await seedValuation('Only Retired Inc', user.id);
    await ctx.pool.query('UPDATE valuations SET archived_at = now() WHERE id = $1', [retired.id]);

    const result = await runDueAutoEmails({ pool: ctx.pool });

    expect(result).toEqual({ queued: 0, skipped: 0, suppressed: 0, failed: 0, declined: false });
  });

  /**
   * The send record is what `max_sends` counts against, so a candidate that was
   * refused must leave none behind. Otherwise un-archiving an engagement would
   * bring it back with its allowance already spent on messages nobody received.
   */
  it('leaves no send record behind for a refused candidate', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    await seedCampaign();
    const retired = await seedValuation('No Ghost Sends Inc', user.id);
    await ctx.pool.query('UPDATE valuations SET archived_at = now() WHERE id = $1', [retired.id]);

    await runDueAutoEmails({ pool: ctx.pool });

    const { rows } = await ctx.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM auto_email_sends WHERE valuation_id = $1',
      [retired.id],
    );
    expect(rows[0]!.n).toBe(0);
  });
});
