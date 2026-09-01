import { lookup } from 'node:dns/promises';
import pLimit from 'p-limit';
import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { describeTransportFailure, FLAGS, flagEnabled, logUnretried } from '@n409/shared';
import {
  buildWebhookPayload,
  DELIVERY_HEADER,
  EVENT_HEADER,
  isPermanentDeliveryFailure,
  isPrivateAddress,
  isPublicWebhookHost,
  nextAttemptAt,
  parseRetryAfter,
  SIGNATURE_HEADER,
  signWebhookBody,
  webhookTargetPolicyAllowsPrivate,
  webhookWantsEvent,
  type WebhookEventType,
  type WebhookValuationView,
} from '../domain/partnerWebhooks.js';
import {
  claimRetryableDeliveries,
  enabledWebhooks,
  failExhaustedDeliveries,
  recordDelivery,
  settleDelivery,
  type PartnerWebhookRow,
  type WebhookDeliveryRow,
} from '../repos/partnerWebhooks.js';

/**
 * Partner webhook delivery. Same durability rule as the email outbox: the
 * delivery row is written BEFORE the attempt, so a crash or receiver outage
 * leaves a record the partner can see in their delivery log, never a silent
 * gap.
 *
 * A failed attempt is not the end of the event (migration 0103). The row keeps
 * 'pending' with a backoff stamped on it and `retryDueDeliveries` — the sweep
 * on the service interval — picks it up when its time comes, until it is
 * delivered or out of attempts. Only then does it read 'failed'.
 */

export interface WebhookDeps {
  pool: pg.Pool;
  log?: FastifyBaseLogger;
  /**
   * Per-call override of the process-wide target policy
   * (`setWebhookTargetPolicy`). Left unset outside tests.
   */
  allowPrivateTargets?: boolean;
  /**
   * Name resolution, injectable so the SSRF tests can pin a public name to a
   * private address without depending on a public resolver answering.
   */
  lookupFn?: LookupFn;
}

/** `dns.lookup(host, { all: true })`, narrowed to what the guard reads. */
export type LookupFn = (hostname: string) => Promise<{ address: string }[]>;

const defaultLookup: LookupFn = (hostname) => lookup(hostname, { all: true });

/**
 * The POST's own ceiling. `DELIVERY_ATTEMPT_BUDGET_MS` in the domain is the
 * whole attempt around it — the DNS lookup in front and the settle write behind
 * — and is what the claim lease is derived from; this bounds only the request.
 */
const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Receivers the retirement batch announces to at once — see
 * {@link firePartnerWebhooksForRetirement}. Four, matching the connector sync
 * sweep beside it: enough that one unreachable receiver cannot hold up the
 * others, small enough that a retention pass is not a burst of outbound
 * sockets. Per-receiver ordering is unaffected; each chain is serial.
 */
const RETIREMENT_FANOUT_CONCURRENCY = 4;

/**
 * Resolves the target's host and refuses anything inside the network.
 *
 * The registration check in `isValidWebhookUrl` sees the literal host, which
 * catches `http://127.0.0.1/` and stops there. It cannot catch a name: DNS is
 * answered at delivery time, so a host that was public when the partner
 * registered it can point at loopback by the time the first event fires (and a
 * host registered specifically to do that resolves publicly for exactly as
 * long as it needs to). Resolving here and checking every address the name
 * carries is what closes that, and it is why this runs on every attempt rather
 * than being cached.
 *
 * Returns the reason it was refused, or null when the target is fine.
 */
async function blockedTargetReason(url: string, lookupFn: LookupFn): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'target is not a valid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `refusing to deliver to a ${parsed.protocol} target`;
  }
  if (!isPublicWebhookHost(parsed.hostname)) {
    return 'refusing to deliver to a non-public host';
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookupFn(parsed.hostname);
  } catch (err) {
    return `could not resolve ${parsed.hostname}: ${describeTransportFailure(err)}`;
  }
  // `all: true` and not just the first: a name with one public and one private
  // A record would otherwise pass or fail on resolver ordering.
  if (addresses.length === 0) return `${parsed.hostname} resolved to no addresses`;
  const priv = addresses.find((a) => isPrivateAddress(a.address));
  if (priv) return `${parsed.hostname} resolves to the non-public address ${priv.address}`;
  return null;
}

