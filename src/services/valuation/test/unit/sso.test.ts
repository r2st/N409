import { describe, it, expect } from 'vitest';
import {
  activeFromPatch,
  isScimRejection,
  parseScimUser,
  parseUserNameFilter,
  toScimUser,
} from '../../src/domain/scim.js';
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
    const fromEmails = parseScimUser({ emails: [{ value: 'p@corp.com', primary: true }] });
    expect(isScimRejection(fromEmails) ? null : fromEmails.email).toBe('p@corp.com');
    // A body naming no user is refused with the reason, not with a bare null —
    // see scim.test.ts for the whole set of bounds this parse now applies.
    expect(parseScimUser({})).toEqual({ rejected: 'A userName / email is required' });
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

  /**
   * The multi-valued claim (round 201, M6).
   *
   * node-saml collapses a single `AttributeValue` to a string and leaves
   * several as an array. `mail`, `givenName` and `sn` are all multi-valued in
   * the LDAP schema every AD- and OpenLDAP-backed IdP builds its assertions
   * from, so an employee with a second address on their record sends a list —
   * and the string check walked straight past it.
   */
  describe('a claim the IdP sent as a list', () => {
    it('reads the address out of a multi-valued mail attribute', () => {
      expect(
        extractIdentity({ mail: ['Ada@Acme.com', 'ada.lovelace@acme.com'], nameID: 'opaque-id' }).email,
      ).toBe('ada@acme.com');
    });

    it('does not fall through to an opaque nameID when the address was there', () => {
      // The failure this replaces: 401 "SAML assertion has no email", for every
      // user in that directory, about an assertion that carried one.
      const identity = extractIdentity({
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': ['ada@acme.com'],
        nameID: 'AAAAAA==-persistent-entra-id',
      });
      expect(identity.email).toBe('ada@acme.com');
    });

    it('reads multi-valued display names', () => {
      expect(
        extractIdentity({ mail: 'a@acme.com', givenName: ['Ada'], surname: ['Lovelace', 'Byron'] }),
      ).toEqual({ email: 'a@acme.com', firstName: 'Ada', lastName: 'Lovelace' });
    });

    it('skips the values in the list it cannot use', () => {
      expect(extractIdentity({ mail: ['', '   ', 42, 'ada@acme.com'] }).email).toBe('ada@acme.com');
    });

    it('still refuses a list whose first usable value is too long to store', () => {
      // Same rule as the scalar: over the bound the claim is dropped rather
      // than truncated, and a dropped address is a 401 rather than an account
      // nobody can email.
      expect(extractIdentity({ mail: [`${'a'.repeat(400)}@acme.com`] }).email).toBeNull();
      expect(extractIdentity({ mail: 'a@acme.com', givenName: ['x'.repeat(200)] }).firstName).toBeNull();
    });

    it('reads an empty list as an absent claim', () => {
      expect(extractIdentity({ mail: [], nameID: 'nid@corp.com' }).email).toBe('nid@corp.com');
    });
  });
});
