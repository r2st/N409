import { describe, expect, it } from 'vitest';
import {
  toScimUser,
  scimError,
  scimList,
  parseUserNameFilter,
  parseScimUser,
  isScimRejection,
  activeFromPatch,
  scimBoolean,
  scimPage,
  SCIM_MAX_PAGE,
  SCIM_USER_SCHEMA,
  SCIM_LIST_SCHEMA,
  SCIM_ERROR_SCHEMA,
  type ScimCreate,
  type ScimUserRow,
} from '../../src/domain/scim.js';

/** The parsed create body, failing the test rather than the compiler on a rejection. */
function provisioned(body: unknown): ScimCreate {
  const parsed = parseScimUser(body);
  if (isScimRejection(parsed)) throw new Error(`expected a create body, got: ${parsed.rejected}`);
  return parsed;
}

/** Why the body was refused, failing the test if it was in fact accepted. */
function rejection(body: unknown): string {
  const parsed = parseScimUser(body);
  if (!isScimRejection(parsed)) throw new Error('expected a rejection, got a create body');
  return parsed.rejected;
}

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
    expect(result.name.givenName).toBe('Alice');
    expect(result.name.familyName).toBe('Smith');
    expect(result.displayName).toBe('Alice Smith');
    expect(result.emails[0]).toEqual({
      value: 'alice@example.com',
      primary: true,
      type: 'work',
    });
    expect(result.meta.resourceType).toBe('User');
    expect(result.meta.location).toBe('/scim/v2/Users/usr_123');
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
    expect(result.name.givenName).toBeUndefined();
    expect(result.name.familyName).toBeUndefined();
  });

  it('uses first name only when last name is null', () => {
    const result = toScimUser(fakeUser({ last_name: null }));
    expect(result.displayName).toBe('Alice');
  });

  /**
   * The attributes RFC 7644 requires on a User resource. An IdP that does not
   * find them reports "the SCIM endpoint is not compliant" and nothing more
   * specific, so a field quietly dropped from the mapping surfaces as an
   * integration nobody can debug from either end.
   */
  it('carries every attribute an IdP looks for', () => {
    const result = toScimUser(fakeUser());
    expect(Object.keys(result).sort()).toEqual([
      'active',
      'displayName',
      'emails',
      'externalId',
      'id',
      'meta',
      'name',
      'schemas',
      'userName',
    ]);
    expect(result.meta.created).toEqual(new Date('2024-01-15T00:00:00Z'));
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
    expect(list.Resources.length).toBe(2);
  });

  it('handles empty list', () => {
    const list = scimList([]);
    expect(list.totalResults).toBe(0);
    expect(list.Resources.length).toBe(0);
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
    const result = provisioned(body);
    // email comes from primary emails entry
    expect(result.email).toBe('alice@example.com');
    expect(result.firstName).toBe('Alice');
    expect(result.lastName).toBe('Smith');
    expect(result.externalId).toBe('ext-001');
    expect(result.active).toBe(true);
  });

  it('falls back to userName when emails array is empty', () => {
    expect(provisioned({ userName: 'Bob@Corp.com', name: {} }).email).toBe('bob@corp.com');
  });

  it('defaults active to true when omitted', () => {
    expect(provisioned({ userName: 'a@b.com', name: {} }).active).toBe(true);
  });

  it('rejects a missing body', () => {
    expect(rejection(null)).toBe('A userName / email is required');
    expect(rejection(undefined)).toBe('A userName / email is required');
  });

  it('rejects a body no email can be derived from', () => {
    expect(rejection({ name: {} })).toBe('A userName / email is required');
  });

  it('handles non-string name fields', () => {
    expect(provisioned({ userName: 'a@b.com', name: { givenName: 123 } }).firstName).toBeNull();
  });

  // Entra ID creates already-suspended users with active:"False" (a string).
  it('creates a user inactive when active is the string "False"', () => {
    expect(provisioned({ userName: 'a@b.com', name: {}, active: 'False' }).active).toBe(false);
  });

  it('creates a user active when active is the string "True"', () => {
    expect(provisioned({ userName: 'a@b.com', name: {}, active: 'True' }).active).toBe(true);
  });

  /**
   * The bounds on what an IdP may write into `users`.
   *
   * This was the only create path into that table with no schema in front of
   * it, and the two columns it fills are both under unique b-tree indexes
   * (`users_email_key` over `lower(email)`, `users_scim_external_id_idx` over
   * `scim_external_id`). A b-tree index tuple stops at 2704 bytes, so a value
   * past that failed the INSERT with 54000 rather than a unique violation — a
   * 500 on a provision, which Okta and Entra both retry forever.
   *
   * Each case asserts the *reason*, not just the refusal: the connector shows
   * `detail` to the directory admin, and "a userName is required" for a 4 KB
   * givenName sends them to the wrong field.
   */
  describe('bounds on what an IdP can write', () => {
    /** Comfortably past a b-tree index tuple, and trivial to send. */
    const huge = (n: number) => 'a'.repeat(n);

    it('refuses an address longer than RFC 5321 allows', () => {
      expect(rejection({ userName: `${huge(4000)}@corp.com` })).toBe(
        'userName / emails[].value must be an email address of at most 320 characters',
      );
    });

    it('refuses the same address arriving through emails[] instead of userName', () => {
      expect(rejection({ emails: [{ value: `${huge(4000)}@corp.com`, primary: true }] })).toBe(
        'userName / emails[].value must be an email address of at most 320 characters',
      );
    });

    it('accepts an address at exactly the limit', () => {
      // 320 total: local part padded so the whole address lands on the bound.
      const at = `${huge(320 - '@corp.com'.length)}@corp.com`;
      expect(at).toHaveLength(320);
      expect(provisioned({ userName: at }).email).toBe(at.toLowerCase());
    });

    it('refuses a userName that is not an address at all', () => {
      // `userName` becomes `users.email` — the login identity and the address
      // every password reset is sent to. A row where it is not an address is an
      // account nobody can sign into and nobody can email.
      expect(rejection({ userName: 'CORP\\jdoe' })).toContain('must be an email address');
      expect(rejection({ userName: 'S-1-5-21-1004336348' })).toContain('must be an email address');
    });

    it.each([
      ['name.givenName', { userName: 'a@b.com', name: { givenName: huge(101) } }, 100],
      ['name.familyName', { userName: 'a@b.com', name: { familyName: huge(101) } }, 100],
      ['externalId', { userName: 'a@b.com', externalId: huge(256) }, 255],
    ])('refuses an over-long %s and names it', (field, body, max) => {
      expect(rejection(body)).toBe(`${field} must be at most ${max} characters`);
    });

    it('accepts each of those at exactly its bound', () => {
      const ok = provisioned({
        userName: 'a@b.com',
        name: { givenName: huge(100), familyName: huge(100) },
        externalId: huge(255),
      });
      expect(ok.firstName).toHaveLength(100);
      expect(ok.lastName).toHaveLength(100);
      expect(ok.externalId).toHaveLength(255);
    });

    it('refuses an emails array no directory record would have', () => {
      const emails = Array.from({ length: 21 }, (_, i) => ({ value: `u${i}@corp.com` }));
      expect(rejection({ userName: 'a@b.com', emails })).toBe('emails accepts at most 20 entries');
    });

    it('still reads the primary out of a plausible emails array', () => {
      expect(
        provisioned({
          emails: [
            { value: 'home@corp.com' },
            { value: 'work@corp.com', primary: true },
            { value: 'other@corp.com' },
          ],
        }).email,
      ).toBe('work@corp.com');
    });

    it('trims rather than storing the padding an IdP sends', () => {
      const ok = provisioned({ userName: '  Ada@Corp.com  ', name: { givenName: '  Ada  ' } });
      expect(ok.email).toBe('ada@corp.com');
      expect(ok.firstName).toBe('Ada');
    });

    it('treats a whitespace-only claim as absent rather than as a name', () => {
      expect(provisioned({ userName: 'a@b.com', name: { givenName: '   ' } }).firstName).toBeNull();
    });
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

  // Microsoft Entra ID sends `active` as a capitalised *string*, not a JSON
  // boolean. Boolean("False") is true, so a deprovision used to answer 200 and
  // leave the offboarded account fully active.
  it('deactivates on the Entra ID patch body verbatim', () => {
    const body = {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    };
    expect(activeFromPatch(body)).toBe(false);
  });

  it('reactivates on the string "True"', () => {
    const body = { Operations: [{ op: 'Replace', path: 'active', value: 'True' }] };
    expect(activeFromPatch(body)).toBe(true);
  });

  it('honours a string "false" nested in a pathless replace', () => {
    const body = { Operations: [{ op: 'replace', value: { active: 'false' } }] };
    expect(activeFromPatch(body)).toBe(false);
  });

  it('accepts an uppercase op verb', () => {
    expect(activeFromPatch({ Operations: [{ op: 'REPLACE', path: 'active', value: false }] })).toBe(false);
  });

  it('treats add on active as a replace', () => {
    expect(activeFromPatch({ Operations: [{ op: 'add', path: 'active', value: true }] })).toBe(true);
    expect(activeFromPatch({ Operations: [{ op: 'Add', path: 'active', value: 'False' }] })).toBe(false);
  });

  it('ignores ops it does not implement', () => {
    expect(activeFromPatch({ Operations: [{ op: 'remove', path: 'active' }] })).toBeUndefined();
  });

  it('takes the first active-bearing op when several are sent', () => {
    const body = {
      Operations: [
        { op: 'Replace', path: 'displayName', value: 'New Name' },
        { op: 'Replace', path: 'active', value: 'False' },
      ],
    };
    expect(activeFromPatch(body)).toBe(false);
  });
});

