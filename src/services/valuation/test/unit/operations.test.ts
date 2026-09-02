import { describe, expect, it } from 'vitest';
import { parseEmailSubjectRef, stateGroupOf, STATE_GROUPS } from '../../src/domain/operations.js';
import {
  canEditComment,
  canManageTokens,
  canPostComment,
  visibleCommentKinds,
} from '../../src/auth/operations.js';
import { VALUATION_STATES } from '../../src/domain/valuation.js';
import type { Principal } from '../../src/auth/rbac.js';

const ops: Principal = { id: 'op', roles: ['admin'], partnerId: null };
const partner: Principal = { id: 'pa', roles: ['partner'], partnerId: 'P1' };
const member: Principal = { id: 'me', roles: ['member'], partnerId: 'P1' };
const client: Principal = { id: 'cl', roles: ['valuation_user'], partnerId: null };

describe('state groups', () => {
  it('assigns every state to exactly one group', () => {
    const all = Object.values(STATE_GROUPS).flat();
    expect([...all].sort()).toEqual([...VALUATION_STATES].sort());
    for (const state of VALUATION_STATES) expect(stateGroupOf(state)).toBeTruthy();
  });

  it('maps representative states', () => {
    expect(stateGroupOf('pending')).toBe('open');
    expect(stateGroupOf('review')).toBe('in_review');
    expect(stateGroupOf('draft_changes')).toBe('drafted');
    expect(stateGroupOf('published')).toBe('published');
    expect(stateGroupOf('cancelled')).toBe('closed');
  });
});

describe('parseEmailSubjectRef', () => {
  it('finds a ULID anywhere in the subject', () => {
    const id = '01HZXW5N8YBFJ4G2Q0TCVMKRAE';
    expect(parseEmailSubjectRef(`Re: valuation ${id} docs`)).toEqual({ id });
    expect(parseEmailSubjectRef(`re: valuation ${id.toLowerCase()} docs`)).toEqual({ id });
  });

  it('finds a #number reference', () => {
    expect(parseEmailSubjectRef('Fwd: question about #482')).toEqual({ number: 482 });
  });

  it('returns empty for unmatched subjects', () => {
    expect(parseEmailSubjectRef('hello there')).toEqual({});
  });
});

describe('comment policy', () => {
  it('ops see all kinds; everyone else sees chat only', () => {
    expect([...visibleCommentKinds(ops)].sort()).toEqual(['chat', 'email', 'note']);
    expect([...visibleCommentKinds(client)]).toEqual(['chat']);
    expect([...visibleCommentKinds(partner)]).toEqual(['chat']);
  });

  it('clients may chat on their own valuation but never post notes', () => {
    const ref = { userId: 'cl', partnerId: null };
    expect(canPostComment(client, ref, 'chat')).toBe(true);
    expect(canPostComment(client, ref, 'note')).toBe(false);
    expect(canPostComment(client, { userId: 'other', partnerId: null }, 'chat')).toBe(false);
    expect(canPostComment(ops, ref, 'note')).toBe(true);
  });

  it('email is never postable through the comment endpoint', () => {
    expect(canPostComment(ops, { userId: 'cl', partnerId: null }, 'email')).toBe(false);
  });
});

describe('token policy', () => {
  it('ops manage any partner, partner admins their own org only', () => {
    expect(canManageTokens(ops, 'P1')).toBe(true);
    expect(canManageTokens(partner, 'P1')).toBe(true);
    expect(canManageTokens(partner, 'P2')).toBe(false);
    expect(canManageTokens(member, 'P1')).toBe(false);
    expect(canManageTokens(client, 'P1')).toBe(false);
  });

  /*
   * `isOps` subtracts the suspension for the ops roles, and answers nothing
   * about this one: the `partner` line is the whole of a firm administrator's
   * authority and it read a role key straight off the row. An API token is
   * also the one credential a later suspension cannot reach, since it is
   * revoked by its own record rather than by its holder's session.
   */
  it('a suspended firm administrator mints nothing', () => {
    const suspended = { ...partner, roles: [...partner.roles, 'ignored' as const] };
    expect(canManageTokens(suspended, 'P1')).toBe(false);
  });
});

describe('a suspension subtracts from every predicate in this file', () => {
  const suspendedClient: Principal = { ...client, roles: [...client.roles, 'ignored'] };
  const suspendedOps: Principal = { ...ops, roles: [...ops.roles, 'ignored'] };

  it('refuses a suspended author their own comment', () => {
    // `ignored` is additive: the row keeps `valuation_user`, and the own-record
    // arm compares an id rather than asking what the principal may do.
    expect(canEditComment(client, { author_id: client.id })).toBe(true);
    expect(canEditComment(suspendedClient, { author_id: suspendedClient.id })).toBe(false);
  });

  it('refuses a suspended moderator everyone else’s', () => {
    expect(canEditComment(ops, { author_id: client.id })).toBe(true);
    expect(canEditComment(suspendedOps, { author_id: client.id })).toBe(false);
  });

  it('still refuses an unattributed comment to a live client', () => {
    expect(canEditComment(client, { author_id: null })).toBe(false);
  });
});
