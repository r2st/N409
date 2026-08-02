import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { runDueAutoEmails } from '../../src/hooks/autoEmails.js';
import { createAutoEmail } from '../../src/repos/communications.js';
import { createValuation } from '../../src/repos/valuations.js';

const dbUp = await isDbAvailable();

/**
 * Every instant the drip scan compares against is written by Postgres:
 * `state_entered_at` is `valuation_events.occurred_at` or `valuations.created_at`
 * (both `DEFAULT now()`), and the prior send times are `auto_email_sends.sent_at`.
 * Reading `now` from this process instead measured those intervals against a
 * different clock, and the app server and the database are not required to be
 * the same machine — in the deployed setup they are separate containers.
 *
 * The skew does not have to be large to change what the scan does. It only has
 * to cross the delay boundary, and for a `delay_hours: 0` campaign that
 * boundary is zero: a database a few milliseconds ahead makes the interval
 * negative at the instant its own valuation was created, so the message is
 * skipped forever after — the campaign's own trigger row is already in the past
 * by the next pass, but the scan that would have caught it has moved on. These
 * cases push the process clock far enough either way that the wrong clock is
 * unambiguous rather than a race.
 */
describe.skipIf(!dbUp)('drip campaign scan clock', () => {
  let ctx: TestApp;
  let userId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    userId = (await seedUser(ctx, { roles: ['valuation_user'] })).id;
  });
  afterAll(async () => ctx?.teardown());

  beforeEach(async () => {
    await ctx.pool.query('DELETE FROM auto_emails');
    await ctx.pool.query('DELETE FROM email_outbox');
    await ctx.pool.query(`UPDATE valuations SET state = 'ignored'`);
  });

  // Only Date is faked: the pool's own timers must keep running, or a scan that
  // needs a fresh connection would hang instead of failing the assertion.
  afterEach(() => vi.useRealTimers());

  /** Moves this process's clock `ms` away from the database's, leaving the database alone. */
  async function skewProcessClock(ms: number) {
    const { rows } = await ctx.pool.query<{ now: Date }>('SELECT now() AS now');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(rows[0]!.now.getTime() + ms));
  }

  let seq = 0;
  async function seedCampaign(delayHours: number) {
    return createAutoEmail(ctx.pool, {
      name: `clock_${seq++}`,
      channel: 'email',
      trigger_state: 'pending',
      condition: 'always',
      delay_hours: delayHours,
      repeat_hours: null,
      max_sends: 1,
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

  it('sends a zero-delay campaign when the process clock lags the database', async () => {
    await seedCampaign(0);
    const valuation = await seedValuation('Lagging Clock Inc');

    // The database stamped created_at at real now; this process believes it is
    // five minutes earlier. Measured against the process clock the valuation
    // has been in `pending` for minus five minutes, which is short of a delay
    // of zero, and the campaign is skipped.
    await skewProcessClock(-5 * 60_000);
    const result = await runDueAutoEmails({ pool: ctx.pool });

    expect(result.queued).toBe(1);
    const { rows } = await ctx.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM email_outbox WHERE valuation_id = $1',
      [valuation.id],
    );
    expect(rows[0]!.count).toBe('1');
  });

  it('holds a delayed campaign when the process clock runs ahead of the database', async () => {
    await seedCampaign(1);
    const valuation = await seedValuation('Leading Clock Inc');

    // The other direction, and the one that reaches a client's inbox: a process
    // clock two hours fast makes a one-hour delay look served the moment the
    // valuation is created.
    await skewProcessClock(2 * 3_600_000);
    const result = await runDueAutoEmails({ pool: ctx.pool });

    expect(result.queued).toBe(0);
    const { rows } = await ctx.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM auto_email_sends WHERE valuation_id = $1',
      [valuation.id],
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('still honours an explicitly supplied now', async () => {
    // Callers that pass `now` — the domain tests, and any backfill — must keep
    // overriding the clock rather than being silently corrected to the
    // database's.
    await seedCampaign(24);
    await seedValuation('Explicit Clock Inc');

    const early = await runDueAutoEmails({ pool: ctx.pool, now: new Date('2000-01-01T00:00:00Z') });
    expect(early.queued).toBe(0);

    const late = await runDueAutoEmails({ pool: ctx.pool, now: new Date('2100-01-01T00:00:00Z') });
    expect(late.queued).toBe(1);
  });
});
