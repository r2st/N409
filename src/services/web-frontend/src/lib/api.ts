/**
 * Minimal API client. Same-origin /api/* (the web service proxies to the
 * valuation service), RFC 9457 problem+json errors surfaced as ApiError.
 *
 * Auth (audit F-2): the JWT lives in an httpOnly cookie the server sets on
 * login — it is never written to localStorage, so injected script can't read
 * it. Same-origin fetch sends that cookie automatically. We keep the token in
 * a module variable only for the current tab's lifetime (belt-and-suspenders
 * Authorization header, and the SSE/download flows), and persist only a
 * non-secret session marker — the expiry timestamp — under TOKEN_KEY so a
 * reload knows a session exists and can schedule a clean sign-out.
 */

const TOKEN_KEY = 'n409.token';
export const UNAUTHORIZED_EVENT = 'n409:unauthorized';

/** The JWT for this tab, in memory only. Lost on reload — the cookie persists. */
let memToken: string | null = null;

export function getToken(): string | null {
  return memToken;
}

export function setToken(token: string): void {
  memToken = token;
  // Persist only the (non-secret) expiry as a session marker, never the JWT.
  const exp = tokenExpiry(token);
  localStorage.setItem(TOKEN_KEY, exp !== null ? String(exp) : '1');
}

export function clearToken(): void {
  memToken = null;
  localStorage.removeItem(TOKEN_KEY);
}

/** True when a session marker is present (a cookie session may exist). */
export function hasStoredSession(): boolean {
  return localStorage.getItem(TOKEN_KEY) !== null;
}

/** Epoch millis when the in-memory JWT expires, or null if absent/opaque. */
export function tokenExpiry(token: string | null = getToken()): number | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: number;
    };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Expiry epoch millis from the persisted session marker (survives reload). */
export function storedExpiry(): number | null {
  const raw = localStorage.getItem(TOKEN_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 1 ? n : null;
}

export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  errors?: Array<{ path?: Array<string | number>; message?: string }>;
  /** Field-level engine pre-flight findings on a rejected compute. */
  issues?: Array<{
    code: string;
    field: string;
    message: string;
    severity: 'error' | 'warning';
    hint: string | null;
  }>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem,
  ) {
    super(problem.detail ?? problem.title ?? `Request failed (${status})`);
    this.name = 'ApiError';
  }
}

/**
 * `If-Match` headers for a write guarded by an optimistic-lock version.
 *
 * Returns nothing when the version is absent so the call site can spread this
 * unconditionally: a resource whose payload predates the version column (a list
 * projection, a cached shape) simply falls back to the old last-write-wins
 * behaviour rather than sending `If-Match: "undefined"`, which the server would
 * — correctly — reject as malformed.
 */
export function ifMatch(version: number | undefined): Record<string, string> | undefined {
  return version === undefined ? undefined : { 'if-match': `"${version}"` };
}

export async function api<T>(
  path: string,
  init: Omit<RequestInit, 'body'> & { body?: unknown } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.body);
  }

  const res = await fetch(`/api/v1${path}`, { ...init, headers, body });
  if (res.status === 401 && token) {
    // Session token rejected (expired or revoked) — sign the user out globally.
    clearToken();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  if (!res.ok) {
    const problem: Problem = await res.json().catch(() => ({ status: res.status }));
    throw new ApiError(res.status, problem);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Fetches a file with auth and triggers a browser download (CSV/PDF/ZIP exports). */
export async function apiDownload(
  path: string,
  fallbackName: string,
  init: { method?: 'GET' | 'POST' } = {},
): Promise<void> {
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(`/api/v1${path}`, { method: init.method ?? 'GET', headers });
  if (!res.ok) {
    const problem: Problem = await res.json().catch(() => ({ status: res.status }));
    throw new ApiError(res.status, problem);
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Multipart upload (documents) — same auth/problem handling as api(). */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const headers = new Headers({ accept: 'application/json' });
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);

  const res = await fetch(`/api/v1${path}`, { method: 'POST', headers, body: form });
  if (res.status === 401 && token) {
    clearToken();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  if (!res.ok) {
    const problem: Problem = await res.json().catch(() => ({ status: res.status }));
    throw new ApiError(res.status, problem);
  }
  return (await res.json()) as T;
}
