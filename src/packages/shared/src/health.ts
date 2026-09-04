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
  /** False only when a *gating* check failed — see `optional` on the options. */
  healthy: boolean;
  /** name -> 'ok', or the scrubbed reason the check threw. */
  detail: Record<string, string>;
  /** Optional checks that failed. Never affects `healthy`; always reported. */
  degraded: string[];
  /** Names of the checks that decide the status code. */
  gating: string[];
}

/** The last readiness run this process completed, and when it completed. */
export interface ReadinessVerdict extends ReadinessSnapshot {
  /** `Date.now()` at the moment the run finished. */
  at: number;
}

/**
 * The readiness state of one app, for a caller that is not an HTTP probe.
 *
 * Returned by {@link registerHealth} so the verdict can be published on the
 * scrape endpoint — see {@link registerReadinessMetrics} for why that is not
 * the same thing as serving it on `/ready`.
 */
export interface ReadinessHandle {
  /** The last verdict, or `null` if nothing has probed this process yet. */
  verdict(): ReadinessVerdict | null;
  /**
   * Recompute in the background when the last verdict is older than `maxAgeMs`.
   *
   * Never throws and never returns the run: the caller is a synchronous
   * `collect`, so what it can do is ask for the *next* reading to be fresh.
   * Concurrent calls collapse onto the run already in flight.
   */
  refreshIfOlderThan(maxAgeMs: number): void;
}

/**
 * The same check map with every failure flattened to `failed`.
 *
 * Exported since R405 (methodology M11) because a second surface now shows the
 * verdict — the valuation tier's ops incident view — and the disclosure rule
 * has to be the same one, written once. The scrubbed reason names hosts, roles
 * and sometimes a DSN; it belongs in the journal and the token-gated `/ready`
 * body and nowhere a page can render it.
 */
export function publicChecks(detail: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(detail).map(([name, status]) => [name, status === CHECK_OK ? CHECK_OK : CHECK_FAILED]),
  );
}

/** The verdict as a page may show it: never the reasons, always the age. */
export interface ReadinessSummary {
  ready: boolean;
  /** Optional checks that failed. Never affects `ready`; always reported. */
  degraded: string[];
  /** name -> `ok` | `failed`. */
  checks: Record<string, string>;
  /**
   * How old this verdict is.
   *
   * Carried rather than left implicit for the reason
   * `service_readiness_age_seconds` exists: the verdict is recomputed when
   * something asks, so one frozen at the last completed run reads exactly like
   * a current one.
   */
  age_s: number;
}

