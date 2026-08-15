import {
  ApiProblem,
  CircuitOpenError,
  CircuitRegistry,
  classifyFailure,
  classifyStatus,
  currentRequestId,
  probeReady as sharedProbeReady,
  problems,
  requestIdHeaders,
  type FailureClass,
} from '@n409/shared';

/**
 * Thin JSON client for the internal AI / engine services. Failures surface as
 * problems: an upstream 4xx means our payload was incomplete (→ 422 to the
 * client); anything else is a 502 so an outage never reads as a valuation bug.
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
    /** Seconds until the breaker will admit a trial call; only set with `circuitOpen`. */
    readonly retryAfterSeconds: number | null = null,
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
});

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
  const retries = opts.retries ?? 1;
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
    breaker.acquire();
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
      throw new InternalServiceError(service, null, `did not respond within ${seconds}s`, [], true);
    }
    // A transport failure's message is written for whoever is holding the
    // stack, not for a client: `getaddrinfo ENOTFOUND engine-wrapper` and
    // `connect ECONNREFUSED 10.0.1.4:3003` both name internal topology. Kept
    // for the log and the call record, withheld from the response.
    const reason = err instanceof Error ? err.message : 'unreachable';
    emit({ response: null, status: null, error: reason });
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
   * The body, under the same error boundary as the fetch that promised it.
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
    text = await res.text();
  } catch (err) {
    return failExchange(err);
  }
  if (!res.ok) {
    let detail = text.slice(0, 500);
    // Until a problem document says otherwise, `detail` is whatever bytes the
    // upstream happened to send — see the `opaque` field on the error.
    let opaque = true;
    let issues: UpstreamIssue[] = [];
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; title?: unknown; issues?: unknown };
      if (typeof parsed.detail === 'string') {
        detail = parsed.detail;
        opaque = false;
      } else if (typeof parsed.title === 'string') {
        detail = parsed.title;
        opaque = false;
      }
      issues = parseIssues(parsed.issues);
    } catch {
      /* keep raw text */
    }
    // The body as it arrived, parsed when it was JSON and raw when it was not.
    // On a rejection the raw text is often the whole answer — a stack trace, a
    // proxy's HTML error page — and re-reading it later beats re-running the
    // call that produced it.
    emit({ response: safeParse(text), status: res.status, error: detail });
    throw new InternalServiceError(service, res.status, detail, issues, false, opaque);
  }
  let parsed: T;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    emit({ response: text.slice(0, 2_000), status: res.status, error: 'invalid JSON in response body' });
    throw new InternalServiceError(service, res.status, 'invalid JSON in response body');
  }
  emit({ response: parsed, status: res.status, error: null });
  return parsed;
}

/** JSON when it parses, the raw text when it does not. Never throws. */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 2_000);
  }
}

/**
 * The upstream's own words when it wrote them for a caller, and nothing when
 * it did not. See `InternalServiceError.opaque`.
 */
function describedBy(err: InternalServiceError): string | null {
  return err.opaque ? null : err.detail;
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

/** Converts an InternalServiceError to the client-facing ApiProblem. */
export function toProblem(err: InternalServiceError): ApiProblem {
  const said = describedBy(err);
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
  if (err.status !== null && err.status >= 400 && err.status < 500) {
    // Field-level issues ride along as a problem extension so the UI can
    // anchor each message to the input that caused it. They survive an opaque
    // body because `parseIssues` builds them field by field from a known
    // shape — nothing unrecognised is copied through.
    return problems.unprocessable(
      said === null ? `${err.service} rejected the request.` : `${err.service} rejected the request: ${said}`,
      err.issues.length > 0 ? { issues: err.issues } : undefined,
    );
  }
  return new ApiProblem({
    status: 502,
    title: 'Bad Gateway',
    type: 'urn:n409:problem:upstream',
    detail: said === null ? `${err.service} is unavailable.` : `${err.service} is unavailable: ${said}`,
  });
}
