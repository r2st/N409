import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installGlobalCrashHandlers, reportCrash, resetCrashReports } from '../src/lib/crashReport';

/**
 * Before R313 a render crash went to `console.error` in the user's own
 * devtools and nowhere else — `ErrorBoundary.onError` had no call site, and
 * there were no global handlers at all. These pin the reporter's two jobs:
 * getting the report out, and not becoming the fault itself.
 */

function sentBodies(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.map(
    (call) => JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetCrashReports();
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetCrashReports();
});

describe('reportCrash', () => {
  it('files the error, the stack and where it happened', () => {
    const err = new TypeError('cannot read properties of undefined');
    reportCrash('render', err, '\n    at ValuationWorkspace');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/client-errors');
    // Survives the navigation that a crash is often followed by.
    expect((init as RequestInit).keepalive).toBe(true);
    const body = sentBodies(fetchMock)[0]!;
    expect(body).toMatchObject({
      kind: 'render',
      name: 'TypeError',
      message: 'cannot read properties of undefined',
      component_stack: '\n    at ValuationWorkspace',
    });
    expect(String(body.stack)).toContain('TypeError');
  });

  it('files one report for a component that throws on every render', () => {
    for (let i = 0; i < 25; i++) reportCrash('render', new Error('boom'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still stops after ten distinct errors, because that is a loop too', () => {
    for (let i = 0; i < 25; i++) reportCrash('render', new Error(`boom ${i}`));
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('describes a rejection that is not an Error, which has no stack to fall back on', () => {
    reportCrash('unhandled_rejection', { status: 502 });
    expect(sentBodies(fetchMock)[0]).toMatchObject({
      kind: 'unhandled_rejection',
      name: 'NonError',
      message: '{"status":502}',
    });
  });

  it('never files a blank message', () => {
    reportCrash('uncaught', undefined);
    expect(String(sentBodies(fetchMock)[0]!.message)).toBe('undefined');
  });

  it('cannot become the crash it is reporting', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('network stack is gone too');
      }),
    );
    expect(() => reportCrash('render', new Error('boom'))).not.toThrow();
  });

  it('sends no credentials — a crash report must not refresh a session', () => {
    reportCrash('render', new Error('boom'));
    expect((fetchMock.mock.calls[0]![1] as RequestInit).credentials).toBe('omit');
  });
});

describe('installGlobalCrashHandlers', () => {
  it('catches the throws a React boundary never sees', () => {
    const uninstall = installGlobalCrashHandlers(window);
    try {
      const swallow = (event: Event): void => event.preventDefault();
      window.addEventListener('error', swallow);
      window.dispatchEvent(
        new ErrorEvent('error', {
          error: new Error('from a timer'),
          message: 'from a timer',
          cancelable: true,
        }),
      );
      window.removeEventListener('error', swallow);
      expect(sentBodies(fetchMock)[0]).toMatchObject({ kind: 'uncaught', message: 'from a timer' });
    } finally {
      uninstall();
    }
  });

  it('stops listening once uninstalled', () => {
    installGlobalCrashHandlers(window)();
    // jsdom re-raises an unhandled `error` event as an uncaught exception, which
    // is exactly the behaviour under test — swallow it here so the assertion is
    // about the reporter rather than about the environment.
    const swallow = (event: Event): void => event.preventDefault();
    window.addEventListener('error', swallow);
    try {
      window.dispatchEvent(new ErrorEvent('error', { error: new Error('after'), cancelable: true }));
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('error', swallow);
    }
  });
});
