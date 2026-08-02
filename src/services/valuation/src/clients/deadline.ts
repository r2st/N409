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
