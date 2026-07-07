/**
 * Minimal API client. Same-origin /api/* (the web service proxies to the
 * valuation service), bearer JWT from localStorage, RFC 9457 problem+json
 * errors surfaced as ApiError.
 */

const TOKEN_KEY = 'n409.token';
export const UNAUTHORIZED_EVENT = 'n409:unauthorized';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** Epoch millis when the stored JWT expires, or null if absent/opaque. */
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

export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  errors?: Array<{ path?: Array<string | number>; message?: string }>;
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
