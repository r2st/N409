import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  ApiError,
  apiDownload,
  apiUpload,
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

/** Counts UNAUTHORIZED_EVENT for the duration of `run`, then unsubscribes. */
async function signOutsDuring(run: () => Promise<unknown>): Promise<number> {
  const listener = vi.fn();
  window.addEventListener(UNAUTHORIZED_EVENT, listener);
  try {
    await run().catch(() => {});
  } finally {
    window.removeEventListener(UNAUTHORIZED_EVENT, listener);
  }
  return listener.mock.calls.length;
}

/** A 401 problem+json response, the shape every guarded route returns. */
function unauthorized(): Response {
  return new Response(JSON.stringify({ title: 'Unauthorized', status: 401 }), { status: 401 });
}

/**
 * The state of a tab that has been reloaded: the httpOnly cookie still carries
 * the session and the marker still says one exists, but `memToken` — which is
 * module state, deliberately not persisted — is gone. Written through
 * localStorage rather than setToken() precisely because setToken() would also
 * put the JWT back in memory, which a reload never does.
 */
function reloadedTabWithSession(): void {
  clearToken();
  localStorage.setItem('n409.token', String(Date.now() + 3_600_000));
}

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

/*
 * `AuthProvider` states the contract these cover in one line — "Any 401
 * anywhere in the app signs the user out" — and then listens for one event to
 * implement it. Three of the four ways a 401 can arrive did not raise it.
 */
describe('a 401 ends the session', () => {
  it('signs out a reloaded tab, where the JWT is gone but the cookie session is not', async () => {
    reloadedTabWithSession();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(unauthorized());
    // The request carries no bearer header at all — the cookie is the session.
    expect(getToken()).toBeNull();
    expect(await signOutsDuring(() => api('/valuations'))).toBe(1);
    expect(hasStoredSession()).toBe(false);
  });

  it('signs out on a download, not just on a JSON call', async () => {
    setToken('stale');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(unauthorized());
    expect(await signOutsDuring(() => apiDownload('/valuations/export?format=csv', 'v.csv'))).toBe(1);
    expect(getToken()).toBeNull();
  });

  it('signs out on an upload', async () => {
    setToken('stale');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(unauthorized());
    const body = new FormData();
    expect(await signOutsDuring(() => apiUpload('/valuations/v1/documents', body))).toBe(1);
    expect(getToken()).toBeNull();
  });

  it('still reports the failure as an ApiError — signing out does not swallow it', async () => {
    reloadedTabWithSession();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(unauthorized());
    await expect(api('/valuations')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('a 401 that is not the end of a session', () => {
  it('does not sign out on a mistyped password, even with a session in the tab behind it', async () => {
    reloadedTabWithSession();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(unauthorized());
    expect(
      await signOutsDuring(() =>
        api('/auth/login', { method: 'POST', body: { email: 'a@b.c', password: 'wrong' } }),
      ),
    ).toBe(0);
    // The session it was not about is left intact.
    expect(hasStoredSession()).toBe(true);
    clearToken();
  });

  it('does not sign out on a wrong second factor', async () => {
    reloadedTabWithSession();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(unauthorized());
    expect(
      await signOutsDuring(() => api('/auth/mfa/verify', { method: 'POST', body: { code: '000000' } })),
    ).toBe(0);
    expect(hasStoredSession()).toBe(true);
    clearToken();
  });

  it('does not sign out an anonymous visitor who never had a session', async () => {
    clearToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(unauthorized());
    expect(await signOutsDuring(() => api('/public/branding'))).toBe(0);
  });
});
