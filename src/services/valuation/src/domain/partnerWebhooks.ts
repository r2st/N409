import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isPrivateAddress as isPrivateLiteral } from './privateAddress.js';

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
  /**
   * The engagement has been withdrawn: it will not transition again, every
   * write to it now answers 409, and the deliverable stops being shared.
   *
   * The only terminal event on this API, and the reason it exists is that
   * nothing else says so. A retired engagement leaves `GET /valuations`,
   * stops emitting `valuation.state_changed` (there are no more states), and
   * simply goes quiet — an integration waiting on a report it will never get
   * has no way to distinguish that from work still in progress.
   */
  'valuation.retired',
  /** Sent by POST /webhooks/{id}/test — a signed ping to verify the receiver. */
  'webhook.test',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

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
 * already made. Five steps, so a delivery is tried at most six times: the
 * immediate attempt, then +1 min, +5 min, +30 min, +2 h, +6 h.
 *
 * The spread is chosen against what actually takes a receiver down. A minute
 * covers a rolling restart or a momentary connection reset; five covers a
 * deploy; thirty covers an incident someone has to be paged for. Doubling from
 * a one-minute base would spend all the attempts inside the first quarter of
 * an hour and land the whole set inside a single outage.
 *
 * The two long steps are what make that argument finish. Stopping at thirty
 * gave the ladder a 36-minute reach, so *every* incident longer than half an
 * hour — the ordinary kind, where the page fires at 02:00 and the fix lands at
 * 04:30 — dropped the partner's events permanently while the receiver was
 * merely down, which is the one outcome the retry mechanism exists to prevent.
 * Reaching ~8.5 hours spans an overnight incident and a business day's
 * response, and it is still bounded: a receiver that is genuinely gone settles
 * to 'failed' and stops, rather than being retried forever behind an
 * ever-growing counter.
 */
export const WEBHOOK_RETRY_BACKOFF_MINUTES: readonly number[] = [1, 5, 30, 120, 360];

/** The initial attempt plus one per backoff step. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_BACKOFF_MINUTES.length + 1;

/**
 * How long to wait before attempt number `attemptsMade + 1`, or null when the
 * row is out of attempts and the failure is terminal.
 *
 * `attemptsMade` is the count *including* the one that just failed, which is
 * how the row reads after a claim (the claim increments). So a first failure
 * asks for BACKOFF[0].
 *
 * This is the *base* step. The scheduled time adds jitter — see `nextAttemptAt`
 * — so this stays the pure, testable statement of the ladder's shape.
 */
export function retryDelayMinutes(attemptsMade: number, maxAttempts = WEBHOOK_MAX_ATTEMPTS): number | null {
  if (attemptsMade >= maxAttempts) return null;
  const step = WEBHOOK_RETRY_BACKOFF_MINUTES[attemptsMade - 1];
  // More attempts allowed than we have backoff steps for: hold at the longest
  // step rather than falling through to "terminal", which would silently make
  // a raised max_attempts do nothing.
  return step ?? WEBHOOK_RETRY_BACKOFF_MINUTES.at(-1) ?? 30;
}

/**
 * The smallest share of a backoff step that may actually be waited.
 *
 * "Equal jitter": the delay lands uniformly in [50%, 100%] of the step. The
 * problem being solved is that an outage fails every delivery in flight at
 * roughly the same moment, and a fixed ladder then gives all of them the *same*
 * next-attempt time — so the whole backlog comes due in one instant and the
 * sweep serves the receiver its entire outage the second it comes back. A
 * receiver that has just restarted is precisely the one that cannot take that,
 * which turns one outage into two.
 *
 * Half a step rather than full jitter (uniform in [0, step]) because the ladder's
 * steps mean something: full jitter would retry a 30-minute step after 40
 * seconds, undoing the reasoning above about what each step covers. Halving
 * decorrelates the backlog — which is all that is needed — while keeping every
 * attempt inside the order of magnitude it was chosen for.
 */