/** {@link ReadinessVerdict} in the form a person may be shown. */
export function readinessSummary(verdict: ReadinessVerdict, now: number = Date.now()): ReadinessSummary {
  return {
    ready: verdict.healthy,
    degraded: verdict.degraded,
    checks: publicChecks(verdict.detail),
    age_s: Math.round((now - verdict.at) / 1000),
  };
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
    /**
     * Dependencies this service is designed to serve without.
     *
     * Run and reported exactly like {@link checks}, and deliberately excluded
     * from the status code. A 503 from `/ready` is a claim — *this instance
     * cannot serve the request and another one can* — and a load balancer acts
     * on it by taking the instance out. Making that claim over a dependency the
     * service has already decided is optional is a readiness check that
     * manufactures the outage it is reporting: the valuation service's own boot
     * gate refuses to require the AI and engine units precisely because
     * "refusing to boot would convert a degraded feature into a total outage",
     * and its `/ready` then required both anyway — so an expired provider key
     * on :3002 answered the public origin with 503 and failed the deploy.
     *
     * The AI service already had this distinction internally: `_VERDICT_CHECKS`
     * are reported, and exactly one of them, `_GATING_CHECK`, decides the code.
     * This is the same split, one tier up.
     *
     * Not silent: a failing optional check is named in the body, is `failed` in
     * the public form, moves `status` to `degraded`, and logs — and since R361
     * the two Python units are scrape targets in their own right, so `up` is the
     * direct signal an operator alerts on rather than this cascade.
     */
    optional?: Record<string, ReadinessCheck>;
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
): ReadinessHandle {
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
    const required = Object.entries(opts.checks ?? {});
    const optional = Object.entries(opts.optional ?? {});
    const entries = [...required, ...optional];
    const gating = new Set(required.map(([name]) => name));
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
    const failed = settled.filter(([, status]) => status !== CHECK_OK).map(([name]) => name);
    const healthy = failed.every((name) => !gating.has(name));
    const degraded = failed.filter((name) => !gating.has(name));
    if (failed.length > 0) {
      // Logged here rather than per request, so a flood of probes against a
      // sick estate does not also flood the log: this runs once per fan-out.
      //
      // Two messages, because they are two different facts and only one of them
      // is this instance saying it cannot serve. A degraded optional dependency
      // that logged 'reporting unavailable' would be read as the outage it is
      // explicitly not.
      log.warn(
        { service: opts.service, checks: detail, degraded },
        healthy
          ? 'optional dependency unavailable — still serving, the features that need it will not'
          : 'readiness check failed — reporting unavailable',
      );
    }
    const snapshot: ReadinessSnapshot = { healthy, detail, degraded, gating: [...gating] };
    // Recorded here rather than at the `/ready` handler, so a verdict computed
    // by a scrape-driven refresh counts the same as one a probe asked for.
    last = { ...snapshot, at: Date.now() };
    return snapshot;
  };

  /*
   * The verdict, kept where something other than an HTTP probe can read it
   * (R405, methodology M11).
   *
   * Everything above computes a claim this process makes about whether it can
   * serve — and on this estate the only thing that ever asks for it is
   * `deploy.sh`, which polls `/ready` once per restart and then never again.
   * There is no load balancer and no Kubernetes on the box: ports 3001–3004 are
   * firewalled and :3000 is a plain Caddy reverse proxy with no active health
   * check. So between deploys the endpoint is answered by nobody, and a gating
   * check that starts failing afterwards — Postgres gone, the font assets
   * missing after a partial rsync, the startup gate never opened — is a 503 in
   * a tree with nobody around to hear it.
   *
   * `refreshIfOlderThan` is what lets the scraper be the thing that asks. It
   * cannot be `collect`'s own work: a gauge is sampled synchronously inside the
   * scrape and these checks are network-bound, so what a scrape can do is
   * publish the last verdict and ask for the next one to be current.
   */
  let last: ReadinessVerdict | null = null;
  let refreshing = false;
  const handle: ReadinessHandle = {
    verdict: () => last,
    refreshIfOlderThan: (maxAgeMs) => {
      if (refreshing) return;
      if (last !== null && Date.now() - last.at < maxAgeMs) return;
      refreshing = true;
      // `runChecks` never rejects — a failed dependency is a result — so the
      // only thing left to contain is a throw from the logger itself.
      void Promise.resolve()
        .then(() => runChecks(app.log))
        .catch(() => undefined)
        .finally(() => {
          refreshing = false;
        });
    },
  };

  app.get('/ready', async (req, reply) => {
    const snapshot =
      cacheMs > 0 ? await cache.getOrLoad('ready', () => runChecks(req.log)) : await runChecks(req.log);
    void reply.header('cache-control', 'no-store');
    return reply.status(snapshot.healthy ? 200 : 503).send({
      // Three words for two status codes on purpose. `degraded` is a 200 — this
      // instance can serve, and a load balancer must keep it — but it is not
      // `ready`, and reporting it as such is how an optional dependency that has
      // been down for a week goes unnoticed. The failing check is already named
      // in `checks`; this is the summary a person reads first.
      status: !snapshot.healthy ? 'unavailable' : snapshot.degraded.length > 0 ? 'degraded' : 'ready',
      checks: isInternalCaller(req) ? snapshot.detail : publicChecks(snapshot.detail),
      build_sha: build.sha,
    });
  });

  return handle;
}

