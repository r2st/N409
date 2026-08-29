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
/**
 * Who a request is being served for, in ids only.
 *
 * Deliberately not the principal: `roles` is a shape rather than an identity
 * and belongs on the 5xx line where the failure is being described, not on
 * every line; and everything that would *name* the person — email, first name,
 * company — is on the pino redact list and must not arrive here by another
 * door. Three opaque ids is the whole of it.
 */
export interface RequestActor {
  userId: string;
  /** The tenant, when the user belongs to one. */
  partnerId?: string | null;
  /** Set when the caller authenticated with an API token rather than a session. */
  apiTokenId?: string | null;
}

/**
 * The background tick a line was written under, when no request caused it.
 *
 * A sweep tick is the async unit this platform has and cannot correlate. The
 * failure line carries `sweep` because {@link sweepFailed} puts it there, and
 * the two saturation gauges label by it — but every line written *inside* a
 * tick carries neither the name nor anything else that groups it. Twelve sweeps
 * share one process and one logger, so their interior lines interleave, and
 * several of the functions they call (`retryFailedEmails`,
 * `retryDueDeliveries`, `runDueAutoEmails`) are also reachable from an
 * ops-triggered route — which means "did this warning come from the schedule or
 * from somebody pressing the button" was not answerable either.
 *
 * `runId` is per *tick*, not per sweep: grouping is the whole point, and two
 * ticks of the same sweep an hour apart must not share a key.
 */
export interface SweepContext {
  /** The name the gauges and {@link sweepFailed} already use for this sweep. */
  name: string;
  /** One id per tick. */
  runId: string;
}

export interface RequestContext {
  requestId?: string;
  /**
   * Bound once the request has authenticated, so it is absent on the lines
   * written before that (the routing, the rate-limit refusals) and on
   * everything a genuinely anonymous route writes. Mutable for the reason
   * {@link bindActor} gives.
   */
  actor?: RequestActor;
  /**
   * Set while a background tick is in flight. Present *alongside* `requestId`
   * when the run was triggered from a route rather than the schedule, because
   * both answers are true and the join wants each of them.
   */
  sweep?: SweepContext;
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
 * The active sweep tick, or undefined outside one.
 */
export function currentSweep(): SweepContext | undefined {
  return storage.getStore()?.sweep;
}

/**
 * Run `fn` with a background tick's identity bound.
 *
 * `run` rather than `enterWith`: a tick *is* a continuation, and the binding
 * must end with it — `enterWith` would leak the sweep onto whatever else the
 * scheduler's async context goes on to do.
 *
 * Any request context already in scope is carried through rather than
 * replaced. A sweep function called from an ops route runs under that route's
 * request, and dropping the id there would lose the correlation this whole
 * module exists for; the two facts do not compete.
 */
export function runWithSweep<T>(sweep: SweepContext, fn: () => T): T {
  const store = storage.getStore();
  return storage.run({ ...store, sweep }, fn);
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
 * The active actor, or undefined before the request has authenticated.
 */
export function currentActor(): RequestActor | undefined {
  return storage.getStore()?.actor;
}

/**
 * Record who this request is for, on the context already bound to it.
 *
 * ## Why every log line and not just the 5xx one
 *
 * `requestErrorContext` has put an `actor` block on the unhandled-error line
 * since the B-1 audit, on the reasoning that "is this one customer or everyone"
 * is the first question asked of a spike in 500s. That reasoning does not stop
 * at 500s. There are forty-odd `log.warn({ err }, …)` sites in the routes
 * reporting failures that never become one — a webhook that would not sign, an
 * upload that would not scan, a sync that came back empty — and for those the
 * question has no answer at all: the id is on the request and on nothing the
 * request wrote. Joining back through `requestId` only works when some *other*
 * line for the same request happened to carry the actor, which for a request
 * that never 500s is no line at all.
 *
 * ## Why it mutates rather than re-binds
 *
 * The store is put in place by `bindRequestId` at `onRequest`, and the actor is
 * not known until the `authenticate` preHandler has resolved it. Calling
 * `enterWith` a second time would bind a *new* store to whatever async context
 * the preHandler happens to be running in, and every consumer that matters —
 * the handler, the hooks after it, and above all the work this service starts
 * and deliberately does not await — reads through the reference taken from the
 * first one. Mutating the object they already hold reaches all of them.
 *
 * Outside a request there is no store and this does nothing, which is correct
 * rather than defensive: a background sweep has no actor, and inventing one
 * would make "no userId" stop meaning "nobody asked for this".
 */
export function bindActor(actor: RequestActor): void {
  const store = storage.getStore();
  if (store) store.actor = actor;
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
