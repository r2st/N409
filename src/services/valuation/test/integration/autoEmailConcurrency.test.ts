import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { runDueAutoEmails } from '../../src/hooks/autoEmails.js';
import { createAutoEmail } from '../../src/repos/communications.js';
import { createValuation } from '../../src/repos/valuations.js';
import type { EmailTransport } from '../../src/hooks/stateChange.js';

const dbUp = await isDbAvailable();

/**
 * The drip-campaign scan (§15.6) is the sibling of the retry sweep fixed in
 * 0095, and it reached the outbox the same unguarded way. There are the same
 * three ways to get two scanners running at once — the interval in index.ts and
 * the ops-facing POST /admin/auto-emails/run are the same function, an ops
 * double-click fires it twice, and a deployment can run more than one instance
 * against this database — and the scan decides whether to send by counting
 * auto_email_sends rows that the other scanner has not written yet.
 *
 * A campaign with max_sends = 1 that sends twice is the whole point of
 * max_sends failing, and it fails toward the client's inbox.
 */
describe.skipIf(!dbUp)('drip campaign scan claiming', () => {
  let ctx: TestApp;
  let userId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    userId = (await seedUser(ctx, { roles: ['valuation_user'] })).id;
    // The pool opens connections lazily, and a cold connect costs more than a
    // whole scan takes: the first scanner would finish before the second was
    // even connected, hiding the exact interleaving these cases exist to pin
    // down. Warming the pool makes "concurrent" in a test mean concurrent at
    // the database.
    const warm = await Promise.all(Array.from({ length: 5 }, () => ctx.pool.connect()));
    for (const client of warm) client.release();
  });
  afterAll(async () => ctx?.teardown());

  // Each case reasons about which candidates a scan picks up, so nothing a
  // previous case created may still be due — valuations included, or a later
  // case's campaign fires for the earlier cases' companies too.
  beforeEach(async () => {
    await ctx.pool.query('DELETE FROM auto_emails');
    await ctx.pool.query('DELETE FROM email_outbox');
    // valuation_events is append-only, so the valuations themselves cannot be
    // deleted between cases. Parking them in 'ignored' takes them out of every
    // campaign's trigger state, which is all these cases need.
    await ctx.pool.query(`UPDATE valuations SET state = 'ignored'`);
  });

  let seq = 0;
  /** A campaign that is due the moment a valuation exists in `pending`. */
  async function seedCampaign(overrides: { maxSends?: number; repeatHours?: number | null } = {}) {
    return createAutoEmail(ctx.pool, {
      name: `drip_${seq++}`,
      channel: 'email',
      trigger_state: 'pending',
      condition: 'always',
      delay_hours: 0,
      repeat_hours: overrides.repeatHours ?? null,
      max_sends: overrides.maxSends ?? 1,
      template_key: 'valuation_started',
      enabled: true,
    });
  }

  async function seedValuation(companyName: string) {
    return createValuation(
      ctx.pool,
      { kind: '409a', companyName, userId },
      { actorType: 'human', actorId: userId },
    );
  }

  /** Records every delivery so duplicates are visible at the transport, not just in the DB. */
  function recordingTransport(): { transport: EmailTransport; delivered: string[] } {
    const delivered: string[] = [];
    return {
      delivered,
      transport: {
        async send(e) {
          delivered.push(e.to_email);
        },
      },
    };
  }

  it('queues and delivers one message per campaign when scans overlap', async () => {
    await seedCampaign({ maxSends: 1 });
    const valuation = await seedValuation('Overlap Inc');
    const scanners = Array.from({ length: 4 }, () => recordingTransport());

    // Every scan reaches its candidate query before any of them writes a send
    // record — the window the unguarded scan left open.
    const results = await Promise.all(
      scanners.map((s) => runDueAutoEmails({ pool: ctx.pool, transport: s.transport })),
    );

    const { rows } = await ctx.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM email_outbox WHERE valuation_id = $1',
      [valuation.id],
    );
    expect(Number(rows[0]!.count)).toBe(1);
    expect(results.reduce((n, r) => n + r.queued, 0)).toBe(1);
    expect(scanners.flatMap((s) => s.delivered)).toHaveLength(1);
  });

  it('never exceeds max_sends across overlapping scans', async () => {
    await seedCampaign({ maxSends: 2, repeatHours: null });
    const valuation = await seedValuation('Cap Inc');

    // Four scanners at once: whatever the interleaving, a one-shot campaign
    // (repeat_hours null) owes this valuation exactly one message.
    await Promise.all(Array.from({ length: 4 }, () => runDueAutoEmails({ pool: ctx.pool })));

    const { rows } = await ctx.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM auto_email_sends WHERE valuation_id = $1',
      [valuation.id],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('still sends to every due valuation, not just the first', async () => {
    // The serialisation must not turn into "one message per scan" — a scan
    // covers the whole backlog.
    await seedCampaign({ maxSends: 1 });
    await seedValuation('First Inc');
    await seedValuation('Second Inc');
    await seedValuation('Third Inc');

    const result = await runDueAutoEmails({ pool: ctx.pool });
    expect(result.queued).toBe(3);
  });

  it('records the send and the outbox row together or not at all', async () => {
    // The scan claims not to double-send across a crash because the send record
    // is written before delivery. That only holds if the outbox row and the
    // send record land atomically: a crash between them leaves a queued message
    // the retry sweep will still deliver, with no record to stop the next scan
    // re-queueing it.
    await seedCampaign({ maxSends: 1 });
    const valuation = await seedValuation('Atomic Inc');
    await runDueAutoEmails({ pool: ctx.pool });

    const { rows } = await ctx.pool.query<{ outbox: string; sends: string }>(
      `SELECT (SELECT count(*)::text FROM email_outbox WHERE valuation_id = $1) AS outbox,
              (SELECT count(*)::text FROM auto_email_sends WHERE valuation_id = $1) AS sends`,
      [valuation.id],
    );
    expect(rows[0]!.outbox).toBe(rows[0]!.sends);

    // And the record points at the row it was written with.
    const { rows: linked } = await ctx.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM auto_email_sends s
       JOIN email_outbox o ON o.id = s.outbox_id
       WHERE s.valuation_id = $1`,
      [valuation.id],
    );
    expect(linked[0]!.count).toBe('1');
  });
});
