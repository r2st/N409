import {
  ApiProblem,
  CircuitOpenError,
  CircuitRegistry,
  classifyFailure,
  classifyStatus,
  currentRequestId,
  FLAGS,
  flagEnabled,
  probeReady as sharedProbeReady,
  problems,
  issuePath,
  requestIdHeaders,
  type CircuitState,
  type Counter,
  type FailureClass,
  type Histogram,
  type MetricsRegistry,
} from '@n409/shared';
import { sliceChars } from '../domain/textSlice.js';
import { MAX_INTEGRATION_JSON_BYTES, readCappedBytes } from './deadline.js';

/**
 * Thin JSON client for the internal AI / engine services. Failures surface as
 * problems: an upstream 4xx means our payload was incomplete (→ 422 to the
 * client), a 429 is the upstream out of allowance (→ 429, with its own
 * `retry-after`), and anything else is a 502 so an outage never reads as a
 * valuation bug.
 */
/**
 * A structured input problem reported by an upstream service (the engine's
 * pre-flight validator). `field` is a dotted path into the request payload, so
 * the UI can point at the control the analyst has to fix.
 */
export interface UpstreamIssue {
  code: string;
  field: string;
  message: string;
  severity: 'error' | 'warning';
  hint: string | null;
}

/**
 * The most body we will hold from an internal service before giving up.
 *
 * Far above every real answer: an engine compute carries an allocation and a
 * trace, a sensitivity response a grid whose dimensions the route caps at
 * 9 x 9, and an AI pipeline result is bounded by the model's token ceiling.
 * Chosen to be out of the way of a legitimate response rather than to be
 * tight, and deliberately the same figure as `MAX_INTEGRATION_JSON_BYTES` so
 * the two client families do not have to be reasoned about separately.
 */
export const MAX_INTERNAL_BODY_BYTES = MAX_INTEGRATION_JSON_BYTES;

export class InternalServiceError extends Error {
  constructor(
    readonly service: string,
    readonly status: number | null,
    readonly detail: string,
    /** Field-level issues when the upstream sent them; empty otherwise. */
    readonly issues: UpstreamIssue[] = [],
    /**
     * True when *we* gave up on a request the upstream had already accepted,
     * rather than the upstream failing. The distinction decides whether a retry
     * is free (see `isRetryable`).
     */
    readonly abandoned: boolean = false,
    /**
     * True when `detail` is text of unknown provenance rather than a sentence
     * the upstream authored for a caller to read.
     *
     * `detail` is used two ways and they want opposite things. The log and the
     * network-call record want everything there is — the comment at the throw
     * site is explicit that the raw body "is often the whole answer", a
     * traceback or a proxy's HTML page, and that keeping it beats re-running
     * the call. `toProblem` puts it in an HTTP response body, and a traceback
     * in a 422 is a file path and a module layout handed to whoever asked.
     *
     * The two are not hypothetical: the engine's own request-validation handler
     * answers with `detail` as pydantic's error *list*, whose entries carry an
     * `input` field echoing the offending payload. That is not a string, so the
     * parse below falls through to the raw body — and the raw body then rode
     * into a user-facing problem detail, request id and all.
     *
     * So the flag, rather than a blanket redaction: a `detail` string in a
     * problem document is written to be read by a caller and stays exactly as
     * it is (the engine's "volatility is required" is the whole point of the
     * pipe). Anything else is kept for the log and withheld from the response.
     */
    readonly opaque: boolean = false,
    /**
     * True when this request was never sent, because the breaker for `service`
     * is open (see {@link circuits}).
     *
     * Carried on the ordinary error type rather than escaping as a
     * `CircuitOpenError` so that every existing `catch (err instanceof
     * InternalServiceError)` keeps working — of which there are dozens, and any
     * one of them missed would turn a handled upstream outage into a 500. The
     * flag is what `toProblem` reads to answer 503-and-come-back rather than
     * 502-it-is-broken.
     */
    readonly circuitOpen: boolean = false,
    /**
     * Seconds until it is worth asking again, when something said so.
     *
     * Two sources, both of them an upstream answering "not now" rather than
     * "not ever": the breaker, which knows exactly when it will admit a trial
     * call, and a `retry-after` on an upstream 429. The AI service raises the
     * second one when OpenRouter's allowance is spent — a daily quota on the
     * key, so every model in its fallback chain refuses at once — and that
     * number is the only useful thing anyone can tell the analyst who is
     * looking at the failed run.
     */
    readonly retryAfterSeconds: number | null = null,
    /**
     * The payload paths a framework-level schema rejection named, when the
     * upstream answered with one.
     *
     * Separate from {@link issues} because it comes from a different place and
     * carries less. `issues` is the engine's own hand-written pre-flight list,
     * with a message and a hint per field; this is FastAPI's
     * `RequestValidationError` body, which both Python services answer a schema
     * failure with — `detail` as an array of `{loc, msg, type}`.
     *
     * Only the `loc` paths are kept. `msg` is pydantic's prose and `input` is
     * the offending value echoed back, and {@link opaque} exists to keep both
     * of those out of a response; nothing here changes that. A path is the one
     * part of that body which is a fact about *our* request rather than about
     * its contents, and it is the part the reader needs: the engine's remedy
     * says "correct the inputs it names", and until R357 a schema rejection
     * named none, because an array `detail` fell through every branch of the
     * parse and was withheld whole.
     */
    readonly refusedFields: readonly string[] = [],
  ) {
    super(`${service}: ${detail}`);
  }
}

