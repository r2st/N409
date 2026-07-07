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
