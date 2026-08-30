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
 * The message to show when a submit did not go through (round 222).
 *
 * Five pages wrote this by hand, all of them the same way:
 *
 *   setError(err instanceof ApiError ? err.message : 'Something went wrong — please try again.');
 *
 * The `else` branch is not a general-purpose fallback, which is what its
 * wording assumes. `api()` throws `ApiError` whenever the server answered at
 * all — any status, any body, even an empty one — so the only way to reach the
 * other side is for `fetch` itself to have rejected, and `fetch` rejects when
 * the request never arrived: no network, DNS failing, the tab offline, a
 * captive portal in the way. That is a specific situation with a specific
 * remedy, and "something went wrong" describes it in a way that points the
 * reader back at the form. On a sign-up or a password reset that is a person
 * retyping a password they typed correctly, on a connection that is still
 * down.
 *
 * The second half matters as much. A submit that failed here sent nothing, so
 * nothing was half-done — no account half-created, no password half-changed —
 * and saying so is what stops the reader wondering whether pressing the button
 * again will do the thing twice.
 */
export const OFFLINE_DETAIL =
  'That request could not reach the server, so nothing was submitted — this is usually a dropped ' +
  'connection rather than anything you entered. Check your network and try again.';

/**
 * Turn whatever a failed request threw into a sentence for the reader.
 *
 * `ApiError`'s own message is preferred and is almost always what shows: the
 * server writes these deliberately, and `detail` is the field it puts the
 * remedy in. The exception is a problem body with no `detail` and no `title` —
 * a bodiless 502 from a proxy that never reached the app — where `ApiError`
 * falls back to `Request failed (502)`. That is a status code wearing a
 * sentence, so it is replaced here rather than shown.
 */
export function describeRequestFailure(err: unknown): string {
  if (err instanceof ApiError) {
    if (/^Request failed \(\d+\)$/.test(err.message)) {
      return (
        `The server answered with an error (${err.status}) and no explanation, which usually means ` +
        'the request did not reach the application itself. Nothing was saved; wait a moment and try again.'
      );
    }
    return err.message;
  }
  return OFFLINE_DETAIL;
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

/**
 * Endpoints that exchange credentials for a session. A 401 from one of these
 * means "what you typed is wrong", not "your session is over": signing out on
 * them would fire a logout request on every mistyped password, and would end
 * the still-valid session in the tab behind the login form.
 */
const CREDENTIAL_EXCHANGE = new Set(['/auth/login', '/auth/mfa/verify']);

/**
 * Handle a 401 the way `AuthProvider` claims the app does — "any 401 anywhere
 * in the app signs the user out".
 *
 * Two things it has to get right, and neither was:
 *
 *   - The session it is testing for is not the in-memory JWT. `memToken` is
 *     deliberately lost on reload (the httpOnly cookie is what carries the
 *     session across one), so in every reloaded tab `getToken()` is null.
 *     Gating the sign-out on the token therefore skipped it in exactly the
 *     tabs that had one — a session revoked from elsewhere (sign out other
 *     sessions, a password change, an admin disabling the account) left the
 *     app showing a signed-in shell in which nothing would load, with no way
 *     out but a manual reload. `hasStoredSession()` is the marker that
 *     actually survives a reload, so it is the one to ask.
 *
 *   - The token *is* still worth asking about, for the tab that has one and
 *     no marker yet, so both are consulted.
 *
 * Returns nothing: callers still throw the ApiError, because a failed request
 * is a failed request whether or not it also ended the session.
 */
function noteUnauthorized(path: string, status: number): void {
  if (status !== 401) return;
  if (CREDENTIAL_EXCHANGE.has(path.split('?')[0] ?? path)) return;
  if (getToken() === null && !hasStoredSession()) return;
  clearToken();
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
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
  noteUnauthorized(path, res.status);
  if (!res.ok) {
    const problem: Problem = await res.json().catch(() => ({ status: res.status }));
    throw new ApiError(res.status, problem);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * The name the server gave the file, read the way RFC 6266 §4.3 says to.
 *
 * A `content-disposition` from this API carries the name twice — once as the
 * ASCII `filename` a 2005 browser can read, and once as `filename*`, an RFC
 * 5987 ext-value holding the real UTF-8 bytes. The server builds both from one
 * string (see `contentDisposition` in the valuation service) and the ASCII half
 * is deliberately lossy: every character ASCII cannot spell becomes `_`.
 *
 * This function used to read only the lossy half. So an uploaded document named
 * `Ångström-cap-table.xlsx` — the exact case the server writes `filename*` for —
 * arrived on disk as `_ngstr_m-cap-table.xlsx`, and it did so *while the correct
 * name was sitting in `fallbackName`*: the Documents panel passes `doc.filename`,
 * which is the untouched original. Parsing the header made the answer worse than
 * not parsing it at all, which is why nothing looked broken from the code.
 *
 * The spec's rule is the one implemented here: when both forms are present, the
 * ext-value wins. It is also the only one that can lose — a truncated or
 * mis-encoded percent sequence makes `decodeURIComponent` throw — so a failure
 * to decode falls back to the ASCII form rather than to nothing.
 *
 * Exported for the test; not part of the module's normal surface.
 */
export function dispositionFilename(header: string, fallback: string): string {
  const ext = /filename\*\s*=\s*([^;]+)/i.exec(header)?.[1]?.trim();
  if (ext) {
    // ext-value is charset, apostrophe, language, apostrophe, percent-encoded
    // bytes. The language part is routinely empty and is not a name; only the
    // third field is.
    const parts = ext.split("'");
    if (parts.length >= 3) {
      const charset = parts[0]!.toLowerCase();
      const encoded = parts.slice(2).join("'");
      try {
        // Both charsets percent-encode bytes; they differ only in how the bytes
        // map to characters, and for ISO-8859-1 that map is the code point.
        const decoded =
          charset === 'utf-8'
            ? decodeURIComponent(encoded)
            : charset === 'iso-8859-1'
              ? encoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
                  String.fromCharCode(parseInt(hex, 16)),
                )
              : null;
        const clean = decoded === null ? null : scrubDownloadName(decoded);
        if (clean) return clean;
      } catch {
        // Malformed percent-encoding — fall through to the ASCII form below.
      }
    }
  }
  const ascii = /filename\s*=\s*"([^"]*)"/i.exec(header)?.[1];
  return (ascii === undefined ? null : scrubDownloadName(ascii)) ?? fallback;
}

