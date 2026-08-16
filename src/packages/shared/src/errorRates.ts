import { routeLabel, statusClass } from './metrics.js';

/**
 * Error rates an operator can read without a metrics backend.
 *
 * `createHttpMetrics` already records rate, errors and duration — into the
 * OpenTelemetry API, which without a collector wired is a no-op provider. That
 * is the right place for the real time series and the wrong place for the
 * question asked during an incident, which is "is this box throwing 500s right
 * now" and which currently has no answer reachable over HTTP. Every other
 * operational signal in this service is a queryable endpoint: the job backlog,
 * the webhook queue, the pool, the slow statements. Error rate was the gap.
 *
 * Process-local and reset on deploy, deliberately, matching `queryStats`. It
 * describes the build that is running now, which is the scope the question has
 * during an incident, and it makes a metrics backend an improvement rather than
 * a prerequisite.
 *
 * ## Bounded on purpose, in two directions
 *
 * **Time.** A ring of fixed buckets rather than a growing list, so the window
 * slides and memory does not depend on uptime.
 *
 * **Cardinality.** This is the one with an attacker on the other end of it. The
 * route recorded is `req.routeOptions?.url ?? req.url`, and `routeOptions` is
 * undefined precisely when nothing matched — so every 404 contributes its own
 * raw path. `routeLabel` collapses id-shaped segments, which handles
 * `/valuations/01J.../report` and does nothing at all for `/wp-admin`,
 * `/.env`, `/phpmyadmin` and the rest of what arrives at a public origin all
 * day. Unbounded keys driven by unmatched paths is a memory leak reachable from
 * the internet by anyone with a scanner, so a bucket attributes at most
 * {@link MAX_ROUTES} distinct routes and counts the rest in the totals only.
 * The totals stay exact; attribution is what degrades, which is the right thing
 * to lose — during a flood the interesting number is that there is a flood.
 */

/** Buckets in the ring, and the span of each. One hour at one-minute resolution. */
export const BUCKET_MS = 60_000;
export const BUCKET_COUNT = 60;

/** Distinct routes one bucket will attribute before it stops adding new ones. */
export const MAX_ROUTES = 50;

interface Bucket {
  /** Start of the minute this bucket covers; -1 when never written. */
  startMs: number;
  total: number;
  client: number;
  server: number;
  /** route -> [total, server]. Capped at {@link MAX_ROUTES}. */
  routes: Map<string, [number, number]>;
}

export interface RouteErrorRate {
  route: string;
  requests: number;
  server_errors: number;
}

export interface ErrorRateSnapshot {
  window_minutes: number;
  requests: number;
  client_errors: number;
  server_errors: number;
  /** Server errors as a fraction of requests; 0 when nothing was served. */
  error_rate: number;
  /** Worst routes by server errors, then by volume. At most 10. */
  worst_routes: RouteErrorRate[];
  /** True while some routes went unattributed — see the cardinality note. */
  routes_truncated: boolean;
}

const emptyBucket = (): Bucket => ({
  startMs: -1,
  total: 0,
  client: 0,
  server: 0,
  routes: new Map(),
});

/**
 * A sliding window of request outcomes.
 *
 * `now` is injectable because the alternative is a test that sleeps through a
 * real minute to see a bucket expire, and the expiry is the part most worth
 * testing.
 */
export class ErrorRates {
  private readonly buckets: Bucket[];
  private readonly now: () => number;
  private truncated = false;

  constructor(opts: { now?: () => number } = {}) {
    this.buckets = Array.from({ length: BUCKET_COUNT }, emptyBucket);
    this.now = opts.now ?? Date.now;
  }

  /**
   * The bucket covering `at`, cleared first if the ring has wrapped past it.
   *
   * The stale check is what makes this a *sliding* window rather than a
   * cumulative one: index 7 is reused every hour, and without comparing
   * `startMs` an hour-old minute would keep contributing forever.
   */
  private bucketAt(at: number): Bucket {
    const start = at - (at % BUCKET_MS);
    const bucket = this.buckets[Math.floor(start / BUCKET_MS) % BUCKET_COUNT]!;
    if (bucket.startMs !== start) {
      bucket.startMs = start;
      bucket.total = 0;
      bucket.client = 0;
      bucket.server = 0;
      bucket.routes.clear();
    }
    return bucket;
  }

  record(args: { route: string | undefined | null; statusCode: number }): void {
    const bucket = this.bucketAt(this.now());
    bucket.total += 1;
    const bucketClass = statusClass(args.statusCode);
    if (bucketClass === '4xx') bucket.client += 1;
    else if (bucketClass === '5xx') bucket.server += 1;

    const route = routeLabel(args.route);
    const existing = bucket.routes.get(route);
    if (existing) {
      existing[0] += 1;
      if (bucketClass === '5xx') existing[1] += 1;
      return;
    }
    // The cap. Totals above are already counted, so what is lost is only which
    // route a request belonged to — see the cardinality note at the top.
    if (bucket.routes.size >= MAX_ROUTES) {
      this.truncated = true;
      return;
    }
    bucket.routes.set(route, [1, bucketClass === '5xx' ? 1 : 0]);
  }

  /** The last `windowMinutes` (default: the whole ring), aggregated. */
  snapshot(windowMinutes = BUCKET_COUNT): ErrorRateSnapshot {
    const minutes = Math.min(Math.max(Math.floor(windowMinutes), 1), BUCKET_COUNT);
    const at = this.now();
    // Inclusive of the minute in progress, so a burst is visible while it is
    // happening rather than only once its minute has closed.
    const oldest = at - (at % BUCKET_MS) - (minutes - 1) * BUCKET_MS;

    let requests = 0;
    let client = 0;
    let server = 0;
    const routes = new Map<string, [number, number]>();
    for (const bucket of this.buckets) {
      if (bucket.startMs < oldest) continue;
      requests += bucket.total;
      client += bucket.client;
      server += bucket.server;
      for (const [route, [total, errors]] of bucket.routes) {
        const acc = routes.get(route);
        if (acc) {
          acc[0] += total;
          acc[1] += errors;
        } else {
          routes.set(route, [total, errors]);
        }
      }
    }

    const worst = [...routes.entries()]
      .map(([route, [reqs, errors]]) => ({ route, requests: reqs, server_errors: errors }))
      .sort((a, b) => b.server_errors - a.server_errors || b.requests - a.requests)
      .slice(0, 10);

    return {
      window_minutes: minutes,
      requests,
      client_errors: client,
      server_errors: server,
      // Guarded rather than left as NaN: a quiet minute is a 0% error rate, and
      // NaN in a JSON body is `null`, which reads as "unknown" to a dashboard.
      error_rate: requests === 0 ? 0 : server / requests,
      worst_routes: worst,
      routes_truncated: this.truncated,
    };
  }
}
