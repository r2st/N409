import type { FastifyInstance, FastifyRequest } from 'fastify';
import { buildInfo } from './build.js';
import { setAlertLineSink } from './logger.js';
import {
  INTERNAL_TOKEN_ENV,
  INTERNAL_TOKEN_HEADER,
  internalToken,
  internalTokenMatches,
  isProductionEnv,
} from './internalAuth.js';
import { routeLabel, statusClass } from './metrics.js';

/**
 * A scrapeable `/metrics`, because the numbers already being recorded are
 * currently readable by nobody.
 *
 * Three things measure this estate today and none of them is a monitoring
 * integration:
 *
 *   * `metrics.ts` records RED and a dozen gauges into the OpenTelemetry API.
 *     Without `OTEL_EXPORTER_OTLP_ENDPOINT` set — and it is not set on the
 *     deployed box — that API is a no-op provider. The instruments run, the
 *     readings go nowhere, and standing up a collector is a prerequisite
 *     nobody has met.
 *   * `errorRates.ts` keeps a one-hour sliding window in memory, served from
 *     `GET /api/v1/admin/system/metrics` behind a session and an ops role. It
 *     is shaped for a human during an incident, not for a scraper: a sliding
 *     window is not a counter, and it cannot be rated, aggregated across
 *     instances, or alerted on.
 *   * `/health` and `/ready` answer up/down, which is the question you ask
 *     after somebody has already told you something is wrong.
 *
 * So the platform has no way to answer "what was the p99 at 04:10 last
 * Tuesday", and no way to alert before a person notices. This module is the
 * missing half: cumulative counters and histograms, in the text exposition
 * format, on an endpoint a scraper can poll — with no collector, no sidecar,
 * and no dependency beyond what is already here.
 *
 * ## Deliberately its own tally
 *
 * The obvious objection is that this is a third place counting requests. It is,
 * and the alternative is worse: `ErrorRates` is a *sliding window* — it forgets
 * — and a Prometheus counter must be monotonic for `rate()` to mean anything.
 * Deriving one from the other would produce a counter that goes backwards every
 * minute. They are different shapes for different questions, and the honest
 * arrangement is two tallies over one hook rather than one tally serving a
 * question it cannot answer.
 *
 * ## Cardinality is the failure mode
 *
 * A Prometheus registry is an in-memory map keyed by label values, and the
 * route label comes from `req.routeOptions?.url ?? req.url` — where the
 * fallback is taken *precisely when nothing matched*. Every `/wp-admin`,
 * `/.env` and `/phpmyadmin` that arrives at a public origin would mint a
 * series that is never freed. That is a memory leak reachable from the
 * internet by anyone with a scanner, and it is the standard way a metrics
 * endpoint takes a service down.
 *
 * `routeLabel` collapses id-shaped segments, which handles the legitimate
 * paths and does nothing for the scanner. So every metric is additionally
 * capped at {@link MAX_SERIES_PER_METRIC} distinct label sets, and everything
 * past the cap is added to one reserved series labelled {@link OVERFLOW_LABEL}.
 * Totals stay exact; attribution is what degrades, which is the right thing to
 * lose — during a flood the interesting number is that there is a flood.
 */

/** The exposition format this module writes. Prometheus text, version 0.0.4. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Distinct label sets one metric will attribute before folding the rest. */
export const MAX_SERIES_PER_METRIC = 200;

/** Every label of the reserved series that absorbs everything past the cap. */
export const OVERFLOW_LABEL = '__other__';

/** Default duration buckets, in seconds. One millisecond to ten seconds. */
export const DEFAULT_DURATION_BUCKETS: readonly number[] = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

export type Labels = Readonly<Record<string, string>>;

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertMetricName(name: string): void {
  if (!METRIC_NAME.test(name)) throw new Error(`Invalid Prometheus metric name: ${JSON.stringify(name)}`);
}

