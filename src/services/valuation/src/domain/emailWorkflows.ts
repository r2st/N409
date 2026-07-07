import type { ValuationState } from './valuation.js';

/**
 * Auto email workflows + notification rules (M4, P1 #21 / P2 #27).
 *
 * Declarative map from a state transition to who gets told what. Pure —
 * rendering takes a snapshot of the valuation, the hook layer resolves
 * recipients to actual users and writes outbox rows / notifications in the
 * same transaction as the state change.
 */

export type Recipient = 'owner' | 'reviewer';

/**
 * The frozen event-type taxonomy for notification preferences (P2 #11).
 * Every RULES entry's templateKey / notify type MUST be one of these — the
 * preference matrix keys on them. Transactional account emails (password
 * reset, invitations) are intentionally NOT here: they always deliver.
 */
export const NOTIFICATION_EVENT_TYPES = [
  'valuation_started',
  'review_needed',
  'draft_ready',
  'changes_requested',
  'valuation_completed',
  'valuation_cancelled',
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export interface ValuationSnapshot {
  id: string;
  kind: string;
  company_name: string;
  user_id: string;
  assigned_reviewer_id: string | null;
}

export interface EmailSpec {
  recipient: Recipient;
  templateKey: string;
  subject: string;
  body: string;
}

export interface NotificationSpec {
  recipient: Recipient;
  type: string;
  title: string;
  body: string;
}

interface TransitionRule {
  email?: Array<{
    recipient: Recipient;
    templateKey: string;
    subject: (v: ValuationSnapshot) => string;
    body: (v: ValuationSnapshot) => string;
  }>;
  notify?: Array<{
    recipient: Recipient;
    type: string;
    title: (v: ValuationSnapshot) => string;
    body: (v: ValuationSnapshot) => string;
  }>;
}

const label = (v: ValuationSnapshot) => `${v.kind.toUpperCase()} valuation for ${v.company_name}`;

/** Rules keyed by the state being ENTERED. */
const RULES: Partial<Record<ValuationState, TransitionRule>> = {
  started: {
    email: [
      {
        recipient: 'owner',
        templateKey: 'valuation_started',
        subject: (v) => `We've started your ${label(v)}`,
        body: (v) =>
          `Work on your ${label(v)} has begun. We'll let you know as soon as anything needs your input.`,
      },
    ],
  },
  review: {
    email: [
      {
        recipient: 'reviewer',
        templateKey: 'review_needed',
        subject: (v) => `Review needed: ${label(v)}`,
        body: (v) => `The ${label(v)} is ready for review. Please pick it up in the dashboard.`,
      },
    ],
    notify: [
      {
        recipient: 'reviewer',
        type: 'review_needed',
        title: () => 'Review needed',
        body: (v) => `${label(v)} is waiting on your review.`,
      },
    ],
  },
  drafted: {
    email: [
      {
        recipient: 'owner',
        templateKey: 'draft_ready',
        subject: (v) => `Your draft ${label(v)} is ready`,
        body: (v) =>
          `A draft of your ${label(v)} is ready for your review. Sign in to accept it or request changes.`,
      },
    ],
    notify: [
      {
        recipient: 'owner',
        type: 'draft_ready',
        title: () => 'Draft ready',
        body: (v) => `A draft of your ${label(v)} is ready for review.`,
      },
    ],
  },
  draft_changes: {
    notify: [
      {
        recipient: 'reviewer',
        type: 'changes_requested',
        title: () => 'Changes requested',
        body: (v) => `The client requested changes on the ${label(v)}.`,
      },
    ],
  },
  published: {
    email: [
      {
        recipient: 'owner',
        templateKey: 'valuation_completed',
        subject: (v) => `Your ${label(v)} is complete`,
        body: (v) =>
          `Your ${label(v)} has been finalized and published. The report is available in your dashboard.`,
      },
    ],
    notify: [
      {
        recipient: 'owner',
        type: 'valuation_completed',
        title: () => 'Valuation complete',
        body: (v) => `Your ${label(v)} has been published.`,
      },
    ],
  },
  cancelled: {
    email: [
      {
        recipient: 'owner',
        templateKey: 'valuation_cancelled',
        subject: (v) => `Your ${label(v)} was cancelled`,
        body: (v) => `Your ${label(v)} has been cancelled. Reply to this email if that's unexpected.`,
      },
    ],
  },
};

export function emailsForTransition(v: ValuationSnapshot, to: ValuationState): EmailSpec[] {
  return (RULES[to]?.email ?? []).map((r) => ({
    recipient: r.recipient,
    templateKey: r.templateKey,
    subject: r.subject(v),
    body: r.body(v),
  }));
}

export function notificationsForTransition(v: ValuationSnapshot, to: ValuationState): NotificationSpec[] {
  return (RULES[to]?.notify ?? []).map((r) => ({
    recipient: r.recipient,
    type: r.type,
    title: r.title(v),
    body: r.body(v),
  }));
}

// ── Transactional templates (P0 #3 password reset, feature #9 invitations) ───
// Account emails, not workflow emails — rendered directly by the auth/admin
// routes and always delivered regardless of notification settings.

export interface TransactionalEmail {
  templateKey: string;
  subject: string;
  body: string;
}

export function passwordResetEmail(link: string): TransactionalEmail {
  return {
    templateKey: 'password_reset',
    subject: 'Reset your N409 password',
    body:
      `We received a request to reset the password for your N409 account.\n\n` +
      `Use this link within the next hour to choose a new password:\n\n${link}\n\n` +
      `If you didn't request this, you can safely ignore this email — your password is unchanged.`,
  };
}

export function invitationEmail(link: string, invitedByEmail: string): TransactionalEmail {
  return {
    templateKey: 'user_invite',
    subject: "You've been invited to N409",
    body:
      `${invitedByEmail} invited you to the N409 valuations workspace.\n\n` +
      `Use this link within the next 7 days to set your password and sign in:\n\n${link}\n\n` +
      `If you weren't expecting this invitation, you can ignore this email.`,
  };
}
