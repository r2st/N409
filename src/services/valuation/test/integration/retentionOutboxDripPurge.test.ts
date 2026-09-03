import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { purgeExpiredOutbox } from '../../src/repos/retention.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/** The policy age the sweep is run under here. */
const RETENTION_DAYS = 90;

/**
 * A drip campaign's mail must not be able to wedge the outbox purge.
 *
 * `auto_email_sends` is append-only — it is the ledger the campaign scanner
 * reads to honour `max_sends` and `repeat_hours` — and its `outbox_id` pointed
 * at `email_outbox` under a NO ACTION foreign key (0051). So the first drip
 * message to age past the retention policy made `purgeExpiredOutbox` raise a
 * foreign-key violation, and since the DELETE takes the *oldest* eligible batch
 * the same rows came back every pass: the purge stopped for good, the backlog
 * grew without limit, and the retention policy stopped being enforced for
 * everything behind it.
 *
 * 0206 makes the reference `ON DELETE SET NULL`, which is the reading the two
 * outbox children written twelve migrations later were given: the message can
 * go, the record that the campaign fired cannot.
 */
describe.skipIf(!dbUp)('retention: purging a drip campaign message', () => {
  let ctx: TestDb;
  let pool: pg.Pool;

  beforeAll(async () => {
    ctx = await setupTestDb();
    pool = ctx.pool;
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('deletes the message and keeps the send record, with its pointer cleared', async () => {
    const userId = newUlid();
    const valuationId = newUlid();
    await pool.query(
      `INSERT INTO users (id, email, password_digest) VALUES ($1, 'drip.owner@example.com', 'x')`,
      [userId],
    );
    await pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id, currency)
       VALUES ($1, '409a', 'DripPurge Co', $2, 'USD')`,
      [valuationId, userId],
    );

    const campaignId = newUlid();
    await pool.query(
      `INSERT INTO auto_emails (id, name, trigger_state, template_key)
       VALUES ($1, 'drip_purge_probe', 'started', 'valuation_started')`,
      [campaignId],
    );

    // Settled and well past the policy — eligible on every conjunct of
    // `purgeExpiredOutbox`'s own predicate.
    const outboxId = newUlid();
    await pool.query(
      `INSERT INTO email_outbox (id, template_key, to_email, subject, body, status, created_at)
       VALUES ($1, 'valuation_started', 'drip.owner@example.com', 's', 'b', 'sent',
               now() - ($2 || ' days')::interval)`,
      [outboxId, String(RETENTION_DAYS * 4)],
    );
    const sendId = newUlid();
    await pool.query(
      `INSERT INTO auto_email_sends (id, auto_email_id, valuation_id, outbox_id)
       VALUES ($1, $2, $3, $4)`,
      [sendId, campaignId, valuationId, outboxId],
    );

    // Before 0206 this threw 23503 and took the sweep's whole transaction with
    // it — the held count, the delete and the retention action log.
    const { ids } = await purgeExpiredOutbox(pool, RETENTION_DAYS, 100);
    expect(ids).toContain(outboxId);

    const { rows: gone } = await pool.query('SELECT 1 FROM email_outbox WHERE id = $1', [outboxId]);
    expect(gone).toHaveLength(0);

    // The ledger row survives, or the campaign re-arms and the client is
    // drip-mailed a second time about work that started a year ago.
    const { rows: ledger } = await pool.query<{ outbox_id: string | null; auto_email_id: string }>(
      'SELECT outbox_id, auto_email_id FROM auto_email_sends WHERE id = $1',
      [sendId],
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.auto_email_id).toBe(campaignId);
    expect(ledger[0]!.outbox_id).toBeNull();
  });
});