function assertLabelNames(names: readonly string[]): void {
  for (const n of names) {
    if (!LABEL_NAME.test(n)) throw new Error(`Invalid Prometheus label name: ${JSON.stringify(n)}`);
    // Reserved by the exposition format for histogram buckets.
    if (n === 'le') throw new Error('`le` is reserved for histogram buckets and cannot be a label name');
  }
}

/** Backslash, double quote and newline, per the exposition format. */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** HELP text escapes only backslash and newline — a quote is literal there. */
export function escapeHelp(help: string): string {
  return help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/**
 * A value as the exposition format spells it.
 *
 * `Number.prototype.toString` gives `Infinity`, which Prometheus does not
 * accept — it wants `+Inf`. Worth getting right rather than assuming it cannot
 * happen: a duration histogram's `_sum` is a running total that a single absurd
 * reading can push to infinity, and it never comes back.
 */
export function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

/** `{a="1",b="2"}`, or the empty string when there are no labels. */
function renderLabels(
  names: readonly string[],
  values: readonly string[],
  extra?: readonly [string, string],
): string {
  const parts: string[] = [];
  for (let i = 0; i < names.length; i += 1) {
    parts.push(`${names[i]}="${escapeLabelValue(values[i] ?? '')}"`);
  }
  if (extra) parts.push(`${extra[0]}="${escapeLabelValue(extra[1])}"`);
  return parts.length > 0 ? `{${parts.join(',')}}` : '';
}

/**
 * Label values in declared order, and the key they are stored under.
 *
 * A missing label is the empty string rather than an error: an instrument is
 * called from a hook on the request path, and a metric that throws there would
 * turn a mislabelled series into a 500.
 */
function orderValues(names: readonly string[], labels: Labels | undefined): string[] {
  return names.map((n) => labels?.[n] ?? '');
}

/**
 * The map key for a label set.
 *
 * A newline separator rather than a space or a comma: label values reach this
 * from route paths and HTTP methods, and two distinct sets must never collide
 * into one series. A value containing the separator would do exactly that, and
 * a newline is the one character that cannot appear in any of them.
 */
const seriesKey = (values: readonly string[]): string => values.join('\n');

/** Shared bookkeeping for the capped label-set map every instrument keeps. */
abstract class Family<S> {
  protected readonly series = new Map<string, S>();
  private overflowKey?: string;

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
    private readonly maxSeries: number,
  ) {
    assertMetricName(name);
    assertLabelNames(labelNames);
  }

  /** Distinct label sets currently held, the overflow series included. */
  get cardinality(): number {
    return this.series.size;
  }

  /** True once at least one reading has been folded into the overflow series. */
  get truncated(): boolean {
    return this.overflowKey !== undefined;
  }

  protected abstract create(): S;

  /**
   * The series for these labels, minting it if there is room and folding into
   * the reserved overflow series if there is not.
   */
  protected at(labels: Labels | undefined): S {
    const key = seriesKey(orderValues(this.labelNames, labels));
    const existing = this.series.get(key);
    if (existing) return existing;
    if (this.series.size >= this.maxSeries) {
      // One reserved series, minted at most once, so the cap bounds this map's
      // size rather than being a ceiling plus one per distinct overflow.
      this.overflowKey ??= seriesKey(this.labelNames.map(() => OVERFLOW_LABEL));
      let overflow = this.series.get(this.overflowKey);
      if (!overflow) {
        overflow = this.create();
        this.series.set(this.overflowKey, overflow);
      }
      return overflow;
    }
    const created = this.create();
    this.series.set(key, created);
    return created;
  }

  /** Label values for a stored key, in declared order. */
  protected valuesOf(key: string): string[] {
    return this.labelNames.length === 0 ? [] : key.split('\n');
  }

  abstract render(): string[];

  protected header(type: string): string[] {
    return [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} ${type}`];
  }
}

/** A monotonically increasing count. */
export class Counter extends Family<{ value: number }> {
  protected create(): { value: number } {
    return { value: 0 };
  }

  /** Adds `by` (default 1) to the series for `labels`. */
  inc(labels?: Labels, by = 1): void {
    // A negative or non-finite delta would make `rate()` nonsense for the rest
    // of the process's life, and the caller is always a hook that cannot check.
    if (!Number.isFinite(by) || by < 0) return;
    this.at(labels).value += by;
  }

  /** Current count for `labels`, for tests and for the ops JSON view. */
  get(labels?: Labels): number {
    return this.series.get(seriesKey(orderValues(this.labelNames, labels)))?.value ?? 0;
  }

  render(): string[] {
    const out = this.header('counter');
    for (const [key, s] of this.series) {
      out.push(`${this.name}${renderLabels(this.labelNames, this.valuesOf(key))} ${formatValue(s.value)}`);
    }
    return out;
  }
}

interface HistogramSeries {
  /** Per-bucket counts, aligned to `bounds`; made cumulative at render time. */
  counts: number[];
  sum: number;
  count: number;
}

/** Observations bucketed by upper bound, plus a sum and a count. */
export class Histogram extends Family<HistogramSeries> {
  readonly bounds: readonly number[];

  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    bounds: readonly number[],
    maxSeries: number,
  ) {
    super(name, help, labelNames, maxSeries);
    // Sorted and de-duplicated: the exposition format requires `le` to
    // increase, and a caller passing an unsorted list is the likelier mistake
    // than one wanting the buckets in that order.
    this.bounds = [...new Set(bounds)].sort((a, b) => a - b);
  }

  protected create(): HistogramSeries {
    return { counts: new Array<number>(this.bounds.length).fill(0), sum: 0, count: 0 };
  }

  /** Records one observation. Non-finite readings are dropped, not summed. */
  observe(value: number, labels?: Labels): void {
    if (!Number.isFinite(value)) return;
    const s = this.at(labels);
    s.count += 1;
    s.sum += value;
    for (let i = 0; i < this.bounds.length; i += 1) {
      if (value <= this.bounds[i]!) {
        // Buckets are made cumulative at render time, so only the first
        // matching bound is incremented here.
        s.counts[i] = (s.counts[i] ?? 0) + 1;
        break;
      }
    }
  }

  /** `{count, sum}` for `labels`, for tests. */
  get(labels?: Labels): { count: number; sum: number } {
    const s = this.series.get(seriesKey(orderValues(this.labelNames, labels)));
    return { count: s?.count ?? 0, sum: s?.sum ?? 0 };
  }

  render(): string[] {
    const out = this.header('histogram');
    for (const [key, s] of this.series) {
      const values = this.valuesOf(key);
      let cumulative = 0;
      for (let i = 0; i < this.bounds.length; i += 1) {
        cumulative += s.counts[i] ?? 0;
        const le = renderLabels(this.labelNames, values, ['le', formatValue(this.bounds[i]!)]);
        out.push(`${this.name}_bucket${le} ${formatValue(cumulative)}`);
      }
      // `+Inf` is the count, not `cumulative`: an observation past the largest
      // bound landed in no bucket at all, and the two must still agree.
      const inf = renderLabels(this.labelNames, values, ['le', '+Inf']);
      out.push(`${this.name}_bucket${inf} ${formatValue(s.count)}`);
      const plain = renderLabels(this.labelNames, values);
      out.push(`${this.name}_sum${plain} ${formatValue(s.sum)}`);
      out.push(`${this.name}_count${plain} ${formatValue(s.count)}`);
    }
    return out;
  }
}

/** One reading of an observable gauge. */
export interface GaugeReading {
  value: number;
  labels?: Labels;
}

/** A gauge sampled at scrape time rather than written to. */
class ObservableGauge {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
    private readonly collect: () => number | readonly GaugeReading[],
  ) {
    assertMetricName(name);
    assertLabelNames(labelNames);
  }

  render(): string[] {
    /*
     * Deliberately not caught here (R341, methodology M11). A gauge whose
     * source is unavailable must not fail the whole scrape — losing one series
     * is recoverable, losing the endpoint during an incident is what this
     * module exists to prevent — and that is still what happens; the catch has
     * moved one level up, to {@link MetricsRegistry.render}, which is the only
     * place that can *record* it.
     *
     * Swallowed here, the gauge simply was not in the body, and an absent
     * series is the one thing a Prometheus rule cannot distinguish from a
     * healthy one. Most of the page-severity rules in this estate are gauge-
     * backed: `SweepStopped` reads `background_sweep_enabled`,
     * `UpstreamCircuitOpen` reads `upstream_circuit_state`, `PoolSaturated`
     * reads `db_pool_connections_waiting`, `JobQueueAlertOpen` reads the job
     * monitor's snapshot. A `collect` that throws on every scrape takes its
     * rule with it, silently and for as long as the process lives.
     */
    const raw = this.collect();
    const readings: readonly GaugeReading[] = typeof raw === 'number' ? [{ value: raw }] : raw;
    const out = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} gauge`];
    for (const r of readings) {
      const values = orderValues(this.labelNames, r.labels);
      out.push(`${this.name}${renderLabels(this.labelNames, values)} ${formatValue(r.value)}`);
    }
    return out;
  }
}