/** The outcome of one POST, before it is written back to the row. */
type AttemptResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      permanent: boolean;
      /**
       * Seconds the receiver asked us to wait, when it sent a usable
       * `Retry-After`. Overrides the backoff ladder for this attempt.
       */
      retryAfterSeconds?: number | null;
    };

/** POST one signed payload. Never throws: a transport error is an outcome. */
async function postDelivery(
  target: { url: string; secret: string },
  event: string,
  deliveryId: string,
  payload: Record<string, unknown>,
  allowPrivateTargets?: boolean,
  lookupFn: LookupFn = defaultLookup,
): Promise<AttemptResult> {
  if (!(allowPrivateTargets ?? webhookTargetPolicyAllowsPrivate())) {
    const blocked = await blockedTargetReason(target.url, lookupFn);
    // Permanent: every remaining attempt would resolve the same way, and the
    // partner needs to see the reason in their delivery log rather than a
    // column of identical timeouts.
    if (blocked) return { ok: false, error: blocked, permanent: true };
  }
  const body = JSON.stringify(payload);
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signWebhookBody(target.secret, body),
        [EVENT_HEADER]: event,
        [DELIVERY_HEADER]: deliveryId,
      },
      body,
      // Never follow a redirect: fetch would re-resolve the new location
      // without any of the checks above, which hands back the whole SSRF
      // primitive through a 302 on a public host.
      redirect: 'manual',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      return {
        ok: false,
        error: `receiver redirected (${res.status}) — webhook targets must be a final URL`,
        permanent: true,
      };
    }
    if (res.ok) return { ok: true };
    return {
      ok: false,
      error: `receiver responded ${res.status}`,
      permanent: isPermanentDeliveryFailure(res.status),
      // Only read off the statuses that define it. A `Retry-After` on some
      // other 5xx is not a scheduling instruction, and honouring it there
      // would let any misbehaving receiver push its own row to the back of
      // the queue.
      retryAfterSeconds:
        res.status === 429 || res.status === 503 ? parseRetryAfter(res.headers.get('retry-after')) : null,
    };
  } catch (err) {
    // A timeout, a refused connection, DNS — the transient class this whole
    // mechanism exists for.
    //
    // Described rather than quoted. `err.message` here is `fetch failed` for
    // every one of those conditions, and this string is not a log line: it is
    // the `error` column of the partner's own delivery log, which is the only
    // place they get to find out why their endpoint is not receiving anything.
    // "fetch failed" against an expired certificate or a deleted DNS record
    // sends them to us; the condition sends them to the fix.
    return { ok: false, error: describeTransportFailure(err), permanent: false };
  }
}

/**
 * What one attempt did to its row.
 *
 * `superseded` is not an outcome of the POST — it is the row refusing this
 * outcome because another sweeper has owned it since this one took it. See
 * `settleDelivery`: the request was made and may well have arrived, but the
 * record of it belongs to whoever holds the row now, and writing over them
 * would resurrect a settled delivery.
 */
export type AttemptOutcome = 'delivered' | 'failed' | 'retrying' | 'superseded';

/** Writes an attempt's outcome back to the row, scheduling the next try. */
async function settle(
  deps: WebhookDeps,
  delivery: Pick<WebhookDeliveryRow, 'id' | 'attempts' | 'max_attempts'>,
  result: AttemptResult,
): Promise<AttemptOutcome> {
  if (result.ok) {
    const applied = await settleDelivery(deps.pool, delivery.id, { status: 'delivered' }, delivery.attempts);
    return applied ? 'delivered' : 'superseded';
  }
  const next = result.permanent
    ? null
    : nextAttemptAt(delivery.attempts, delivery.max_attempts, new Date(), {
        retryAfterSeconds: result.retryAfterSeconds,
      });
  const applied = await settleDelivery(
    deps.pool,
    delivery.id,
    { status: 'failed', error: result.error, nextAttemptAt: next },
    delivery.attempts,
  );
  if (!applied) return 'superseded';
  return next === null ? 'failed' : 'retrying';
}

/**
 * What one delivery did, for the caller that has to tell somebody about it.
 *
 * `deliverToWebhook` answers with the outcome alone, which is all the fan-out
 * wants. The test ping is the other kind of caller: a partner asked it to prove
 * their receiver works, and "no" is only half an answer — the half that sends
 * them to us. Both facts they need are already written to the row this call
 * inserts, so this hands back what was put there rather than making the route
 * go looking for a row it has no id for.
 */
