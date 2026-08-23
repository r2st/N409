import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startStreamRevalidation, type StreamAccess } from '../../src/realtime/streamAccess.js';

/**
 * The timer half of stream revocation. What it has to get right is not the
 * predicate — that is `authorizeStream`, exercised end to end against a real
 * database in the integration suite — but the three things a timer that fires
 * against a database for every open connection can get wrong: firing twice,
 * queueing behind itself, and treating a blip as a revocation.
 */
describe('startStreamRevalidation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const allow: StreamAccess = { ok: true, principal: { id: 'u1', roles: [], partnerId: null } };
  const deny = (reason: 'unauthorized' | 'forbidden'): StreamAccess => ({ ok: false, reason });

  it('leaves an authorized stream alone, however many ticks pass', async () => {
    const check = vi.fn(async () => allow);
    const onRevoked = vi.fn();
    const stop = startStreamRevalidation({
      intervalMs: 100,
      check,
      onRevoked,
      onError: () => {},
    });

    for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(100);
    expect(check).toHaveBeenCalledTimes(5);
    expect(onRevoked).not.toHaveBeenCalled();
    stop();
  });

  it('tears the stream down once, and stops checking, on the first refusal', async () => {
    const check = vi.fn(async () => deny('unauthorized'));
    const onRevoked = vi.fn();
    startStreamRevalidation({ intervalMs: 100, check, onRevoked, onError: () => {} });

    await vi.advanceTimersByTimeAsync(100);
    expect(onRevoked).toHaveBeenCalledExactlyOnceWith('unauthorized');

    // The interval is cleared by the refusal, so nothing runs behind it — a
    // second onRevoked would end an already-ended response.
    await vi.advanceTimersByTimeAsync(1000);
    expect(check).toHaveBeenCalledTimes(1);
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });

  it('passes the reason through, so the frame the client is sent says which', async () => {
    const onRevoked = vi.fn();
    startStreamRevalidation({
      intervalMs: 100,
      check: async () => deny('forbidden'),
      onRevoked,
      onError: () => {},
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(onRevoked).toHaveBeenCalledExactlyOnceWith('forbidden');
  });

  /**
   * A check slower than its own interval must skip the beat, not stack. Every
   * open stream on the process runs one of these, so a database slow enough to
   * outlast the interval would otherwise have each connection queueing a second
   * query behind the first — the load answering the slowness with more of it.
   */
  it('skips a tick rather than queueing a second check behind a slow one', async () => {
    let release: (() => void) | undefined;
    const check = vi.fn(
      () =>
        new Promise<StreamAccess>((resolve) => {
          release = () => resolve(allow);
        }),
    );
    startStreamRevalidation({ intervalMs: 100, check, onRevoked: () => {}, onError: () => {} });

    await vi.advanceTimersByTimeAsync(100);
    expect(check).toHaveBeenCalledTimes(1);
    // Three more beats pass while the first is still in flight.
    await vi.advanceTimersByTimeAsync(300);
    expect(check).toHaveBeenCalledTimes(1);

    release?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(check).toHaveBeenCalledTimes(2);
  });

  /**
   * Fails open. A revocation one minute late is a far smaller harm than every
   * stream on the platform closing on a transient error and reconnecting into
   * the database that just failed them.
   */
  it('keeps the stream, and keeps checking, when the check throws', async () => {
    const onError = vi.fn();
    const onRevoked = vi.fn();
    let calls = 0;
    const check = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) throw new Error('connection terminated unexpectedly');
      return deny('unauthorized');
    });
    startStreamRevalidation({ intervalMs: 100, check, onRevoked, onError });

    await vi.advanceTimersByTimeAsync(200);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onRevoked).not.toHaveBeenCalled();

    // Still running: the revocation on the next healthy tick is still caught.
    await vi.advanceTimersByTimeAsync(100);
    expect(onRevoked).toHaveBeenCalledExactlyOnceWith('unauthorized');
  });

  it('stops on teardown, so a closed socket is not still being checked', async () => {
    const check = vi.fn(async () => allow);
    const stop = startStreamRevalidation({
      intervalMs: 100,
      check,
      onRevoked: () => {},
      onError: () => {},
    });
    await vi.advanceTimersByTimeAsync(100);
    stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(check).toHaveBeenCalledTimes(1);
  });

  /**
   * The teardown and a refusal can race — a client closing the tab in the same
   * tick the check comes back denied. Neither may fire `onRevoked` after the
   * other has run.
   */
  it('does not revoke a stream that was torn down while its check was in flight', async () => {
    let release: ((a: StreamAccess) => void) | undefined;
    const onRevoked = vi.fn();
    const stop = startStreamRevalidation({
      intervalMs: 100,
      check: () => new Promise<StreamAccess>((resolve) => (release = resolve)),
      onRevoked,
      onError: () => {},
    });
    await vi.advanceTimersByTimeAsync(100);
    stop();
    release?.(deny('forbidden'));
    await vi.advanceTimersByTimeAsync(100);
    expect(onRevoked).not.toHaveBeenCalled();
  });
});
