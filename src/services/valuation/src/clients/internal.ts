import { ApiProblem, problems } from '@n409/shared';

/**
 * Thin JSON client for the internal AI / engine services. Failures surface as
 * problems: an upstream 4xx means our payload was incomplete (→ 422 to the
 * client); anything else is a 502 so an outage never reads as a valuation bug.
 */
export class InternalServiceError extends Error {
  constructor(
    readonly service: string,
    readonly status: number | null,
    readonly detail: string,
  ) {
    super(`${service}: ${detail}`);
  }
}

/** A 4xx means our payload was wrong — retrying can't fix it. */
function isRetryable(err: InternalServiceError): boolean {
  return err.status === null || err.status >= 500;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function postJsonOnce<T>(
  service: string,
  url: string,
  body: unknown,
  timeoutMs?: number,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; title?: unknown };
      if (typeof parsed.detail === 'string') detail = parsed.detail;
      else if (typeof parsed.title === 'string') detail = parsed.title;
    } catch {
      /* keep raw text */
    }
    throw new InternalServiceError(service, res.status, detail);
  }
  return JSON.parse(text) as T;
}

/** Converts an InternalServiceError to the client-facing ApiProblem. */
export function toProblem(err: InternalServiceError): ApiProblem {
  if (err.status !== null && err.status >= 400 && err.status < 500) {
    return problems.unprocessable(`${err.service} rejected the request: ${err.detail}`);
  }
  return new ApiProblem({
    status: 502,
    title: 'Bad Gateway',
    type: 'urn:n409:problem:upstream',
    detail: `${err.service} is unavailable: ${err.detail}`,
  });
}
