import {
  ApiProblem,
  currentRequestId,
  probeReady as sharedProbeReady,
  problems,
  requestIdHeaders,
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
  ) {
    super(`${service}: ${detail}`);
  }
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

  for (let attempt = 0; ; attempt++) {
    try {
      return await postJsonOnce<T>(service, url, body, Math.max(MIN_ATTEMPT_MS, remaining()), record);
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
    const reason = err instanceof Error ? err.message : 'unreachable';
    emit({ response: null, status: null, error: reason });
    throw new InternalServiceError(service, null, reason);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 500);
    let issues: UpstreamIssue[] = [];
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; title?: unknown; issues?: unknown };
      if (typeof parsed.detail === 'string') detail = parsed.detail;
      else if (typeof parsed.title === 'string') detail = parsed.title;
      issues = parseIssues(parsed.issues);
    } catch {
      /* keep raw text */
    }
    // The body as it arrived, parsed when it was JSON and raw when it was not.
    // On a rejection the raw text is often the whole answer — a stack trace, a
    // proxy's HTML error page — and re-reading it later beats re-running the
    // call that produced it.
    emit({ response: safeParse(text), status: res.status, error: detail });
    throw new InternalServiceError(service, res.status, detail, issues);
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

/** Converts an InternalServiceError to the client-facing ApiProblem. */
export function toProblem(err: InternalServiceError): ApiProblem {
  if (err.status !== null && err.status >= 400 && err.status < 500) {
    // Field-level issues ride along as a problem extension so the UI can
    // anchor each message to the input that caused it.
    return problems.unprocessable(
      `${err.service} rejected the request: ${err.detail}`,
      err.issues.length > 0 ? { issues: err.issues } : undefined,
    );
  }
  return new ApiProblem({
    status: 502,
    title: 'Bad Gateway',
    type: 'urn:n409:problem:upstream',
    detail: `${err.service} is unavailable: ${err.detail}`,
  });
}