/**
 * One breaker per internal service, shared by every call site.
 *
 * Module-level for the same reason `networkSink` is: the alternative is
 * threading a registry through every repo and route that happens to call the
 * engine, and a breaker that is not shared is not a breaker at all (see
 * `CircuitRegistry`).
 *
 * The thresholds are deliberately not tight. Five consecutive transient
 * failures is several seconds of a genuinely dead upstream, not one unlucky
 * request, and the 30-second cooldown is short enough that a service restarting
 * under `deploy.sh` is picked back up within one wait-loop interval. The cost of
 * opening too eagerly is a feature that reports itself unavailable while it
 * would in fact have worked; the cost of opening too late is the cascade. Both
 * are real, and these numbers sit closer to the cautious end on purpose.
 */
export const circuits = new CircuitRegistry({
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMax: 1,
  onStateChange: (change) => {
    try {
      circuitObserver?.(change);
    } catch {
      /* a diagnostic that cannot be written must not fail the call that caused it */
    }
  },
});

/**
 * A breaker's state transitions, offered to the composition root.
 *
 * The breaker had `onStateChange` from the day it was written and nothing ever
 * passed one, so the single most consequential event in this tier — "we have
 * stopped calling the AI service" — was recorded nowhere. `snapshots()` is on
 * the ops incident endpoint, which answers *what the state is right now* to
 * somebody who already suspects a problem and has gone looking. It cannot say
 * that a breaker opened at 03:12 and closed at 03:14, and a transition that
 * happens between two visits to that page leaves no trace at all.
 *
 * So: the transition goes to the log (durable, has the request id and the
 * classified reason on it) and the *state* goes on `/metrics` below (pollable,
 * and the only channel on this box anything alerts from — see the note on
 * `registerMetricsEndpoint`). Neither substitutes for the other.
 */
export type CircuitStateSink = (change: {
  name: string;
  from: CircuitState;
  to: CircuitState;
  reason: string;
}) => void;

let circuitObserver: CircuitStateSink | null = null;

/**
 * Where breaker transitions go, or null to record nothing.
 *
 * Module-level for the same reason {@link setNetworkSink} is: `circuits` is a
 * module-level singleton constructed at import time, long before there is a
 * Fastify logger to hand it.
 */
export function setCircuitObserver(sink: CircuitStateSink | null): void {
  circuitObserver = sink;
}

/**
 * The dependencies this service puts behind a breaker.
 *
 * Named here rather than discovered, because `CircuitRegistry.get` mints a
 * breaker on first use: a registry that has never been called is empty, so a
 * gauge derived from `snapshots()` alone publishes *no series* for a service
 * until the first request reaches it. An alert on a missing series is a
 * different, worse alert than one on a series reading zero — and the moment it
 * matters most is a boot into an outage, where the first call fails and the
 * breaker opens before anything has scraped a healthy value to compare against.
 *
 * `upstreamCircuitRoster.test.ts` pins this list against the names the call
 * sites actually pass, so a fourth dependency cannot be added silently.
 */
export const UPSTREAM_CIRCUITS = ['engine', 'ai-service', 'report'] as const;

/** Numeric ordering used by the state gauge; higher is worse. */
const CIRCUIT_STATES: readonly CircuitState[] = ['closed', 'half-open', 'open'];

/**
 * Publish breaker state on the scrape endpoint.
 *
 * A state-set rather than an encoded number: `upstream_circuit_state{state="open"}
 * == 1` is an alert expression somebody can read, where a gauge holding 2 needs
 * the legend to be somewhere else. Three services times three states is nine
 * series, well inside `MAX_SERIES_PER_METRIC`.
 *
 * All three reads are in-memory, which is the requirement for a scrape-time
 * gauge — `snapshot()` only compares a monotonic clock against a timestamp.
 */
/**
 * How an attempt against an internal service ended.
 *
 * Per *attempt*, matching `NetworkCall`: a call that was retried made two
 * exchanges, and collapsing them would hide the retry — which is exactly what
 * an operator is looking for when a pipeline "took four minutes".
 *
 * `rejected` (4xx) and `failed` (5xx) are separate because they are different
 * people's problems: a run of 4xx is this service sending the engine payloads
 * it will not accept, and a run of 5xx is the engine. Nothing downstream can
 * tell them apart from a single error rate, and only one of them is worth
 * waking somebody for.
 */
export type UpstreamOutcome =
  'ok' | 'rejected' | 'failed' | 'timeout' | 'unreachable' | 'bad_body' | 'circuit_open';

let upstreamCalls: Counter | null = null;
let upstreamDuration: Histogram | null = null;

/**
 * Wall time an internal call is allowed to take, as buckets.
 *
 * `DEFAULT_DURATION_BUCKETS` tops out at ten seconds, which is the right shape
 * for a request this service serves and the wrong one for a request it makes:
 * the default budget here is 120 seconds and an AI pipeline routinely uses tens
 * of it, so every interesting call would land in `+Inf` and the histogram would
 * answer nothing. Extended to cover the budget, so the quantile that matters —
 * "are we close to the deadline that abandons the work" — is readable.
 */
