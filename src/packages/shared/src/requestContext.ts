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
 * The longest inbound correlation id this estate will adopt.
 *
 * Not a guess about what a load balancer sends — AWS, Cloudflare and every
 * tracing library in the field emit a UUID, a ULID or a 32-hex trace id, all of
 * which are well under this. It is a ceiling on what one request can cost.
 */
export const MAX_REQUEST_ID_CHARS = 128;

/**
 * An inbound `x-request-id`, if it is one, and `null` if it is anything else.
 *
 * All three Fastify services set `requestIdHeader: 'x-request-id'`, which
 * adopts whatever arrives *verbatim* — Fastify does not look at it. That is the
 * intended behaviour for the hop it was written for, a load balancer or a
 * synthetic check supplying its own id, and it is also a header any browser can
 * set. The web BFF then stamps `req.id` onto the proxied call, the valuation
 * service binds it and forwards it again to the engine, the AI gateway and the
 * renderer, and every log line in all five services carries it.
 *
 * So one request with an 8 KB `x-request-id` — the most Node's header limit
 * allows — is 8 KB on every line of a five-service trace, in a journal on a box
 * with 3.8 GB of memory. Nothing about it is malformed; it is simply a string
 * the estate agreed to repeat without bound.
 *
 * The charset is the second half. Pino writes JSON, so a newline in an id is
 * escaped rather than forged into a second log line — but an id is a value
 * things are *joined* on, and a whitespace- or control-character-bearing id
 * does not survive the grep or the journal query that a join is made of. What
 * is accepted is what an id is made of: the unreserved URL characters, plus the
 * separators tracing formats already use.
 *
 * A refusal is not an error. The caller sent something this hop will not adopt,
 * and the answer is the id it would have minted anyway — the request is served,
 * and it is correlatable, just not under a name a client chose.
 *
 * The count of five is deliberate, and this file can only enforce three of
 * them. The Python pair holds the same rule in its own vocabulary —
 * `acceptable_request_id` in each service's `app/observability.py`, same
 * ceiling and same charset — because a rule the TS side states about five
 * services and applies to three is a rule with two doors left open.
 */
export function acceptableRequestId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > MAX_REQUEST_ID_CHARS) return null;
  return /^[A-Za-z0-9._~:@=+-]+$/.test(raw) ? raw : null;
}

/** Mints the ids `requestIdFromHeaders` falls back to, in Fastify's own shape. */
let minted = 0;

/**
 * The id this request will be logged and traced under.
 *
 * Wired as Fastify's `genReqId` with `requestIdHeader: false`, which is the
 * only way to *look* at the header before adopting it — with `requestIdHeader`
 * set, Fastify takes whatever arrived and `genReqId` never runs. See
 * {@link acceptableRequestId} for what is and is not adopted; the fallback is
 * the same `req-<n>` Fastify would have minted, so a refused header costs the
 * caller nothing but the name.
 */
export function requestIdFromHeaders(headers: Record<string, string | string[] | undefined>): string {
  return acceptableRequestId(headers[REQUEST_ID_HEADER]) ?? `req-${(minted++).toString(36)}`;
}

/**
 * `{ 'x-request-id': … }` when there is something to correlate to, `{}` otherwise.
 *
 * Empty rather than a *minted* id when there is not: inventing one at the client
 * would let the downstream service log an id that appears in no other service's
 * logs, which is worse than letting it mint its own.
 *
 * ## Why a sweep tick counts
 *
 * That argument was written when a background tick had no identity, and it has
 * had one since {@link runWithSweep}: `sweepRun` is on every line the tick
 * writes here (see `requestIdMixin` in logger.ts) and it is a ULID, so it is
 * both stable and acceptable to `acceptableRequestId` on either side of the
 * wire. Forwarding it is not minting — it is sending an id that already appears
 * in this service's logs, which is the exact test the rule above states.
 *
 * The gap it closes is reachable on the ordinary path. `pipeline-retry` is a
 * sweep whose whole job is to re-run auto-pipeline orchestrations, so it drives
 * `postJson` at the AI and engine services from inside a tick; `cap-table-sync`
 * and `hris-sync` do the same. With no header the Python tier minted a fresh
 * uuid per call, so the two halves of one retried pipeline — the valuation
 * lines under `sweepRun`, the AI lines under that uuid — had no field in common
 * and could only be joined by timestamp. The failures those sweeps exist to
 * report are precisely the ones whose explanation is on the far side.
 *
 * A request wins when both are bound: a sweep function reached from an ops
 * route is serving that request, and `requestId` is the id the caller is
 * holding. Both facts are still on every local line, so neither join is lost.
 */
export function requestIdHeaders(): Record<string, string> {
  const requestId = currentRequestId() ?? currentSweep()?.runId;
  return requestId ? { [REQUEST_ID_HEADER]: requestId } : {};
}