export interface DeliveryAttempt {
  outcome: AttemptOutcome;
  /** The row in the partner's own delivery log, so they can go read the rest. */
  deliveryId: string;
  /** Exactly the string written to `last_error`; null when it was delivered. */
  error: string | null;
}

/** Deliver one event to one webhook: record, sign, POST, settle. */
export async function deliverToWebhook(
  deps: WebhookDeps,
  webhook: PartnerWebhookRow,
  event: WebhookEventType,
  payload: Record<string, unknown>,
  valuationId?: string | null,
): Promise<AttemptOutcome> {
  return (await attemptDelivery(deps, webhook, event, payload, valuationId)).outcome;
}

/** `deliverToWebhook`, keeping the delivery id and the reason it failed. */
export async function attemptDelivery(
  deps: WebhookDeps,
  webhook: PartnerWebhookRow,
  event: WebhookEventType,
  payload: Record<string, unknown>,
  valuationId?: string | null,
): Promise<DeliveryAttempt> {
  const delivery = await recordDelivery(deps.pool, {
    webhookId: webhook.id,
    eventType: event,
    valuationId,
    payload,
  });
  const result = await postDelivery(
    webhook,
    event,
    delivery.id,
    payload,
    deps.allowPrivateTargets,
    deps.lookupFn,
  );
  const outcome = await settle(deps, delivery, result);
  if (!result.ok) {
    // `deliveryId` for the same reason every line in the retry sweep carries
    // one: this is attempt 1 of a ladder whose remaining attempts are all
    // logged against the row id, so without it a delivery's life story starts
    // in a different vocabulary from the rest of itself — and the partner's own
    // delivery log, which is where a complaint arrives from, is indexed by
    // exactly this id. `valuationId` because the event is about an engagement
    // and nothing else on the line says which.
    deps.log?.warn(
      {
        deliveryId: delivery.id,
        webhookId: webhook.id,
        valuationId: valuationId ?? null,
        event,
        outcome,
        error: result.error,
      },
      'partner webhook delivery failed',
    );
  }
  if (outcome === 'superseded') {
    // Only reachable if something re-claimed a row this call inserted moments
    // ago and still holds. Logged rather than swallowed: the outcome above was
    // discarded, and the row now says whatever the other writer decided.
    deps.log?.warn(
      { deliveryId: delivery.id, webhookId: webhook.id, event },
      'partner webhook delivery outcome discarded: the row was claimed by another sweeper',
    );
  }
  return { outcome, deliveryId: delivery.id, error: result.ok ? null : result.error };
}

/**
 * Retry sweep: re-POSTs every delivery whose backoff has elapsed.
 *
 * Called on an interval from the service entrypoint and on demand from
 * POST /admin/webhooks/retry. The batch is claimed before anything is sent
 * (see claimRetryableDeliveries), so two sweepers split the backlog rather than
 * both delivering all of it.
 *
 * A row that runs out of attempts, or whose receiver answered with something
 * permanent, settles to 'failed' and is never seen again — retrying forever
 * would mask a genuinely broken endpoint behind an ever-growing counter.
 *
 * The reap runs first and is not a delivery: it settles rows whose final
 * attempt was lost with the process that was making it, which the claim below
 * can never pick up again (see `failExhaustedDeliveries`). It shares this
 * sweep rather than getting a timer of its own because it wants exactly the
 * same cadence and the same lease, and a second interval would be a second
 * place to keep that number.
 */
