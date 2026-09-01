import { useEffect, useRef } from 'react';

/**
 * Re-ask a question on a timer, but only while somebody is looking.
 *
 * ## Why the timer stops (R338, methodology M8)
 *
 * `setInterval` does not know about tabs. Every poll in this app kept firing at
 * full rate in a window that had been behind another one since lunch, and the
 * two surfaces that poll are the two most likely to be left open:
 *
 *   * the navigation badges (`useBadgePoll`) — three endpoints, once a minute,
 *     mounted on every authenticated page;
 *   * the job monitor (`AdminJobsPage`) — three endpoints, every fifteen
 *     seconds, the screen an operator deliberately parks on a second monitor.
 *
 * A single backgrounded job-monitor tab is 5,760 requests over an eight-hour
 * day, and the cost is not the JSON: `routes/inbox.ts` put TTL caches behind
 * these endpoints precisely because the query was the cheap part, and each
 * request still costs a JWT verification, the `findAuthPrincipal` join every
 * authenticated route makes, a rate-limit charge against the caller, and an
 * access-log line. `BADGE_MIN_REFETCH_MS` is the same fix applied to the
 * navigation storm; this is the same fix applied to the clock.
 *
 * Stopping is only half of it, and the wrong half on its own: a reader who
 * comes back to a tab is looking at figures as old as the time they were away.
 * So returning to the tab polls immediately when the interval has already
 * elapsed, which it almost always has — the reader gets fresher data on return
 * than the timer would have given them, from strictly fewer requests.
 *
 * `tick` is read through a ref, so a call site may pass a fresh closure every
 * render (they all do — it is the same `load` the Refresh button calls) without
 * restarting the clock. That is a behaviour change worth stating: the interval
 * used to reset on every filter change, so a user changing filters faster than
 * the period never saw a poll at all.
 *
 * Not used for the payment-return poll in `PaymentRedirectPages`: that one is
 * waiting on a webhook while the reader is very likely on the *provider's* tab,
 * which is exactly the case this hook would stall.
 */
export function usePoll(tick: () => void, intervalMs: number, enabled = true): void {
  const latest = useRef(tick);
  latest.current = tick;
  const lastRunAt = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    // The caller loads on mount; the clock starts from that, not from zero, so
    // hiding and showing a tab in the first second does not force a re-ask.
    lastRunAt.current = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;

    const run = () => {
      lastRunAt.current = Date.now();
      latest.current();
    };
    const start = () => {
      if (timer === undefined) timer = setInterval(run, intervalMs);
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stop();
        return;
      }
      if (Date.now() - lastRunAt.current >= intervalMs) run();
      start();
    };

    // `visibilityState` is absent in no browser this app supports, but it is
    // absent in some test environments; an undefined state is treated as
    // visible, so the hook degrades to the plain interval it replaces.
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, intervalMs]);
}
