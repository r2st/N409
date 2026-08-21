import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { circuits, InternalServiceError, postJson } from '../../src/clients/internal.js';

/**
 * The two kill switches that cross this client: FLAG_CIRCUIT_BREAKERS and
 * FLAG_RETRY_LADDERS.
 *
 * What these pin is mostly the *default*. Both mechanisms are live in
 * production, so the expensive mistake is not a flag that fails to work — it is
 * a flag whose unset state turns something off, which would take effect on the
 * deploy that introduced it and look exactly like an unrelated regression.
 * Every describe below therefore starts from an environment with no flag set
 * and asserts the shipped behaviour is intact.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Five consecutive transient failures — the configured threshold. */
async function tripBreaker(service: string): Promise<void> {
  const failing = vi.fn().mockImplementation(async () => jsonResponse(503, { detail: 'down' }));
  vi.stubGlobal('fetch', failing);
  for (let i = 0; i < 5; i++) {
    await postJson(service, 'http://x/y', {}, { retries: 0 }).catch(() => undefined);
  }
}

let service: string;
let counter = 0;

beforeEach(() => {
  // A fresh breaker name per test: the registry is module-level and shared by
  // design, so reusing one name would leak state between cases.
  service = `flagtest-${counter++}`;
  delete process.env.FLAG_CIRCUIT_BREAKERS;
  delete process.env.FLAG_RETRY_LADDERS;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FLAG_CIRCUIT_BREAKERS;
  delete process.env.FLAG_RETRY_LADDERS;
  circuits.get(service).reset();
});

describe('FLAG_CIRCUIT_BREAKERS', () => {
  it('refuses the call once the breaker is open, by default', async () => {
    await tripBreaker(service);
    expect(circuits.get(service).snapshot().state).toBe('open');

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postJson(service, 'http://x/y', {}, { retries: 0 })).rejects.toBeInstanceOf(
      InternalServiceError,
    );
    // The point of the breaker: the upstream was never dialled.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dials anyway when switched off, even with the breaker open', async () => {
    await tripBreaker(service);
    expect(circuits.get(service).snapshot().state).toBe('open');

    process.env.FLAG_CIRCUIT_BREAKERS = 'off';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postJson(service, 'http://x/y', {}, { retries: 0 })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps watching while switched off, so it comes back warm rather than cold', async () => {
    // The asymmetry the client documents: the flag gates the refusal, not the
    // bookkeeping. An operator who switches the breaker back on after an
    // incident should get a breaker that knows what just happened.
    process.env.FLAG_CIRCUIT_BREAKERS = 'off';
    await tripBreaker(service);
    expect(circuits.get(service).snapshot().state).toBe('open');

    delete process.env.FLAG_CIRCUIT_BREAKERS;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(postJson(service, 'http://x/y', {}, { retries: 0 })).rejects.toBeInstanceOf(
      InternalServiceError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is read per call, so a restart is not needed to observe a change', async () => {
    await tripBreaker(service);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    process.env.FLAG_CIRCUIT_BREAKERS = 'off';
    await expect(postJson(service, 'http://x/y', {}, { retries: 0 })).resolves.toBeTruthy();

    process.env.FLAG_CIRCUIT_BREAKERS = 'on';
    await expect(postJson(service, 'http://x/y', {}, { retries: 0 })).rejects.toBeInstanceOf(
      InternalServiceError,
    );
  });

  it('falls back to enforcing on a value it cannot parse', async () => {
    // Never throw on the request path; the deploy preflight is what refuses the
    // typo. The safe reading of an unreadable flag is the shipped behaviour.
    await tripBreaker(service);
    process.env.FLAG_CIRCUIT_BREAKERS = 'disable';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postJson(service, 'http://x/y', {}, { retries: 0 })).rejects.toBeInstanceOf(
      InternalServiceError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('FLAG_RETRY_LADDERS', () => {
  it('retries a 5xx once by default', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { detail: 'restarting' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postJson(service, 'http://x/y', {}, { backoffMs: 1 })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('makes exactly one attempt when switched off', async () => {
    process.env.FLAG_RETRY_LADDERS = 'off';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503, { detail: 'down' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postJson(service, 'http://x/y', {}, { backoffMs: 1 })).rejects.toBeInstanceOf(
      InternalServiceError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cannot be overridden by a call site asking for retries', async () => {
    // A kill switch individual callers could opt out of would not be one — and
    // the callers that ask for the most retries are the ones worth stopping.
    process.env.FLAG_RETRY_LADDERS = 'off';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503, { detail: 'down' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postJson(service, 'http://x/y', {}, { retries: 5, backoffMs: 1 })).rejects.toBeInstanceOf(
      InternalServiceError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still surfaces the upstream failure rather than swallowing it', async () => {
    // Off means "report instead of re-attempt", not "report differently".
    process.env.FLAG_RETRY_LADDERS = 'off';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(502, { detail: 'down' })));

    await expect(postJson(service, 'http://x/y', {}, { backoffMs: 1 })).rejects.toMatchObject({
      status: 502,
    });
  });

  it('leaves the breaker enforcing — the two switches are independent', async () => {
    process.env.FLAG_RETRY_LADDERS = 'off';
    await tripBreaker(service);
    expect(circuits.get(service).snapshot().state).toBe('open');

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(postJson(service, 'http://x/y', {}, { retries: 0 })).rejects.toBeInstanceOf(
      InternalServiceError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