const UPSTREAM_DURATION_BUCKETS: readonly number[] = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120];

/**
 * RED for the dependencies, on the scrape endpoint.
 *
 * Everything this service knew about the engine and the AI gateway was either
 * per-engagement (`network_items`, a row keyed to a valuation, absent for every
 * call that is not on behalf of one) or per-request (the problem document the
 * caller got). Nothing aggregated: no rate, no error rate, no latency. The
 * report offload has had exactly this pair since it was written
 * (`report_render_total`), and the two hops that actually compute the valuation
 * had neither.
 *
 * From this side of the wire on purpose. Neither Python service exposes a
 * scrape endpoint, and even if it did, the numbers that decide whether a user
 * saw a failure are the caller's: a request abandoned at our deadline is a
 * success in the engine's own access log, still running.
 */
export function registerUpstreamMetrics(registry: MetricsRegistry): void {
  upstreamCalls = registry.counter(
    'upstream_requests_total',
    'Attempts against an internal service, by outcome. One per attempt, so a retried call counts twice.',
    ['service', 'outcome'],
  );
  upstreamDuration = registry.histogram(
    'upstream_request_duration_seconds',
    'Wall time of one attempt against an internal service, whether it succeeded or not.',
    ['service'],
    UPSTREAM_DURATION_BUCKETS,
  );
}

/** Test seam: drops the instruments so one suite's counts cannot leak into another. */
export function resetUpstreamMetrics(): void {
  upstreamCalls = null;
  upstreamDuration = null;
}

/**
 * Record one finished attempt.
 *
 * `durationMs` is null for `circuit_open`, which is not an attempt — nothing was
 * dialled, and folding a zero into the latency histogram would drag every
 * quantile toward the floor exactly while the dependency is down.
 */
function recordUpstream(service: string, outcome: UpstreamOutcome, durationMs: number | null): void {
  upstreamCalls?.inc({ service, outcome });
  if (durationMs !== null) upstreamDuration?.observe(durationMs / 1000, { service });
}

export function registerCircuitMetrics(registry: MetricsRegistry): void {
  // Mint the known breakers so their series exist from boot; see the roster note.
  for (const name of UPSTREAM_CIRCUITS) circuits.get(name);

  registry.gauge(
    'upstream_circuit_state',
    'Circuit-breaker state per internal dependency; 1 on the active state. state="open" means we have stopped dialling it.',
    () =>
      circuits.snapshots().flatMap((s) =>
        CIRCUIT_STATES.map((state) => ({
          value: s.state === state ? 1 : 0,
          labels: { service: s.name, state },
        })),
      ),
    ['service', 'state'],
  );
  registry.gauge(
    'upstream_circuit_rejected_total',
    'Calls refused locally without dialling because the breaker was open, cumulative',
    () => circuits.snapshots().map((s) => ({ value: s.rejected, labels: { service: s.name } })),
    ['service'],
  );
  // The leading indicator: this climbing toward the threshold is the window in
  // which a dependency is failing and the platform has not yet given up on it.
  registry.gauge(
    'upstream_circuit_consecutive_failures',
    'Consecutive transient failures against a dependency since its last success',
    () => circuits.snapshots().map((s) => ({ value: s.consecutiveFailures, labels: { service: s.name } })),
    ['service'],
  );
}

/**
 * How a failed exchange is classified for the breaker.
 *
 * `InternalServiceError` already carries the status, so this defers to the
 * shared HTTP table rather than re-deriving anything: a 4xx is our payload
 * being wrong and must not open the breaker (see the note on
 * `CircuitBreaker.recordFailure`), a 5xx and a refused connection are the
 * upstream being unwell and must.
 *
 * The abandoned case — our own deadline firing — is transient here even though
 * `isRetryable` refuses to retry it. That is not a contradiction: the two
 * questions differ, and this is the one that matters for a cascade. An upstream
 * slow enough to burn the full budget on every request is precisely the
 * condition that fills this service's handlers, and a breaker that ignored it
 * would keep dialling right through the worst case it exists for.
 */
export function classifyInternalError(err: unknown): FailureClass {
  if (err instanceof InternalServiceError) {
    if (err.status !== null) return classifyStatus(err.status);
    return {
      kind: 'transient',
      reason: err.abandoned ? 'internal.abandoned' : 'internal.unreachable',
      retryable: !err.abandoned,
    };
  }
  return classifyFailure(err);
}

/** Reads the engine's `issues`/`warnings` array off an error body, defensively. */
export function parseIssues(value: unknown): UpstreamIssue[] {
  if (!Array.isArray(value)) return [];
  const issues: UpstreamIssue[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.message !== 'string') continue;
    issues.push({
      code: typeof item.code === 'string' ? item.code : 'unknown',
      field: typeof item.field === 'string' ? item.field : '',
      message: item.message,
      severity: item.severity === 'warning' ? 'warning' : 'error',
      hint: typeof item.hint === 'string' ? item.hint : null,
    });
  }
  return issues;
}