export async function retryDueDeliveries(deps: WebhookDeps & { limit?: number; leaseMs?: number }): Promise<{
  attempted: number;
  delivered: number;
  retrying: number;
  failed: number;
  reaped: number;
  /**
   * Attempts whose outcome was refused because the row had moved on — the
   * count of duplicate deliveries this pass made. Reported rather than folded
   * into `failed`, because it says something about *us* rather than about any
   * receiver, and a non-zero value here means two sweepers are overlapping.
   */
  superseded: number;
  /**
   * Attempts whose settle was refused by the database — a POST that reached the
   * receiver and was recorded nowhere.
   *
   * Its own count rather than folded into `failed`, for the reason `superseded`
   * has one: `failed` is a statement about a receiver, and this is a statement
   * about us. A row counted here keeps its claim until the lease lapses and is
   * then delivered again, so every one of these is a duplicate the partner will
   * see and nothing else records.
   */
  unsettled: number;
}> {
  // See the note in hooks/emailRetry.ts: claiming nothing is what makes
  // FLAG_RETRY_LADDERS a pause rather than a loss. A pending delivery keeps its
  // backoff stamp and its attempt count, and resumes when the flag goes back on.
  //
  // The reap is behind the same guard even though it delivers nothing. A row it
  // would settle has no attempts left, so nothing is lost by waiting — and while
  // the ladders are paused, "still pending" is the honest reading of every
  // unsettled row rather than a claim about this one in particular.
  if (!flagEnabled(FLAGS.retryLadders)) {
    return { attempted: 0, delivered: 0, retrying: 0, failed: 0, reaped: 0, superseded: 0, unsettled: 0 };
  }

  const abandoned = await failExhaustedDeliveries(deps.pool, { leaseMs: deps.leaseMs, limit: deps.limit });
  for (const row of abandoned) {
    deps.log?.warn(
      { deliveryId: row.id, webhookId: row.webhook_id, event: row.event_type, attempts: row.attempts },
      'partner webhook delivery abandoned mid-attempt with no retries left; settled as failed',
    );
  }

  const claimed = await claimRetryableDeliveries(deps.pool, {
    limit: deps.limit,
    leaseMs: deps.leaseMs,
  });

  let delivered = 0;
  let retrying = 0;
  let failed = 0;
  let superseded = 0;
  let unsettled = 0;
  for (const row of claimed) {
    const result = await postDelivery(
      { url: row.url, secret: row.secret },
      row.event_type,
      row.id,
      row.payload,
      deps.allowPrivateTargets,
      deps.lookupFn,
    );
    /*
     * The settle is contained, the way `dispatchToWebhook` contains the fan-out
     * and `hooks/emailRetry.ts` contains its own.
     *
     * `postDelivery` never throws, so this loop's only raise is a database
     * failure inside `settle` — and it was the one of the three delivery loops
     * that let it out. The claim above takes up to a hundred rows in one
     * statement, stamping a lease and spending an attempt on every one of them,
     * so a single refused UPDATE ended the tick with the whole tail still
     * claimed: an attempt poorer for a POST nobody made, invisible until the
     * lease lapses, and — because the throw escapes `scheduleSweep` — with the
     * tally for everything this pass *had* delivered never counted either.
     *
     * The row this happened on is the expensive one. Its POST already reached
     * the partner's receiver; only the record of it is missing, so the re-claim
     * after the lease is a second delivery of an event they have already
     * processed. `logUnretried` because nothing recovers *this* attempt — the
     * next sweep makes a new one — and because a database refusing writes
     * halfway through a batch is a person's problem, not the next tick's.
     */
    let outcome: AttemptOutcome;
    try {
      outcome = await settle(deps, row, result);
    } catch (err) {
      unsettled += 1;
      if (deps.log) {
        logUnretried(
          deps.log,
          err,
          {
            deliveryId: row.id,
            webhookId: row.webhook_id,
            event: row.event_type,
            attempts: row.attempts,
            posted: result.ok,
          },
          'partner webhook delivery could not be settled; the row keeps its claim and will be delivered again',
        );
      }
      continue;
    }
    if (outcome === 'delivered') delivered += 1;
    else if (outcome === 'retrying') retrying += 1;
    else if (outcome === 'superseded') {
      superseded += 1;
      // Warn, not info: this pass POSTed an event a concurrent sweeper was also
      // POSTing, so the partner's receiver saw it twice. Nothing else records
      // that, and the row itself cannot — it carries the other sweeper's
      // outcome and looks entirely ordinary.
      deps.log?.warn(
        { deliveryId: row.id, webhookId: row.webhook_id, event: row.event_type, attempts: row.attempts },
        'partner webhook delivery outcome discarded: the row was re-claimed mid-attempt',
      );
    } else {
      failed += 1;
      deps.log?.warn(
        { deliveryId: row.id, webhookId: row.webhook_id, event: row.event_type, attempts: row.attempts },
        'partner webhook delivery exhausted its retries',
      );
    }
  }
  return {
    attempted: claimed.length,
    delivered,
    retrying,
    failed,
    reaped: abandoned.length,
    superseded,
    unsettled,
  };
}

