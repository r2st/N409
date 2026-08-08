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

// ── Delivery retries (migration 0103) ────────────────────────────────────────

/**
 * Backoff between retries, in minutes, indexed by the number of attempts
 * already made. Three steps, so a delivery is tried at most four times: the
 * immediate attempt, then +1 min, +5 min, +30 min.
 *
 * The spread is chosen against what actually takes a receiver down. A minute
 * covers a rolling restart or a momentary connection reset; five covers a
 * deploy; thirty covers an incident someone has to be paged for. Doubling from
 * a one-minute base would spend all four attempts inside the first quarter of
 * an hour and land the whole set inside a single outage.
 */
export const WEBHOOK_RETRY_BACKOFF_MINUTES: readonly number[] = [1, 5, 30];

/** The initial attempt plus one per backoff step. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_BACKOFF_MINUTES.length + 1;

/**
 * How long to wait before attempt number `attemptsMade + 1`, or null when the
 * row is out of attempts and the failure is terminal.
 *
 * `attemptsMade` is the count *including* the one that just failed, which is
 * how the row reads after a claim (the claim increments). So a first failure
 * asks for BACKOFF[0].
 */
export function retryDelayMinutes(attemptsMade: number, maxAttempts = WEBHOOK_MAX_ATTEMPTS): number | null {
  if (attemptsMade >= maxAttempts) return null;
  const step = WEBHOOK_RETRY_BACKOFF_MINUTES[attemptsMade - 1];
  // More attempts allowed than we have backoff steps for: hold at the longest
  // step rather than falling through to "terminal", which would silently make
  // a raised max_attempts do nothing.
  return step ?? (WEBHOOK_RETRY_BACKOFF_MINUTES.at(-1) ?? 30);
}

/** The absolute time of the next attempt, or null when the row is exhausted. */
export function nextAttemptAt(
  attemptsMade: number,
  maxAttempts = WEBHOOK_MAX_ATTEMPTS,
  now: Date = new Date(),
): Date | null {
  const minutes = retryDelayMinutes(attemptsMade, maxAttempts);
  return minutes === null ? null : new Date(now.getTime() + minutes * 60_000);
}

/**
 * A response the receiver is telling us not to repeat.
 *
 * 4xx other than 408/425/429 means the request itself is the problem — a
 * revoked path, a receiver that rejects our signature, a URL that now 404s.
 * Retrying those three more times changes nothing and delays the delivery log
 * telling the partner something is actually wrong. 5xx, timeouts and connection
 * errors are the transient class this whole mechanism exists for.
 */
export function isPermanentDeliveryFailure(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return false;
  return status >= 400 && status < 500;
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