/**
 * The `loc` paths off a FastAPI/pydantic rejection body — paths only.
 *
 * Both Python services hand a schema failure to `RequestValidationError`, whose
 * body is `{detail: [{loc, msg, type, input}, ...]}`. The reader above tests
 * `typeof detail === 'string'`, so that array falls through to `title`
 * (absent), leaves `opaque` true, and is withheld — correctly, because `input`
 * is the submitted payload verbatim. The cost of withholding it whole was that
 * the analyst got the engine's voice with nothing in the middle: "The
 * calculation could not be run. Correct the inputs it names…", a remedy that
 * promises named inputs attached to a sentence naming none.
 *
 * So: the paths, and nothing else. `msg` and `input` and `ctx` stay withheld.
 * A leading `body` segment is dropped because every payload this client sends
 * is one; `query` and `path` are kept, because they say where to look.
 */
export function parseRefusedFields(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const fields: string[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const loc = (raw as Record<string, unknown>).loc;
    if (!Array.isArray(loc)) continue;
    const segments = loc.filter((s): s is string | number => typeof s === 'string' || typeof s === 'number');
    const path = issuePath(segments[0] === 'body' ? segments.slice(1) : segments);
    if (path !== '' && !fields.includes(path)) fields.push(path);
  }
  return fields;
}

/**
 * A 4xx means our payload was wrong — retrying can't fix it.
 *
 * Neither can retrying a request we abandoned. `status === null` covers two
 * very different failures and used to treat them alike: a refused connection
 * (nobody took the request — retrying is free and is the case the retry exists
 * for) and our own deadline firing (the upstream took the request and is still
 * working on it). Retrying the second one re-sends the whole payload, so a
 * pipeline that is merely slow gets run twice: two LLM calls billed, two of the
 * AI service's forty threadpool slots held on the same job, and the caller
 * waiting out both deadlines before hearing anything.
 */
function isRetryable(err: InternalServiceError): boolean {
  if (err.abandoned) return false;
  return err.status === null || err.status >= 500;
}

/**
 * One completed HTTP exchange with an internal service, as offered to the sink.
 *
 * Per *attempt*, not per call: a request that was retried made two exchanges,
 * and collapsing them would hide the retry, which is exactly the thing an
 * operator is looking for when a pipeline "took four minutes". `status` is null
 * when there was never a response — a refused connection, or our own deadline
 * firing — and `error` then says which.
 */
export interface NetworkCall {
  service: string;
  /** The logical operation, named by the call site: 'engine compute'. */
  name: string;
  valuationId: string;
  request: unknown;
  response: unknown;
  status: number | null;
  error: string | null;
  durationMs: number;
  requestId: string | null;
}

export type NetworkSink = (call: NetworkCall) => void;

/**
 * Where recorded calls go, or null to record nothing.
 *
 * A module-level sink rather than a parameter threaded through every call site,
 * and rather than a pool passed into this file. Persistence needs a database
 * handle, and a JSON HTTP client that imports `pg` to log its own traffic has
 * the layering backwards — the client would then be untestable without a
 * database. The composition root sets this once (`app.ts`); tests set their own
 * and read it back. Unset, every `record` option below is inert, which is what
 * keeps the client's existing unit tests free of any of this.
 */
let networkSink: NetworkSink | null = null;

export function setNetworkSink(sink: NetworkSink | null): void {
  networkSink = sink;
}

/** Below this there is no point starting an attempt; it would only time out. */
const MIN_ATTEMPT_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Shared-secret header for the internal AI/engine services (audit B-1 P0).
 * Read from the environment per-call so the token can rotate without a
 * restart; omitted (and the Python side skips the check) when unset.
 */
export function internalAuthHeaders(): Record<string, string> {
  const token = process.env.INTERNAL_SERVICE_TOKEN;
  return token ? { 'x-internal-token': token } : {};
}

/**
 * Readiness probe for an internal service (`/ready`), used by this service's own
 * /ready. The mechanics live in @n409/shared (the web/BFF needs the same probe
 * for its own readiness); this wrapper only adds the internal shared secret.
 *
 * The AI/engine services leave /ready outside the token check, so the header is
 * strictly belt-and-braces — but it costs nothing and keeps a future decision to
 * protect /ready from silently making us permanently not-ready.
 */