/** One instrument's label-set usage. See {@link MetricsRegistry.seriesCensus}. */
export interface SeriesCensusEntry {
  metric: string;
  /** Distinct label sets held, the reserved overflow series included. */
  cardinality: number;
  /** True once at least one reading has been folded into `__other__`. */
  truncated: boolean;
}

/**
 * The metrics one process exposes.
 *
 * Instruments are registered once at boot and written to from hooks; gauges are
 * sampled at scrape time. Registering the same name twice returns the existing
 * instrument rather than shadowing it, so a service that wires the same helper
 * from two places gets one series rather than two that disagree.
 */
export class MetricsRegistry {
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly gauges = new Map<string, ObservableGauge>();

  constructor(private readonly maxSeries: number = MAX_SERIES_PER_METRIC) {}

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    const existing = this.counters.get(name);
    if (existing) return existing;
    const created = new Counter(name, help, labelNames, this.maxSeries);
    this.counters.set(name, created);
    return created;
  }

  histogram(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    bounds: readonly number[] = DEFAULT_DURATION_BUCKETS,
  ): Histogram {
    const existing = this.histograms.get(name);
    if (existing) return existing;
    const created = new Histogram(name, help, labelNames, bounds, this.maxSeries);
    this.histograms.set(name, created);
    return created;
  }

  /**
   * Registers a gauge sampled on every scrape.
   *
   * `collect` may answer a plain number or one reading per label set. It is
   * called inside the request that scrapes, so it must be cheap and
   * synchronous — an in-memory counter, a pool's `idleCount`. Deliberately no
   * async variant: a scrape that queries the database turns a monitoring poll
   * into load on the thing being monitored, and does so hardest exactly when
   * the database is already the problem.
   */
  gauge(
    name: string,
    help: string,
    collect: () => number | readonly GaugeReading[],
    labelNames: readonly string[] = [],
  ): void {
    if (this.gauges.has(name)) return;
    this.gauges.set(name, new ObservableGauge(name, help, labelNames, collect));
  }

  /**
   * What each capped instrument is holding, and whether it has begun folding.
   *
   * WHY THIS IS EXPORTED (R341, methodology M11). `Family` has computed
   * `cardinality` and `truncated` since the cap was written, and until now the
   * only thing that ever read either was `prometheus.test.ts`. So the one event
   * this module's header calls out as the cost of the cap — "attribution is
   * what degrades" — happened, permanently and per-process, with no channel at
   * all: no log line, no series, no rule. A dashboard grouped by `route` simply
   * starts showing `__other__` beside the real routes, as if it were one, and
   * nothing anywhere says that a fold is what produced it.
   *
   * The fold is silent in the direction that matters most for the rules in
   * `infra/monitoring/alerts.yml`. Totals stay exact, so `sum by (job)` keeps
   * answering correctly — which is why `HighServerErrorRate` and `SlowRequests`
   * are unaffected — but a rule that *selects* a label value
   * (`outcome="unsettled"`, `sweep="job-alerts"`) matches the folded readings
   * no longer, because they are filed under `__other__`. Such a rule goes from
   * watching a condition to watching nothing, and a query returning no series
   * is what a healthy system looks like.
   *
   * Gauges are absent on purpose: `ObservableGauge` holds no series map and
   * re-derives its readings on every scrape, so there is nothing there to
   * overflow.
   */
  seriesCensus(): SeriesCensusEntry[] {
    const out: SeriesCensusEntry[] = [];
    for (const family of [...this.counters.values(), ...this.histograms.values()]) {
      out.push({ metric: family.name, cardinality: family.cardinality, truncated: family.truncated });
    }
    return out;
  }

  /**
   * Gauge collections that threw, by metric.
   *
   * Registered on the first failure rather than at construction, so an estate
   * where nothing has ever thrown exposes no series at all and the alert on it
   * is written against a condition, not against a permanent zero. Lazy is also
   * what keeps `seriesCensus` honest: an instrument nothing has used is not an
   * instrument this endpoint is holding anything for.
   */
  private collectFailures(): Counter {
    return this.counter(
      'n409_metric_collect_failures_total',
      'Gauge collections that threw during a scrape — that gauge is absent from this body, and any rule reading it is matching nothing',
      ['metric'],
    );
  }

  /** The whole registry in the text exposition format, newline-terminated. */
  render(): string {
    /*
     * Gauges first, though they are written out last. A `collect` that throws
     * is recorded on the counter below, and the counter has to be rendered
     * after that increment or the failure would not appear until the *next*
     * scrape — which for a gauge that throws once, on the scrape somebody is
     * reading, is never.
     */
    const gauges: string[] = [];
    for (const g of this.gauges.values()) {
      try {
        gauges.push(...g.render());
      } catch {
        // The scrape continues without this one, which is the original
        // contract and the right one: an endpoint that 500s because a pool
        // handle went away is an endpoint that is down exactly when it is
        // needed. What is new is that the absence is now countable.
        this.collectFailures().inc({ metric: g.name });
      }
    }
    const lines: string[] = [];
    for (const c of this.counters.values()) lines.push(...c.render());
    for (const h of this.histograms.values()) lines.push(...h.render());
    lines.push(...gauges);
    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
  }
}

