import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { runDueAutoEmails } from '../../src/hooks/autoEmails.js';
import {
  AUTO_EMAIL_PAGE_LIMIT,
  createAutoEmail,
  dueCandidates,
  eachDueCandidate,
} from '../../src/repos/communications.js';
import { createValuation } from '../../src/repos/valuations.js';

const dbUp = await isDbAvailable();

/**
 * The drip scan's candidate query, bounded.
 *
 * It was the last read on a job path with no LIMIT: every valuation in a
 * campaign's trigger state, each carrying four correlated subqueries' worth of
 * columns, materialised in this process at once and held while the scan worked
 * through them. A scan rather than a request, and it holds the auto-email
 * advisory lock throughout, so the failure mode is a heap-exhausted service
 * rather than a slow endpoint — and it grows with the table, with nothing
 * saying so on the way up.
 *
 * Two properties, and both are needed. The bound alone would be a cap, and a
 * cap on this path is worse than the unbounded read: the head of the queue gets
 * mailed and the tail never does, while the scan reports a healthy `queued`
 * count. So the read is bounded *and* the scan is paged, and the test that
 * matters is that a backlog larger than one page is fully delivered.
 */
describe.skipIf(!dbUp)('the drip scan reads its candidates a page at a time', () => {
  let ctx: TestApp;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let seq = 0;

  beforeAll(async () => {
    ctx = await setupTestApp({ EMAIL_MODE: 'off', AUTO_PIPELINE: 'off' });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  beforeEach(async () => {
    await ctx.pool.query('DELETE FROM auto_email_sends');
    await ctx.pool.query('DELETE FROM auto_emails');
    await ctx.pool.query('DELETE FROM email_outbox');
    // Park every other seeded engagement out of the trigger state, so each case
    // only ever sees the rows it made.
    await ctx.pool.query(`UPDATE valuations SET state = 'ignored'`);
  });

  /** A campaign due the instant a valuation enters `pending`. */
  const seedCampaign = () =>
    createAutoEmail(ctx.pool, {
      name: `paging_${seq++}`,
      channel: 'email',
      trigger_state: 'pending',
      condition: 'always',
      delay_hours: 0,
      repeat_hours: null,
      max_sends: 1,
      template_key: 'valuation_started',
      enabled: true,
    });

  const seedValuations = async (n: number): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const v = await createValuation(
        ctx.pool,
        { kind: '409a', companyName: `Paging Co ${seq++}`, userId: owner.id },
        { actorType: 'human', actorId: owner.id },
      );
      ids.push(v.id);
    }
    return ids;
  };

  it('never asks for more than one page in a single read', async () => {
    const campaign = await seedCampaign();
    await seedValuations(5);

    const rows = await dueCandidates(ctx.pool, campaign, { limit: 2 });
    expect(rows.length).toBe(2);

    // And the ceiling is a ceiling, not a suggestion: a caller asking for more
    // than the page limit gets the page limit, so no code path can restore the
    // unbounded read by passing a large number.
    const asked = await dueCandidates(ctx.pool, campaign, { limit: AUTO_EMAIL_PAGE_LIMIT * 10 });
    expect(asked.length).toBeLessThanOrEqual(AUTO_EMAIL_PAGE_LIMIT);
  });

  it('walks the whole candidate set across pages, visiting each row once', async () => {
    const campaign = await seedCampaign();
    const seeded = await seedValuations(7);

    const seen: string[] = [];
    let pages = 0;
    for await (const page of eachDueCandidate(ctx.pool, campaign, { pageSize: 2 })) {
      pages += 1;
      expect(page.length, 'a yielded page must never be empty').toBeGreaterThan(0);
      for (const c of page) seen.push(c.valuation_id);
    }

    // The paging is real, not one page in disguise.
    expect(pages).toBeGreaterThan(1);
    expect(new Set(seen).size, 'a valuation was visited twice').toBe(seen.length);
    expect([...seen].sort()).toEqual([...seeded].sort());
  });

  it('mails the tail of a backlog larger than one page, not just the head', async () => {
    // The property a cap would break. Asserted through the scan rather than the
    // repo, because the scan is what writes `auto_email_sends` rows as it goes
    // — and those rows feed the `prior_sends_at` subquery the next page's
    // candidate query reads, which is exactly the interaction a naive OFFSET
    // page would get wrong.
    await seedCampaign();
    const seeded = await seedValuations(5);

    const result = await runDueAutoEmails({ pool: ctx.pool, log: ctx.app.log, pageSize: 2 });
    expect(result.queued).toBe(seeded.length);

    const { rows } = await ctx.pool.query<{ valuation_id: string }>(
      'SELECT DISTINCT valuation_id FROM email_outbox WHERE valuation_id = ANY($1::ulid[])',
      [seeded],
    );
    expect(rows.map((r) => r.valuation_id).sort()).toEqual([...seeded].sort());
  });

  it('does not re-queue on the next pass, however the pages fell', async () => {
    // Paging must not become a way to double-send: the send record and the
    // outbox row commit together, and `max_sends` is judged from the record, so
    // a second scan over the same backlog has to queue nothing.
    await seedCampaign();
    const seeded = await seedValuations(5);

    const first = await runDueAutoEmails({ pool: ctx.pool, log: ctx.app.log, pageSize: 2 });
    const second = await runDueAutoEmails({ pool: ctx.pool, log: ctx.app.log, pageSize: 2 });

    expect(first.queued).toBe(seeded.length);
    expect(second.queued).toBe(0);
  });
});
