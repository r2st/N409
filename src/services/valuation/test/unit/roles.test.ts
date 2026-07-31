import { describe, expect, it } from 'vitest';
import {
  ROLE_KEYS,
  OPS_ROLES,
  PARTNER_ROLES,
  CLIENT_ROLES,
  USER_ADMIN_ROLES,
  type RoleKey,
} from '../../src/domain/roles.js';

describe('ROLE_KEYS', () => {
  it('contains all expected roles', () => {
    expect(ROLE_KEYS).toContain('admin');
    expect(ROLE_KEYS).toContain('god');
    expect(ROLE_KEYS).toContain('partner');
    expect(ROLE_KEYS).toContain('valuation_user');
    expect(ROLE_KEYS).toContain('ignored');
    expect(ROLE_KEYS).toContain('auditor');
  });

  it('has no duplicates', () => {
    const unique = new Set(ROLE_KEYS);
    expect(unique.size).toBe(ROLE_KEYS.length);
  });
});

describe('role scope sets', () => {
  it('OPS_ROLES, PARTNER_ROLES, CLIENT_ROLES are disjoint', () => {
    for (const role of OPS_ROLES) {
      expect(PARTNER_ROLES.has(role)).toBe(false);
      expect(CLIENT_ROLES.has(role)).toBe(false);
    }
    for (const role of PARTNER_ROLES) {
      expect(OPS_ROLES.has(role)).toBe(false);
      expect(CLIENT_ROLES.has(role)).toBe(false);
    }
    for (const role of CLIENT_ROLES) {
      expect(OPS_ROLES.has(role)).toBe(false);
      expect(PARTNER_ROLES.has(role)).toBe(false);
    }
  });

  it('all scope members are valid ROLE_KEYS', () => {
    const allKeys = new Set<string>(ROLE_KEYS);
    for (const role of OPS_ROLES) expect(allKeys.has(role)).toBe(true);
    for (const role of PARTNER_ROLES) expect(allKeys.has(role)).toBe(true);
    for (const role of CLIENT_ROLES) expect(allKeys.has(role)).toBe(true);
  });

  it('ignored and auditor are not in any scope', () => {
    expect(OPS_ROLES.has('ignored')).toBe(false);
    expect(PARTNER_ROLES.has('ignored')).toBe(false);
    expect(CLIENT_ROLES.has('ignored')).toBe(false);
    expect(OPS_ROLES.has('auditor')).toBe(false);
    expect(PARTNER_ROLES.has('auditor')).toBe(false);
    expect(CLIENT_ROLES.has('auditor')).toBe(false);
  });
});

describe('USER_ADMIN_ROLES', () => {
  it('is a subset of OPS_ROLES', () => {
    for (const role of USER_ADMIN_ROLES) {
      expect(OPS_ROLES.has(role)).toBe(true);
    }
  });

  it('includes admin, god, supervisor', () => {
    expect(USER_ADMIN_ROLES.has('admin')).toBe(true);
    expect(USER_ADMIN_ROLES.has('god')).toBe(true);
    expect(USER_ADMIN_ROLES.has('supervisor')).toBe(true);
  });

  it('does not include support or data roles', () => {
    expect(USER_ADMIN_ROLES.has('support' as RoleKey)).toBe(false);
    expect(USER_ADMIN_ROLES.has('data' as RoleKey)).toBe(false);
  });
});