/** A scraper credential that is not the estate's internal service token. */
export const METRICS_TOKEN_ENV = 'METRICS_TOKEN';

/**
 * The secret a scraper must present, or null when none is configured.
 *
 * `METRICS_TOKEN` first so a scraper can hold a credential that is not the
 * internal service token — the two rotate on different schedules, and a
 * Prometheus configuration file is a wider blast radius than a systemd unit.
 * Falls back to `INTERNAL_SERVICE_TOKEN` so an estate that already has one
 * needs no new configuration to turn this on.
 */
export function metricsToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env[METRICS_TOKEN_ENV];
  if (explicit) return explicit;
  return internalToken(env);
}

/** True when the request carries the metrics secret. */
export function metricsCallerAuthorized(req: FastifyRequest, expected: string): boolean {
  const header = req.headers[INTERNAL_TOKEN_HEADER];
  const internal = Array.isArray(header) ? header[0] : header;
  if (internalTokenMatches(internal, expected)) return true;
  // `Authorization: Bearer …` too, because that is what a Prometheus scrape
  // config can send without a custom-header stanza.
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return match ? internalTokenMatches(match[1], expected) : false;
}

export interface MetricsEndpointLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface MetricsEndpointOptions {
  registry: MetricsRegistry;
  service: string;
  /** Injected by tests; defaults to the real environment. */
  env?: NodeJS.ProcessEnv;
  log?: MetricsEndpointLogger;
  /** Path to mount. Defaults to `/metrics`. */
  path?: string;
}

