/**
 * Tell the server when the browser breaks.
 *
 * `ErrorBoundary` has offered an `onError` hook since the F-1 audit and its
 * docstring promises the error is "reported via onError rather than lost". No
 * call site ever passed one, so every render crash went to `console.error` in
 * the user's own devtools — and there were no `window.onerror` or
 * `unhandledrejection` handlers either. A release that blanks one route for
 * every user produced an access log full of 200s (the shell and the bundle both
 * served fine), an unchanged server error rate, and nothing else. The first
 * report arrived from a client, by email.
 *
 * The receiving end is `POST /api/v1/client-errors` on the valuation service,
 * reached through the same-origin `/api` proxy. It counts and logs; nothing is
 * stored.
 *
 * ## This is not analytics and is deliberately not behind consent
 *
 * No cookie is set, no identifier is minted or read, and nothing is shared with
 * a third party — the report goes to the first-party origin that just served
 * the page. It is the operational record of a fault in the service, which is
 * the one category the consent banner does not gate (see `lib/consent`). What
 * would need gating is *attributing* a crash to a person, and this deliberately
 * cannot: the body carries the error, the path and the bundle, and no
 * identifier of any kind.
 *
 * ## Why it caps itself
 *
 * A component that throws on every render throws on every retry too, and React
 * remounts a boundary's children when its parent re-renders. Left alone this
 * would be an unbounded loop of beacons from a tab nobody is watching. So the
 * client is bounded twice — a per-load ceiling and a duplicate filter — and the
 * server is bounded again by a per-address throttle it counts refusals against,
 * because a bound the client sets is a bound an attacker does not have.
 */

const ENDPOINT = '/api/v1/client-errors';

/** Which door the error came through; matches the server's enum. */
export type CrashKind = 'render' | 'uncaught' | 'unhandled_rejection';

/**
 * The most one page load will file.
 *
 * Ten rather than one: a single fault often surfaces as a handful of distinct
 * errors (the throw, the rejection it leaves behind, the chunk that then fails
 * to load), and the second and third are frequently the ones that name the
 * cause. Past ten it is a loop, and a loop is fully described by its first
 * report.
 */
const MAX_REPORTS_PER_LOAD = 10;

/** Server-side caps, applied here too so a long stack is trimmed, not refused. */
const MAX_MESSAGE = 500;
const MAX_STACK = 4_000;
const MAX_URL = 500;

let filed = 0;
const seen = new Set<string>();

/** The subset of `import.meta.env` this module reads — see vite.config.ts. */
interface CrashReportEnv {
  VITE_BUILD_SHA?: string;
}

/** The bundle this tab is running, so a stale tab is distinguishable. */
const RELEASE = ((import.meta.env as CrashReportEnv).VITE_BUILD_SHA ?? '').trim();

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * A stable identity for "the same crash again".
 *
 * The first stack frame rather than the whole stack: the same fault reached
 * through two different routes produces two stacks that differ only in their
 * tails, and filing both says nothing the first did not.
 */
function fingerprint(kind: CrashKind, name: string, message: string, stack: string): string {
  return `${kind}|${name}|${message}|${stack.split('\n')[1] ?? ''}`;
}

/** Whatever was thrown, as the two strings a report is made of. */
function describe(error: unknown): { name: string; message: string; stack: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? '' };
  }
  // A non-Error rejection is common and is exactly the case with no stack to
  // fall back on, so the value itself has to carry the whole report.
  let message: string;
  try {
    message = typeof error === 'string' ? error : JSON.stringify(error);
  } catch {
    message = Object.prototype.toString.call(error);
  }
  // An empty message is the one shape that makes a report worthless: a
  // cross-origin script error arrives as `ErrorEvent` with no `error` and the
  // fixed string "Script error.", and a rejection with `undefined` stringifies
  // to nothing at all. Say which, rather than filing a blank.
  return { name: 'NonError', message: message || String(error), stack: '' };
}

/** Test seam: forget this load's ceiling and duplicate filter. */
export function resetCrashReports(): void {
  filed = 0;
  seen.clear();
}

/**
 * File one crash. Never throws, never rejects, and never blocks a render.
 *
 * `keepalive` because the most interesting crash is the one on the way out —
 * a throw during an unload or a route change would otherwise have its request
 * cancelled with the document.
 */
export function reportCrash(kind: CrashKind, error: unknown, componentStack?: string): void {
  try {
    if (filed >= MAX_REPORTS_PER_LOAD) return;
    const { name, message, stack } = describe(error);
    const key = fingerprint(kind, name, message, stack);
    if (seen.has(key)) return;
    seen.add(key);
    filed += 1;

    const body: Record<string, string> = {
      kind,
      name: truncate(name, 100),
      message: truncate(message, MAX_MESSAGE),
    };
    if (stack) body.stack = truncate(stack, MAX_STACK);
    if (componentStack) body.component_stack = truncate(componentStack, MAX_STACK);
    if (RELEASE) body.release = truncate(RELEASE, 100);
    // Path and search only. The origin is this one, and a fragment is never
    // sent to a server by anything else on this page either.
    body.url = truncate(window.location.pathname + window.location.search, MAX_URL);

    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
      // No cookie needed and none wanted: the route is unauthenticated, and a
      // crash report should not be the thing that refreshes a session.
      credentials: 'omit',
    }).catch(() => {
      /* the network is the other thing that might be broken */
    });
  } catch {
    /* reporting a crash must never be the cause of one */
  }
}

/**
 * Catch the throws that never reach a React boundary.
 *
 * A boundary sees render, lifecycle and effect errors. It does not see a throw
 * from an event handler, a `setTimeout`, or a promise nobody awaited — which is
 * most of the interesting ones in an app whose work is asynchronous.
 *
 * Returns its own uninstaller so a test can take it back off.
 */
export function installGlobalCrashHandlers(target: Window = window): () => void {
  const onError = (event: ErrorEvent): void => {
    reportCrash('uncaught', event.error ?? event.message);
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    reportCrash('unhandled_rejection', event.reason);
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}
