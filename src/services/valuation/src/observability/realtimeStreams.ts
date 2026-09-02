import type { Counter, MetricsRegistry } from '@n409/shared';
import type { CapacityScope } from '../realtime/hub.js';

/**
 * What the realtime hub is turning away, and which of its three ceilings did it.
 *
 * WHY THIS EXISTS (R369, methodology M11). `realtime_streams_open` has been
 * registered since the hub was built and is the only instrument this subsystem
 * has. It reports `hub.stats().total` — one number against `maxTotal`, which
 * is 1024 — and it is the *last* of the three ceilings a caller meets. The
 * defaults are `maxPerUser: 12`, `maxPerRoom: 64`, `maxTotal: 1024`, so the
 * ordinary way a person is refused a stream is a per-user ceiling reached at
 * **twelve** open connections, with the gauge that would have said so reading
 * 12 out of 1024. Nothing is wrong with that gauge; it is answering a different
 * question, and on its own it says the subsystem is 1% busy at the moment
 * somebody cannot open a valuation.
 *
 * The refusal itself left nothing at all. `capacityFor` computes exactly which
 * ceiling was met, `stream.ts` discards that value, and the route answers
 * `problems.tooManyRequests(...)` — one 429, no log line, no event row, counted
 * in `http_requests_total`'s 4xx class beside every rate-limited request on the
 * estate. `scimRequests.ts` states the fact that makes it invisible: there is
 * no 4xx rule on this box at all. So a room that fills, a client stuck in a
 * reconnect loop against its own ceiling, or a process that has accumulated a
 * thousand leaked sockets all present identically — as nothing.
 *
 * A LEAK IS THE CASE THAT MATTERS. Every SSE connection is a held socket, a
 * heartbeat timer and a room entry that lives until the client goes away, and
 * `hub.ts` says why nothing else bounds them: "a caller allowed N new requests
 * a minute can accumulate connections for as long as it keeps them open".
 * `leave` runs from the heartbeat's failed-write teardown, so a connection
 * whose peer vanished without a FIN — a laptop lid, a NAT timeout, a proxy that
 * drops silently — is held until the next heartbeat write fails. If that
 * teardown ever stops firing, the count climbs monotonically and the first
 * symptom is every user on the box being refused, at once, permanently, with
 * `maxTotal` reached. That is the shape a saturation gauge is supposed to catch
 * on the way up, and it can only do so if something reads it.
 *
 * DELIBERATELY LABELLED BY SCOPE AND NOTHING ELSE, the choice
 * `apiTokenAuth.ts` and `scimRequests.ts` both make: one series per ceiling,
 * with the user and the valuation on the log line where an operator reads them.
 * `CapacityScope` itself rather than a second spelling of it, so a fourth
 * ceiling added to the hub fails to compile here until it is given a home.
 */
let refusals: Counter | null = null;

/**
 * The ceilings, exported as a gauge so a rule can compute a ratio.
 *
 * `hub.ts` holds them as a module constant that a deployment may override, so
 * the number an alert would have to hardcode is not reliably the number in
 * force. `DiskFillingUp` gives the argument for a ratio over an absolute — "a
 * thousand streams left is a different situation under one ceiling and another,
 * and the ceiling is raised without anybody remembering this file" — and it is
 * the same argument here.
 *
 * Registered on the same `scope` label values as the counter, so the two join.
 */
export function registerRealtimeStreamMetrics(
  registry: MetricsRegistry,
  ceilings: () => Readonly<Record<CapacityScope, number>>,
): void {
  refusals = registry.counter(
    'realtime_stream_refusals_total',
    'Realtime SSE connections refused at a hub ceiling, by which ceiling. scope="total" is the process-wide limit and means every user on this box is being refused; the 429 that says so is invisible in the HTTP metrics.',
    ['scope'],
  );
  registry.gauge(
    'realtime_stream_capacity',
    'The hub ceiling in force for each scope, so the open-stream gauge can be read as a ratio',
    () => {
      const limits = ceilings();
      return (Object.keys(limits) as CapacityScope[]).map((scope) => ({
        value: limits[scope],
        labels: { scope },
      }));
    },
    ['scope'],
  );
}

/** Test seam: drops the instrument so one suite's counts cannot leak into another. */
export function resetRealtimeStreamMetrics(): void {
  refusals = null;
}

/** A logger shaped like the one every route handler already holds. */
interface StreamLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Counts one refused join and, for the ceilings that are shared, says who ran
 * into it.
 *
 * `user` is counted and not logged, for the reason `apiTokenAuth.ts` leaves
 * `unknown` unlogged: a single caller exceeding a per-caller ceiling is the
 * ceiling working, the caller is told (429 with a `Retry-After`), and a client
 * in a reconnect loop must not get to choose how much this box writes to the
 * journal. The *rate* of it is still a signal even when no single one is, which
 * is exactly what a counter is for.
 *
 * `room` and `total` are logged, because both are one caller's behaviour
 * denying somebody else: a full room turns away the next person to open that
 * valuation, and a full process turns away everyone. Both are bounded by how
 * often a ceiling is actually met, which on this estate's traffic is rare
 * enough to be worth a line each.
 *
 * No `alert: true`: the alerting channel here is the scrape, and a hand-stamped
 * flag on a line nothing consumes is the shape R155 found six copies of.
 */
export function refuseRealtimeStream(
  log: StreamLogger,
  scope: CapacityScope,
  who: { userId: string; valuationId: string },
): void {
  refusals?.inc({ scope });
  if (scope === 'user') return;
  log.warn(
    {
      source: 'realtime',
      scope,
      // Neither is a metric label and both are what the operator needs: `room`
      // is remedied by looking at one valuation, and there is no way to find
      // out which one from a counter. The correlation mixin's own spellings
      // (`logger.ts`), not a second pair, so a filter for one valuation's
      // trouble finds this line too.
      valuationId: who.valuationId,
      actorUserId: who.userId,
    },
    REFUSAL_LOG[scope],
  );
}

/**
 * One line each, written for the person reading it at the point the alert
 * fires, and saying what is now impossible rather than what was refused — the
 * ceiling is the `scope` field beside it.
 */
const REFUSAL_LOG: Record<Exclude<CapacityScope, 'user'>, string> = {
  room: 'realtime stream refused: this valuation has as many open streams as the hub will hold, so the next person to open it is turned away too',
  total:
    'realtime stream refused: the process-wide stream ceiling is met, so every user on this box is being refused — check realtime_streams_open for a count that is not coming down',
};
