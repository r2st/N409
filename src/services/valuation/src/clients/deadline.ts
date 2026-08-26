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
/**
 * An integration failure whose wording is safe to show the person who asked.
 *
 * The route that pulls an HRIS roster ended in
 *
 *     catch (err) { throw problems.unprocessable(`Sync failed: ${err.message}`) }
 *
 * which forwards *whatever was thrown* to the client. That is right for the
 * errors this file raises — "Rippling did not respond within 30s", "Gusto
 * returned a non-JSON response" — each of which names the provider and what it
 * did and carries nothing else. It is wrong for everything else that can be
 * thrown from inside a sync, and the sync's insert loop has no catch of its
 * own: one grant with a date Postgres will not take, and the analyst is shown
 *
 *     Sync failed: date/time field value out of range: "2026-02-31"
 *
 * or, on a unique violation, the name of the index. Driver wording, column
 * names and constraint names are internal detail, and the catch-all could not
 * tell them from the two sentences above because both arrive as `Error`.
 *
 * So "safe to echo" becomes a type rather than a hope. A route forwards the
 * message of an `IntegrationError` and answers everything else with its own
 * constant, having logged the real one.
 *
 * Thrown by `withDeadline` and `readJson`, which is where the provider-
 * attributable failures of every integration client already funnel. The
 * clients' own `throw new Error(…)` sites are converted per client as their
 * routes start forwarding; a plain `Error` is the conservative default,
 * because the cost of the wrong answer is asymmetric — an unhelpful message
 * on one side, disclosure on the other.
 */
export class IntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationError';
  }
}

export async function withDeadline<T>(
  label: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  try {
    return await run(AbortSignal.timeout(timeoutMs));
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new IntegrationError(`${label} did not respond within ${Math.round(timeoutMs / 1000)}s`);
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
    throw new IntegrationError(`${label} returned a non-JSON response`);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new IntegrationError(`${label} returned an unexpected response body`);
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
