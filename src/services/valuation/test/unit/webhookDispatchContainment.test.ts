import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import {
  firePartnerWebhooks,
  firePartnerWebhooksForRetirement,
  firePartnerWebhooksForTransition,
} from '../../src/hooks/partnerWebhooks.js';

/**
 * R273 (methodology M11) — a dispatch failure never reaches the caller.
 *
 * `firePartnerWebhooks` contains a failure *per hook*, on the stated ground
 * that "the receivers are independent subscribers to the same event, so one
 * partner's write failing must not decide whether the others hear about it".
 * What it did not contain was the read above the loop, or the two batch entry
 * points' own `SELECT`. Its note answered that by naming the caller —
 * `onStateChanged` "logs and swallows what escapes" — and two of the three
 * callers do no such thing:
 *
 *   - the retention sweep fires the retirement batch under a comment reading
 *     "never allowed to fail the sweep", which was true of `deliverToWebhook`
 *     and not of the lookup; a statement timeout took the sweep down after it
 *     had archived;
 *   - the manual-withdrawal route awaits it between `recordActions` and
 *     `audit`, so a throw answered the admin 500 for a retirement that had
 *     committed, and skipped `valuation_retired` on the way out.
 *
 * A pool that rejects every query is the whole fixture: the failure being
 * modelled is a busy pool or a statement timeout, and no webhook, transport or
 * delivery row is reached before it fires.
 */

function rejectingPool(): {
  pool: pg.Pool;
  log: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
} {
  const pool = {
    query: vi.fn(() =>
      Promise.reject(
        Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
      ),
    ),
  } as unknown as pg.Pool;
  return { pool, log: { warn: vi.fn(), error: vi.fn() } };
}

describe('a partner webhook dispatch cannot fail its caller (R273)', () => {
  it('absorbs a failed lookup on the transition entry point', async () => {
    const { pool, log } = rejectingPool();
    await expect(
      firePartnerWebhooksForTransition({ pool, log } as never, '01J0000000000000000000000X', 'drafted'),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('absorbs a failed lookup on the retirement entry point', async () => {
    const { pool, log } = rejectingPool();
    await expect(
      firePartnerWebhooksForRetirement({ pool, log } as never, ['01J0000000000000000000000X']),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('absorbs a failed read of the partner’s webhooks', async () => {
    const { pool, log } = rejectingPool();
    await expect(
      firePartnerWebhooks({ pool, log } as never, '01J00000000000000000000PTR', 'valuation.retired', null),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  /*
   * `logUnretried`, not `warn`. The event was owed, no delivery row exists to
   * carry it, and the retry sweep works from delivery rows — so the transience
   * of a statement timeout says nothing about whether the partner is ever
   * told. `retried: false` and `alert: true` are the fields that say so.
   */
  it('records the loss as a loss, not as a delay', async () => {
    const { pool, log } = rejectingPool();
    await firePartnerWebhooksForRetirement({ pool, log } as never, ['01J0000000000000000000000X']);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error.mock.calls[0]![0]).toMatchObject({
      retried: false,
      alert: true,
      failure_kind: 'transient',
    });
  });

  it('says nothing when there is nothing to announce', async () => {
    const { pool, log } = rejectingPool();
    await firePartnerWebhooksForRetirement({ pool, log } as never, []);
    expect(pool.query).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  /*
   * Per-hook dispatch: the webhook lookup succeeds but `deliverToWebhook`
   * throws before a delivery row is written. Same loss shape as the lookup
   * failure above — the partner is simply not told — so it must carry
   * `alert: true` through `logUnretried`.
   */
  it('records a per-hook dispatch failure as a loss (alert: true)', async () => {
    let calls = 0;
    const pool = {
      query: vi.fn(() => {
        calls += 1;
        // First query: enabledWebhooks — return one webhook row.
        if (calls === 1)
          return Promise.resolve({
            rows: [{ id: '01J0000000000000000000HOOK', partner_id: 'p', url: 'https://x.test/hook', secret: 'plain', events: [], enabled: true }],
          });
        // Everything after: the delivery path (recordDelivery INSERT) — fail.
        return Promise.reject(new Error('connection terminated unexpectedly'));
      }),
      connect: vi.fn(() => Promise.reject(new Error('no connections'))),
    } as unknown as pg.Pool;
    const log = { warn: vi.fn(), error: vi.fn() };

    await expect(
      firePartnerWebhooks(
        { pool, log } as never,
        '01J00000000000000000000PTR',
        'valuation.state_changed',
        { id: '01J00000000000000000000VAL', number: 1, kind: '409a', state: 'started', company_name: 'Co' },
      ),
    ).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalled();
    expect(log.error.mock.calls[0]![0]).toMatchObject({
      alert: true,
      retried: false,
    });
  });
});
