import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InternalServiceError,
  internalAuthHeaders,
  parseIssues,
  postJson,
  toProblem,
} from '../../src/clients/internal.js';

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
