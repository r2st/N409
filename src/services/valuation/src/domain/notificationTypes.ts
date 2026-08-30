import { NOTIFICATION_EVENT_CHANNELS, type NotificationEventType } from './emailWorkflows.js';

/**
 * Every kind of in-app notification this platform writes, and whether a reader
 * can turn it off.
 *
 * The preference matrix (`NOTIFICATION_EVENT_TYPES`) answers "which switches
 * does the settings screen show". It was never the answer to "what can arrive
 * in my inbox": the `notifications.type` column is free text, and the writers
 * outside the state-change hook — the billing webhooks, the payment webhooks,
 * the job-queue alerts, the auditor portal — each chose their own value at the
 * call site. Fifteen types reached readers that the matrix has never listed,
 * so the honest answer to "can I opt out of this?" was "of six of them", and
 * nothing anywhere said which six.
 *
 * Most of that is correct and deliberate — a chargeback deadline is not a
 * preference, and neither is a receipt — but it was correct by accident of
 * where each writer happened to be written. This registry makes it a decision:
 * a type is either bound to a matrix key that silences it, or it is a must-send
 * with a reason recorded beside it. The census in
 * `test/unit/notificationTypeCensus.test.ts` reads the notification writes out
 * of the source and refuses a type that is not here, so the next writer has to
 * answer the question rather than inherit it.
 *
 * `audience` is the second half of the same question and the one that decides
 * what may go in a body. An `ops` type is written only to holders of an
 * administrative role, so it may quote an internal note or name a Stripe
 * object; a `client` type reaches the engagement's owner and may not.
 */
export interface NotificationTypeSpec {
  /** The preference key that silences this, or null for a must-send. */
  optOut: NotificationEventType | null;
  /** Who this is written to. */
  audience: 'client' | 'ops' | 'both';
  /** Why it cannot be turned off, or what it is for. One line. */
  why: string;
}

export const NOTIFICATION_TYPES: Readonly<Record<string, NotificationTypeSpec>> = {
  // ── Workflow transitions (hooks/stateChange.ts) ────────────────────────────
  // The only family that has ever been opt-outable, because it is the only one
  // whose type doubles as its matrix key.
  review_needed: {
    optOut: 'review_needed',
    audience: 'ops',
    why: 'An engagement arrived in the reviewer’s queue.',
  },
  draft_ready: {
    optOut: 'draft_ready',
    audience: 'client',
    why: 'A draft is waiting on the client to accept it or send it back.',
  },
  changes_requested: {
    optOut: 'changes_requested',
    audience: 'ops',
    why: 'The client sent a draft back to the analyst.',
  },
  valuation_completed: {
    optOut: 'valuation_completed',
    audience: 'client',
    why: 'The report is published and available.',
  },

  // ── Engagement thread (hooks/commentNotifications.ts) ─────────────────────
  comment_posted: {
    optOut: 'comment_posted',
    audience: 'both',
    why: 'Somebody wrote on the engagement thread.',
  },

  // ── Correspondence with a deadline attached ───────────────────────────────
  auditor_note_received: {
    optOut: null,
    audience: 'ops',
    why: 'An outside auditor put a finding on the record against their own audit deadline.',
  },

  // ── Money (routes/billing.ts, routes/payments.ts) ─────────────────────────
  // None of these is a preference. A receipt and a refund are financial
  // records, and a declined renewal is the last chance to keep an account —
  // the same rule the transactional email path applies, for the same reason.
  payment_received: { optOut: null, audience: 'client', why: 'Receipt for a payment on an engagement.' },
  payment_failed: { optOut: null, audience: 'both', why: 'A bank debit did not clear; the file is unpaid.' },
  payment_reversed: {
    optOut: null,
    audience: 'both',
    why: 'Money went back out and the engagement’s paid status changed with it.',
  },
  payment_partially_refunded: {
    optOut: null,
    audience: 'both',
    why: 'Part of a payment was refunded; the balance is a fact somebody has to reconcile.',
  },
  payment_disputed: {
    optOut: null,
    audience: 'ops',
    why: 'A chargeback has a Stripe response deadline; the client who raised it is not told.',
  },
  invoice_paid: { optOut: null, audience: 'client', why: 'Receipt for a subscription invoice.' },
  invoice_refunded: { optOut: null, audience: 'both', why: 'A refund against a subscription invoice.' },
  subscription_payment_failed: {
    optOut: null,
    audience: 'both',
    why: 'Dunning: a renewal was declined and the plan lapses if nobody acts.',
  },
  subscription_canceled: { optOut: null, audience: 'client', why: 'The subscription has ended.' },
  subscription_trial_ending: {
    optOut: null,
    audience: 'client',
    why: 'A trial converts to a charge in three days.',
  },
  subscription_conflict: {
    optOut: null,
    audience: 'ops',
    why: 'An account is being billed for two subscriptions and one was not recorded.',
  },

  // ── Infrastructure (hooks/jobAlerts.ts) ───────────────────────────────────
  job_alert: { optOut: null, audience: 'ops', why: 'A background queue has stalled or is failing.' },
  job_alert_resolved: {
    optOut: null,
    audience: 'ops',
    why: 'The queue recovered; an alert that never closes is one an operator learns to ignore.',
  },
};

/** The matrix keys that some notification type is actually bound to. */
export function optOutKeysInUse(): Set<NotificationEventType> {
  const keys = new Set<NotificationEventType>();
  for (const spec of Object.values(NOTIFICATION_TYPES)) if (spec.optOut) keys.add(spec.optOut);
  return keys;
}

/**
 * Whether the matrix advertises an in-app switch for a key nothing is bound to.
 *
 * The reverse of `optOutKeysInUse`, and the direction that goes wrong quietly:
 * an event type declaring `in_app: true` in `NOTIFICATION_EVENT_CHANNELS` and
 * bound to no notification type is a checkbox that silences nothing.
 */
export function unboundInAppKeys(): NotificationEventType[] {
  const bound = optOutKeysInUse();
  return (Object.keys(NOTIFICATION_EVENT_CHANNELS) as NotificationEventType[]).filter(
    (key) => NOTIFICATION_EVENT_CHANNELS[key].in_app && !bound.has(key),
  );
}
