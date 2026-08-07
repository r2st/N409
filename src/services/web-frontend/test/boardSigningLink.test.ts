import { describe, expect, it } from 'vitest';
import { signingLinkNote } from '../src/components/BoardApprovalPanel';

/**
 * Board signing tokens expire (migration 0101). The console has to say so,
 * because the failure is otherwise silent from the firm's side: the director
 * clicks a dead link, the row still reads "pending", and the first anyone hears
 * of it is a chasing email. Resend re-mints the token and the deadline together,
 * so surfacing the state is the whole fix.
 */

const NOW = new Date('2026-08-07T12:00:00Z');
const inDays = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

const member = (over: Partial<Parameters<typeof signingLinkNote>[0]> = {}) => ({
  status: 'pending' as const,
  sent_at: '2026-07-10T09:00:00Z',
  token_expires_at: inDays(20),
  ...over,
});

describe('signingLinkNote', () => {
  it('flags a lapsed link so ops know to resend', () => {
    expect(signingLinkNote(member({ token_expires_at: inDays(-1) }), NOW)).toBe('Link expired — resend');
  });

  it('counts down only inside the last week, and reads naturally at one day', () => {
    expect(signingLinkNote(member({ token_expires_at: inDays(6) }), NOW)).toBe('Link expires in 6 days');
    expect(signingLinkNote(member({ token_expires_at: inDays(0.5) }), NOW)).toBe('Link expires in 1 day');
  });

  it('stays quiet on a link with plenty of time left', () => {
    expect(signingLinkNote(member(), NOW)).toBeNull();
  });

  it('stays quiet until the link has actually been sent', () => {
    // The next action on an unsent row is "Email link" either way, so a
    // countdown there is noise.
    expect(signingLinkNote(member({ sent_at: null, token_expires_at: inDays(2) }), NOW)).toBeNull();
    // An expired one still shows, because resending is what fixes it.
    expect(signingLinkNote(member({ sent_at: null, token_expires_at: inDays(-2) }), NOW)).toBe(
      'Link expired — resend',
    );
  });

  it('says nothing about a member who has already decided', () => {
    expect(signingLinkNote(member({ status: 'signed', token_expires_at: inDays(-5) }), NOW)).toBeNull();
    expect(signingLinkNote(member({ status: 'rejected', token_expires_at: inDays(-5) }), NOW)).toBeNull();
  });

  it('degrades quietly on a row from before the deadline existed', () => {
    expect(signingLinkNote(member({ token_expires_at: null }), NOW)).toBeNull();
    expect(signingLinkNote(member({ token_expires_at: undefined }), NOW)).toBeNull();
    expect(signingLinkNote(member({ token_expires_at: 'not a date' }), NOW)).toBeNull();
  });
});
