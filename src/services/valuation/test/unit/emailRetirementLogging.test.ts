import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { retryFailedEmails } from '../../src/hooks/emailRetry.js';

/**
 * R273 (methodology M11) — the retirement sweep's own failure, classified.
 *
 * R272 gave a 'queued' row that reached the attempt ceiling the ending the
 * ladder gives everything else, and wrapped the retirement in a `catch` so it
 * could not cost the batch. That catch logged at a fixed `error`, which is
 * wrong in both directions: a busy pool is not worth waking anybody for, and a
 * broken statement carried no `alert: true` and so matched no rule. The claim
 * immediately below it is *not* caught, so it reaches `scheduler.ts` and gets
 * classified — the arm that existed to protect the batch took the
 * classification with it.
 *
 * A rejecting pool is the fixture: the two failures being modelled are a
 * statement timeout and a statement that no longer parses, and neither reaches
 * a transport.
 */

function poolThatRejects(err: Error): pg.Pool {
  return { query: vi.fn(() => Promise.reject(err)) } as unknown as pg.Pool;
}

const logger = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() });

describe('the stranded-outbox retirement reports its own failure (R273)', () => {
  it('is a warning when the database was merely busy — the next tick runs it again', async () => {
    const log = logger();
    const busy = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    // No transports, so the claim below the retirement never queries: the only
    // failure this run can have is the one being asserted.
    await expect(retryFailedEmails({ pool: poolThatRejects(busy), log: log as never })).resolves.toEqual({
      attempted: 0,
      sent: 0,
    });
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toMatchObject({ failure_kind: 'transient' });
  });

  it('alerts when nothing but a person will fix it', async () => {
    const log = logger();
    const broken = Object.assign(new Error('column "claimed_at" does not exist'), { code: '42703' });
    await expect(retryFailedEmails({ pool: poolThatRejects(broken), log: log as never })).resolves.toEqual({
      attempted: 0,
      sent: 0,
    });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]![0]).toMatchObject({ alert: true, failure_kind: 'permanent' });
  });
});
