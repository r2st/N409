import { describe, expect, it } from 'vitest';
import {
  emailsForTransition,
  NOTIFICATION_EVENT_CHANNELS,
  NOTIFICATION_EVENT_TYPES,
  notificationsForTransition,
} from '../../src/domain/emailWorkflows.js';
import type { ValuationSnapshot } from '../../src/domain/emailWorkflows.js';
import { VALUATION_STATES } from '../../src/domain/valuation.js';

const valuation: ValuationSnapshot = {
  id: '01JZragTESTVALUATION0000000',
  kind: '409a',
  company_name: 'Acme Corp',
  user_id: 'user-1',
  assigned_reviewer_id: 'reviewer-1',
};

describe('auto email workflows (M4 #21)', () => {
  it('emails the owner when the valuation is published', () => {
    const emails = emailsForTransition(valuation, 'published');
    expect(emails).toHaveLength(1);
    expect(emails[0]!.recipient).toBe('owner');
    expect(emails[0]!.templateKey).toBe('valuation_completed');
    expect(emails[0]!.subject).toContain('Acme Corp');
    expect(emails[0]!.subject).toContain('409A');
  });

  it('emails the reviewer when review starts', () => {
    const emails = emailsForTransition(valuation, 'review');
    expect(emails.map((e) => e.recipient)).toEqual(['reviewer']);
    expect(emails[0]!.templateKey).toBe('review_needed');
  });

  it('notifies the owner when a draft is ready', () => {
    const notifications = notificationsForTransition(valuation, 'drafted');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.recipient).toBe('owner');
    expect(notifications[0]!.type).toBe('draft_ready');
  });

  it('notifies the reviewer when the client requests changes', () => {
    const notifications = notificationsForTransition(valuation, 'draft_changes');
    expect(notifications.map((n) => n.recipient)).toEqual(['reviewer']);
  });

  it('stays silent on transitions without rules', () => {
    expect(emailsForTransition(valuation, 'onboarding_completed')).toEqual([]);
    expect(notificationsForTransition(valuation, 'timeout')).toEqual([]);
  });

  // P2 #11 — the preference matrix keys on templateKey / notify type, so every
  // rule must use an event type from the frozen taxonomy.
  it('keeps every workflow event type inside NOTIFICATION_EVENT_TYPES', () => {
    const known = new Set<string>(NOTIFICATION_EVENT_TYPES);
    for (const state of VALUATION_STATES) {
      for (const email of emailsForTransition(valuation, state)) {
        expect(known.has(email.templateKey), `email templateKey for ${state}`).toBe(true);
      }
      for (const notify of notificationsForTransition(valuation, state)) {
        expect(known.has(notify.type), `notify type for ${state}`).toBe(true);
      }
    }
  });

  /**
   * The other direction, which was missing and is the one the settings screen
   * depends on.
   *
   * The census above proves no rule uses a key outside the taxonomy. It says
   * nothing about a taxonomy entry that advertises a channel no rule produces,
   * and four of them did — so the preference matrix offered checkboxes that
   * saved a value nothing ever read. `NOTIFICATION_EVENT_CHANNELS` is derived
   * from `RULES`, so what these two assertions really pin is the pair that
   * cannot be derived: `marketing` and `comment_posted` are declared by hand,
   * and a declaration that drifts from what those two paths actually send is
   * exactly the bug this closes, one file further away.
   */
  it('advertises a channel only where something produces on it', () => {
    const produced = Object.fromEntries(
      NOTIFICATION_EVENT_TYPES.map((t) => [t, { in_app: false, email: false }]),
    ) as Record<string, { in_app: boolean; email: boolean }>;
    for (const state of VALUATION_STATES) {
      for (const email of emailsForTransition(valuation, state)) produced[email.templateKey]!.email = true;
      for (const notify of notificationsForTransition(valuation, state)) produced[notify.type]!.in_app = true;
    }
    // The two non-transition event types, whose senders are elsewhere.
    produced.marketing!.email = true; // domain/communications.isSuppressed
    produced.comment_posted!.in_app = true; // hooks/commentNotifications.ts

    for (const type of NOTIFICATION_EVENT_TYPES) {
      expect(NOTIFICATION_EVENT_CHANNELS[type], `channels for ${type}`).toEqual(produced[type]);
    }
  });

  it('leaves no event type with both channels dark', () => {
    for (const type of NOTIFICATION_EVENT_TYPES) {
      const c = NOTIFICATION_EVENT_CHANNELS[type];
      expect(c.in_app || c.email, `${type} reaches nobody on either channel`).toBe(true);
    }
  });
});
