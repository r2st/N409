import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  ROLE_DEFS,
  capabilitiesFor,
  capabilitiesForRole,
  hasCapability,
  scopeOfRole,
} from '../../src/domain/permissions.js';
import { ROLE_KEYS, type RoleKey } from '../../src/domain/roles.js';
import {
  canCreateValuation,
  canEditWorkingData,
  canManageBranding,
  canManageUsers,
  canReadValuation,
  isOps,
  valuationScope,
  type Principal,
} from '../../src/auth/rbac.js';

const principal = (roles: RoleKey[], partnerId: string | null = null): Principal => ({
  id: 'U1',
  roles,
  partnerId,
});

describe('capability matrix', () => {
  it('describes every role exactly once', () => {
    expect(ROLE_DEFS.map((r) => r.key)).toEqual([...ROLE_KEYS]);
    for (const def of ROLE_DEFS) {
      expect(def.label, `${def.key} has no label`).toBeTruthy();
      expect(def.description.length, `${def.key} has no description`).toBeGreaterThan(20);
    }
  });

  it('uses unique capability keys', () => {
    const keys = CAPABILITIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('grants nothing at all to ignored', () => {
    expect(capabilitiesForRole('ignored')).toEqual([]);
    expect(scopeOfRole('ignored')).toBe('none');
  });

  it('lets ignored subtract from every other role a user holds', () => {
    // The one role that takes away. A suspended admin keeps their `admin` row
    // so restoring them is one delete, and a union that ignored `ignored`
    // would hand them the console back.
    const suspendedAdmin = principal(['admin', 'ignored']);
    expect(hasCapability(suspendedAdmin, 'users.manage')).toBe(false);
    expect(capabilitiesFor(suspendedAdmin)).toEqual([]);
    expect(valuationScope(suspendedAdmin).kind).toBe('none');
  });

  it('unions capabilities across a multi-role principal', () => {
    const caps = capabilitiesFor(principal(['reviewer', 'admin']));
    expect(caps).toContain('working_data.edit'); // reviewer's
    expect(caps).toContain('users.manage'); // admin's
    expect(caps).toEqual([...caps].sort());
  });

  // The point of the file: the matrix is a description of auth/rbac.ts, and a
  // description that drifts is worse than none. Each of these asserts the two
  // agree for every role, so a change to one without the other fails here.
  describe('agrees with the rbac predicates it describes', () => {
    it.each([...ROLE_KEYS])('%s', (role) => {
      const p = principal([role], 'P1');

      expect(hasCapability(p, 'valuations.read.all')).toBe(isOps(p));
      expect(hasCapability(p, 'working_data.edit')).toBe(canEditWorkingData(p));
      expect(hasCapability(p, 'users.manage')).toBe(canManageUsers(p));
      expect(hasCapability(p, 'valuations.create')).toBe(canCreateValuation(p));

      expect(hasCapability(p, 'valuations.read.partner')).toBe(valuationScope(p).kind === 'partner');
      expect(hasCapability(p, 'valuations.read.own')).toBe(valuationScope(p).kind === 'own');

      // Branding splits two ways: platform admins may edit any tenant
      // (`partners.manage`), a partner exactly their own.
      const ownBranding = hasCapability(p, 'branding.manage.own') || hasCapability(p, 'partners.manage');
      expect(ownBranding).toBe(canManageBranding(p, 'P1'));
    });
  });

  it('keeps a member out of their own firm’s branding', () => {
    // `member` is the ordinary seat inside a firm, not its administrator —
    // the distinction the matrix exists to make visible.
    const member = principal(['member'], 'P1');
    expect(hasCapability(member, 'branding.manage.own')).toBe(false);
    expect(hasCapability(member, 'valuations.read.partner')).toBe(true);
    expect(canManageBranding(member, 'P1')).toBe(false);
  });

  it('scopes a partner user to their own firm and nobody else', () => {
    const partner = principal(['partner'], 'P1');
    expect(canReadValuation(partner, { userId: 'U9', partnerId: 'P1' })).toBe(true);
    expect(canReadValuation(partner, { userId: 'U9', partnerId: 'P2' })).toBe(false);
    expect(hasCapability(partner, 'valuations.read.all')).toBe(false);
  });

  it('gives the auditor no valuation scope of its own', () => {
    // Auditor access is granted per engagement through the portal, not by a
    // role that opens a slice of the table.
    const auditor = principal(['auditor']);
    expect(scopeOfRole('auditor')).toBe('none');
    expect(capabilitiesForRole('auditor')).toEqual([]);
    expect(hasCapability(auditor, 'valuations.read.own')).toBe(false);
  });

  it('keeps the shared inbox to ops and partner staff', () => {
    // Clients reply on their own engagement's thread; a cross-engagement
    // inbox is not a thing they have.
    expect(hasCapability(principal(['support']), 'inbox.read')).toBe(true);
    expect(hasCapability(principal(['member'], 'P1'), 'inbox.read')).toBe(true);
    expect(hasCapability(principal(['valuation_user']), 'inbox.read')).toBe(false);
  });
});
