import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InternalServiceError,
  internalAuthHeaders,
  parseIssues,
  parseRetryAfter,
  postJson,
  setNetworkSink,
  toProblem,
  type NetworkCall,
} from '../../src/clients/internal.js';
import { runWithRequestId } from '@n409/shared';
import { AI_PIPELINE_TIMEOUT_MS } from '../../src/routes/ai.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('internal client retry (IMPROVEMENTS_RESEARCH §6 — error handling)', () => {
  it('retries once on a 5xx and succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { detail: 'restarting' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await postJson<{ ok: boolean }>('ai-service', 'http://x/y', {}, { backoffMs: 1 });
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on network errors', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postJson('engine', 'http://x/y', {}, { backoffMs: 1 })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never retries a 4xx — the payload will not get better', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(422, { detail: 'bad inputs' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postJson('engine', 'http://x/y', {}, { backoffMs: 1 })).rejects.toBeInstanceOf(
      InternalServiceError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry budget and surfaces the upstream error', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(502, { detail: 'down' }));
    vi.stubGlobal('fetch', fetchMock);

    const err = await postJson('ai-service', 'http://x/y', {}, { retries: 2, backoffMs: 1 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InternalServiceError);
    expect((err as InternalServiceError).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Maps to a 502 problem, not a client error.
    expect(toProblem(err as InternalServiceError).status).toBe(502);
  });

  it('retries can be disabled', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(503, { detail: 'down' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postJson('engine', 'http://x/y', {}, { retries: 0 })).rejects.toBeInstanceOf(
      InternalServiceError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('internal shared-secret header (audit B-1 P0)', () => {
  const original = process.env.INTERNAL_SERVICE_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
    else process.env.INTERNAL_SERVICE_TOKEN = original;
  });

  it('omits the header when no token is configured', () => {
    delete process.env.INTERNAL_SERVICE_TOKEN;
    expect(internalAuthHeaders()).toEqual({});
  });

  it('emits x-internal-token when configured', () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'top-secret';
    expect(internalAuthHeaders()).toEqual({ 'x-internal-token': 'top-secret' });
  });

  it('attaches the token to every outgoing AI/engine request', async () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'top-secret';
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await postJson('ai-service', 'http://ai/pipe', { a: 1 });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-internal-token']).toBe('top-secret');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
});

describe('invalid JSON response handling', () => {
  it('wraps non-JSON 200 response as InternalServiceError', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('not json at all', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const err = await postJson('engine', 'http://x/y', {}, { retries: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InternalServiceError);
    expect((err as InternalServiceError).detail).toBe('invalid JSON in response body');
    expect((err as InternalServiceError).status).toBe(200);
  });
});

describe('structured upstream issues', () => {
  it('carries the engine issue array onto the error and the problem', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(422, {
        detail: 'volatility is required (and 1 more input problem)',
        issues: [
          {
            code: 'required',
            field: 'inputs.volatility',
            message: 'volatility is required',
            severity: 'error',
            hint: 'Run the volatility estimator.',
          },
          {
            code: 'not_positive',
            field: 'inputs.market.metric',
            message: 'market.metric must be positive',
            severity: 'error',
            hint: null,
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const err = (await postJson('engine', 'http://x/y', {}, { retries: 0 }).catch(
      (e: unknown) => e,
    )) as InternalServiceError;
    expect(err.issues).toHaveLength(2);
    expect(err.issues[0]!.field).toBe('inputs.volatility');

    const problem = toProblem(err);
    expect(problem.status).toBe(422);
    expect((problem.extensions as { issues: unknown[] }).issues).toHaveLength(2);
  });

  it('leaves issues empty when the upstream sends none', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(422, { detail: 'nope' }));
    vi.stubGlobal('fetch', fetchMock);

    const err = (await postJson('engine', 'http://x/y', {}, { retries: 0 }).catch(
      (e: unknown) => e,
    )) as InternalServiceError;
    expect(err.issues).toEqual([]);
    expect(toProblem(err).extensions).toBeUndefined();
  });
});

describe('parseIssues', () => {
  it('drops entries that are not issue-shaped and defaults the rest', () => {
    expect(
      parseIssues([
        null,
        'nope',
        { field: 'x' }, // no message
        { message: 'bare' },
        { message: 'warn me', severity: 'warning', code: 'c', field: 'f', hint: 'h' },
      ]),
    ).toEqual([
      { code: 'unknown', field: '', message: 'bare', severity: 'error', hint: null },
      { code: 'c', field: 'f', message: 'warn me', severity: 'warning', hint: 'h' },
    ]);
  });

  it('returns an empty array for anything that is not a list', () => {
    expect(parseIssues(undefined)).toEqual([]);
    expect(parseIssues({ issues: [] })).toEqual([]);
  });
});

describe('request-id propagation to the internal services', () => {
  it('forwards the active request id so the engine logs under our id', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await runWithRequestId('req-abc', () => postJson('engine', 'http://engine/compute', { a: 1 }));

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-request-id']).toBe('req-abc');
  });

  it('sends no request id outside a request, letting the engine mint its own', async () => {
    // Background work — the pipeline reaper, a cron sweep — has no inbound
    // request to correlate to, and a made-up id would appear in no other log.
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await postJson('engine', 'http://engine/compute', { a: 1 });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-request-id']).toBeUndefined();
  });

  it('keeps the id across the retry, so both attempts are traceable', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { detail: 'restarting' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await runWithRequestId('req-retry', () =>
      postJson('engine', 'http://engine/compute', {}, { backoffMs: 1 }),
    );

    for (const call of fetchMock.mock.calls) {
      expect(((call[1] as RequestInit).headers as Record<string, string>)['x-request-id']).toBe('req-retry');
    }
  });

  it('carries both the shared secret and the request id together', async () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'top-secret';
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await runWithRequestId('req-both', () => postJson('ai-service', 'http://ai/pipe', {}));

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-internal-token']).toBe('top-secret');
    expect(headers['x-request-id']).toBe('req-both');
    delete process.env.INTERNAL_SERVICE_TOKEN;
  });
});

describe('internal client whole-call deadline', () => {
  /** Rejects the way `fetch` does when its AbortSignal.timeout fires. */
  const timeoutError = () => Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });

  it('does not re-send a request it abandoned on our own deadline', async () => {
    // The upstream took the request and may still be running it. Sending the
    // payload again bills a second set of LLM calls and holds a second slot in
    // the AI service's threadpool for one job the caller asked for once.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postJson('ai-service', 'http://x/y', {}, { backoffMs: 1 })).rejects.toBeInstanceOf(
      InternalServiceError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries a refused connection, which is what the retry is for', async () => {
    // The distinction the flag draws: nobody accepted this request, so re-sending
    // it duplicates nothing.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postJson('ai-service', 'http://x/y', {}, { backoffMs: 1 })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('says whose clock ran out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError()));
    const err = await postJson('ai-service', 'http://x/y', {}, { timeoutMs: 5_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(InternalServiceError);
    expect(err.abandoned).toBe(true);
    expect(err.detail).toBe('did not respond within 5s');
  });

  it('spends one budget across attempts rather than one per attempt', async () => {
    // Two attempts against a 5xx, with the budget nearly gone. Previously each
    // attempt started a fresh `timeoutMs`, so the caller's number bounded an
    // attempt and not the wait.
    const deadlines: number[] = [];
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      // AbortSignal.timeout(n) is opaque, so record elapsed budget indirectly:
      // the attempt must be given less than the full budget the second time.
      deadlines.push(Date.now());
      void init;
      return jsonResponse(503, { detail: 'restarting' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const started = Date.now();
    await postJson('engine', 'http://x/y', {}, { timeoutMs: 400, retries: 5, backoffMs: 120 }).catch(
      (e) => e,
    );
    const elapsed = Date.now() - started;

    // Five retries at 120ms doubling would run for seconds; the 400ms budget
    // stops it, and stops it by declining a retry it cannot pay for rather than
    // by running one into the deadline.
    expect(elapsed).toBeLessThan(400);
    expect(fetchMock.mock.calls.length).toBeLessThan(6);
  });

  it('leaves a restart-time retry essentially the whole budget', async () => {
    // The retry's reason for existing must survive the shared budget: a refused
    // connection fails in milliseconds, so attempt two is not squeezed.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postJson('engine', 'http://x/y', {}, { timeoutMs: 30_000, backoffMs: 1 })).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('the AI pipeline deadline outlasts the AI service budget', () => {
  it('waits longer than the upstream is allowed to take', async () => {
    // openrouter.DEFAULT_CALL_BUDGET_S is 150s. Our deadline has to be the
    // looser of the two, or we abandon work that was going to succeed.
    const AI_SERVICE_CALL_BUDGET_MS = 150_000;
    expect(AI_PIPELINE_TIMEOUT_MS).toBeGreaterThan(AI_SERVICE_CALL_BUDGET_MS);
  });
});

/**
 * `AbortSignal.timeout` does not stop at the response headers — it aborts the
 * body stream too. So an upstream that answers and then stalls mid-body fails
 * at the `res.text()` rather than at the `fetch`, and that `await` used to sit
 * outside every catch in `postJsonOnce`: no `network_items` row, no
 * `InternalServiceError`, and a bare `DOMException` reaching the route instead
 * of the upstream problem it maps to a 502. A slow engine looked like a bug in
 * this service, and the diagnostic that would have said otherwise was the one
 * thing not written.
 */
describe('internal client — the body is inside the error boundary too', () => {
  /**
   * Headers arrived; the body then fails.
   *
   * A real `Response` over a stream that errors, rather than an object with a
   * rejecting `text()`: the read is capped now (`MAX_INTERNAL_BODY_BYTES`), so
   * it goes through the body stream, and a double that has only `text()` would
   * be asserting against a shape the client no longer uses.
   */
  const failingBody = (err: Error): Response =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(err);
        },
      }),
      { status: 200 },
    );

  /** The body aborts, the way undici reports our deadline. */
  const abortMidBody = (name: 'TimeoutError' | 'AbortError' = 'TimeoutError') =>
    failingBody(Object.assign(new Error('The operation was aborted'), { name }));

  /** The connection died — undici's `terminated`. */
  const resetMidBody = () => failingBody(new TypeError('terminated'));

  afterEach(() => {
    setNetworkSink(null);
  });

  it('reports a body that timed out as the deadline it was, not as a 500', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(abortMidBody()));
    const err = await postJson('engine', 'http://x/y', {}, { timeoutMs: 5_000 }).catch((e) => e);

    expect(err).toBeInstanceOf(InternalServiceError);
    expect(err.abandoned).toBe(true);
    expect(err.detail).toBe('did not respond within 5s');
    expect(toProblem(err as InternalServiceError).status).toBe(502);
  });

  it('does not re-send a call whose body our own deadline abandoned', async () => {
    // Same reason the headers case does not: the upstream took the request and
    // may still be running it.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(abortMidBody())
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postJson('engine', 'http://x/y', {}, { backoffMs: 1 })).rejects.toBeInstanceOf(
      InternalServiceError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an AbortError mid-body is classified the same way as a TimeoutError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(abortMidBody('AbortError')));
    const err = await postJson('engine', 'http://x/y', {}, { timeoutMs: 30_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(InternalServiceError);
    expect(err.abandoned).toBe(true);
  });

  it('retries a connection dropped mid-body — there is no complete response either way', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resetMidBody())
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postJson('engine', 'http://x/y', {}, { backoffMs: 1 })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('records the failed exchange, which is the row that names the real culprit', async () => {
    const calls: NetworkCall[] = [];
    setNetworkSink((call) => calls.push(call));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(abortMidBody()));

    await postJson(
      'engine',
      'http://x/y',
      { cap_table: 'big' },
      { timeoutMs: 5_000, record: { valuationId: '01JAAAAAAAAAAAAAAAAAAAAAAA', name: 'engine compute' } },
    ).catch(() => undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      service: 'engine',
      name: 'engine compute',
      status: null,
      error: 'did not respond within 5s',
      response: null,
    });
  });
});

