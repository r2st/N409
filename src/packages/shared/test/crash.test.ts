import { describe, expect, it, vi } from 'vitest';
import { installCrashHandlers } from '../src/crash.js';

/**
 * A stand-in for `process` that records the handlers installed on it and lets a
 * test fire them, so the real process is never at risk of being exited.
 */
function fakeProcess() {
  const handlers = new Map<string, (arg: unknown) => void>();
  const exits: number[] = [];
  const target = {
    on(event: string, handler: (arg: unknown) => void) {
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
  const calls: { obj: Record<string, unknown>; msg: string }[] = [];
  return {
    log: {
      fatal(obj: Record<string, unknown>, msg: string) {
        calls.push({ obj, msg });
      },
    },
    calls,
  };
}

/** Lets the handler's async shutdown chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('installCrashHandlers', () => {
  it('registers both process-level handlers', () => {
    const { target, handlers } = fakeProcess();
    installCrashHandlers(fakeLog().log, { service: 'valuation', target });
    expect([...handlers.keys()].sort()).toEqual(['uncaughtException', 'unhandledRejection']);
  });

  it('logs an uncaught exception through pino and exits non-zero', async () => {
    const { target, handlers, exits } = fakeProcess();
    const { log, calls } = fakeLog();
    installCrashHandlers(log, { service: 'valuation', target });

    const boom = new Error('kaboom');
    handlers.get('uncaughtException')!(boom);
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.obj).toMatchObject({ err: boom, event: 'uncaughtException', service: 'valuation' });
    expect(calls[0]!.msg).toContain('uncaughtException');
    expect(exits).toEqual([1]);
  });

  it('logs an unhandled rejection and exits', async () => {
    const { target, handlers, exits } = fakeProcess();
    const { log, calls } = fakeLog();
    installCrashHandlers(log, { service: 'web', target });

    handlers.get('unhandledRejection')!(new Error('dangling'));
    await settle();

    expect(calls[0]!.obj).toMatchObject({ event: 'unhandledRejection', service: 'web' });
    expect(exits).toEqual([1]);
  });

  it('logs a non-Error rejection reason as-is', async () => {
    const { target, handlers } = fakeProcess();
    const { log, calls } = fakeLog();
    installCrashHandlers(log, { service: 'report', target });

    handlers.get('unhandledRejection')!('just a string');
    await settle();

    expect(calls[0]!.obj.err).toBe('just a string');
  });

  it('runs the shutdown hook before exiting', async () => {
    const { target, handlers, exits } = fakeProcess();
    const order: string[] = [];
    installCrashHandlers(fakeLog().log, {
      service: 'report',
      target,
      onShutdown: async () => {
        order.push('shutdown');
      },
    });

    handlers.get('uncaughtException')!(new Error('x'));
    await settle();

    expect(order).toEqual(['shutdown']);
    expect(exits).toEqual([1]);
  });

  it('still exits when the shutdown hook rejects', async () => {
    const { target, handlers, exits } = fakeProcess();
    installCrashHandlers(fakeLog().log, {
      service: 'web',
      target,
      onShutdown: () => Promise.reject(new Error('close failed')),
    });

    handlers.get('uncaughtException')!(new Error('x'));
    await settle();

    expect(exits).toEqual([1]);
  });

  it('exits even when the shutdown hook never settles', async () => {
    vi.useFakeTimers();
    try {
      const { target, handlers, exits } = fakeProcess();
      installCrashHandlers(fakeLog().log, {
        service: 'valuation',
        target,
        flushMs: 50,
        onShutdown: () => new Promise<void>(() => {}),
      });

      handlers.get('uncaughtException')!(new Error('wedged'));
      await vi.advanceTimersByTimeAsync(60);

      expect(exits).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a second crash while already shutting down', async () => {
    const { target, handlers, exits } = fakeProcess();
    const { log, calls } = fakeLog();
    installCrashHandlers(log, { service: 'web', target });

    handlers.get('uncaughtException')!(new Error('first'));
    handlers.get('unhandledRejection')!(new Error('second'));
    await settle();

    expect(calls).toHaveLength(1);
    expect(exits).toEqual([1]);
  });

  it('honours a custom exit code', async () => {
    const { target, handlers, exits } = fakeProcess();
    installCrashHandlers(fakeLog().log, { service: 'web', target, exitCode: 70 });

    handlers.get('uncaughtException')!(new Error('x'));
    await settle();

    expect(exits).toEqual([70]);
  });
});
