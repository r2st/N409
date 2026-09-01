import { describe, expect, it } from 'vitest';
import { BUCKET_COUNT, BUCKET_MS, ErrorRates, MAX_ROUTES } from '../src/errorRates.js';

/**
 * The error rate an operator can read during an incident.
 *
 * `createHttpMetrics` already records RED — into the OpenTelemetry API, which
 * without a collector is a no-op provider. That is the right home for the time
 * series and no help at all for "is this box throwing 500s right now", which
 * every other operational signal in the service answers over HTTP: the job
 * backlog, the webhook queue, the pool, the slow statements.
 *
 * Two properties carry the weight here and neither is about arithmetic. The
 * window has to actually slide, or the number becomes a lifetime average that
 * an incident cannot move. And the route map has to be bounded, because the
 * key it is built from is attacker-controlled.
 */

/** A clock the test moves, so a minute expiring does not take a minute. */
function fixedClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  return {
    now: () => now,
    advanceMinutes: (n: number) => {
      now += n * BUCKET_MS;
    },
  };
}

describe('counting outcomes', () => {
  it('separates client errors from server errors from successes', () => {
    // 4xx is the caller's problem and 5xx is ours; an endpoint that merged them
    // would show a validation-heavy client as an outage.
    const rates = new ErrorRates();
    rates.record({ route: '/api/v1/valuations', statusCode: 200 });
    rates.record({ route: '/api/v1/valuations', statusCode: 404 });
    rates.record({ route: '/api/v1/valuations', statusCode: 500 });

    const snap = rates.snapshot();
    expect(snap).toMatchObject({ requests: 3, client_errors: 1, server_errors: 1 });
    expect(snap.error_rate).toBeCloseTo(1 / 3);
  });

  it('reports a quiet window as 0% rather than NaN', () => {
    // NaN serializes to null, which a dashboard reads as "unknown" — the one
    // thing a healthy idle process must not look like.
    const snap = new ErrorRates().snapshot();
    expect(snap.error_rate).toBe(0);
    expect(snap.requests).toBe(0);
  });

  it('collapses id segments so one route is one key', () => {
    // Without this every valuation is its own route and the worst-routes list
    // is a list of ids.
    const rates = new ErrorRates();
    rates.record({ route: '/api/v1/valuations/01J0000000000000000000000A', statusCode: 500 });
    rates.record({ route: '/api/v1/valuations/01J0000000000000000000000B', statusCode: 500 });

    expect(rates.snapshot().worst_routes).toEqual([
      { route: '/api/v1/valuations/:id', requests: 2, server_errors: 2 },
    ]);
  });

  it('ranks the worst route first, breaking ties by volume', () => {
    const rates = new ErrorRates();
    rates.record({ route: '/a', statusCode: 500 });
    rates.record({ route: '/b', statusCode: 500 });
    rates.record({ route: '/b', statusCode: 500 });
    rates.record({ route: '/c', statusCode: 200 });
    rates.record({ route: '/c', statusCode: 200 });
    rates.record({ route: '/c', statusCode: 200 });

    const worst = rates.snapshot().worst_routes;
    expect(worst[0]).toEqual({ route: '/b', requests: 2, server_errors: 2 });
    expect(worst[1]).toEqual({ route: '/a', requests: 1, server_errors: 1 });
    // No errors, most traffic — last of the three.
    expect(worst[2]).toEqual({ route: '/c', requests: 3, server_errors: 0 });
  });
});

describe('the window slides', () => {
  it('drops a minute once it falls out of the requested window', () => {
    const clock = fixedClock();
    const rates = new ErrorRates({ now: clock.now });
    rates.record({ route: '/a', statusCode: 500 });

    expect(rates.snapshot(5).server_errors).toBe(1);
    clock.advanceMinutes(5);
    // The minute holding it is now older than the five being asked for.
    expect(rates.snapshot(5).server_errors).toBe(0);
  });

  it('counts the minute in progress, so a burst is visible while it happens', () => {
    // Waiting for a minute to close before showing its errors would put a
    // 60-second delay on the one number an incident is watched through.
    const clock = fixedClock();
    const rates = new ErrorRates({ now: clock.now });
    rates.record({ route: '/a', statusCode: 500 });
    expect(rates.snapshot(1).server_errors).toBe(1);
  });

  it('does not let an hour-old minute contribute when the ring wraps onto it', () => {
    // The bug this shape exists to avoid: bucket N is reused every hour, so
    // without comparing its start time the window silently becomes cumulative
    // and an incident can never move the number back down.
    const clock = fixedClock();
    const rates = new ErrorRates({ now: clock.now });
    rates.record({ route: '/a', statusCode: 500 });

    clock.advanceMinutes(BUCKET_COUNT);
    rates.record({ route: '/a', statusCode: 200 });

    const snap = rates.snapshot();
    expect(snap.requests).toBe(1);
    expect(snap.server_errors).toBe(0);
  });

  it('never reports more than the ring holds, whatever is asked for', () => {
    const clock = fixedClock();
    const rates = new ErrorRates({ now: clock.now });
    const writes = BUCKET_COUNT * 2;
    for (let i = 0; i < writes; i += 1) {
      rates.record({ route: '/a', statusCode: 500 });
      // Not after the last one: the window includes the minute in progress, and
      // leaving it empty would make this assert 59 for a reason that has
      // nothing to do with the ring's size.
      if (i < writes - 1) clock.advanceMinutes(1);
    }
    // A caller asking for a day gets the hour that exists, labelled honestly.
    const snap = rates.snapshot(60 * 24);
    expect(snap.window_minutes).toBe(BUCKET_COUNT);
    expect(snap.requests).toBe(BUCKET_COUNT);
  });
});