/**
 * Fan one event out to every enabled, subscribed webhook of a partner.
 *
 * Each delivery is contained. `postDelivery` never throws, so the only thing
 * that can raise here is a database failure in `recordDelivery` or `settle` —
 * and that is precisely the case where an uncontained loop does the most
 * damage. The receivers are independent subscribers to the same event, so one
 * partner's write failing must not decide whether the others hear about it.
 *
 * It also cannot be recovered downstream. The retry sweep works from delivery
 * rows, and a `recordDelivery` that failed left none — so an aborted fan-out
 * does not delay the remaining webhooks, it drops their event entirely, with
 * nothing anywhere recording that it was owed.
 *
 * THE READ ABOVE THE LOOP IS CONTAINED HERE TOO (round 273, methodology M11).
 * It used to say the caller "logs and swallows what escapes", naming
 * `onStateChanged` — which does. The other two callers do not, and the escape
 * is a plain `SELECT` on a busy pool:
 *
 *   - `retention.ts` fires the retirement batch under a comment reading "never
 *     allowed to fail the sweep", which was true of `deliverToWebhook` and not
 *     of the read that finds the hooks. A statement timeout there took the
 *     whole archival sweep down *after* it had archived, so the run reported
 *     nothing and the retention actions it had just written had no summary.
 *   - the manual withdrawal route awaits the same call between `recordActions`
 *     and `audit`. The engagement was retired and committed, so a throw
 *     answered the admin 500 for work that had landed — and skipped the
 *     `valuation_retired` audit event entirely, leaving a retirement on the
 *     spine's retention log and off its admin trail.
 *
 * A door whose whole contract is "a dispatch failure never reaches the caller"
 * has to hold that itself; it cannot be three call sites each remembering. So
 * the read is caught here, and `logUnretried` rather than `warn` for the reason
 * the per-hook arm below gives: no delivery row exists to carry this, nothing
 * revisits it, and the partner is simply not told.
 */
export async function firePartnerWebhooks(
  deps: WebhookDeps,
  partnerId: string,
  event: WebhookEventType,
  valuation: WebhookValuationView | null,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const hooks = await readEnabledWebhooks(deps, partnerId, event, valuation?.id ?? null);
  if (hooks === null) return;
  await dispatchToWebhooks(deps, hooks, partnerId, event, valuation, extra);
}

/**
 * The hooks half of the door above, split out so a fan-out can read once.
 *
 * `null` means the read failed and has been logged; the caller returns. An
 * empty array means the partner has no enabled webhook, which is the ordinary
 * case and not a failure.
 */
async function readEnabledWebhooks(
  deps: WebhookDeps,
  partnerId: string,
  event: WebhookEventType,
  valuationId: string | null,
): Promise<PartnerWebhookRow[] | null> {
  try {
    return await enabledWebhooks(deps.pool, partnerId);
  } catch (err) {
    if (deps.log) {
      logUnretried(
        deps.log,
        err,
        { partnerId, event, valuationId },
        'could not read a partner’s webhooks; the event was owed and no delivery row exists',
      );
    }
    return null;
  }
}

/** One event to one webhook, contained: a dispatch failure never reaches a caller. */
async function dispatchToWebhook(
  deps: WebhookDeps,
  hook: PartnerWebhookRow,
  partnerId: string,
  event: WebhookEventType,
  payload: Record<string, unknown>,
  valuationId: string | null,
): Promise<void> {
  try {
    await deliverToWebhook(deps, hook, event, payload, valuationId);
  } catch (err) {
    // Error, not warn: no delivery row survives to carry this, so this line
    // is the only record that the partner was owed an event and did not get
    // one.
    deps.log?.error(
      { err, webhookId: hook.id, partnerId, event },
      'partner webhook dispatch failed before a delivery row existed; event dropped for this webhook',
    );
  }
}

/** The dispatch half: filter to the subscribers, build the body, deliver. */
async function dispatchToWebhooks(
  deps: WebhookDeps,
  hooks: readonly PartnerWebhookRow[],
  partnerId: string,
  event: WebhookEventType,
  valuation: WebhookValuationView | null,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const wanted = hooks.filter((h) => webhookWantsEvent(h.events, event));
  if (wanted.length === 0) return;
  const payload = buildWebhookPayload(event, valuation, extra);
  for (const hook of wanted) {
    await dispatchToWebhook(deps, hook, partnerId, event, payload, valuation?.id ?? null);
  }
}

