import { describe, expect, it } from 'vitest';
import { editableFields, isOps, isPartner, scopeLabel } from '../src/lib/rbac';
import type { User } from '../src/lib/types';

const base: Omit<User, 'roles'> = {
  id: 'u1',
  email: 'u@example.com',
  first_name: null,
  last_name: null,
  phone: null,
  job_title: null,
  company_name: null,
  timezone: null,
  verified: true,
  sso_provider: null,
  partner_id: null,
};

const user = (roles: string[], id = 'u1'): User => ({ ...base, id, roles });

describe('rbac (mirrors valuation service policy)', () => {
  it('classifies ops, partner and client roles', () => {
    expect(isOps(user(['admin']))).toBe(true);
    expect(isOps(user(['reviewer']))).toBe(true);
    expect(isOps(user(['valuation_user']))).toBe(false);
    expect(isPartner(user(['partner']))).toBe(true);
    // ops trumps partner if both are present
    expect(isPartner(user(['partner', 'admin']))).toBe(false);
  });

  it('gives ops the full patchable field set', () => {
    const fields = editableFields(user(['admin']), { user_id: 'someone-else', state: 'published' });
    expect(fields.has('state')).toBe(true);
    expect(fields.has('paid_status')).toBe(true);
  });

  it('limits owners to cosmetic fields on their own valuation', () => {
    const fields = editableFields(user(['valuation_user']), { user_id: 'u1', state: 'started' });
    expect([...fields].sort()).toEqual(['company_name', 'qsbs_attestation', 'service_name']);
  });

  it('closes the owner’s edits once review begins, and on a stopped file', () => {
    // Mirrors domain/clientEdits.ts: the server answers the PATCH with a 409
    // from `review` on, so the form is not drawn. Ops keep the full set.
    for (const state of ['review', 'reviewed', 'drafted', 'draft_accepted', 'published', 'cancelled']) {
      expect(editableFields(user(['valuation_user']), { user_id: 'u1', state }).size).toBe(0);
      expect(editableFields(user(['admin']), { user_id: 'u1', state }).has('company_name')).toBe(true);
    }
    const open = ['pending', 'started', 'onboarding_completed', 'user_finished', 'completed', 'paid'];
    for (const state of open) {
      const fields = editableFields(user(['valuation_user']), { user_id: 'u1', state });
      expect(fields.has('company_name')).toBe(true);
    }
  });

  it('gives non-owners nothing', () => {
    expect(editableFields(user(['valuation_user']), { user_id: 'other', state: 'started' }).size).toBe(0);
    expect(editableFields(null, { user_id: 'u1', state: 'started' }).size).toBe(0);
  });

  it('describes the data scope per role', () => {
    expect(scopeLabel(user(['admin']))).toMatch(/All valuations/);
    expect(scopeLabel(user(['partner']))).toMatch(/partner/i);
    expect(scopeLabel(user(['valuation_user']))).toMatch(/Your valuations/);
  });
});