export const WEBHOOK_JITTER_FLOOR = 0.5;

/** `Math.random`, injectable so the tests can pin both ends of the range. */
export type RandomFn = () => number;

export interface NextAttemptOptions {
  random?: RandomFn;
  /**
   * Seconds the receiver asked for via `Retry-After`, if it sent a usable one.
   * Overrides the ladder for this attempt — see `parseRetryAfter`.
   */
  retryAfterSeconds?: number | null;
}

/**
 * The longest `Retry-After` that will be honoured, in seconds.
 *
 * A receiver asking for more than the ladder's own reach is either
 * misconfigured or telling us to hold an event past the point where it is still
 * worth delivering, and an unbounded value read off a remote header is a
 * remote party choosing how long our row occupies the queue.
 */
export const MAX_RETRY_AFTER_SECONDS = 6 * 60 * 60;

/**
 * `Retry-After` as seconds from `now`, or null when it is absent or unusable.
 *
 * Both RFC 9110 forms: delta-seconds, and an HTTP-date. A date in the past
 * reads as 0 (retry now) rather than a negative delay; anything unparseable is
 * null so the caller falls back to the ladder rather than to a NaN.
 */
export function parseRetryAfter(value: string | null | undefined, now: Date = new Date()): number | null {
  if (value == null) return null;
  const text = value.trim();
  if (text === '') return null;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS) : null;
  }
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  const seconds = Math.ceil((at - now.getTime()) / 1000);
  return Math.min(Math.max(seconds, 0), MAX_RETRY_AFTER_SECONDS);
}

/**
 * The absolute time of the next attempt, or null when the row is exhausted.
 *
 * `Retry-After` wins over the ladder when the receiver sent one: a 429 or a 503
 * carrying it is the receiver stating when it will be ready, and retrying
 * earlier gets us rate-limited again and burns an attempt on a request we were
 * told would fail. It is *not* jittered — the whole point is that the receiver
 * chose the time — but it is clamped by `parseRetryAfter`.
 */
export function nextAttemptAt(
  attemptsMade: number,
  maxAttempts = WEBHOOK_MAX_ATTEMPTS,
  now: Date = new Date(),
  options: NextAttemptOptions = {},
): Date | null {
  const minutes = retryDelayMinutes(attemptsMade, maxAttempts);
  // Checked before `Retry-After` is read: a row out of attempts is terminal
  // whatever the receiver asks for, or a receiver could keep itself in the
  // queue indefinitely by answering 429 with a header every time.
  if (minutes === null) return null;

  const asked = options.retryAfterSeconds;
  if (asked != null && Number.isFinite(asked) && asked >= 0) {
    return new Date(now.getTime() + asked * 1000);
  }

  const random = options.random ?? Math.random;
  const factor = WEBHOOK_JITTER_FLOOR + (1 - WEBHOOK_JITTER_FLOOR) * random();
  return new Date(now.getTime() + Math.round(minutes * 60_000 * factor));
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
 * Accepts a bare IPv4 or IPv6 literal, with or without the brackets a URL's
 * `hostname` keeps around a v6 one; anything unparseable is treated as
 * blocked, because an address this cannot classify is not one to fetch.
 *
 * The classification itself is `domain/privateAddress.ts`, shared with the
 * logo fetcher. This used to be its own second implementation, and it matched
 * IPv6 on the text of the address: `::1` and `fe80::` were caught, but
 * `::ffff:7f00:1` was not — which is the form `new URL()` normalises
 * `http://[::ffff:127.0.0.1]/` into, so that target registered as public. 6to4
 * and NAT64 wrappings of a private v4 address had the same hole, and those two
 * arrive from DNS rather than from the URL, so no attacker had to type them.
 */
export function isPrivateAddress(address: string): boolean {
  const ip = address.trim().replace(/^\[|\]$/g, '');
  if (ip === '') return true;
  return isPrivateLiteral(ip);
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
