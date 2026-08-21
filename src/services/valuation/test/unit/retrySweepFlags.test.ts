import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { retryFailedEmails } from '../../src/hooks/emailRetry.js';
import { retryDueDeliveries } from '../../src/hooks/partnerWebhooks.js';
import { retryFailedPipelineRuns } from '../../src/hooks/pipelineRetry.js';

/**
 * FLAG_RETRY_LADDERS against the three *persisted* ladders — the email outbox
 * (0159), partner webhook deliveries (0103) and pipeline runs (0161).
 *
 * The assertion in every "off" case is that the pool is never touched. That is
 * a stronger claim than "no work was done" and it is the one that matters: each
 * of these sweeps begins by *claiming* rows, and a claim is a write. It spends
 * an attempt from a bounded ladder, takes a lease, and — for pipeline runs —
 * moves the row to an active status that holds the one-per-valuation index. A
 * sweep that claimed and then declined to act would quietly burn the backlog's
 * retry budget while the flag was off, so that turning it back on would find
 * rows with nothing left to spend. Never issuing the query is what makes this
 * switch a pause rather than a slow loss.
 *
 * The pool below therefore throws on any query, which means these tests need no
 * database — and would fail loudly if the gate were ever moved below the claim.
 */

/** A pool that fails the test if anything asks it for anything. */
const hostilePool = {
  query: () => {
    throw new Error('the sweep queried the database while FLAG_RETRY_LADDERS was off');
  },
  connect: () => {
    throw new Error('the sweep took a connection while FLAG_RETRY_LADDERS was off');
  },
} as unknown as pg.Pool;

const transport = { send: vi.fn(async () => ({ ok: true })) } as never;

beforeEach(() => {
  process.env.FLAG_RETRY_LADDERS = 'off';
});

afterEach(() => {
  delete process.env.FLAG_RETRY_LADDERS;
  vi.restoreAllMocks();
});

describe('FLAG_RETRY_LADDERS off — the email outbox sweep', () => {
  it('claims nothing, so no row spends an attempt', async () => {
    await expect(retryFailedEmails({ pool: hostilePool, transport })).resolves.toEqual({
      attempted: 0,
      sent: 0,
    });
  });

  it('is gated inside the driver, not at the interval', async () => {
    // The sweep is reachable from the timer, from the ops retry route, and from
    // any future caller. A kill switch wired only to the timer would leave the
    // operator's manual "retry now" button running the thing they just stopped.
    await expect(
      retryFailedEmails({ pool: hostilePool, transport, maxAttempts: 99, limit: 500 }),
    ).resolves.toEqual({ attempted: 0, sent: 0 });
  });
});

describe('FLAG_RETRY_LADDERS off — the partner webhook sweep', () => {
  it('claims nothing, so a pending delivery keeps its backoff', async () => {
    await expect(
      retryDueDeliveries({ pool: hostilePool, log: undefined } as never),
      // `reaped` is behind the same flag: a row it would settle has no attempts
      // left either way, so waiting loses nothing, and while the ladders are
      // paused "still pending" is the honest reading of every unsettled row.
    ).resolves.toEqual({ attempted: 0, delivered: 0, retrying: 0, failed: 0, reaped: 0 });
  });
});

describe('FLAG_RETRY_LADDERS off — the pipeline retry sweep', () => {
  it('claims nothing, so no run is moved to an active status', async () => {
    // The most consequential of the three: claiming moves a run to active, and
    // an active run holds the one-per-valuation index — so a claim the flag
    // then declined to act on would block new triggers for that valuation until
    // the stale reaper came round.
    await expect(retryFailedPipelineRuns({ pool: hostilePool, autoPipeline: {} as never })).resolves.toEqual({
      claimed: 0,
      resumed: 0,
    });
  });
});

describe('the default is still to retry', () => {
  // Proven by reaching the database rather than by a return value: with the
  // flag unset the gate must fall through to the claim, and the hostile pool
  // turns "fell through" into an observable event. If a future edit made the
  // default off, these would start passing silently — so they assert the throw.
  beforeEach(() => {
    delete process.env.FLAG_RETRY_LADDERS;
  });

  it('the email sweep reaches its claim', async () => {
    await expect(retryFailedEmails({ pool: hostilePool, transport })).rejects.toThrow(/the sweep/);
  });

  it('the webhook sweep reaches its claim', async () => {
    await expect(retryDueDeliveries({ pool: hostilePool, log: undefined } as never)).rejects.toThrow(
      /the sweep/,
    );
  });

  it('the pipeline sweep reaches its claim', async () => {
    await expect(retryFailedPipelineRuns({ pool: hostilePool, autoPipeline: {} as never })).rejects.toThrow(
      /the sweep/,
    );
  });

  it('an empty value is unset, not off', async () => {
    // The shape .env.example ships.
    process.env.FLAG_RETRY_LADDERS = '';
    await expect(retryFailedEmails({ pool: hostilePool, transport })).rejects.toThrow(/the sweep/);
  });

  it('an unreadable value falls back to retrying', async () => {
    process.env.FLAG_RETRY_LADDERS = 'disable';
    await expect(retryFailedEmails({ pool: hostilePool, transport })).rejects.toThrow(/the sweep/);
  });
});
