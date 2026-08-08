import { lookup } from 'node:dns/promises';
import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import {
  buildWebhookPayload,
  DELIVERY_HEADER,
  EVENT_HEADER,
  isPermanentDeliveryFailure,
  isPrivateAddress,
  isPublicWebhookHost,
  nextAttemptAt,
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

const DELIVERY_TIMEOUT_MS = 10_000;

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
    return `could not resolve ${parsed.hostname}: ${err instanceof Error ? err.message : String(err)}`;
  }
  // `all: true` and not just the first: a name with one public and one private
  // A record would otherwise pass or fail on resolver ordering.
  if (addresses.length === 0) return `${parsed.hostname} resolved to no addresses`;
  const priv = addresses.find((a) => isPrivateAddress(a.address));
  if (priv) return `${parsed.hostname} resolves to the non-public address ${priv.address}`;
  return null;
}

/** The outcome of one POST, before it is written back to the row. */
type AttemptResult = { ok: true } | { ok: false; error: string; permanent: boolean };

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
    // Permanent: the next four attempts would resolve the same way, and the
    // partner needs to see the reason in their delivery log rather than four
    // identical timeouts.
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
    };
  } catch (err) {
    // A timeout, a refused connection, DNS — the transient class this whole
    // mechanism exists for.
    return { ok: false, error: err instanceof Error ? err.message : String(err), permanent: false };
  }
}

/** Writes an attempt's outcome back to the row, scheduling the next try. */
async function settle(
  deps: WebhookDeps,
  delivery: Pick<WebhookDeliveryRow, 'id' | 'attempts' | 'max_attempts'>,
  result: AttemptResult,
): Promise<'delivered' | 'failed' | 'retrying'> {
  if (result.ok) {
    await settleDelivery(deps.pool, delivery.id, { status: 'delivered' });
    return 'delivered';
  }
  const next = result.permanent ? null : nextAttemptAt(delivery.attempts, delivery.max_attempts);
  await settleDelivery(deps.pool, delivery.id, {
    status: 'failed',
    error: result.error,
    nextAttemptAt: next,
  });
  return next === null ? 'failed' : 'retrying';
}

/** Deliver one event to one webhook: record, sign, POST, settle. */
export async function deliverToWebhook(
  deps: WebhookDeps,
  webhook: PartnerWebhookRow,
  event: WebhookEventType,
  payload: Record<string, unknown>,
  valuationId?: string | null,
): Promise<'delivered' | 'failed' | 'retrying'> {
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
    deps.log?.warn(
      { webhookId: webhook.id, event, outcome, error: result.error },
      'partner webhook delivery failed',
    );
  }
  return outcome;
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
 */
export async function retryDueDeliveries(
  deps: WebhookDeps & { limit?: number; leaseMs?: number },
): Promise<{ attempted: number; delivered: number; retrying: number; failed: number }> {
  const claimed = await claimRetryableDeliveries(deps.pool, {
    limit: deps.limit,
    leaseMs: deps.leaseMs,
  });

  let delivered = 0;
  let retrying = 0;
  let failed = 0;
  for (const row of claimed) {
    const result = await postDelivery(
      { url: row.url, secret: row.secret },
      row.event_type,
      row.id,
      row.payload,
      deps.allowPrivateTargets,
      deps.lookupFn,
    );
    const outcome = await settle(deps, row, result);
    if (outcome === 'delivered') delivered += 1;
    else if (outcome === 'retrying') retrying += 1;
    else {
      failed += 1;
      deps.log?.warn(
        { deliveryId: row.id, webhookId: row.webhook_id, event: row.event_type, attempts: row.attempts },
        'partner webhook delivery exhausted its retries',
      );
    }
  }
  return { attempted: claimed.length, delivered, retrying, failed };
}

/** Fan one event out to every enabled, subscribed webhook of a partner. */
export async function firePartnerWebhooks(
  deps: WebhookDeps,
  partnerId: string,
  event: WebhookEventType,
  valuation: WebhookValuationView | null,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const hooks = await enabledWebhooks(deps.pool, partnerId);
  const wanted = hooks.filter((h) => webhookWantsEvent(h.events, event));
  if (wanted.length === 0) return;
  const payload = buildWebhookPayload(event, valuation, extra);
  for (const hook of wanted) {
    await deliverToWebhook(deps, hook, event, payload, valuation?.id ?? null);
  }
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
  const { rows } = await deps.pool.query<{
    id: string;
    number: string | number | null;
    kind: string;
    state: string;
    company_name: string;
    partner_id: string | null;
  }>('SELECT id, number, kind, state, company_name, partner_id FROM valuations WHERE id = $1', [valuationId]);
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
