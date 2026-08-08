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
  return step ?? WEBHOOK_RETRY_BACKOFF_MINUTES.at(-1) ?? 30;
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

// ── Where a webhook is allowed to point (SSRF) ───────────────────────────────

/**
 * A webhook target is a URL a *partner* chooses and this service then fetches,
 * which is the definition of a server-side request forgery primitive: the POST
 * leaves from inside the network, so `http://127.0.0.1:3001`, a sibling
 * service's port, or the cloud metadata endpoint at 169.254.169.254 are all
 * reachable from a form field. The body is signed, not secret, so the payload
 * itself gives an attacker little — but the *response status* comes back in the
 * partner's own delivery log (`receiver responded 403`), which turns the
 * delivery log into an internal port scanner, and a POST to an internal
 * endpoint that acts on its path needs no response to have done its damage.
 *
 * So the target is checked twice, and both are needed:
 *
 *  - here at registration, against the literal host, so the obvious cases are
 *    refused with a message instead of failing silently at delivery time;
 *  - again in the delivery hook against the *resolved* address, because
 *    `evil.example.com` is a perfectly public name until its A record says
 *    127.0.0.1. A name resolves at delivery, not at registration, so a
 *    registration-time check alone is only a typo filter.
 */

/** Host names that mean "this machine" without needing to resolve anything. */
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', 'localhost.localdomain']);

/** `.local` (mDNS) and `.internal` (cloud-private zones) are never public. */
const BLOCKED_TLDS: readonly string[] = ['.local', '.internal', '.localhost'];

/**
 * True for an address that is not routable on the public internet: loopback,
 * RFC1918 private space, link-local (which is where every cloud metadata
 * service lives), shared/CGNAT space, multicast, and the reserved blocks.
 * Accepts a bare IPv4 or IPv6 literal; anything unparseable is treated as
 * blocked, because an address this cannot classify is not one to fetch.
 */
export function isPrivateAddress(address: string): boolean {
  const ip = address.trim().replace(/^\[|\]$/g, '');
  if (ip === '') return true;

  // IPv4-mapped and -compatible IPv6 (::ffff:127.0.0.1) are IPv4 targets
  // wearing a v6 hat; classify them as the v4 address they carry.
  const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);

  if (ip.includes(':')) return isPrivateIpv6(ip);
  return isPrivateIpv4(ip);
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return true;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = octets as [number, number, number, number];

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local — cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true; // unspecified, loopback
  if (lower.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(lower)) return true; // unique-local (fc00::/7)
  if (lower.startsWith('ff')) return true; // multicast
  return false;
}

/**
 * Registration-time check of the literal host. A hostname that is not an IP
 * literal passes here and is re-checked against its resolved addresses at
 * delivery — see `assertPublicWebhookTarget` in hooks/partnerWebhooks.ts.
 */
export function isPublicWebhookHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host === '') return false;
  if (BLOCKED_HOSTNAMES.has(host)) return false;
  if (BLOCKED_TLDS.some((tld) => host.endsWith(tld))) return false;
  // An IP literal is decided here and now; a name is decided at delivery.
  if (/^\[?[0-9a-f:.]+\]?$/i.test(host) && (/\d+\.\d+\.\d+\.\d+/.test(host) || host.includes(':'))) {
    return !isPrivateAddress(host);
  }
  return true;
}

/**
 * Whether this deployment delivers to private addresses at all.
 *
 * Process-wide rather than a parameter threaded through every caller, because
 * that is what it is: a property of where the service is running, not of the
 * request that happened to fire the event. `onStateChanged` reaches the
 * delivery hook from four unrelated route modules, and giving each of them a
 * webhook field to forward would put the same deployment fact in four places
 * for any of them to get wrong.
 *
 * Defaults to false, so a deployment that sets nothing is the safe one;
 * `buildApp` sets it from WEBHOOK_ALLOW_PRIVATE_TARGETS at boot.
 */
let allowPrivateWebhookTargets = false;

export function setWebhookTargetPolicy(allowPrivate: boolean): void {
  allowPrivateWebhookTargets = allowPrivate;
}

export function webhookTargetPolicyAllowsPrivate(): boolean {
  return allowPrivateWebhookTargets;
}

/**
 * A webhook URL must be plain http(s) — anything else (file:, gopher:, a
 * partner typo) is refused at registration rather than fetched at delivery —
 * and must not name a host inside the network.
 *
 * `allowPrivateTargets` overrides the process policy for a single call; it is
 * the seam the unit tests use to assert both behaviours in one file.
 */
export function isValidWebhookUrl(value: string, allowPrivateTargets?: boolean): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (allowPrivateTargets ?? allowPrivateWebhookTargets) return true;
  return isPublicWebhookHost(url.hostname);
}
