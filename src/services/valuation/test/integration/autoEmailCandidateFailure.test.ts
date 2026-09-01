import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { runDueAutoEmails } from '../../src/hooks/autoEmails.js';
import { createAutoEmail, dueCandidates } from '../../src/repos/communications.js';
import { createValuation } from '../../src/repos/valuations.js';
import { isSuppressed } from '../../src/repos/emailDelivery.js';
import type { EmailOutboxRow } from '../../src/repos/emailOutbox.js';

const dbUp = await isDbAvailable();

/**
 * One candidate failing, in a scan that has a backlog behind it.
 *
 * The two sibling send loops are contained per message and say why in as many
 * words — `hooks/stateChange.ts`: "letting one of them abort the loop hands the
 * sweep every remaining recipient of the same transition, each waiting out the
 * claim lease before anyone hears anything", and `hooks/emailRetry.ts` the same
 * for its settle. The drip scan is the widest of the three and was the only one
 * uncontained: it walks every enabled campaign's whole backlog, so a statement
 * timeout on one enqueue took the tail of that campaign *and every campaign
 * after it*, and the pass reported a failure carrying none of what it had
 * already queued.
 *
 * Driven with a trigger that refuses one valuation's outbox row, which is what
 * a deadlock on the enqueue looks like from here.
 */
describe.skipIf(!dbUp)('one candidate failing inside the drip scan', () => {
  let ctx: TestApp;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let seq = 0;

  beforeAll(async () => {
    ctx = await setupTestApp({ EMAIL_MODE: 'off', AUTO_PIPELINE: 'off' });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
  }, 60_000);
  afterAll(async () => ctx?.teardown());

  beforeEach(async () => {
    await ctx.pool.query('DELETE FROM auto_email_sends');
    await ctx.pool.query('DELETE FROM auto_emails');
    await ctx.pool.query('DELETE FROM email_outbox');
    await ctx.pool.query(`UPDATE valuations SET state = 'ignored'`);
  });

  const seedCampaign = () =>
    createAutoEmail(ctx.pool, {
      name: `candidate_failure_${seq++}`,
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
        { kind: '409a', companyName: `Candidate Failure Co ${seq++}`, userId: owner.id },
        { actorType: 'human', actorId: owner.id },
      );
      ids.push(v.id);
    }
    return ids;
  };

  const outboxFor = async (valuationId: string): Promise<number> => {
    const { rows } = await ctx.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM email_outbox WHERE valuation_id = $1',
      [valuationId],
    );
    return rows[0]!.n;
  };

  it('reports the failed candidate and keeps mailing the ones behind it', async () => {
    const campaign = await seedCampaign();
    const seeded = await seedValuations(3);
    // The scan walks the candidate query's own order, so which row it reaches
    // first is a question for the database rather than for the seeding above.
    const order = (await dueCandidates(ctx.pool, campaign, { limit: 10 })).map((c) => c.valuation_id);
    expect(order.length).toBe(seeded.length);
    const doomed = order[0]!;
    const behind = order.slice(1);

    await ctx.pool.query(
      `CREATE OR REPLACE FUNCTION test_fail_one_candidate() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01';
         END $$;
       CREATE TRIGGER test_fail_one_candidate BEFORE INSERT ON email_outbox
         FOR EACH ROW WHEN (NEW.valuation_id = $1)
         EXECUTE FUNCTION test_fail_one_candidate()`.replace('$1', `'${doomed}'`),
    );
    try {
      // Not a rejection. Before the per-candidate catch this threw out of the
      // scan, and the pass reported a failure carrying none of what it had
      // already queued — while the rows behind the failure were never looked
      // at, on this campaign or on any campaign after it.
      const result = await runDueAutoEmails({ pool: ctx.pool, log: ctx.app.log });

      expect(result.failed).toBe(1);
      expect(result.queued).toBe(behind.length);
      expect(await outboxFor(doomed)).toBe(0);
      for (const id of behind) expect(await outboxFor(id)).toBe(1);

      // The enqueue and its send record are one transaction, so the refused
      // candidate has no `auto_email_sends` row either — which is what makes
      // the next pass owe it again rather than count it against `max_sends`.
      const { rows } = await ctx.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM auto_email_sends WHERE valuation_id = $1',
        [doomed],
      );
      expect(rows[0]!.n).toBe(0);
    } finally {
      await ctx.pool.query('DROP TRIGGER IF EXISTS test_fail_one_candidate ON email_outbox');
    }

    // And the next pass does owe it: the only candidate still due is the one
    // the trigger refused, and with the trigger gone it is mailed.
    const second = await runDueAutoEmails({ pool: ctx.pool, log: ctx.app.log });
    expect(second.failed).toBe(0);
    expect(second.queued).toBe(1);
    expect(await outboxFor(doomed)).toBe(1);
  });

  it('reports nothing failed on an ordinary pass', async () => {
    // The other side of the pair: `failed` must be the interleaving and not a
    // number this scan produces whenever it feels like it.
    await seedCampaign();
    const seeded = await seedValuations(2);
    const result = await runDueAutoEmails({ pool: ctx.pool, log: ctx.app.log });
    expect(result).toEqual({ queued: seeded.length, skipped: 0, suppressed: 0, failed: 0 });
  });

  /**
   * A mailbox that permanently rejected us, on a pass where the stamp cannot be
   * written.
   *
   * `onFailed` makes two writes about two different things: `markEmail` records
   * what became of this *message*, `recordSendFailure` records what the relay
   * said about this *address*. They shared one `try` here, so a refused
   * `email_outbox` UPDATE threw straight past the bounce record and into the
   * per-candidate catch above — the candidate counted failed, the scan carried
   * on, and the address stayed off the suppression list with a `550 5.1.1`
   * behind it. The next campaign, and the retry ladder, went on sending to it.
   *
   * Staged with a trigger that refuses only the 'failed' stamp: the bounce
   * fold touches `bounced_at` and leaves `status` alone, so it passes.
   */
  it('suppresses a hard-rejected address even when the failed stamp is refused', async () => {
    await seedCampaign();
    const [only] = await seedValuations(1);

    const transport = {
      send: async (_email: EmailOutboxRow) => {
        throw Object.assign(new Error('550 5.1.1 user unknown'), { stage: 'rcpt', replyCode: 550 });
      },
    };

    await ctx.pool.query(
      `CREATE OR REPLACE FUNCTION test_refuse_failed_stamp() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           RAISE EXCEPTION 'canceling statement due to statement timeout' USING ERRCODE = '57014';
         END $$;
       CREATE TRIGGER test_refuse_failed_stamp BEFORE UPDATE ON email_outbox
         FOR EACH ROW WHEN (NEW.status = 'failed')
         EXECUTE FUNCTION test_refuse_failed_stamp()`,
    );
    try {
      await runDueAutoEmails({ pool: ctx.pool, log: ctx.app.log, transport });

      // The stamp is gone, which is the blip: the row stays 'queued' and the
      // retry sweep owns it from here.
      expect(await outboxFor(only!)).toBe(1);
      const { rows } = await ctx.pool.query<{ status: string }>(
        'SELECT status FROM email_outbox WHERE valuation_id = $1',
        [only],
      );
      expect(rows[0]!.status).toBe('queued');
      // The suppression is not. A permanent rejection is a fact about the
      // mailbox and has to outlive this row's bookkeeping.
      expect(await isSuppressed(ctx.pool, owner.email)).not.toBeNull();
    } finally {
      await ctx.pool.query('DROP TRIGGER IF EXISTS test_refuse_failed_stamp ON email_outbox');
      await ctx.pool.query('DELETE FROM email_suppressions');
    }
  });
});