describe('cardinality is bounded, because the key is not ours', () => {
  it('keeps totals exact once attribution stops', () => {
    // The scanner case. `routeOptions` is undefined when nothing matched, so
    // the raw path is what gets recorded: /wp-admin, /.env, /phpmyadmin, all
    // day, every one a distinct key. Losing attribution is the right thing to
    // lose — during a flood the interesting fact is that there is a flood.
    const rates = new ErrorRates();
    const extra = 25;
    for (let i = 0; i < MAX_ROUTES + extra; i += 1) {
      rates.record({ route: `/scanner-path-${i}`, statusCode: 404 });
    }

    const snap = rates.snapshot();
    expect(snap.requests).toBe(MAX_ROUTES + extra);
    expect(snap.client_errors).toBe(MAX_ROUTES + extra);
    expect(snap.routes_truncated).toBe(true);
  });

  it('does not grow the map past the cap', () => {
    const rates = new ErrorRates();
    for (let i = 0; i < MAX_ROUTES * 4; i += 1) {
      rates.record({ route: `/p${i}`, statusCode: 404 });
    }
    // Ten is the report's own limit; the cap is what stops the map behind it.
    expect(rates.snapshot().worst_routes).toHaveLength(10);
  });

  it('keeps counting a route it already knows after the cap is reached', () => {
    // The cap must not turn into "the 51st request to a known route is lost".
    const rates = new ErrorRates();
    rates.record({ route: '/known', statusCode: 500 });
    for (let i = 0; i < MAX_ROUTES * 2; i += 1) {
      rates.record({ route: `/junk${i}`, statusCode: 404 });
    }
    rates.record({ route: '/known', statusCode: 500 });

    const known = rates.snapshot().worst_routes.find((r) => r.route === '/known');
    expect(known).toEqual({ route: '/known', requests: 2, server_errors: 2 });
  });

  it('reports untruncated when nothing was dropped', () => {
    const rates = new ErrorRates();
    rates.record({ route: '/a', statusCode: 200 });
    expect(rates.snapshot().routes_truncated).toBe(false);
  });

  it('stops reporting truncation once the minute that caused it has slid out', () => {
    // The flag was a process-lifetime latch inside a sliding window: one
    // scanner burst set it and nothing ever cleared it, so every snapshot for
    // the rest of the process's life described its `worst_routes` as
    // incomplete. That is the wrong direction to be wrong in — the caveat is
    // there to tell an operator mid incident that the route they are hunting
    // may be missing from the list, and one that is always on is one nobody
    // reads by the time it is true.
    let now = 0;
    const rates = new ErrorRates({ now: () => now });
    for (let i = 0; i < MAX_ROUTES + 5; i += 1) {
      rates.record({ route: `/scanner-${i}`, statusCode: 404 });
    }
    expect(rates.snapshot().routes_truncated).toBe(true);

    // A quiet minute later, asked about that minute alone.
    now += BUCKET_MS;
    rates.record({ route: '/a', statusCode: 200 });
    expect(rates.snapshot(1).routes_truncated).toBe(false);
    // The hour still contains the burst, so the wide window still says so.
    expect(rates.snapshot().routes_truncated).toBe(true);

    // And once the ring has wrapped past it, nothing does.
    now += BUCKET_MS * BUCKET_COUNT;
    rates.record({ route: '/a', statusCode: 200 });
    expect(rates.snapshot().routes_truncated).toBe(false);
  });

  it('attributes again in a fresh minute rather than staying capped', () => {
    // The other half of the same latch: the cap is per bucket, so a minute
    // after a burst starts with an empty route map and full attribution.
    let now = 0;
    const rates = new ErrorRates({ now: () => now });
    for (let i = 0; i < MAX_ROUTES * 2; i += 1) {
      rates.record({ route: `/junk-${i}`, statusCode: 404 });
    }
    now += BUCKET_MS;
    rates.record({ route: '/real', statusCode: 500 });
    expect(rates.snapshot(1).worst_routes).toEqual([{ route: '/real', requests: 1, server_errors: 1 }]);
  });
});
