import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import {
  buildWebhookPayload,
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  signWebhookBody,
  webhookWantsEvent,
  type WebhookEventType,
  type WebhookValuationView,
} from '../domain/partnerWebhooks.js';
import {
  enabledWebhooks,
  markDelivery,
  recordDelivery,
  type PartnerWebhookRow,
} from '../repos/partnerWebhooks.js';

/**
 * Partner webhook delivery. Same durability rule as the email outbox: the
 * delivery row is written BEFORE the attempt, so a crash or receiver outage
 * leaves a 'pending'/'failed' record the partner can see in their delivery
 * log, never a silent gap. One attempt per event; the row carries the outcome.
 */

export interface WebhookDeps {
  pool: pg.Pool;
  log?: FastifyBaseLogger;
}

const DELIVERY_TIMEOUT_MS = 10_000;

/** Deliver one event to one webhook: record, sign, POST, mark. */
export async function deliverToWebhook(
  deps: WebhookDeps,
  webhook: PartnerWebhookRow,
  event: WebhookEventType,
  payload: Record<string, unknown>,
  valuationId?: string | null,
): Promise<'delivered' | 'failed'> {
  const delivery = await recordDelivery(deps.pool, {
    webhookId: webhook.id,
    eventType: event,
    valuationId,
    payload,
  });
  const body = JSON.stringify(payload);
  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signWebhookBody(webhook.secret, body),
        [EVENT_HEADER]: event,
        [DELIVERY_HEADER]: delivery.id,
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (res.ok) {
      await markDelivery(deps.pool, delivery.id, 'delivered');
      return 'delivered';
    }
    await markDelivery(deps.pool, delivery.id, 'failed', `receiver responded ${res.status}`);
    return 'failed';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markDelivery(deps.pool, delivery.id, 'failed', message);
    deps.log?.warn({ err, webhookId: webhook.id, event }, 'partner webhook delivery failed');
    return 'failed';
  }
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