/**
 * How stale a published verdict may be before a scrape asks for a fresh one.
 *
 * Sized against the scrape interval rather than against {@link READY_CACHE_MS}:
 * the coalescing window exists to stop a *burst of probes* costing a fan-out
 * each, and there is no burst here — one scraper, on the box, on its own
 * schedule. 20s is under any sane scrape interval, so every scrape gets a
 * verdict computed since the previous one, and over it by enough that two
 * scrapers pointed at the same unit do not double the fan-out.
 */
export const READINESS_METRIC_MAX_AGE_MS = 20_000;

/** The slice of `MetricsRegistry` this file needs; see the note on the import. */
interface GaugeRegistrar {
  gauge(
    name: string,
    help: string,
    collect: () => number | readonly { value: number; labels?: Record<string, string> }[],
    labelNames?: readonly string[],
  ): void;
}

/**
 * Publish the readiness verdict on the scrape endpoint (R405, methodology M11).
 *
 * `/ready` is a claim about whether this instance can serve, and on this estate
 * it is made to nobody: `deploy.sh` polls it once per restart and nothing polls
 * it afterwards — there is no load balancer, and `infra/monitoring/alerts.yml`
 * describes a scraper that reads `/metrics` and nothing else. So the whole
 * readiness apparatus — the gating/optional split, the per-check detail, the
 * `degraded` word this file argues for at length — reached the journal and the
 * deploy log and no alerting rule at all.
 *
 * What that costs is not hypothetical. `ServiceDown` is the availability rule,
 * and it fires on `up == 0` — a *missed scrape*. `/metrics` is served out of
 * process memory and touches no dependency, so a valuation service whose
 * Postgres has gone answers every scrape in full, with a complete set of
 * healthy-looking numbers, while `/ready` has been saying 503 for a week. The
 * first symptom anybody sees is a user's 500.
 *
 * Three series, and the third is load-bearing:
 *
 *  * `service_ready` — the gating verdict, 1 or 0.
 *  * `service_dependency_up{dependency,required}` — one reading per check, so
 *    an alert can name the thing that is down rather than the unit it is under,
 *    and `required` keeps a degraded optional dependency from paging.
 *  * `service_readiness_age_seconds` — how old that verdict is. Without it a
 *    verdict frozen at the last successful run reads exactly like a current
 *    one, which is the failure this whole function exists against, one level
 *    up.
 *
 * Nothing is emitted until the first verdict exists: a `service_ready` of 0
 * during boot is the process saying it cannot serve, which is true and would
 * fire on every restart, and a 1 would be a claim made before anything was
 * checked. An absent series is what "nothing has looked yet" reads as, and
 * `service_readiness_age_seconds` is what stops it staying that way unnoticed.
 */
export function registerReadinessMetrics(
  metrics: GaugeRegistrar,
  readiness: ReadinessHandle,
  opts: { maxAgeMs?: number } = {},
): void {
  const maxAgeMs = opts.maxAgeMs ?? READINESS_METRIC_MAX_AGE_MS;
  // Asked for once per scrape, on whichever gauge renders first — the refresh
  // is idempotent and collapses onto any run already in flight.
  const sample = (): ReadinessVerdict | null => {
    readiness.refreshIfOlderThan(maxAgeMs);
    return readiness.verdict();
  };

  metrics.gauge('service_ready', 'This instance says it can serve: every gating readiness check passed', () => {
    const v = sample();
    return v === null ? [] : [{ value: v.healthy ? 1 : 0 }];
  });

  metrics.gauge(
    'service_dependency_up',
    'One readiness check, 1 when it passed; `required` is 0 for a dependency this service is designed to serve without',
    () => {
      const v = sample();
      if (v === null) return [];
      return Object.entries(v.detail).map(([dependency, status]) => ({
        value: status === CHECK_OK ? 1 : 0,
        labels: { dependency, required: v.gating.includes(dependency) ? 'true' : 'false' },
      }));
    },
    ['dependency', 'required'],
  );

  metrics.gauge(
    'service_readiness_age_seconds',
    'Seconds since the published readiness verdict was computed',
    () => {
      const v = sample();
      return v === null ? [] : [{ value: (Date.now() - v.at) / 1000 }];
    },
  );
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
