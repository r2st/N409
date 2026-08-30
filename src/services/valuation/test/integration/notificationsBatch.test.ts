import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createNotification, createNotifications, listNotifications } from '../../src/repos/notifications.js';

const dbUp = await isDbAvailable();

/**
 * The group fan-out, written once instead of once per recipient.
 *
 * Several callers alert a *role* rather than a person — the billing admins on a
 * chargeback, the ops roles on a stalled queue — and each was issuing one
 * INSERT per recipient inside a loop. The recipient list comes from a role
 * lookup, so it grows with the team, and the loops sit on paths with somewhere
 * better to spend their latency: a Stripe webhook running against a redelivery
 * deadline, an alert tick that fires every five minutes.
 *
 * What these pin is that the batched form is not merely faster but writes the
 * same rows — same recipients, same content, same order, and the same behaviour
 * for the empty list, which is the case a naive `unnest` gets wrong by issuing
 * a query that inserts nothing.
 */
describe.skipIf(!dbUp)('notifications — batched fan-out', () => {
  let ctx: TestApp;
  let pool: pg.Pool;
  let recipients: Array<{ id: string; email: string }>;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    pool = ctx.pool;
    recipients = [];
    for (let i = 0; i < 4; i++) {
      recipients.push(await seedUser(ctx, { roles: ['reviewer'] }));
    }
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('writes one row per recipient, in one query', async () => {
    const spy = vi.spyOn(pool, 'query');
    try {
      const rows = await createNotifications(
        pool,
        recipients.map((r) => ({
          userId: r.id,
          type: 'job_alert',
          title: 'Queue looks stalled',
          body: 'The email queue has not drained in an hour.',
        })),
      );
      expect(rows).toHaveLength(recipients.length);
      // Four recipients, one round trip. The loop it replaced made four.
      expect(spy.mock.calls).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }

    for (const r of recipients) {
      const mine = await listNotifications(pool, r.id);
      expect(mine.map((n) => n.title)).toContain('Queue looks stalled');
    }
  });

  it('returns the rows in the order they were asked for', async () => {
    // Callers pair a returned row with the recipient it was written for, and
    // RETURNING order is not promised by the standard however reliably a single
    // INSERT happens to preserve it.
    const rows = await createNotifications(
      pool,
      recipients.map((r, i) => ({ userId: r.id, type: 'ordering', title: `n${i}` })),
    );
    expect(rows.map((n) => n.user_id)).toEqual(recipients.map((r) => r.id));
    expect(rows.map((n) => n.title)).toEqual(recipients.map((_, i) => `n${i}`));
  });

  it('issues no query at all for an empty list', async () => {
    const spy = vi.spyOn(pool, 'query');
    try {
      expect(await createNotifications(pool, [])).toEqual([]);
      expect(spy.mock.calls).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('writes the same row the single-insert form does', async () => {
    const user = recipients[0]!;
    const input = {
      userId: user.id,
      valuationId: null,
      type: 'payment_disputed',
      title: 'Chargeback opened',
      body: 'Submit evidence in Stripe before the response deadline.',
    };
    const single = await createNotification(pool, input);
    const [batched] = await createNotifications(pool, [input]);

    expect(batched).toBeTruthy();
    for (const key of ['user_id', 'valuation_id', 'type', 'title', 'body', 'link', 'read_at'] as const) {
      expect(batched![key]).toEqual(single[key]);
    }
    // Distinct rows with distinct ids, not one row written twice.
    expect(batched!.id).not.toBe(single.id);
  });

  /**
   * The link column (migration 0188) goes through the same `unnest`, and it is
   * the one whose value is a navigation in the reader's browser. Both forms
   * pass it through `appPath`, so a caller cannot store a destination outside
   * the application by choosing the batched insert.
   */
  it('stores an app path and drops anything that leaves the app', async () => {
    const [good] = await createNotifications(pool, [
      { userId: recipients[2]!.id, type: 'subscription_canceled', title: 'Ended', link: '/billing' },
    ]);
    expect(good!.link).toBe('/billing');

    const [bad] = await createNotifications(pool, [
      { userId: recipients[2]!.id, type: 'subscription_canceled', title: 'Ended', link: '//evil.example' },
    ]);
    expect(bad!.link).toBeNull();
  });

  it('carries a null body and a null valuation through unchanged', async () => {
    // `unnest` over a text[] holding nulls is the shape that silently turns a
    // missing body into the string "null" if the arrays are built carelessly.
    const [row] = await createNotifications(pool, [
      { userId: recipients[1]!.id, type: 'no_body', title: 'Title only' },
    ]);
    expect(row!.body).toBeNull();
    expect(row!.valuation_id).toBeNull();
    expect(row!.link).toBeNull();
  });
});