/**
 * Mounts the scrape endpoint, gated on a secret.
 *
 * Not public, and the gate is not optional in production. The web service is
 * served straight through Caddy at `409.doaide.com` — every path on port 3000
 * is on the open internet — and this body names every route the service has,
 * how often each is hit and how often each fails. That is a map of the estate
 * and a free traffic-analysis feed for anyone who asks.
 *
 * With no secret configured in production the endpoint is not registered at
 * all, and the reason is logged at boot. Outside production it is open, which is
 * what a `docker compose up` and the test suites want, and matches how
 * `registerInternalAuth` already treats the same question.
 *
 * A caller with the wrong secret is handed to the service's own not-found
 * handler rather than given a 401 or a body written here. Two reasons, and the
 * second is the weaker one on purpose:
 *
 *   * It keeps one 404 shape per service rather than inventing a second. On the
 *     valuation and report services that is `registerProblemHandler`'s
 *     problem+json, which is what every other unmatched path there answers.
 *   * It declines to confirm the endpoint exists. Only partly, and only where
 *     it can: the web service registers an `/*` SPA fallback, so an unknown
 *     path there is a 200 carrying `index.html` while a rejected scrape is a
 *     404 — distinguishable, and not worth contorting the SPA routing to hide.
 *     `/metrics` is a guessable path on any instrumented service anyway; the
 *     token is the protection, and this is tidiness on top of it.
 */
