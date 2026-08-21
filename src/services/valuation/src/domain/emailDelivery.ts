/**
 * What happened to a message after the relay took it (migration 0163).
 *
 * Everything here is pure. The rules are the whole point of the subsystem —
 * getting "is this address dead" wrong in either direction is expensive, and
 * both directions are easy to get wrong:
 *
 *   * too eager, and a transient relay fault suppresses a paying client's
 *     address and they silently stop receiving their own valuation reports;
 *   * too shy, and a dead address burns the 0159 ladder's six attempts every
 *     time anybody emails it, forever.
 *
 * So the classification is deliberately conservative and the reasons are
 * written down beside each rule.
 */

/** Terminal for the address, or merely for this attempt. */
export type BounceKind = 'hard' | 'soft' | 'complaint';

export type DeliveryEventKind = 'delivered' | 'bounced' | 'complained' | 'deferred' | 'opened';

/**
 * A bounce that means "stop sending here", as opposed to "try again later".
 *
 * A complaint counts. It is not a delivery failure at all — the message
 * arrived, and a human pressed the spam button — but continuing to send after
 * one is the single fastest way to lose a sending domain, so it stops us
 * harder than a hard bounce does.
 */
export function isTerminalBounce(kind: BounceKind): boolean {
  return kind === 'hard' || kind === 'complaint';
}

/**
 * The SMTP command a reply came back to. Only one of them can indict the
 * recipient, which is the entire reason this is threaded through.
 */
export type SmtpStage =
  'connect' | 'greeting' | 'ehlo' | 'starttls' | 'auth' | 'from' | 'rcpt' | 'data' | 'body';

/**
 * Classify a synchronous SMTP rejection.
 *
 * This is the signal we already have and have never used: the relay tells us
 * `550 5.1.1 <someone@example.com>: Recipient address rejected` in the same
 * conversation, and today that becomes a generic 'failed' row which the ladder
 * then retries five more times over eight and a half hours before giving up —
 * and the next message to the same address does it again.
 *
 * The stage is load-bearing. A permanent rejection is only evidence about the
 * *address* when it came back to RCPT TO. The same 5xx at AUTH means our
 * credentials are wrong; at MAIL FROM it means our envelope sender is not
 * allowed to relay; at DATA it usually means the message is too large or was
 * scored as spam. Every one of those is our fault and applies to every message
 * we are sending, so treating any of them as a hard bounce would suppress
 * whichever client's address happened to be in flight when the relay broke —
 * the worst possible outcome for a subsystem whose job is deliverability.
 *
 * Returns null when the reply is not a rejection we should act on at all.
 */
export function classifySmtpReply(stage: SmtpStage, replyCode: number | null): BounceKind | null {
  if (replyCode === null || !Number.isFinite(replyCode)) return null;

  // 4yz is explicitly "try again" in RFC 5321. Whatever the stage, that is the
  // ladder's case, unmodified.
  if (replyCode >= 400 && replyCode < 500) return 'soft';

  if (replyCode >= 500 && replyCode < 600) {
    // Permanent — but only about the recipient if it was the recipient we
    // asked about.
    if (stage === 'rcpt') return 'hard';
    // A permanent failure of ours. Still a failure, and the row must not be
    // retried forever, but it is the ladder's to bound and it says nothing
    // about the address.
    return 'soft';
  }

  return null;
}

/**
 * Template keys a suppression must not block.
 *
 * A suppression is meant to stop us mailing a dead address, not to lock a user
 * out of the product. `email_verification` is the one message that exists to
 * *prove* an address works, and it is only ever sent because a signed-in user
 * asked for it — so if it were suppressed, an address suppressed in error
 * could never be cleared from the user's side, and the only route back would be
 * an admin releasing it by hand.
 *
 * Deliberately just the one key. `password_reset` is not on it: a hard bounce
 * means the mailbox does not exist, so the reset would bounce too, and sending
 * it anyway spends sending reputation to no effect. An operator who believes a
 * suppression is wrong releases it — which is a decision with a name attached
 * to it, and that is the right shape for this.
 */
export const SUPPRESSION_EXEMPT_TEMPLATES: ReadonlySet<string> = new Set(['email_verification']);

/** The shape `SmtpError` presents, read structurally. */
interface TransportRejection {
  stage: SmtpStage;
  replyCode: number | null;
}