/**
 * Keeps a server-supplied name from being read as a path.
 *
 * `a.download` is specified to treat its value as a bare filename, but the
 * treatment is the browser's and differs between them, and a name that arrives
 * over the wire is worth one line of not trusting. Directory separators and
 * control characters go; a name that is nothing but those is no name.
 */
function scrubDownloadName(name: string): string | null {
  let out = '';
  for (const ch of name) {
    if (ch === '/' || ch === '\\' || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) continue;
    out += ch;
  }
  out = out.trim();
  return out === '' || out === '.' || out === '..' ? null : out;
}

/**
 * Fetches a file with auth and triggers a browser download (CSV/PDF/ZIP exports).
 *
 * Returns whether the server capped the export. `routes/exports.ts` puts a
 * notice *inside* the XLSX (above the header) and the PDF (in its title), and
 * deliberately puts none inside the CSV — there is no comment syntax a
 * spreadsheet honours and a trailing note row would be indistinguishable from
 * data. `x-export-truncated` exists precisely so the client can say it
 * out-of-band instead, and nothing read it, so a capped CSV arrived looking
 * like the whole book.
 */
export async function apiDownload(
  path: string,
  fallbackName: string,
  init: { method?: 'GET' | 'POST' } = {},
): Promise<{ truncated: boolean }> {
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(`/api/v1${path}`, { method: init.method ?? 'GET', headers });
  noteUnauthorized(path, res.status);
  if (!res.ok) {
    const problem: Problem = await res.json().catch(() => ({ status: res.status }));
    throw new ApiError(res.status, problem);
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const filename = dispositionFilename(disposition, fallbackName);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { truncated: res.headers.get('x-export-truncated') === 'true' };
}

/** Multipart upload (documents) — same auth/problem handling as api(). */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const headers = new Headers({ accept: 'application/json' });
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);

  const res = await fetch(`/api/v1${path}`, { method: 'POST', headers, body: form });
  noteUnauthorized(path, res.status);
  if (!res.ok) {
    const problem: Problem = await res.json().catch(() => ({ status: res.status }));
    throw new ApiError(res.status, problem);
  }
  return (await res.json()) as T;
}
