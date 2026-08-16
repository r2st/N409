import type { FastifyInstance, FastifyRequest } from 'fastify';
import { buildInfo } from './build.js';
import { TtlCache } from './cache.js';
import { INTERNAL_TOKEN_HEADER, internalToken, internalTokenMatches } from './internalAuth.js';
import { scrubSensitive } from './problem.js';

export type ReadinessCheck = () => Promise<void>;

/** What a check reports to a caller that has not proved it is one of ours. */
export const CHECK_OK = 'ok';
export const CHECK_FAILED = 'failed';

/**
 * How long a readiness result is reused. Short enough that a probe still
 * reflects the estate within one interval of any load balancer or `deploy.sh`
 * wait loop, long enough that a burst costs one fan-out rather than one per
 * request — see the coalescing note on {@link registerHealth}.
 */
export const READY_CACHE_MS = 1000;

/**
 * How long one dependency check may take before it is called failed.
 *
 * Every check registered here was written to be fast and most carry their own
 * bound, but "most" is the problem: the fan-out has no ceiling of its own, so
 * `/ready` was as slow as the slowest thing anyone had ever added to it. The
 * bounds that do exist are also larger than they look. `probeReady` stops at
 * 3s, but the Postgres check is `pool.query('SELECT 1')`, whose worst case is
 * `connectionTimeoutMillis` waiting for a connection (10s) and then
 * `statement_timeout` running the query (15s) — twenty-five seconds during
 * which the endpoint answers nothing at all.
 *
 * Answering nothing is worse than answering 503, and not by a little. A load
 * balancer that gets a 503 takes the instance out immediately; one that gets a
 * hung socket waits for its own timeout, and until then keeps routing real
 * traffic to a process that has just said it cannot serve it. The coalescing
 * cache widens that: probes join the in-flight run rather than starting their
 * own, so one stuck check hangs *every* concurrent prober, and the failure
 * presents as an unresponsive endpoint rather than an unhealthy one.
 *
 * 5s is the default because it is comfortably above every check's normal cost
 * (a loopback `/ready` and a `SELECT 1` are single-digit milliseconds) and
 * comfortably below the shortest timeout on the other side of it — `deploy.sh`
 * waits 10s per poll. A check that has not answered in five seconds is not
 * about to answer usefully; the dependency is down, which is the thing being
 * asked.
 */
export const CHECK_TIMEOUT_MS = 5000;

/** How a timed-out check reads in the operator detail. Never public. */
export function checkTimedOut(ms: number): string {
  return `timed out after ${ms}ms`;
}

/**
 * `check` with a deadline.
 *
 * A promise cannot be cancelled, so the losing check keeps running after the
 * race is decided. Two consequences are handled rather than tolerated: its
 * eventual rejection is swallowed (it would otherwise surface as an unhandled
 * rejection, and `crash.ts` treats those as fatal), and the timer is cleared on
 * the winning path so a fast check does not hold a 5s handle open — which, on a
 * process trying to exit, is 5s of shutdown that nothing is waiting for.
 */