/**
 * The retirement entry point: fires `valuation.retired` for whichever of these
 * ids belong to a partner.
 *
 * Takes a batch because both callers have one. The manual withdrawal passes a
 * single id; the retention sweep archives up to five hundred rows in one
 * statement, and a per-id lookup would put five hundred round trips behind a
 * job that had just been rewritten down to two.
 *
 * The company name is read *after* the retirement, so it carries the
 * ` [retired]` suffix. That is deliberate — the event describes the row as it
 * now is, and a partner reconciling on `id` or their own `external_id` is
 * unaffected. One reconciling on the company name was already going to be
 * wrong about a renamed company.
 *
 * Failures are the same shape as every other dispatch here: logged per
 * webhook, never raised. A partner whose receiver is down must not be able to
 * fail somebody's retirement.
 */
/** The columns the retirement announcement reads, per archived engagement. */
interface RetiredValuationRow {
  id: string;
  number: string | number | null;
  kind: string;
  state: string;
  company_name: string;
  partner_id: string;
}

export async function firePartnerWebhooksForRetirement(
  deps: WebhookDeps,
  valuationIds: readonly string[],
): Promise<void> {
  return announceArchivalChange(deps, valuationIds, 'valuation.retired');
}

/**
 * The other direction, which nothing announced (round 327, methodology M4).
 *
 * `valuation.retired` tells an integration the engagement is finished with:
 * every write answers 409, it leaves `GET /valuations`, and it will not
 * transition again. A restore makes all three false, and said nothing — so a
 * partner that acted on the terminal event has no way back, and the
 * `valuation.state_changed` that resumes lands against a record it closed.
 *
 * Same fan-out as the retirement it undoes, because it is the same shape: a
 * batch of ids, grouped by partner, one serial chain per receiver. The row is
 * read after the restore, so `company_name` has lost its `[retired]` suffix and
 * `state` is the state the engagement is resuming from.
 */
export async function firePartnerWebhooksForRestoration(
  deps: WebhookDeps,
  valuationIds: readonly string[],
): Promise<void> {
  return announceArchivalChange(deps, valuationIds, 'valuation.restored');
}

/**
 * Announce a retirement or a restoration to every partner receiver that wants
 * it. One body for both, so the batching, the per-receiver chaining and the
 * failure containment written up below cannot be half-copied into the second
 * direction.
 */
