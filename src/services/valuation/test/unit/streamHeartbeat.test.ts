import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startHeartbeat } from '../../src/routes/stream.js';

/**
 * The heartbeat was the one writer to a hijacked SSE socket that did not guard
 * its write. `ValuationHub.broadcast` has always wrapped the identical call,
 * because an `error` emitted on a response with no listener is thrown — and
 * from a timer callback that is an uncaughtException, which
 * `installCrashHandlers` turns into a process exit. So a single client whose
 * socket died between the last tick and its own `close` event could take the
 * valuation service down.
 */

describe('startHeartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pings on the interval for as long as the socket accepts writes', () => {
    const write = vi.fn();
    const leave = vi.fn();
    startHeartbeat({ intervalMs: 1000, write, onDead: () => {}, leave });

    vi.advanceTimersByTime(3000);

    expect(write).toHaveBeenCalledTimes(3);
    expect(leave).not.toHaveBeenCalled();
  });

  it('swallows a write to a dead socket instead of letting it reach the timer', () => {
    const write = vi.fn(() => {
      throw new Error('write after end');
    });
    const onDead = vi.fn();
    startHeartbeat({ intervalMs: 1000, write, onDead, leave: () => {} });

    // Unguarded, this is the throw that becomes an uncaughtException.
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(onDead.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it('stops pinging and releases the room entry after the first failed write', () => {
    const write = vi.fn(() => {
      throw new Error('ERR_STREAM_DESTROYED');
    });
    const leave = vi.fn();
    startHeartbeat({ intervalMs: 1000, write, onDead: () => {}, leave });

    vi.advanceTimersByTime(5000);

    // One attempt, not five: a dead socket is not worth pinging again.
    expect(write).toHaveBeenCalledTimes(1);
    // And the presence badge / per-user cap gets its slot back.
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('returns a stop that is safe to call after the heartbeat already gave up', () => {
    const write = vi.fn(() => {
      throw new Error('gone');
    });
    const leave = vi.fn();
    const stop = startHeartbeat({ intervalMs: 1000, write, onDead: () => {}, leave });

    vi.advanceTimersByTime(1000); // heartbeat tears itself down
    stop(); // …and then the socket's own close handler fires

    // `leave` is idempotent in the hub, but it must still be reached twice
    // rather than throw — the close handler runs regardless of what the ping did.
    expect(leave).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('stops the timer when the client disconnects first', () => {
    const write = vi.fn();
    const leave = vi.fn();
    const stop = startHeartbeat({ intervalMs: 1000, write, onDead: () => {}, leave });

    vi.advanceTimersByTime(1000);
    stop();
    vi.advanceTimersByTime(10_000);

    expect(write).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
