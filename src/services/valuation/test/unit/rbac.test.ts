import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canCreateValuation,
  canEditWorkingData,
  canManageBranding,
  canManageUsers,
  canReadReport,
  canReadValuation,
  isOps,
  patchableFields,
  valuationScope,
  type Principal,
} from '../../src/auth/rbac.js';
import { OPS_ROLES, USER_ADMIN_ROLES, type RoleKey } from '../../src/domain/roles.js';

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

/**
 * The suspension has to reach the privilege predicates, not only the scope one.
 *
 * `ignored` is designed to subtract while leaving the other `user_roles` rows
 * in place, so lifting a suspension is one DELETE. Every predicate therefore
 * has to subtract it for itself, and the four spelled `roles.some(r =>
 * SET.has(r))` did not: `admin` is in the set whatever else the row carries.
 *
 * Asserted over every ops and user-admin role rather than one representative,
 * because the bug was in the shape of the test — one suspended `admin` proves
 * nothing about `god` or `data_supervisor`, and the whole set is eighteen
 * strings long.
 */
describe('ignored suspends privilege, not just scope', () => {
  const suspended = (roles: RoleKey[]): Principal => ({
    id: '01SUS',
    roles: [...roles, 'ignored'],
    partnerId: '01PARTNER',
  });

  it('takes ops away from every ops role', () => {
    for (const role of OPS_ROLES) {
      expect(isOps(suspended([role])), role).toBe(false);
      expect(canEditWorkingData(suspended([role])), role).toBe(false);
      expect(patchableFields(suspended([role]), otherValuation).size, role).toBe(0);
    }
  });

  it('takes the user console away from every user-admin role', () => {
    for (const role of USER_ADMIN_ROLES) {
      expect(canManageUsers(suspended([role])), role).toBe(false);
      expect(canManageBranding(suspended([role]), '01PARTNER'), role).toBe(false);
    }
  });

  /*
   * The pair that contradicted each other on one engagement: the suspension
   * denied the valuation and `canReadReport`'s `isOps` short-circuit granted
   * the report drawn from it, in whatever state.
   */
  it('does not hand a suspended admin the report it denies the engagement for', () => {
    const p = suspended(['admin']);
    expect(canReadValuation(p, otherValuation)).toBe(false);
    expect(canReadReport(p, { ...otherValuation, state: 'in_progress' })).toBe(false);
    expect(canReadReport(p, { ...otherValuation, state: 'published' })).toBe(false);
  });

  it('leaves a suspended partner unable to brand their own firm', () => {
    expect(canManageBranding({ id: '01P', roles: ['partner'], partnerId: '01PARTNER' }, '01PARTNER')).toBe(
      true,
    );
    expect(canManageBranding(suspended(['partner']), '01PARTNER')).toBe(false);
  });

  it('still grants an unsuspended holder of the same role everything', () => {
    expect(isOps(admin)).toBe(true);
    expect(canManageUsers(admin)).toBe(true);
    expect(canManageBranding(admin, '01PARTNER')).toBe(true);
  });
});

/**
 * Census: what a suspension is, spelled once.
 *
 * `SUSPENDED_ROLE` exists because the question is asked on both sides of the
 * wire — `isSuspended` for a principal the policy layer holds, and a `WHERE`
 * clause for a row a query is filtering — and a literal written out per query
 * is how the push half and the policy layer come to disagree. The reviewer
 * picker binds the constant; `listUserIdsWithRoles` spelled it out until R373.
 *
 * Scoped to a role `key` comparison on purpose: `ignored` is also a valuation
 * *state*, and `repos/valuations.ts` names it as one in a terminal-state list
 * that has nothing to do with suspension.
 */
describe('the suspension role is not spelled out in SQL', () => {
  const srcRoot = new URL('../../src/', import.meta.url).pathname;

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
    });
  }

  it('compares a role key against the bound constant, never a literal', () => {
    const offenders: string[] = [];
    for (const file of sources(srcRoot)) {
      if (file.endsWith('auth/rbac.ts')) continue;
      const text = readFileSync(file, 'utf8');
      for (const [index, line] of text.split('\n').entries()) {
        // Prose is exempt: the notes on `SUSPENDED_ROLE`, `isLastUserAdmin` and
        // the partner API's suspension refusal all quote the clause they are
        // arguing about, and quoting it is the opposite of the drift here.
        if (/^\s*(?:\*|\/\/|\/\*)/.test(line)) continue;
        // `sr.key = 'ignored'`, `key IN ('ignored')`, `key = ANY('{ignored}')` —
        // a role-key *comparison* written out rather than parameterised. The
        // operator is required, so `key: 'ignored'` (the workflow bucket, which
        // is a valuation state and not a role) is not this.
        if (/\bkey\b\s*(?:=|<>|!=|\bIN\b)[^\n]{0,24}ignored/i.test(line)) {
          offenders.push(`${file.slice(srcRoot.length)}:${index + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