describe('scimBoolean', () => {
  it('passes genuine booleans through', () => {
    expect(scimBoolean(true)).toBe(true);
    expect(scimBoolean(false)).toBe(false);
  });

  it('reads the string spellings IdPs actually send', () => {
    for (const falsey of ['False', 'false', 'FALSE', ' false ', '0', '']) {
      expect(scimBoolean(falsey)).toBe(false);
    }
    for (const truthy of ['True', 'true', 'TRUE', '1']) {
      expect(scimBoolean(truthy)).toBe(true);
    }
  });

  it('treats absent values as false', () => {
    expect(scimBoolean(undefined)).toBe(false);
    expect(scimBoolean(null)).toBe(false);
  });
});

/**
 * Paging, as a connector spells it (round 201, M6).
 *
 * `startIndex` and `count` arrive as query-string text from an IdP rather than
 * from a form, so the parse has to land every degenerate spelling somewhere
 * that is not an `OFFSET NaN`. The clamps are RFC 7644 §3.4.2.4's: below 1 is
 * 1 for the index, below 0 is 0 for the count.
 */
describe('scimPage', () => {
  it('defaults to the first page of the largest size this service will build', () => {
    expect(scimPage({})).toEqual({ startIndex: 1, count: SCIM_MAX_PAGE });
    expect(scimPage(undefined)).toEqual({ startIndex: 1, count: SCIM_MAX_PAGE });
  });

  it('reads the two parameters an IdP pages with', () => {
    expect(scimPage({ startIndex: '51', count: '25' })).toEqual({ startIndex: 51, count: 25 });
  });

  it('keeps count=0 distinct from an absent count — it means "just the total"', () => {
    expect(scimPage({ count: '0' }).count).toBe(0);
    expect(scimPage({}).count).toBe(SCIM_MAX_PAGE);
  });

  it('clamps a page larger than this service will build', () => {
    expect(scimPage({ count: '100000' }).count).toBe(SCIM_MAX_PAGE);
  });

  it.each([
    ['a startIndex below the first', { startIndex: '0' }, 1],
    ['a negative startIndex', { startIndex: '-9' }, 1],
    ['a startIndex that is not a number', { startIndex: 'abc' }, 1],
    ['an empty startIndex', { startIndex: '' }, 1],
    // `Number('1e9')` and `Number('0x10')` both parse and neither is an index
    // any IdP means, so only decimal digits count.
    ['a startIndex in exponent notation', { startIndex: '1e9' }, 1],
    ['a hexadecimal startIndex', { startIndex: '0x10' }, 1],
    ['a startIndex past the safe integers', { startIndex: '99999999999999999999' }, 1],
  ])('reads %s as the first page', (_label, query, expected) => {
    expect(scimPage(query).startIndex).toBe(expected);
  });

  it.each([
    ['a negative count', { count: '-5' }, 0],
    ['a count that is not a number', { count: 'all' }, SCIM_MAX_PAGE],
    ['an empty count', { count: '' }, SCIM_MAX_PAGE],
  ])('reads %s safely', (_label, query, expected) => {
    expect(scimPage(query).count).toBe(expected);
  });

  it('takes the last of a repeated parameter, which is how Fastify hands it over', () => {
    expect(scimPage({ count: ['2', '3'], startIndex: ['5', '7'] })).toEqual({
      startIndex: 7,
      count: 3,
    });
  });
});

describe('scimList paging fields', () => {
  const user = toScimUser({
    id: 'u1',
    email: 'a@example.com',
    first_name: null,
    last_name: null,
    scim_external_id: null,
    deleted_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
  });

  it("reports the caller's page, not the constant first one", () => {
    const list = scimList([user], { totalResults: 412, startIndex: 201 });
    expect(list.totalResults).toBe(412);
    expect(list.startIndex).toBe(201);
    expect(list.itemsPerPage).toBe(1);
  });

  it('does not report a truncated page as the whole set', () => {
    // The bug: `totalResults` was `Resources.length`, so 200 of 412 answered
    // "there are 200" — a complete, self-consistent, wrong answer that a
    // reconciliation reads as "the other 212 are gone".
    const page = Array.from({ length: 200 }, () => user);
    expect(scimList(page, { totalResults: 412, startIndex: 1 }).totalResults).toBe(412);
  });

  it('falls back to the page length only when the page is the whole match set', () => {
    // The `userName eq` lookup: one match or none, and no paging to report.
    expect(scimList([user]).totalResults).toBe(1);
    expect(scimList([]).totalResults).toBe(0);
  });
});