export function registerMetricsEndpoint(app: FastifyInstance, opts: MetricsEndpointOptions): void {
  const env = opts.env ?? process.env;
  const path = opts.path ?? '/metrics';

  if (metricsToken(env) === null && isProductionEnv(env)) {
    (opts.log ?? app.log).warn(
      { service: opts.service, env: METRICS_TOKEN_ENV, path },
      `${METRICS_TOKEN_ENV} (or ${INTERNAL_TOKEN_ENV}) is not set — the metrics endpoint is disabled. ` +
        'Set one to let a scraper collect request rates, latencies and queue depths from this process.',
    );
    return;
  }

  app.get(path, async (req, reply) => {
    // Re-read per request so the secret can rotate without a restart, the same
    // way internalAuth.ts does it — including a rotation to nothing, which must
    // close the endpoint rather than open it.
    const secret = metricsToken(env);
    if (secret === null ? isProductionEnv(env) : !metricsCallerAuthorized(req, secret)) {
      // Whatever this service answers for a path it does not have — see above
      // for why that is not a 401 and not a 404 written here.
      return reply.callNotFound();
    }
    // A cached scrape is a lie about the moment it describes.
    void reply.header('cache-control', 'no-store');
    return reply.status(200).type(PROMETHEUS_CONTENT_TYPE).send(opts.registry.render());
  });
}

/**
 * The RED instruments, recorded from an `onResponse` hook.
 *
 * `_total` and `_seconds` suffixes and the `http_*` names are the conventions a
 * Prometheus user's dashboards and alert rules already assume; naming them
 * anything else makes every off-the-shelf recording rule not apply.
 */
export function registerHttpMetrics(app: FastifyInstance, registry: MetricsRegistry): void {
  const requests = registry.counter(
    'http_requests_total',
    'HTTP requests handled, by method, route and status class',
    ['method', 'route', 'status'],
  );
  const errors = registry.counter('http_request_errors_total', 'HTTP requests that returned a 5xx', [
    'method',
    'route',
  ]);
  const duration = registry.histogram(
    'http_request_duration_seconds',
    'HTTP request duration in seconds',
    ['method', 'route'],
    DEFAULT_DURATION_BUCKETS,
  );

  app.addHook('onResponse', (req, reply, done) => {
    // `routeOptions.url` is the templated path when something matched; the raw
    // url is what a 404 leaves behind, which is why every label goes through
    // `routeLabel` and why the registry caps its series.
    const route = routeLabel(req.routeOptions?.url ?? req.url);
    const method = req.method.toUpperCase();
    requests.inc({ method, route, status: statusClass(reply.statusCode) });
    if (reply.statusCode >= 500) errors.inc({ method, route });
    duration.observe(Math.max(0, reply.elapsedTime) / 1000, { method, route });
    done();
  });
}

