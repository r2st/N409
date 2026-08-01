import { describe, it, expect } from 'vitest';
import { activeFromPatch, parseScimUser, parseUserNameFilter, toScimUser } from '../../src/domain/scim.js';
import { extractIdentity } from '../../src/routes/saml.js';

describe('SCIM mapping (feature 9)', () => {
  it('maps a user row to the SCIM User schema', () => {
    const scim = toScimUser({
      id: 'u1',
      email: 'a@corp.com',
      first_name: 'Ann',
      last_name: 'Lee',
      scim_external_id: 'ext-1',
      deleted_at: null,
      created_at: new Date('2026-01-01'),
    });
    expect(scim.userName).toBe('a@corp.com');
    expect(scim.active).toBe(true);
    expect((scim.emails as Array<{ value: string }>)[0].value).toBe('a@corp.com');
    expect(scim.externalId).toBe('ext-1');
  });

  it('marks a soft-deleted user inactive', () => {
    const scim = toScimUser({
      id: 'u1',
      email: 'a@corp.com',
      first_name: null,
      last_name: null,
      scim_external_id: null,
      deleted_at: new Date(),
      created_at: new Date(),
    });
    expect(scim.active).toBe(false);
  });

  it('parses a userName eq filter', () => {
    expect(parseUserNameFilter('userName eq "Bob@Corp.com"')).toBe('bob@corp.com');
    expect(parseUserNameFilter('displayName co "x"')).toBeNull();
    expect(parseUserNameFilter(undefined)).toBeNull();
  });

  it('parses a SCIM create body from emails or userName', () => {
    expect(parseScimUser({ userName: 'C@Corp.com', name: { givenName: 'C' }, externalId: 'e' })).toEqual({
      email: 'c@corp.com',
      firstName: 'C',
      lastName: null,
      externalId: 'e',
      active: true,
    });
    expect(parseScimUser({ emails: [{ value: 'p@corp.com', primary: true }] })?.email).toBe('p@corp.com');
    expect(parseScimUser({})).toBeNull();
  });

  it('resolves active from a PatchOp with or without a path', () => {
    expect(activeFromPatch({ Operations: [{ op: 'replace', path: 'active', value: false }] })).toBe(false);
    expect(activeFromPatch({ Operations: [{ op: 'replace', value: { active: true } }] })).toBe(true);
    expect(
      activeFromPatch({ Operations: [{ op: 'replace', path: 'name.givenName', value: 'X' }] }),
    ).toBeUndefined();
  });
});

describe('SAML identity extraction (feature 9)', () => {
  it('reads email + names from common attribute keys', () => {
    expect(
      extractIdentity({
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'User@Corp.com',
        givenName: 'User',
        surname: 'Person',
      }),
    ).toEqual({ email: 'user@corp.com', firstName: 'User', lastName: 'Person' });
  });

  it('falls back to nameID when it is an email', () => {
    expect(extractIdentity({ nameID: 'nid@corp.com' }).email).toBe('nid@corp.com');
    expect(extractIdentity({ nameID: 'opaque-id' }).email).toBeNull();
  });
});