export async function probeReady(
  service: string,
  baseUrl: string,
  opts: { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<void> {
  return sharedProbeReady(service, baseUrl, { ...opts, headers: internalAuthHeaders() });
}

/**
 * POST JSON to an internal service, under one deadline for the whole call.
 *
 * `timeoutMs` is the budget for the call, not for each attempt. It used to be
 * the latter, which meant the number a caller passed was not the time it could
 * be kept waiting: with the default single retry, `timeoutMs: 30_000` was
 * really "up to 60.25 seconds", and the AI pipeline route — which passed no
 * timeout at all, taking the 120s default — was really "up to 240 seconds" of a
 * held Fastify handler with nothing above it enforcing anything shorter.
 *
 * Sharing one budget costs the retry nothing in the case it was written for. A
 * restarting service refuses the connection in milliseconds, so the second
 * attempt still gets essentially the whole budget; only an upstream that is
 * slow rather than absent is now stopped from spending it twice.
 */
export async function postJson<T>(
  service: string,
  url: string,
  body: unknown,
  opts: {
    timeoutMs?: number;
    retries?: number;
    backoffMs?: number;
    /**
     * Record this call against an engagement (409.ai §11, `network_items`).
     * Omitted on calls that are not on behalf of one engagement — a readiness
     * probe, a schema fetch — which have no row to belong to.
     */
    record?: { valuationId: string; name: string };
  } = {},
): Promise<T> {
  // One retry by default: both internal services are stateless computations,
  // so a transient outage/restart shouldn't surface as a failed run.
  //
  // FLAG_RETRY_LADDERS off pins this to zero however the caller asked, which is
  // the point: the reason to throw that switch is a dependency failing slowly,
  // where every retry is load added to the thing least able to carry it. A flag
  // that individual call sites could override would not be a kill switch.
  const retries = flagEnabled(FLAGS.retryLadders) ? (opts.retries ?? 1) : 0;
  const backoffMs = opts.backoffMs ?? 250;
  const budgetMs = opts.timeoutMs ?? 120_000;
  const startedAt = Date.now();
  const remaining = () => budgetMs - (Date.now() - startedAt);
  const record = opts.record;

  const breaker = circuits.get(service);
  try {
    // The breaker wraps the *whole* call, retries included, rather than each
    // attempt. Per-attempt would count one dead upstream twice and trip at half
    // the configured threshold; worse, it would let the retry ladder run inside
    // an already-open breaker, which is the exact spending this is here to stop.
    //
    // FLAG_CIRCUIT_BREAKERS gates the *refusal*, not the bookkeeping: the
    // recordSuccess/recordFailure calls below run either way, so a breaker
    // switched off still watches. That asymmetry is deliberate. A breaker that
    // stopped observing while disabled would come back cold, and the first
    // thing an operator does after turning it back on is send traffic at the
    // dependency they just had an incident about — which is precisely when the
    // memory is worth having. Read per call, so the flag takes effect on the
    // restart that reloads the unit's EnvironmentFile and needs no rebuild.
    if (flagEnabled(FLAGS.circuitBreakers)) breaker.acquire();
  } catch (err) {
    if (!(err instanceof CircuitOpenError)) throw err;
    const seconds = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
    // Recorded like any other failed exchange: an operator reading the
    // engagement's network log should see the calls that were refused locally,
    // not a silent gap where the requests used to be.
    if (record && networkSink) {
      try {
        networkSink({
          service,
          name: record.name,
          valuationId: record.valuationId,
          request: body,
          response: null,
          status: null,
          error: `circuit open — not dialled (retry in ~${seconds}s)`,
          durationMs: 0,
          requestId: currentRequestId() ?? null,
        });
      } catch {
        /* a diagnostic that cannot be written is a diagnostic that is missing */
      }
    }
    recordUpstream(service, 'circuit_open', null);
    throw new InternalServiceError(
      service,
      null,
      `recently failed repeatedly and is not being called (retry in ~${seconds}s)`,
      [],
      false,
      false,
      true,
      seconds,
    );
  }

  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await postJsonOnce<T>(
          service,
          url,
          body,
          Math.max(MIN_ATTEMPT_MS, remaining()),
          record,
        );
        breaker.recordSuccess();
        return result;
      } catch (err) {
        if (!(err instanceof InternalServiceError) || !isRetryable(err) || attempt >= retries) throw err;
        const backoff = backoffMs * 2 ** attempt;
        // A retry the budget cannot pay for is not taken: it would only run
        // headlong into the deadline and report a timeout instead of the real
        // failure we already have in hand.
        if (remaining() - backoff < MIN_ATTEMPT_MS) throw err;
        await sleep(backoff);
      }
    }
  } catch (err) {
    breaker.recordFailure(classifyInternalError(err));
    throw err;
  }
}

