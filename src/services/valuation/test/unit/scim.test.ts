import { describe, expect, it } from 'vitest';
import {
  toScimUser,
  scimError,
  scimList,
  parseUserNameFilter,
  parseScimUser,
  activeFromPatch,
  SCIM_USER_SCHEMA,
  SCIM_LIST_SCHEMA,
  SCIM_ERROR_SCHEMA,
  type ScimUserRow,
} from '../../src/domain/scim.js';

function fakeUser(overrides: Partial<ScimUserRow> = {}): ScimUserRow {
  return {
    id: 'usr_123',
    email: 'alice@example.com',
    first_name: 'Alice',
    last_name: 'Smith',
    scim_external_id: 'ext-001',
    deleted_at: null,
    created_at: new Date('2024-01-15T00:00:00Z'),
    ...overrides,
  };
}

describe('toScimUser', () => {
  it('maps all fields for an active user', () => {
    const result = toScimUser(fakeUser());
    expect(result.schemas).toEqual([SCIM_USER_SCHEMA]);
    expect(result.id).toBe('usr_123');
    expect(result.externalId).toBe('ext-001');
    expect(result.userName).toBe('alice@example.com');
    expect(result.active).toBe(true);
    expect((result.name as any).givenName).toBe('Alice');
    expect((result.name as any).familyName).toBe('Smith');
    expect(result.displayName).toBe('Alice Smith');
    expect((result.emails as any[])[0]).toEqual({
      value: 'alice@example.com',
      primary: true,
      type: 'work',
    });
    expect((result.meta as any).resourceType).toBe('User');
    expect((result.meta as any).location).toBe('/scim/v2/Users/usr_123');
  });

  it('marks soft-deleted user as inactive', () => {
    const result = toScimUser(fakeUser({ deleted_at: new Date() }));
    expect(result.active).toBe(false);
  });

  it('omits externalId when null', () => {
    const result = toScimUser(fakeUser({ scim_external_id: null }));
    expect(result.externalId).toBeUndefined();
  });

  it('falls back to email as displayName when names are null', () => {
    const result = toScimUser(fakeUser({ first_name: null, last_name: null }));
    expect(result.displayName).toBe('alice@example.com');
    expect((result.name as any).givenName).toBeUndefined();
    expect((result.name as any).familyName).toBeUndefined();
  });

  it('uses first name only when last name is null', () => {
    const result = toScimUser(fakeUser({ last_name: null }));
    expect(result.displayName).toBe('Alice');
  });
});

describe('scimError', () => {
  it('returns well-formed SCIM error', () => {
    const err = scimError(404, 'User not found');
    expect(err.schemas).toEqual([SCIM_ERROR_SCHEMA]);
    expect(err.status).toBe('404');
    expect(err.detail).toBe('User not found');
  });
});

describe('scimList', () => {
  it('wraps resources in ListResponse', () => {
    const users = [toScimUser(fakeUser()), toScimUser(fakeUser({ id: 'usr_456' }))];
    const list = scimList(users);
    expect(list.schemas).toEqual([SCIM_LIST_SCHEMA]);
    expect(list.totalResults).toBe(2);
    expect(list.startIndex).toBe(1);
    expect(list.itemsPerPage).toBe(2);
    expect((list.Resources as any[]).length).toBe(2);
  });

  it('handles empty list', () => {
    const list = scimList([]);
    expect(list.totalResults).toBe(0);
    expect((list.Resources as any[]).length).toBe(0);
  });
});

describe('parseUserNameFilter', () => {
  it('parses standard userName eq filter', () => {
    expect(parseUserNameFilter('userName eq "bob@acme.com"')).toBe('bob@acme.com');
  });

  it('is case-insensitive on operator', () => {
    expect(parseUserNameFilter('userName EQ "Bob@Acme.com"')).toBe('bob@acme.com');
  });

  it('returns null for undefined', () => {
    expect(parseUserNameFilter(undefined)).toBeNull();
  });

  it('returns null for unsupported filter', () => {
    expect(parseUserNameFilter('displayName eq "Bob"')).toBeNull();
  });

  it('returns null for malformed filter (no quotes)', () => {
    expect(parseUserNameFilter('userName eq bob@acme.com')).toBeNull();
  });
});

describe('parseScimUser', () => {
  it('parses a full SCIM User body', () => {
    const body = {
      schemas: [SCIM_USER_SCHEMA],
      userName: 'ALICE@EXAMPLE.COM',
      name: { givenName: 'Alice', familyName: 'Smith' },
      emails: [{ value: 'alice@example.com', primary: true }],
      externalId: 'ext-001',
      active: true,
    };
    const result = parseScimUser(body);
    expect(result).not.toBeNull();
    // email comes from primary emails entry
    expect(result!.email).toBe('alice@example.com');
    expect(result!.firstName).toBe('Alice');
    expect(result!.lastName).toBe('Smith');
    expect(result!.externalId).toBe('ext-001');
    expect(result!.active).toBe(true);
  });

  it('falls back to userName when emails array is empty', () => {
    const result = parseScimUser({ userName: 'Bob@Corp.com', name: {} });
    expect(result!.email).toBe('bob@corp.com');
  });

  it('defaults active to true when omitted', () => {
    const result = parseScimUser({ userName: 'a@b.com', name: {} });
    expect(result!.active).toBe(true);
  });

  it('returns null for missing body', () => {
    expect(parseScimUser(null)).toBeNull();
    expect(parseScimUser(undefined)).toBeNull();
  });

  it('returns null when no email can be derived', () => {
    expect(parseScimUser({ name: {} })).toBeNull();
  });

  it('handles non-string name fields', () => {
    const result = parseScimUser({ userName: 'a@b.com', name: { givenName: 123 } });
    expect(result!.firstName).toBeNull();
  });
});

describe('activeFromPatch', () => {
  it('detects replace active with path', () => {
    const body = { Operations: [{ op: 'replace', path: 'active', value: false }] };
    expect(activeFromPatch(body)).toBe(false);
  });

  it('detects Replace (capitalized) with path', () => {
    const body = { Operations: [{ op: 'Replace', path: 'Active', value: true }] };
    expect(activeFromPatch(body)).toBe(true);
  });

  it('detects pathless replace with active in value object', () => {
    const body = { Operations: [{ op: 'replace', value: { active: false } }] };
    expect(activeFromPatch(body)).toBe(false);
  });

  it('returns undefined when patch does not touch active', () => {
    const body = { Operations: [{ op: 'replace', path: 'displayName', value: 'New' }] };
    expect(activeFromPatch(body)).toBeUndefined();
  });

  it('returns undefined for missing body', () => {
    expect(activeFromPatch(null)).toBeUndefined();
    expect(activeFromPatch(undefined)).toBeUndefined();
  });

  it('returns undefined for non-array Operations', () => {
    expect(activeFromPatch({ Operations: 'bad' })).toBeUndefined();
  });
});