export async function withTimeout<T>(
  check: () => Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return check();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = check();
  // Attached before the race so a rejection arriving after the deadline has a
  // handler already in place; `started` is still what the race awaits, so a
  // real failure is not swallowed on the path that matters.
  started.catch(() => {});
  try {
    return await Promise.race([
      started,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One computed readiness run. `detail` is the operator view; never public. */
interface ReadinessSnapshot {
  healthy: boolean;
  /** name -> 'ok', or the scrubbed reason the check threw. */
  detail: Record<string, string>;
}

/** The same snapshot with every failure flattened to `failed`. */
function publicChecks(detail: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(detail).map(([name, status]) => [name, status === CHECK_OK ? CHECK_OK : CHECK_FAILED]),
  );
}

/**
 * True when the caller presented the estate's internal shared secret.
 *
 * Deliberately not "true when no secret is configured": that is the rule
 * {@link registerInternalAuth} uses for *route access*, where an unset secret
 * has to mean "open" or every developer machine breaks. Here the fallback runs
 * the other way, because the thing being gated is disclosure rather than
 * access, and an installation that has not configured a secret is exactly the
 * one least able to afford leaking its topology. With no secret set nobody is
 * authorized, `/ready` still answers with a correct status and per-check
 * pass/fail, and the reasons are in the log — which on a developer machine is
 * the terminal the service is running in.
 */
function isInternalCaller(req: FastifyRequest): boolean {
  const expected = internalToken();
  if (expected === null) return false;
  const provided = req.headers[INTERNAL_TOKEN_HEADER];
  return internalTokenMatches(Array.isArray(provided) ? provided[0] : provided, expected);
}

export interface HealthLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Health endpoints (issue #4): /health = liveness, /ready = readiness with
 * dependency checks (e.g. SELECT 1 against Postgres).
 *
 * /health also reports the commit that was built (see build.ts) so "which code
 * is live" is answerable without SSH — `dist/` is gitignored and built on the
 * server, so a skipped build used to be invisible from outside.
 *
 * Two properties of `/ready` are load-bearing and neither is obvious from the
 * endpoint's shape, so both are spelled out here.
 *
 * **It does not say why.** A failing check used to put the thrown message
 * straight into the response body, and `/ready` on the web service is served
 * unauthenticated from the public origin (infra/caddy) — so the body was a
 * description of the inside of the estate, published on request. It was not a
 * theoretical description either: `probeReady` names the upstream it could not
 * reach, so a restart of the valuation service answered the internet with
 * `valuation unreachable at http://127.0.0.1:3001/ready: ECONNREFUSED`, and a
 * Postgres outage answered with whatever libpq put in the error — which for the
 * common failures names the host, the database, and the role. The public body
 * now carries the check names and pass/fail, which is everything a load
 * balancer acts on; the reason goes to the log, and into the body only for a
 * caller holding the internal token, which is how an operator on the box still
 * gets it in one curl.
 *
 * **It coalesces.** Each probe fans out to every dependency — on the web
 * service, three internal HTTP calls plus a query against a pool deliberately
 * sized `max: 1` so a probe can never queue behind real work. That makes an
 * unauthenticated endpoint that turns one cheap request into four expensive
 * ones, against the single connection readiness itself depends on: enough
 * concurrent probes and the checks start failing on pool contention, `/ready`
 * goes red, and the load balancer pulls a healthy instance. Results are
 * therefore shared for {@link READY_CACHE_MS} through a single-flight cache, so
 * concurrent probes join one run and a flood costs one fan-out per second.
 */
export function registerHealth(
  app: FastifyInstance,
  opts: {
    service: string;
    version?: string;
    checks?: Record<string, ReadinessCheck>;
    /** Set false when the service serves its own / (e.g. the web SPA). */
    rootRoute?: boolean;
    /** Coalescing window; 0 disables it. Defaults to {@link READY_CACHE_MS}. */
    readyCacheMs?: number;
    /**
     * Deadline applied to every check. Defaults to {@link CHECK_TIMEOUT_MS};
     * 0 or a non-finite value disables the bound, which is what a test that
     * drives the clock itself wants and nothing in production does.
     */
    checkTimeoutMs?: number;
    /**
     * Per-check overrides, by the same name the check is registered under. For
     * the one dependency that is legitimately slower than the rest rather than
     * for tuning the whole endpoint down to its slowest member.
     */
    checkTimeoutsMs?: Record<string, number>;
  },
): void {
  const startedAt = Date.now();
  const build = buildInfo();
  const cacheMs = opts.readyCacheMs ?? READY_CACHE_MS;
  const defaultTimeoutMs = opts.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  const timeoutFor = (name: string): number => opts.checkTimeoutsMs?.[name] ?? defaultTimeoutMs;
  // One key: readiness is a property of the process, not of the request.
  const cache = new TtlCache<ReadinessSnapshot>({ ttlMs: cacheMs, maxEntries: 1 });

  if (opts.rootRoute !== false) {
    app.get('/', async () => ({
      service: opts.service,
      version: opts.version ?? '0.1.0',
      status: 'ok',
      endpoints: ['/health', '/ready'],
    }));
  }

  app.get('/health', async (_req, reply) => {
    // An intermediary that caches liveness answers `ok` for a process that has
    // since died, which is the one answer this endpoint must never give.
    void reply.header('cache-control', 'no-store');
    return {
      status: 'ok',
      service: opts.service,
      version: opts.version ?? '0.1.0',
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      // 'unknown' when the deploy recorded no provenance — reported rather than
      // omitted, so a deploy that skipped the step is visible instead of silent.
      build_sha: build.sha,
      build_sha_source: build.source,
    };
  });

  /**
   * Runs every check once. Never rejects: a failed dependency is a result, and
   * a rejection here would be uncacheable and would reach the error handler as
   * a 500, which is not what "not ready" means to a load balancer.
   */
  const runChecks = async (log: HealthLogger): Promise<ReadinessSnapshot> => {
    const entries = Object.entries(opts.checks ?? {});
    // Checks are independent and mostly network-bound, so run them concurrently:
    // in series, /ready cost the sum of every upstream's timeout.
    const settled = await Promise.all(
      entries.map(async ([name, check]) => {
        const ms = timeoutFor(name);
        try {
          // Bounded here rather than inside each check, so a dependency added
          // later cannot widen the endpoint by forgetting to carry one.
          await withTimeout(check, ms, () => new Error(checkTimedOut(ms)));
          return [name, CHECK_OK] as const;
        } catch (err) {
          // Scrubbed for the reason problem.ts scrubs the 5xx log line: a
          // connection failure names the DSN, password included, and pino's
          // `redact` paths only reach structured fields.
          const reason = err instanceof Error ? err.message : 'failed';
          return [name, scrubSensitive(reason) || CHECK_FAILED] as const;
        }
      }),
    );
    const detail = Object.fromEntries(settled) as Record<string, string>;
    const healthy = settled.every(([, status]) => status === CHECK_OK);
    if (!healthy) {
      // Logged here rather than per request, so a flood of probes against a
      // sick estate does not also flood the log: this runs once per fan-out.
      log.warn({ service: opts.service, checks: detail }, 'readiness check failed — reporting unavailable');
    }
    return { healthy, detail };
  };

  app.get('/ready', async (req, reply) => {
    const snapshot =
      cacheMs > 0 ? await cache.getOrLoad('ready', () => runChecks(req.log)) : await runChecks(req.log);
    void reply.header('cache-control', 'no-store');
    return reply.status(snapshot.healthy ? 200 : 503).send({
      status: snapshot.healthy ? 'ready' : 'unavailable',
      checks: isInternalCaller(req) ? snapshot.detail : publicChecks(snapshot.detail),
      build_sha: build.sha,
    });
  });
}

/**
 * Readiness probe for a sibling service's `/ready`, shared by every service that
 * fronts another one.  Throws with a short, human-readable reason naming the
 * upstream it could not reach — which reaches the log and the token-authenticated
 * body, but not the public one (see {@link registerHealth}).
 *
 * Deliberately short-timeout, unretried and without body parsing: a readiness
 * check must answer fast and must never become a way to hang /ready. An upstream
 * 503 is honoured — a downstream that knows it is broken makes its callers
 * not-ready too, which is the whole point of probing past `SELECT 1`.
 */
export async function probeReady(
  service: string,
  baseUrl: string,
  opts: {
    timeoutMs?: number;
    fetchFn?: typeof fetch;
    headers?: Record<string, string>;
    /** Path to probe, for a service that mounts health under a prefix. */
    path?: string;
  } = {},
): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, '')}${opts.path ?? '/ready'}`;
  const doFetch = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      headers: opts.headers ?? {},
      signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unreachable';
    throw new Error(`${service} unreachable at ${url}: ${reason}`);
  }
  if (!res.ok) throw new Error(`${service} is not ready (HTTP ${res.status})`);
}