async function postJsonOnce<T>(
  service: string,
  url: string,
  body: unknown,
  timeoutMs: number,
  record?: { valuationId: string; name: string },
): Promise<T> {
  const startedAt = Date.now();
  /**
   * Offer this exchange to the sink. Called on every exit path — the success,
   * the upstream rejection, the unreachable host, the unparseable body — because
   * a log that holds only the calls that worked answers none of the questions it
   * exists for.
   *
   * Swallows whatever the sink does with it. The sink's own contract is not to
   * throw, and this belt-and-braces catch is for the case where it does anyway:
   * a diagnostic must not be able to fail a calculation, and — worse — must not
   * be able to replace an accurate upstream error with a misleading one.
   */
  const emit = (fields: Pick<NetworkCall, 'response' | 'status' | 'error'>): void => {
    if (!record || !networkSink) return;
    try {
      networkSink({
        service,
        name: record.name,
        valuationId: record.valuationId,
        request: body,
        durationMs: Date.now() - startedAt,
        requestId: currentRequestId() ?? null,
        ...fields,
      });
    } catch {
      /* a diagnostic that cannot be written is a diagnostic that is missing */
    }
  };

  /**
   * Record a failed exchange and throw the error that describes it.
   *
   * Shared by the two places an exchange can fail without ever producing a
   * body: the fetch, and the read of the body it promised. Splitting the
   * classification across them is how the second one came to have none — see
   * the note on the `res.text()` call below.
   */
  const failExchange = (err: unknown): never => {
    // Our deadline, not their failure: the request may well have been accepted
    // and still be running. Named so the caller's error says whose clock ran
    // out, and flagged so the retry above knows not to duplicate the work.
    const abandoned = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    if (abandoned) {
      const seconds = Math.round(timeoutMs / 1000);
      // Recorded with the duration, which is the figure that makes this row
      // worth having: it says the upstream was still working when we left,
      // rather than that it was down.
      emit({ response: null, status: null, error: `did not respond within ${seconds}s` });
      recordUpstream(service, 'timeout', Date.now() - startedAt);
      throw new InternalServiceError(service, null, `did not respond within ${seconds}s`, [], true);
    }
    // A transport failure's message is written for whoever is holding the
    // stack, not for a client: `getaddrinfo ENOTFOUND engine-wrapper` and
    // `connect ECONNREFUSED 10.0.1.4:3003` both name internal topology. Kept
    // for the log and the call record, withheld from the response.
    const reason = err instanceof Error ? err.message : 'unreachable';
    emit({ response: null, status: null, error: reason });
    recordUpstream(service, 'unreachable', Date.now() - startedAt);
    throw new InternalServiceError(service, null, reason, [], false, true);
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      // The request id makes the engine/AI log lines for this call joinable to
      // ours; the Python side reads it, or mints one when we have none to give.
      headers: { 'content-type': 'application/json', ...internalAuthHeaders(), ...requestIdHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return failExchange(err);
  }
  /**
   * The body, under the same error boundary as the fetch that promised it, and
   * under a ceiling.
   *
   * `res.text()` reads to the end of the stream before it returns, so how much
   * heap this line holds was the upstream's choice and not ours — the same
   * thing `MAX_INTEGRATION_JSON_BYTES` was written about for the third-party
   * clients, and the reason it is not a smaller worry here is only that the
   * upstream is ours. "Ours" is a deployment fact: `ENGINE_URL` and `AI_URL`
   * are environment variables, and a service pointed at something else — a
   * proxy serving a multi-gigabyte error page, a port that answers with
   * whatever is on it — kills this process with no status code and nothing in
   * the log saying why.
   *
   * `AbortSignal.timeout` does not stop at the response headers — it aborts the
   * body stream too — so an upstream that answers and then stalls mid-body
   * fails *here*, at the deadline, with the same `TimeoutError` the fetch would
   * have raised. This `await` used to sit outside every catch in this function,
   * so that one exit path behaved unlike all the others: nothing recorded a
   * `network_items` row, nothing produced an `InternalServiceError`, and the
   * route saw a bare `DOMException` rather than the abandoned-upstream problem
   * it maps to a gateway status. A slow engine looked like a bug in this
   * service, and the diagnostic that would have said otherwise was the one
   * thing not written.
   *
   * The same boundary covers a connection dropped mid-body, which arrives as an
   * ordinary transport error and is retryable for the same reason a refused
   * connection is: there is no complete response either way.
   */
  let text: string;
  try {
    const bytes = await readCappedBytes(res, MAX_INTERNAL_BODY_BYTES);
    if (bytes === null) {
      throw new Error(`answered with a body larger than ${MAX_INTERNAL_BODY_BYTES / (1024 * 1024)} MB`);
    }
    text = bytes.toString('utf8');
  } catch (err) {
    return failExchange(err);
  }
  if (!res.ok) {
    let detail = sliceChars(text, UPSTREAM_DETAIL_CHARS);
    // Forwarded rather than re-guessed: only the upstream knows when its
    // window reopens, and a number invented here would be advice about a
    // dependency this service cannot see.
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    // Until a problem document says otherwise, `detail` is whatever bytes the
    // upstream happened to send — see the `opaque` field on the error.
    let opaque = true;
    let issues: UpstreamIssue[] = [];
    let refusedFields: string[] = [];
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; title?: unknown; issues?: unknown };
      // Bounded on this branch too. The raw-text branch above was cut at 500
      // and this one was not, so the bound stopped applying exactly when the
      // upstream's answer *parsed* — and a parsed answer is the one that goes
      // furthest: `opaque` is false, so `toProblem` puts it verbatim into an
      // HTTP response body, and `emit` puts it in a `text` column no
      // `boundedJson` pass reaches. A `detail` is a sentence written for a
      // caller to read; anything past this bound is not that.
      if (typeof parsed.detail === 'string') {
        detail = sliceChars(parsed.detail, UPSTREAM_DETAIL_CHARS);
        opaque = false;
      } else if (typeof parsed.title === 'string') {
        detail = sliceChars(parsed.title, UPSTREAM_DETAIL_CHARS);
        opaque = false;
      }
      issues = parseIssues(parsed.issues);
      refusedFields = parseRefusedFields(parsed.detail);
    } catch {
      /* keep raw text */
    }
    // The body as it arrived, parsed when it was JSON and raw when it was not.
    // On a rejection the raw text is often the whole answer — a stack trace, a
    // proxy's HTML error page — and re-reading it later beats re-running the
    // call that produced it.
    emit({ response: safeParse(text), status: res.status, error: detail });
    recordUpstream(service, res.status >= 500 ? 'failed' : 'rejected', Date.now() - startedAt);
    throw new InternalServiceError(
      service,
      res.status,
      detail,
      issues,
      false,
      opaque,
      false,
      retryAfter,
      refusedFields,
    );
  }
  let parsed: T;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    emit({ response: sliceChars(text, 2_000), status: res.status, error: 'invalid JSON in response body' });
    recordUpstream(service, 'bad_body', Date.now() - startedAt);
    throw new InternalServiceError(service, res.status, 'invalid JSON in response body');
  }
  emit({ response: parsed, status: res.status, error: null });
  recordUpstream(service, 'ok', Date.now() - startedAt);
  return parsed;
}

