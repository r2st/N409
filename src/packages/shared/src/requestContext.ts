import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The ambient request id, for code too far from the handler to be passed one.
 *
 * The Python tier already reads `x-request-id` off its caller and binds it to a
 * context var for every log line it writes (each service's app/observability.py).
 * Nothing was sending it, so each service minted its own and a single user
 * action wrote log lines under three unrelated ids — the correlation existed on
 * both ends of the wire and nowhere in between.
 *
 * Threading the id through as a parameter would mean touching every engine and
 * AI call site plus the pipeline code that runs after the response is sent. An
 * AsyncLocalStorage keeps the diff at the two edges that actually care: the
 * Fastify hook that binds it and the internal client that sends it. It also
 * mirrors what the Python side does with `contextvars`, which is the same
 * mechanism under a different name.
 */
export interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const REQUEST_ID_HEADER = 'x-request-id';

/** The active request id, or undefined outside a request (a cron tick, boot). */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Run `fn` with `requestId` bound. Use where there is a callback to wrap;
 * Fastify hooks return rather than wrap, so they use `bindRequestId`.
 */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

/**
 * Bind `requestId` to the current async context and everything it spawns.
 *
 * `enterWith` rather than `run` because a Fastify `onRequest` hook has no
 * continuation to wrap — it returns, and the handler runs later in the same
 * async context. The binding therefore lasts for that context, which for a
 * Fastify request is exactly the request.
 */
export function bindRequestId(requestId: string): void {
  storage.enterWith({ requestId });
}

/**
 * `{ 'x-request-id': … }` when a request is in flight, `{}` otherwise.
 *
 * Empty rather than a minted id when unbound: a background job genuinely has no
 * request to correlate to, and inventing one at the client would let the
 * downstream service log an id that appears in no other service's logs, which
 * is worse than letting it mint its own.
 */
export function requestIdHeaders(): Record<string, string> {
  const requestId = currentRequestId();
  return requestId ? { [REQUEST_ID_HEADER]: requestId } : {};
}