/**
 * Facts about the process itself: what it is, how long it has been up, and what
 * it is holding.
 *
 * `n409_build_info` is a gauge fixed at 1 whose labels carry the interesting
 * part — the standard `*_info` idiom, so a dashboard can join a time series to
 * the commit that produced it, and a deploy is visible as a label change rather
 * than something to be correlated by hand.
 */
export function registerProcessMetrics(
  registry: MetricsRegistry,
  service: string,
  proc: Pick<NodeJS.Process, 'uptime' | 'memoryUsage'> = process,
): void {
  const build = buildInfo();
  registry.gauge(
    'n409_build_info',
    'Always 1; the labels carry the build this process is running',
    () => [{ value: 1, labels: { service, sha: build.sha, source: build.source } }],
    ['service', 'sha', 'source'],
  );
  registry.gauge('process_uptime_seconds', 'Seconds since this process started', () => proc.uptime());
  registry.gauge(
    'process_resident_memory_bytes',
    'Resident set size of this process',
    () => proc.memoryUsage().rss,
  );
  registry.gauge('nodejs_heap_used_bytes', 'V8 heap in use', () => proc.memoryUsage().heapUsed);
  registry.gauge('nodejs_heap_total_bytes', 'V8 heap allocated', () => proc.memoryUsage().heapTotal);

  // And what this endpoint is itself holding back. See `seriesCensus`: the cap
  // trades attribution for a bounded map, and the moment that trade is taken is
  // the moment several rules quietly stop matching what they were written for.
  // Registered here rather than beside the HTTP instruments because it is a
  // fact about the process, and because every service already calls this.
  registry.gauge(
    'n409_metric_series',
    'Distinct label sets one instrument is holding, the reserved __other__ series included',
    () => registry.seriesCensus().map((e) => ({ value: e.cardinality, labels: { metric: e.metric } })),
    ['metric'],
  );
  // The alerting contract, at the endpoint that alerts (R376, methodology M11).
  //
  // `logFailure` stamps `alert: true` on a failure no retry is coming for, and
  // forty-odd sites either use it or write the field by hand. Nothing consumed
  // it: journald is retention configuration, not a shipper, and this endpoint
  // is what an alert rule reads — so the estate's one "a person must act" flag
  // reached nobody who was not already reading the journal. Several of the
  // conditions behind it have no other number at all, a document that will no
  // longer decrypt being the sharpest of them.
  //
  // Registered here because every Node service already makes this one call, and
  // the sink is installed from the counter so a service without a metrics
  // registry logs exactly as it did. See `setAlertLineSink` in logger.ts for
  // why it is counted at the logger and why it carries no labels.
  const alertLines = registry.counter(
    'log_alert_lines_total',
    'Log lines carrying alert: true — permanent failures the code says a person must act on',
  );
  // Minted at registration, exactly as `UPSTREAM_CIRCUITS` is: a counter
  // publishes no series until something increments it, and a rule cannot tell
  // an absent series from a healthy one — `increase()` over nothing is nothing,
  // for ever, on a process that has never once alerted and on one whose logger
  // is not wired at all.
  alertLines.inc(undefined, 0);
  setAlertLineSink(() => alertLines.inc());
  registry.gauge(
    'n409_metric_series_folded',
    '1 once an instrument has begun folding label sets into __other__ — its attribution is no longer complete',
    () => registry.seriesCensus().map((e) => ({ value: e.truncated ? 1 : 0, labels: { metric: e.metric } })),
    ['metric'],
  );
}
