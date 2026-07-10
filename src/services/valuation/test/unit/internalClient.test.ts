import { afterEach, describe, expect, it, vi } from 'vitest';
import { InternalServiceError, postJson, toProblem } from '../../src/clients/internal.js';

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