/**
 * The `retry-after` header as whole seconds, or null when there isn't a usable one.
 *
 * RFC 9110 allows a delta or an HTTP-date; the internal services send a delta,
 * but a proxy between here and there may rewrite it, and a date parsed as NaN
 * would otherwise ride out to a client as `retry-after: NaN`. Anything past a
 * day is a message for an operator rather than a wait for a browser tab, so it
 * is clamped to one.
 */
/**
 * How much of an upstream's rejection is kept as the `detail`.
 *
 * `sliceChars` rather than `slice` for the reason `safeParse` below already
 * states: cutting a body at 500 UTF-16 units can land inside an emoji, and the
 * orphaned half is stored as `U+FFFD` in `network_items.error` — a `text`
 * column, so no `boundedJson` pass edits it on the way in — and rides out to a
 * caller in a problem document besides.
 */
const UPSTREAM_DETAIL_CHARS = 500;

const MAX_UPSTREAM_RETRY_AFTER_S = 86_400;

export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const raw = header.trim();
  const delta = Number(raw);
  const seconds = Number.isFinite(delta) && raw !== '' ? delta : (Date.parse(raw) - Date.now()) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(Math.ceil(seconds), MAX_UPSTREAM_RETRY_AFTER_S);
}

/** JSON when it parses, the raw text when it does not. Never throws. */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // `sliceChars`, not `slice`: cutting an upstream body at 2,000 UTF-16 units
    // can land inside an emoji, and half a character is a string the JSONB
    // insert behind `emit` cannot hold. See domain/textSlice.ts.
    return sliceChars(text, 2_000);
  }
}

/**
 * The upstream's own words when it wrote them for a caller, and nothing when
 * it did not. See `InternalServiceError.opaque`.
 */
function describedBy(err: InternalServiceError): string | null {
  return err.opaque ? null : err.detail;
}

/** Named fields in the sentence, bounded, then a count of the rest. */
const MAX_NAMED_FIELDS = 3;

/**
 * What a withheld schema rejection is still allowed to say.
 *
 * The body it comes from stays withheld — see {@link
 * InternalServiceError.refusedFields} for why only the paths survive. This is
 * the middle of `compose`, so it is a fragment rather than a sentence, and it
 * is bounded for the reason `describeIssues` is: a badly-shaped payload
 * produces one entry per field the schema expected, and a message stops being
 * read once it stops fitting where the UI puts it.
 */
function refusedFieldsSentence(fields: readonly string[]): string | null {
  if (fields.length === 0) return null;
  const named = fields.slice(0, MAX_NAMED_FIELDS);
  const hidden = fields.length - named.length;
  const list = named.join(', ');
  return hidden > 0
    ? `it refused ${list} (and ${hidden} more field${hidden === 1 ? '' : 's'})`
    : `it refused ${list}`;
}

/**
 * What the user is told when a dependency is down, per service.
 *
 * The generic "the ai service is unavailable" is accurate and useless: it names
 * an internal component the reader has never heard of, and says nothing about
 * the two things they actually need — whether their work survived, and whether
 * to wait or to do something else. These say both. They are also the only
 * user-facing strings in this file, which is why they are here rather than
 * inlined: a message that appears in front of a paying client during an outage
 * deserves to be reviewable in one place.
 */
const DEGRADED_MESSAGES: Record<string, string> = {
  ai: 'AI assistance is temporarily unavailable. Your valuation and all its inputs are saved — the analysis can be re-run once the service recovers, and nothing needs re-entering.',
  engine:
    'The calculation service is temporarily unavailable. Your inputs are saved; re-run the calculation shortly.',
};

function degradedMessage(service: string): string {
  return (
    DEGRADED_MESSAGES[service] ?? `The ${service} service is temporarily unavailable. Please retry shortly.`
  );
}

/**
 * What to call each service in front of a client, and what they do about it.
 *
 * The reasoning above stopped one branch short. `DEGRADED_MESSAGES` exists
 * because "the ai service is unavailable" names an internal component the
 * reader has never heard of and says nothing about what to do — and then the
 * other three arms of `toProblem` went on saying exactly that: an analyst whose
 * run failed pre-flight was told "engine rejected the request", which reads as
 * a bug in this platform rather than as a field they have to go and fill in.
 *
 * `label` is the name the surface already uses for the thing ("the
 * calculation", "the AI analysis"), so the sentence is about the work the
 * person was doing. `remedy` is the half that cannot be derived: what survived,
 * and what to do next. Both are per service because the answers differ — a
 * rejected calculation has an input to fix; a rejected AI job usually has a
 * document to replace.
 */
interface ServiceVoice {
  label: string;
  /** What to do when the upstream refused our payload (a 4xx). */
  rejectedRemedy: string;
  /** What to do when the upstream never answered or broke (a 5xx). */
  brokenRemedy: string;
}

const SERVICE_VOICE: Record<string, ServiceVoice> = {
  engine: {
    label: 'The calculation could not be run',
    rejectedRemedy:
      'Correct the inputs it names on the valuation’s parameters and run the calculation again.',
    brokenRemedy: 'Your inputs are saved — run the calculation again in a few minutes.',
  },
  ai: {
    label: 'The AI analysis could not be completed',
    rejectedRemedy: 'Check the documents and prompt this run was given, then start it again.',
    brokenRemedy: 'Your valuation and its inputs are saved — start the analysis again in a few minutes.',
  },
  report: {
    label: 'The report could not be rendered',
    rejectedRemedy: 'Check the report’s content for a section that cannot be laid out, then render again.',
    brokenRemedy: 'The report’s content is saved — try the download again in a few minutes.',
  },
};

