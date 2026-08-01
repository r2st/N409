import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  ApiError,
  clearToken,
  getToken,
  hasStoredSession,
  setToken,
  storedExpiry,
  tokenExpiry,
  UNAUTHORIZED_EVENT,
} from '../src/lib/api';

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`;
}

afterEach(() => {
  vi.restoreAllMocks();
  clearToken();
});

describe('api client', () => {
  it('stores and decodes token expiry', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    setToken(fakeJwt({ sub: 'u1', exp }));
    expect(getToken()).not.toBeNull();
    expect(tokenExpiry()).toBe(exp * 1000);
  });

  it('keeps the JWT in memory only — never the raw token in localStorage (F-2)', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = fakeJwt({ sub: 'u1', exp });
    setToken(jwt);
    // getToken returns the in-memory JWT…
    expect(getToken()).toBe(jwt);
    // …but localStorage holds only the non-secret expiry marker, not the JWT.
    const stored = localStorage.getItem('n409.token');
    expect(stored).not.toBe(jwt);
    expect(stored).toBe(String(exp * 1000));
    expect(hasStoredSession()).toBe(true);
    expect(storedExpiry()).toBe(exp * 1000);
  });

  it('clearToken wipes both the in-memory token and the marker', () => {
    setToken(fakeJwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 60 }));
    clearToken();
    expect(getToken()).toBeNull();
    expect(hasStoredSession()).toBe(false);
    expect(storedExpiry()).toBeNull();
  });

  it('persists a marker even for an opaque token, without an expiry', () => {
    setToken('opaque-token');
    expect(getToken()).toBe('opaque-token');
    expect(hasStoredSession()).toBe(true);
    // No decodable exp → marker is a bare presence flag, storedExpiry null.
    expect(storedExpiry()).toBeNull();
  });

  it('attaches the bearer token and parses JSON', async () => {
    setToken('the-token');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const res = await api<{ ok: boolean }>('/valuations');
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/valuations');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer the-token');
  });

  it('throws ApiError with problem+json details', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ title: 'Conflict', status: 409, detail: 'exists' }), { status: 409 }),
    );
    await expect(api('/auth/register', { method: 'POST', body: {} })).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      message: 'exists',
    });
  });

  it('clears the token and broadcasts on 401', async () => {
    setToken('stale');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ title: 'Unauthorized', status: 401 }), { status: 401 }),
    );
    const listener = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, listener);
    await expect(api('/auth/me')).rejects.toBeInstanceOf(ApiError);
    expect(getToken()).toBeNull();
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(UNAUTHORIZED_EVENT, listener);
  });
});
