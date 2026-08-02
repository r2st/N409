import { describe, expect, it, vi } from 'vitest';
import { installShutdownHandlers, SHUTDOWN_FAILED_EXIT_CODE } from '../src/shutdown.js';

/**
 * A stand-in for `process` that records the handlers installed on it and lets a
 * test fire them, so the real process is never at risk of being exited.
 */
function fakeProcess() {
  const handlers = new Map<string, () => void>();
  const exits: number[] = [];
  const target = {
    on(event: string, handler: () => void) {
      handlers.set(event, handler);
      return target;
    },
    exit(code: number) {
      exits.push(code);
      return undefined as never;
    },
  } as unknown as Pick<NodeJS.Process, 'on' | 'exit'>;
  return { target, handlers, exits };
}

function fakeLog() {
  const info: { obj: Record<string, unknown>; msg: string }[] = [];
  const error: { obj: Record<string, unknown>; msg: string }[] = [];
  return {
    log: {
      info(obj: Record<string, unknown>, msg: string) {
        info.push({ obj, msg });
      },
      error(obj: Record<string, unknown>, msg: string) {
        error.push({ obj, msg });
      },
    },
    info,
    error,
  };
}

/** Lets the handler's async shutdown chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('installShutdownHandlers', () => {
  it('registers a handler for each signal', () => {
    const { target, handlers } = fakeProcess();
    installShutdownHandlers(fakeLog().log, {
      service: 'web',
      onShutdown: async () => {},
      target,
    });
    expect([...handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('runs the shutdown and exits zero when it completes', async () => {
    const { target, handlers, exits } = fakeProcess();
    const { log, info } = fakeLog();
    const onShutdown = vi.fn(async () => {});
    installShutdownHandlers(log, { service: 'report', onShutdown, target });

    handlers.get('SIGTERM')!();
    await settle();

    expect(onShutdown).toHaveBeenCalledOnce();
    expect(exits).toEqual([0]);
    expect(info[0]!.obj).toMatchObject({ signal: 'SIGTERM', service: 'report' });
    expect(info[0]!.msg).toBe('shutting down');
  });

  it('still exits when shutdown rejects, and says so', async () => {
    // The bug this replaces: `.then(() => process.exit(0))` never ran on a
    // rejection, so the process hung until the supervisor killed it — and the
    // stray rejection got logged as a crash rather than a restart.
    const { target, handlers, exits } = fakeProcess();
    const { log, error } = fakeLog();
    const boom = new Error('pool.end() failed');
    installShutdownHandlers(log, {
      service: 'valuation',
      onShutdown: async () => {
        throw boom;
      },
      target,
    });

    handlers.get('SIGTERM')!();
    await settle();

    expect(exits).toEqual([SHUTDOWN_FAILED_EXIT_CODE]);
    expect(error).toHaveLength(1);
    expect(error[0]!.obj).toMatchObject({ err: boom, service: 'valuation' });
    expect(error[0]!.msg).toContain('error during graceful shutdown');
  });

  it('exits on the deadline when shutdown never settles', async () => {
    // A connection pool with a stuck query, or a server waiting on an in-flight
    // request that never finishes. Without the deadline this is a 90-second
    // systemd timeout followed by SIGKILL, on every deploy.
    vi.useFakeTimers();
    try {
      const { target, handlers, exits } = fakeProcess();
      const { log, error } = fakeLog();
      installShutdownHandlers(log, {
        service: 'valuation',
        onShutdown: () => new Promise<void>(() => {}), // never settles
        graceMs: 5_000,
        target,
      });

      handlers.get('SIGTERM')!();
      expect(exits).toEqual([]); // still draining

      await vi.advanceTimersByTimeAsync(5_000);

      expect(exits).toEqual([SHUTDOWN_FAILED_EXIT_CODE]);
      expect(error[0]!.msg).toContain('exceeded its deadline');
      expect(error[0]!.obj).toMatchObject({ graceMs: 5_000, service: 'valuation' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not exit early when shutdown finishes just inside the deadline', async () => {
    vi.useFakeTimers();
    try {
      const { target, handlers, exits } = fakeProcess();
      installShutdownHandlers(fakeLog().log, {
        service: 'web',
        onShutdown: () => new Promise<void>((resolve) => setTimeout(resolve, 4_000)),
        graceMs: 5_000,
        target,
      });

      handlers.get('SIGTERM')!();
      await vi.advanceTimersByTimeAsync(4_000);

      expect(exits).toEqual([0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a repeat signal instead of starting a second shutdown', async () => {
    // Ctrl-C twice, or systemd escalating — the old inline handler would call
    // app.close() again on an already-closing server.
    const { target, handlers, exits } = fakeProcess();
    const { log, info } = fakeLog();
    let started = 0;
    installShutdownHandlers(log, {
      service: 'web',
      onShutdown: async () => {
        started += 1;
      },
      target,
    });

    handlers.get('SIGTERM')!();
    handlers.get('SIGINT')!();
    handlers.get('SIGTERM')!();
    await settle();

    expect(started).toBe(1);
    expect(exits).toEqual([0]);
    expect(info.filter((l) => l.msg.includes('ignoring repeat signal'))).toHaveLength(2);
  });

  it('defaults to a grace period well under systemd TimeoutStopSec', () => {
    // The whole point is to exit on our schedule rather than be SIGKILLed on
    // the supervisor's. systemd's default is 90s; if this default ever drifts
    // above it the deadline stops meaning anything.
    const { target, handlers } = fakeProcess();
    const { log, info } = fakeLog();
    installShutdownHandlers(log, { service: 'web', onShutdown: async () => {}, target });

    handlers.get('SIGTERM')!();

    expect(info[0]!.obj.graceMs).toBe(10_000);
    expect(info[0]!.obj.graceMs as number).toBeLessThan(90_000);
  });
});