const SMTP_STAGES: ReadonlySet<string> = new Set<SmtpStage>([
  'connect',
  'greeting',
  'ehlo',
  'starttls',
  'auth',
  'from',
  'rcpt',
  'data',
  'body',
]);

/**
 * Classify whatever a transport threw.
 *
 * Structural rather than `instanceof SmtpError` on purpose. `email/smtp.ts`
 * imports the outbox row type and the outbox would have to import the error
 * class back, and a value-level cycle between a transport and a repository is
 * the sort of thing that works until a bundler reorders it. Reading the two
 * properties also means a future transport (an API-based provider client) can
 * opt into classification by carrying the same two fields, without this module
 * knowing it exists.
 *
 * Returns null for anything unrecognised — a socket timeout, a DNS failure, a
 * bug — which leaves the row on the ordinary retry ladder. That is the right
 * default: an error we cannot classify is not evidence against the address.
 */
export function classifyTransportError(err: unknown): BounceKind | null {
  if (typeof err !== 'object' || err === null) return null;
  const candidate = err as Partial<TransportRejection>;
  if (typeof candidate.stage !== 'string' || !SMTP_STAGES.has(candidate.stage)) return null;
  const code = candidate.replyCode;
  if (typeof code !== 'number') return null;
  return classifySmtpReply(candidate.stage as SmtpStage, code);
}

/**
 * Classify an RFC 3463 enhanced status code (`5.1.1`, `4.2.2`, …), as carried
 * by a DSN or repeated by a provider webhook.
 *
 * The class digit is the whole rule: 4 is persistent-transient, 5 is permanent.
 * The subject/detail digits are deliberately not consulted with one exception —
 * `x.2.2`, mailbox full, which some relays report as 5.2.2 even though the
 * condition is by nature temporary. Suppressing an address because its owner
 * was over quota on a Tuesday is exactly the false positive that makes clients
 * stop trusting the platform, so that one is forced soft.
 */
export function classifyDsnStatus(status: string): BounceKind | null {
  const match = /^([245])\.(\d{1,3})\.(\d{1,3})$/.exec(status.trim());
  if (!match) return null;
  const [, cls, subject, detail] = match;
  if (cls === '2') return null; // success; a DSN can report delivery too
  if (subject === '2' && detail === '2') return 'soft'; // mailbox full, always
  return cls === '5' ? 'hard' : 'soft';
}

/**
 * The state an operator should be shown for one message, derived from the
 * columns the ledger maintains.
 *
 * Ordered by what supersedes what, not by chronology: a message that was
 * delivered and then generated a complaint reads as 'complained', because that
 * is the fact an operator needs to act on. 'sent' is deliberately distinct from
 * 'delivered' — see the migration; conflating them is the defect this whole
 * subsystem exists to remove.
 */
export type DeliveryState =
  'queued' | 'skipped' | 'failed' | 'sent' | 'delivered' | 'opened' | 'bounced' | 'complained';

export interface DeliveryColumns {
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  delivered_at: Date | null;
  bounced_at: Date | null;
  first_opened_at: Date | null;
  bounce_kind: BounceKind | null;
}

export function deliveryStateOf(row: DeliveryColumns): DeliveryState {
  if (row.bounce_kind === 'complaint') return 'complained';
  if (row.bounced_at !== null) return 'bounced';
  if (row.first_opened_at !== null) return 'opened';
  if (row.delivered_at !== null) return 'delivered';
  return row.status;
}

/**
 * Which ledger event kinds move which column. Kept as data so the repo's
 * application step and the stats endpoint cannot drift apart on what 'deferred'
 * means.
 */
export const BOUNCE_EVENT_KINDS = ['bounced', 'complained'] as const;

/**
 * A delivery rate worth printing, or null when the denominator is too small to
 * mean anything.
 *
 * A dashboard that reports "0% delivered" off two messages sends somebody to
 * investigate an outage that isn't happening. Below the floor the endpoint
 * returns the raw counts and no rate, and the UI says "not enough data" rather
 * than inventing a percentage.
 */
export const RATE_FLOOR = 20;

export function rateOrNull(numerator: number, denominator: number): number | null {
  if (denominator < RATE_FLOOR) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}
