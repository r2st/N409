import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { onStateChanged } from '../../src/hooks/stateChange.js';

/**
 * R425, methodology M11 — a notification failure that nothing retries must
 * carry `alert: true` so `log_alert_lines_total` counts it and
 * `PermanentFailuresLogged` fires.
 *
 * `onStateChanged` catches failures from `deliverTransitionMessages` so the
 * caller answers honestly about the transition that already committed. Before
 * R425 the catch used a bare `deps.log?.error(...)` which logged the loss but
 * did not carry `alert: true`, so the metric that decides whether a ticket
 * fires never moved. `logUnretried` is the contract for exactly this shape:
 * fire-and-forget work that fails, where nothing revisits it.
 */
describe('state change notification failure carries alert: true (R425)', () => {
  it('logs with alert: true when the notification path throws', async () => {
    const pool = {
      query: vi.fn(() => Promise.reject(new Error('connection terminated unexpectedly'))),
      connect: vi.fn(() => Promise.reject(new Error('no connections'))),
    } as unknown as pg.Pool;
    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

    // A non-partner valuation, so the webhook arm is skipped and only the
    // notification arm runs — and fails on the first query it makes.
    const valuation = {
      id: '01J0000000000000000000000X',
      kind: '409a',
      company_name: 'AlertTestCo',
      user_id: '01J000000000000000000USR01',
      assigned_reviewer_id: null,
    };

    await expect(onStateChanged({ pool, log } as never, valuation, 'started')).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalled();
    expect(log.error.mock.calls[0]![0]).toMatchObject({
      alert: true,
      retried: false,
    });
  });
});
