/**
 * Deadlines for outbound calls to third-party integrations.
 *
 * Node's `fetch` has no default timeout. If Xero, Carta, Pulley or an HRIS
 * provider completes the TCP handshake and then goes quiet — a black-holed
 * socket, an overloaded gateway, a connection dropped without a FIN — the
 * promise never settles. Nothing downstream is watching: the Fastify handler
 * stays parked on the await, the analyst's "Import" button spins until their
 * browser gives up, and the handler is still holding its slot long after the
 * person who asked for it has gone.
 *
 * `partnerLogo` (3s) and `internal` (120s) already carry deadlines. These
 * OAuth integrations were the callers that did not, so this is the same rule
 * written once for all of them.
 *
 * The two budgets differ because the work does: a token exchange is a small
 * round-trip against an auth server and should be quick or not at all, while a
 * report or full cap-table pull is a real query on the provider's side and is
 * legitimately slow.
 */

/** Token exchange / connection identification — small, latency-sensitive calls. */
export const OAUTH_TIMEOUT_MS = 10_000;

/** Report, cap-table and roster pulls — the provider does real work for these. */
export const IMPORT_TIMEOUT_MS = 30_000;

/**
 * Runs a third-party request under a deadline, and makes a timeout say so.
 *
 * Without the rewrite the caller sees `AbortSignal`'s stock wording, "The
 * operation was aborted due to timeout", which reaches the analyst as
 * `Import failed: The operation was aborted due to timeout` — true, but it
 * names neither the provider nor the fact that the delay was on their side.
 */
export async function withDeadline<T>(
  label: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  try {
    return await run(AbortSignal.timeout(timeoutMs));
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`${label} did not respond within ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  }
}

/**
 * Reads a provider's JSON body, and makes a non-JSON answer say so.
 *
 * A 2xx is not a promise of JSON. When a provider's gateway or an ingress in
 * front of it serves an HTML error page — or a body arrives truncated — the
 * `res.json()` that every one of these clients does unguarded rejects with the
 * parser's own wording, and the route's catch-all forwards it verbatim:
 * `Sync failed: Unexpected token '<', "<html><hea"... is not valid JSON`.
 * That is the same complaint `withDeadline` exists to fix — the analyst is
 * shown a parser's internals and told nothing about which provider misbehaved
 * — so it gets the same treatment.
 *
 * The cast the call sites use (`as TokenResponse`, `as Record<string, unknown>`)
 * is a compile-time assertion with no runtime force, so `null` and arrays reach
 * property reads that then throw `Cannot read properties of null`. Requiring an
 * object here means a caller's `body.access_token` is a miss, not a crash.
 */
export async function readJson(res: Response, label: string): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`${label} returned a non-JSON response`);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`${label} returned an unexpected response body`);
  }
  return body as Record<string, unknown>;
}

/**
 * The array-bodied variant — Xero's `/connections` answers with a bare list.
 * Returns `[]` rather than throwing: every caller treats the connections list
 * as best-effort org identification, not as a reason to fail the connection.
 */
export async function readJsonArray(res: Response): Promise<unknown[]> {
  try {
    const body: unknown = await res.json();
    return Array.isArray(body) ? body : [];
  } catch {
    return [];
  }
}