function voiceOf(service: string): ServiceVoice {
  return (
    SERVICE_VOICE[service] ?? {
      label: `The ${service} step could not be completed`,
      rejectedRemedy: 'Check the inputs to this step and try again.',
      brokenRemedy: 'Nothing has been lost — try again in a few minutes.',
    }
  );
}

/**
 * `label`, the upstream's own words when it wrote any, then the remedy.
 *
 * The upstream sentence is the middle rather than the whole message, which is
 * the entire change: it was previously all there was on two of these arms, and
 * on an opaque body there was nothing at all.
 */
function compose(label: string, said: string | null, remedy?: string): string {
  // The upstream's sentence may or may not be punctuated — the engine's
  // pre-flight messages are not, pydantic's are — and this is one string, so a
  // trailing stop from there and the one added here read as a typo.
  const middle = said?.trim().replace(/[.;:,\s]+$/, '') ?? '';
  const head = middle === '' ? label : `${label}: ${middle}`;
  // The 429 arm passes no remedy when `tooManyRequests` is about to append the
  // wait itself; every other arm has one and always has.
  return remedy === undefined ? head : `${head}. ${remedy}`;
}

/** Converts an InternalServiceError to the client-facing ApiProblem. */
export function toProblem(err: InternalServiceError): ApiProblem {
  const said = describedBy(err) ?? refusedFieldsSentence(err.refusedFields);
  // A breaker rejection is not "bad gateway" — nothing was dialled, and the
  // honest answer is 503 with a time to come back. It is also the one upstream
  // failure the caller can do something useful about, so it gets a sentence
  // written for a person rather than the upstream's own words.
  if (err.circuitOpen) {
    return new ApiProblem({
      status: 503,
      title: 'Service Unavailable',
      type: 'urn:n409:problem:upstream-degraded',
      detail: degradedMessage(err.service),
      // Drives the `retry-after` header via registerProblemHandler, so a client
      // that honours it backs off for exactly as long as the breaker is shut —
      // which also stops well-behaved clients from being the retry storm.
      ...(err.retryAfterSeconds !== null ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
    });
  }
  // An upstream 429 is neither a bad gateway nor a malformed request: the
  // dependency is healthy and out of allowance. It used to fall into the 4xx
  // arm below and reach the analyst as "the ai service rejected the request",
  // which reads as a bug in their valuation — the one reading of it that is
  // both wrong and actionable, so people acted on it.
  const voice = voiceOf(err.service);
  if (err.status === 429) {
    // The wait is only ours to state when the upstream told us one. Without a
    // `retry-after` the honest answer is a shrug, and `tooManyRequests` appends
    // nothing to a 429 it was given no seconds for.
    return problems.tooManyRequests(
      compose(
        `${voice.label} — the service is at its request allowance`,
        said,
        err.retryAfterSeconds === null ? 'Try again in a few minutes.' : undefined,
      ),
      err.retryAfterSeconds ?? undefined,
    );
  }
  if (err.status !== null && err.status >= 400 && err.status < 500) {
    // Field-level issues ride along as a problem extension so the UI can
    // anchor each message to the input that caused it. They survive an opaque
    // body because `parseIssues` builds them field by field from a known
    // shape — nothing unrecognised is copied through.
    return problems.unprocessable(
      compose(voice.label, said, voice.rejectedRemedy),
      err.issues.length > 0 ? { issues: err.issues } : undefined,
    );
  }
  return new ApiProblem({
    status: 502,
    title: 'Bad Gateway',
    type: 'urn:n409:problem:upstream',
    detail: compose(voice.label, said, voice.brokenRemedy),
  });
}

/**
 * The sentence to show a person for an upstream failure that is not being
 * answered with a problem document.
 *
 * Several places report an upstream failure inside a 200 body or store it in a
 * column the UI draws — a bulk endpoint answering per row, the `error` on a
 * failed `calculations` or `ai_jobs` row — and every one of them reached for
 * `err.message`. That is `${service}: ${detail}`, which is two things this file
 * spends its length being careful about:
 *
 *   - `detail` is the raw upstream body whenever {@link
 *     InternalServiceError.opaque} is set, which is the case `opaque` exists
 *     for: a pydantic error list echoing the payload, a traceback, a proxy's
 *     HTML page. `toProblem` withholds it through `describedBy`; `err.message`
 *     is the same string with nothing consulted. A stored one is worse than a
 *     leaked 502 body, because it is drawn again every time the row is listed.
 *   - `service` is an internal component name. The note on DEGRADED_MESSAGES
 *     already says why that is useless to the reader: it "names an internal
 *     component the reader has never heard of".
 *
 * So: the same composition `toProblem` builds, which is the one place that
 * decides whether an upstream's words may be repeated. Callers that store this
 * keep the whole error in their log line, which is where the traceback belongs.
 */
export function describeForUser(err: InternalServiceError): string {
  return toProblem(err).detail ?? voiceOf(err.service).label;
}
