import { describe, expect, it } from 'vitest';
import {
  canCreateValuation,
  canEditWorkingData,
  canManageUsers,
  canReadReport,
  canReadValuation,
  isOps,
  patchableFields,
  valuationScope,
  type Principal,
} from '../../src/auth/rbac.js';

const ops: Principal = { id: '01OPS', roles: ['reviewer'], partnerId: null };
const admin: Principal = { id: '01ADM', roles: ['admin'], partnerId: null };
const partner: Principal = { id: '01PTU', roles: ['partner'], partnerId: '01PARTNER' };
const client: Principal = { id: '01CLI', roles: ['valuation_user'], partnerId: null };
const ignored: Principal = { id: '01IGN', roles: ['ignored'], partnerId: null };
const roleless: Principal = { id: '01NON', roles: [], partnerId: null };

const ownValuation = { userId: '01CLI', partnerId: null };
const partnerValuation = { userId: '01SOMEONE', partnerId: '01PARTNER' };
const otherValuation = { userId: '01OTHER', partnerId: '01OTHERPARTNER' };

describe('valuationScope (issue #3 — partner scoping)', () => {
  it('ops roles see everything', () => {
    expect(valuationScope(ops)).toEqual({ kind: 'all' });
    expect(valuationScope(admin)).toEqual({ kind: 'all' });
  });
  it('partner roles are scoped to their partner', () => {
    expect(valuationScope(partner)).toEqual({ kind: 'partner', partnerId: '01PARTNER' });
  });
  it('a partner-role user without partner_id gets nothing', () => {
    expect(valuationScope({ ...partner, partnerId: null })).toEqual({ kind: 'none' });
  });
  it('clients are scoped to their own valuations', () => {
    expect(valuationScope(client)).toEqual({ kind: 'own', userId: '01CLI' });
  });
  it('ignored and role-less users get nothing', () => {
    expect(valuationScope(ignored)).toEqual({ kind: 'none' });
    expect(valuationScope(roleless)).toEqual({ kind: 'none' });
  });
  it('ignored trumps other roles', () => {
    expect(valuationScope({ id: 'x', roles: ['admin', 'ignored'], partnerId: null })).toEqual({
      kind: 'none',
    });
  });
});

describe('canReadValuation', () => {
  it('ops read anything', () => {
    expect(canReadValuation(ops, otherValuation)).toBe(true);
  });
  it('partner reads inside scope only', () => {
    expect(canReadValuation(partner, partnerValuation)).toBe(true);
    expect(canReadValuation(partner, otherValuation)).toBe(false);
    expect(canReadValuation(partner, ownValuation)).toBe(false);
  });
  it('client reads own only', () => {
    expect(canReadValuation(client, ownValuation)).toBe(true);
    expect(canReadValuation(client, partnerValuation)).toBe(false);
  });
  it('ignored reads nothing', () => {
    expect(canReadValuation(ignored, ownValuation)).toBe(false);
  });
});

describe('patch policy', () => {
  it('ops may patch operational fields incl. state', () => {
    const fields = patchableFields(ops, otherValuation);
    expect(fields.has('state')).toBe(true);
    expect(fields.has('assigned_reviewer_id')).toBe(true);
  });
  it('owner may patch only client-safe fields', () => {
    const fields = patchableFields(client, ownValuation);
    expect(fields.has('company_name')).toBe(true);
    expect(fields.has('state')).toBe(false);
    expect(fields.has('paid_status')).toBe(false);
  });
  it('non-owner client may patch nothing', () => {
    expect(patchableFields(client, partnerValuation).size).toBe(0);
  });
});

describe('misc capabilities', () => {
  it('create allowed for anyone in scope, denied for ignored', () => {
    expect(canCreateValuation(client)).toBe(true);
    expect(canCreateValuation(partner)).toBe(true);
    expect(canCreateValuation(ignored)).toBe(false);
  });
  it('user admin restricted to admin/god/supervisor', () => {
    expect(canManageUsers(admin)).toBe(true);
    expect(canManageUsers(ops)).toBe(false);
    expect(canManageUsers(client)).toBe(false);
  });

  it('isOps matches ops-level roles only', () => {
    expect(isOps(ops)).toBe(true);
    expect(isOps(admin)).toBe(true);
    expect(isOps(partner)).toBe(false);
    expect(isOps(client)).toBe(false);
    expect(isOps(ignored)).toBe(false);
  });

  it('canEditWorkingData is ops-only', () => {
    expect(canEditWorkingData(ops)).toBe(true);
    expect(canEditWorkingData(admin)).toBe(true);
    expect(canEditWorkingData(partner)).toBe(false);
    expect(canEditWorkingData(client)).toBe(false);
  });
});

describe('canReadReport', () => {
  const drafted = { ...ownValuation, state: 'drafted' };
  const published = { ...ownValuation, state: 'published' };
  const inProgress = { ...ownValuation, state: 'in_progress' };

  it('ops can read the report in any state', () => {
    expect(canReadReport(ops, inProgress)).toBe(true);
    expect(canReadReport(ops, drafted)).toBe(true);
  });

  it('owner can read once drafted or published, not before', () => {
    expect(canReadReport(client, drafted)).toBe(true);
    expect(canReadReport(client, published)).toBe(true);
    expect(canReadReport(client, inProgress)).toBe(false);
  });

  it('non-owner cannot read even in a visible state', () => {
    const otherDrafted = { ...otherValuation, state: 'drafted' };
    expect(canReadReport(client, otherDrafted)).toBe(false);
  });
});