/**
 * An upstream that is healthy and out of allowance (R197, methodology M5).
 *
 * The AI service raises this whenever OpenRouter's free-tier quota is spent —
 * a daily cap on the *key*, so every model in the fallback chain refuses at
 * once, which is why the whole call fails rather than falling through. It used
 * to be reported as a 503, and everything downstream then did the wrong thing
 * with it: `postJson` retried (a second full chain of provider calls against a
 * key that had already said no), the breaker counted both, and five of them
 * shut AI off for every other engagement on the platform. It reached the
 * analyst as "the ai service rejected the request", which reads as a bug in
 * the valuation they were working on.
 */
describe('an upstream that is rate limited, not broken', () => {
  function rateLimited(seconds?: string): Response {
    return new Response(JSON.stringify({ detail: 'All models failed: HTTP 429' }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        ...(seconds !== undefined ? { 'retry-after': seconds } : {}),
      },
    });
  }

  it('is not retried — the quota does not refill in 250ms', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => rateLimited('60'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postJson('ai', 'http://x/y', {}, { backoffMs: 1 })).rejects.toBeInstanceOf(
      InternalServiceError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("carries the upstream's retry-after onto the error", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rateLimited('90')));
    const err = await postJson('ai', 'http://x/y', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InternalServiceError);
    expect((err as InternalServiceError).retryAfterSeconds).toBe(90);
  });

  it('becomes a 429 to our own caller, not a 422', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rateLimited('90')));
    const err = (await postJson('ai', 'http://x/y', {}).catch((e: unknown) => e)) as InternalServiceError;
    const problem = toProblem(err);
    expect(problem.status).toBe(429);
    expect(problem.retryAfterSeconds).toBe(90);
    // Names the work, states the condition, and repeats the wait in the prose —
    // `retry-after` is a header a browser does not show anybody.
    expect(problem.detail).toContain('The AI analysis could not be completed');
    expect(problem.detail).toContain('request allowance');
    // `retryPhrase` rounds a minute-and-a-half up to "about 2 minutes" on
    // purpose: under a minute stays in seconds, above it the exact figure is
    // spurious by the time it is read. The pin is that the wait is in the
    // prose, not only in the header.
    expect(problem.detail).toContain('2 minutes');
  });

  it('still answers 429 when the upstream stated no wait', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rateLimited()));
    const err = (await postJson('ai', 'http://x/y', {}).catch((e: unknown) => e)) as InternalServiceError;
    expect(err.retryAfterSeconds).toBeNull();
    expect(toProblem(err).status).toBe(429);
  });

  it('leaves every other 4xx as the unprocessable it was', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(422, { detail: 'volatility is required' })),
    );
    const err = (await postJson('engine', 'http://x/y', {}).catch((e: unknown) => e)) as InternalServiceError;
    const problem = toProblem(err);
    expect(problem.status).toBe(422);
    expect(problem.detail).toContain('volatility is required');
  });
});

describe('parseRetryAfter', () => {
  it('reads a delta in seconds', () => {
    expect(parseRetryAfter('120')).toBe(120);
  });

  it('reads an HTTP-date, which a proxy in between may have rewritten it into', () => {
    const when = new Date(Date.now() + 120_000).toUTCString();
    expect(parseRetryAfter(when)).toBeGreaterThan(60);
    expect(parseRetryAfter(when)).toBeLessThanOrEqual(121);
  });

  it('rounds a fractional wait up rather than down to nothing', () => {
    expect(parseRetryAfter('0.4')).toBe(1);
  });

  it.each([null, '', '   ', 'soon', '-5', '0', 'NaN'])(
    'refuses %o rather than emitting it as a header',
    (header) => {
      expect(parseRetryAfter(header)).toBeNull();
    },
  );

  it('clamps a wait longer than a day', () => {
    expect(parseRetryAfter(String(60 * 60 * 24 * 30))).toBe(86_400);
  });
});
