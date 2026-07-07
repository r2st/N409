import { describe, expect, it } from 'vitest';
import { emailsForTransition, notificationsForTransition } from '../../src/domain/emailWorkflows.js';
import type { ValuationSnapshot } from '../../src/domain/emailWorkflows.js';

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
});
