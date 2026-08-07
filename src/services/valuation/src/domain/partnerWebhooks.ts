import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Partner webhook events (partner API enhancements). Pure: event vocabulary,
 * payload shape, and request signing. The repo owns storage; the hook in
 * hooks/partnerWebhooks.ts owns delivery.
 */

export const WEBHOOK_EVENT_TYPES = [
  /** Any lifecycle transition, for every report type. */
  'valuation.state_changed',
  /** The transition that first makes the deliverable visible to the partner. */
  'valuation.report_ready',
  /** Sent by POST /webhooks/{id}/test — a signed ping to verify the receiver. */
  'webhook.test',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/** An empty subscription list means every event. */
export function webhookWantsEvent(events: readonly string[], event: WebhookEventType): boolean {
  return events.length === 0 || events.includes(event);
}

/** `n409_whsec_…` — same naming scheme as the API tokens (`n409_pat_…`). */
export function newWebhookSecret(): string {
  return `n409_whsec_${randomBytes(24).toString('hex')}`;
}

export const SIGNATURE_HEADER = 'x-n409-signature';
export const EVENT_HEADER = 'x-n409-event';
export const DELIVERY_HEADER = 'x-n409-delivery';

/** `sha256=<hex>` over the exact bytes of the request body. */
export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

/** Receiver-side check, exposed for tests and for the docs example. */
export function verifyWebhookSignature(secret: string, body: string, signature: string): boolean {
  const expected = Buffer.from(signWebhookBody(secret, body));
  const got = Buffer.from(signature);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export interface WebhookValuationView {
  id: string;
  number: number | string | null;
  kind: string;
  state: string;
  company_name: string;
}

export interface WebhookPayload {
  event: WebhookEventType;
  /** ISO-8601 send time. */
  created_at: string;
  valuation: WebhookValuationView | null;
  /** Present on state changes: the transition endpoints. */
  previous_state?: string | null;
  [key: string]: unknown;
}

export function buildWebhookPayload(
  event: WebhookEventType,
  valuation: WebhookValuationView | null,
  extra: Record<string, unknown> = {},
  now: Date = new Date(),
): WebhookPayload {
  return { event, created_at: now.toISOString(), valuation, ...extra };
}

/**
 * A webhook URL must be plain http(s) — anything else (file:, gopher:, a
 * partner typo) is refused at registration rather than fetched at delivery.
 */
export function isValidWebhookUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' || url.protocol === 'http:';
}
