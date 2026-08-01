import { ApiProblem, probeReady as sharedProbeReady, problems } from '@n409/shared';

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

/** A 4xx means our payload was wrong — retrying can't fix it. */
function isRetryable(err: InternalServiceError): boolean {
  return err.status === null || err.status >= 500;
}

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

export async function postJson<T>(
  service: string,
  url: string,
  body: unknown,
  opts: { timeoutMs?: number; retries?: number; backoffMs?: number } = {},
): Promise<T> {
  // One retry by default: both internal services are stateless computations,
  // so a transient outage/restart shouldn't surface as a failed run.
  const retries = opts.retries ?? 1;
  const backoffMs = opts.backoffMs ?? 250;
  for (let attempt = 0; ; attempt++) {
    try {
      return await postJsonOnce<T>(service, url, body, opts.timeoutMs);
    } catch (err) {
      if (err instanceof InternalServiceError && isRetryable(err) && attempt < retries) {
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
}

async function postJsonOnce<T>(service: string, url: string, body: unknown, timeoutMs?: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalAuthHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs ?? 120_000),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unreachable';
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
    throw new InternalServiceError(service, res.status, detail, issues);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new InternalServiceError(service, res.status, 'invalid JSON in response body');
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