async function announceArchivalChange(
  deps: WebhookDeps,
  valuationIds: readonly string[],
  event: 'valuation.retired' | 'valuation.restored',
): Promise<void> {
  const ids = [...new Set(valuationIds)];
  if (ids.length === 0) return;
  // Contained, like the transition entry point above. The sweep call site's
  // comment — "never allowed to fail the sweep" — was a statement about
  // `deliverToWebhook` and not about this read.
  const rows: RetiredValuationRow[] = await deps.pool
    .query<RetiredValuationRow>(
      `SELECT id, number, kind, state, company_name, partner_id
       FROM valuations WHERE id = ANY($1::ulid[]) AND partner_id IS NOT NULL`,
      [ids],
    )
    .then((r) => r.rows)
    .catch((err: unknown) => {
      if (deps.log) {
        logUnretried(
          deps.log,
          err,
          { valuationIds: ids.length },
          `could not look up engagements to announce as ${event}; partner webhooks not queued`,
        );
      }
      return [];
    });
  /*
   * ONE HOOKS READ PER PARTNER, NOT PER ENGAGEMENT (R290).
   *
   * `firePartnerWebhooks` reads the partner's enabled webhooks itself, which is
   * right for its three single-row callers and wrong here: this is the only
   * caller that fans out over a *batch*, and a batch of retirements is the one
   * thing guaranteed to repeat its partner. The retention sweep archives up to
   * 500 engagements a pass and a firm's book ages out together, so 500 rows
   * asked `partner_webhooks` the same handful of questions 500 times — and
   * `enabledWebhooks` decrypts every secret it returns (`openWebhookSecret`),
   * so the repeated work was an AES open per hook per row, not just a round
   * trip.
   *
   * Grouped rather than memoised so the failure story is unchanged: the read is
   * still per partner, still caught by `readEnabledWebhooks`, and a partner
   * whose read fails still loses only its own events. `null` skips that
   * partner's rows exactly as the unbatched form skipped that row.
   */
  const byPartner = new Map<string, RetiredValuationRow[]>();
  for (const row of rows) {
    const bucket = byPartner.get(row.partner_id);
    if (bucket) bucket.push(row);
    else byPartner.set(row.partner_id, [row]);
  }
  /*
   * ONE CHAIN PER RECEIVER, RUN SIDE BY SIDE (R300, M5).
   *
   * This was `for (row) for (hook) await POST`, which is a single serial queue
   * over the whole batch. A POST is bounded by `DELIVERY_TIMEOUT_MS` plus a DNS
   * lookup that is deliberately not cached, so one partner whose receiver has
   * gone dark makes the retention sweep's announcement pass take
   * `rows × hooks × 10s` — five hundred archived engagements is hours, spent
   * inside a tick that also holds `background_sweep_running` at 1 and delays
   * every later pass of the same sweep.
   *
   * The cost of the length is not the wait. A delivery row is written before
   * each attempt and the retry ladder owns it from there, so a *failed* POST
   * loses nothing — but an engagement whose turn had not come yet has no row at
   * all, and nothing revisits a retirement announcement that was never queued.
   * A deploy or a crash anywhere in those hours therefore silently drops the
   * tail of the batch, and the longer the pass the larger the tail.
   *
   * Fanned out per *webhook* rather than per row: each receiver keeps its own
   * serial chain, in the order the engagements were archived, so nothing starts
   * POSTing concurrently at an endpoint that is already struggling. What runs
   * in parallel is distinct receivers, which are distinct hosts. Wall clock
   * becomes the slowest receiver rather than the sum of all of them, and a dead
   * one no longer holds up the partners that are answering.
   */
  const chains: Array<() => Promise<void>> = [];
  for (const [partnerId, partnerRows] of byPartner) {
    const hooks = await readEnabledWebhooks(deps, partnerId, event, null);
    if (hooks === null) continue;
    for (const hook of hooks.filter((h) => webhookWantsEvent(h.events, event))) {
      chains.push(async () => {
        for (const row of partnerRows) {
          const payload = buildWebhookPayload(event, {
            id: row.id,
            number: row.number,
            kind: row.kind,
            state: row.state,
            company_name: row.company_name,
          });
          await dispatchToWebhook(deps, hook, partnerId, event, payload, row.id);
        }
      });
    }
  }
  const limit = pLimit(RETIREMENT_FANOUT_CONCURRENCY);
  // `dispatchToWebhook` contains every failure, so nothing here can reject —
  // and `Promise.all` is still the right join: this function's contract is that
  // the announcement pass is over when it returns.
  await Promise.all(chains.map((chain) => limit(chain)));
}

/**
 * The state-change entry point (called from hooks/stateChange.ts): fires
 * `valuation.state_changed` on every transition of a partner engagement, and
 * `valuation.report_ready` alongside it when the transition is one that puts
 * a deliverable in front of the partner — the draft share and the publish.
 */
export async function firePartnerWebhooksForTransition(
  deps: WebhookDeps,
  valuationId: string,
  to: string,
): Promise<void> {
  // Contained for the reason `firePartnerWebhooks` gives: the entry points are
  // the other half of the same door, and their own lookup is a `SELECT` on the
  // same pool.
  const rows = await deps.pool
    .query<{
      id: string;
      number: string | number | null;
      kind: string;
      state: string;
      company_name: string;
      partner_id: string | null;
    }>('SELECT id, number, kind, state, company_name, partner_id FROM valuations WHERE id = $1', [
      valuationId,
    ])
    .then((r) => r.rows)
    .catch((err: unknown) => {
      if (deps.log) {
        logUnretried(
          deps.log,
          err,
          { valuationId, to },
          'could not look up the engagement to announce its transition; partner webhooks not queued',
        );
      }
      return [];
    });
  const row = rows[0];
  if (!row?.partner_id) return;
  const view: WebhookValuationView = {
    id: row.id,
    number: row.number,
    kind: row.kind,
    // The transition target, not the possibly-later current state — the event
    // describes what happened, and two rapid transitions must not both read
    // as the second.
    state: to,
    company_name: row.company_name,
  };
  await firePartnerWebhooks(deps, row.partner_id, 'valuation.state_changed', view);
  if (to === 'drafted' || to === 'published') {
    await firePartnerWebhooks(deps, row.partner_id, 'valuation.report_ready', view);
  }
}
