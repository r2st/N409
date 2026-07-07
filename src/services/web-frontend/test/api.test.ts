import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, clearToken, getToken, setToken, tokenExpiry, UNAUTHORIZED_EVENT } from '../src/lib/api';

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

  it('attaches the bearer token and parses JSON', async () => {
    setToken('the-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
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
