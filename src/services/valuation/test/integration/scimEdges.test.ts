import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * SCIM's refusals, and the shapes an IdP actually sends.
 *
 * `sso.test.ts` walks one user through provision → filter → deprovision →
 * delete. This is the other half of every handler: the id that is not there,
 * the body that names no user, the unfiltered listing, and the deactivate that
 * arrives in the create rather than in a later PATCH.
 *
 * Everything here has to answer in SCIM's own error shape rather than the
 * platform's problem+json, because the caller is an IdP connector that parses
 * one and not the other — a 500 or an unrecognised body on a deprovision is
 * retried forever by Okta and Entra alike.
 */

const dbUp = await isDbAvailable();
const CT = 'application/scim+json';

describe.skipIf(!dbUp)('SCIM edges', () => {
  let ctx: TestApp;
  let bearer: { authorization: string };

  beforeAll(async () => {
    ctx = await setupTestApp();
    const admin = await seedUser(ctx, { roles: ['admin'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/sso/scim-tokens',
      headers: authHeader(admin.token),
      payload: { label: 'Okta' },
    });
    bearer = { authorization: `Bearer ${created.json().secret}` };
  });
  afterAll(async () => ctx?.teardown());

  const scim = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = bearer,
  ) => ctx.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });

  describe('the bearer token', () => {
    it.each([
      ['no header at all', undefined],
      ['a scheme that is not Bearer', 'Basic c2NpbTpzY2lt'],
      ['Bearer with a token nothing issued', 'Bearer scim_not_a_real_token'],
      ['Bearer with nothing after it', 'Bearer '],
    ])('refuses %s', async (_label, authorization) => {
      const res = await scim(
        'GET',
        '/scim/v2/Users',
        undefined,
        authorization === undefined ? {} : { authorization },
      );
      expect(res.statusCode).toBe(401);
      expect(res.headers['content-type']).toContain(CT);
      expect(res.json().schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
    });

    it('guards every route, not only the listing', async () => {
      for (const [method, url] of [
        ['GET', '/scim/v2/Users/01ARZ3NDEKTSV4RRFFQ69G5FAV'],
        ['POST', '/scim/v2/Users'],
        ['PATCH', '/scim/v2/Users/01ARZ3NDEKTSV4RRFFQ69G5FAV'],
        ['DELETE', '/scim/v2/Users/01ARZ3NDEKTSV4RRFFQ69G5FAV'],
      ] as const) {
        const res = await scim(method, url, method === 'GET' ? undefined : {}, {});
        expect([method, res.statusCode]).toEqual([method, 401]);
      }
    });

    it('serves the service-provider config without one — an IdP reads it first', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/scim/v2/ServiceProviderConfig' });
      expect(res.statusCode).toBe(200);
      expect(res.json().patch.supported).toBe(true);
      expect(res.json().bulk.supported).toBe(false);
    });
  });

  describe('listing', () => {
    it('returns the provisioned users when no filter is given', async () => {
      const created = await scim('POST', '/scim/v2/Users', { userName: 'listed@corp.example' });
      expect(created.statusCode).toBe(201);

      const res = await scim('GET', '/scim/v2/Users');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:ListResponse']);
      expect(body.Resources.map((r: { userName: string }) => r.userName)).toContain('listed@corp.example');
      // Only SCIM-provisioned users: the platform's own accounts are not the
      // IdP's to see, let alone to deprovision.
      expect(body.totalResults).toBe(body.Resources.length);
    });

    it('returns an empty list for a filter that matches nobody', async () => {
      const res = await scim(
        'GET',
        '/scim/v2/Users?filter=' + encodeURIComponent('userName eq "nobody@corp.example"'),
      );
      expect(res.json().totalResults).toBe(0);
      expect(res.json().Resources).toEqual([]);
    });

    it('ignores a filter it does not understand and lists instead', async () => {
      const res = await scim('GET', '/scim/v2/Users?filter=' + encodeURIComponent('displayName pr'));
      expect(res.statusCode).toBe(200);
      expect(res.json().totalResults).toBeGreaterThan(0);
    });
  });

  describe('a user that is not there', () => {
    const GONE = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

    it.each([
      ['GET', undefined],
      ['PATCH', { Operations: [{ op: 'replace', path: 'active', value: false }] }],
      ['DELETE', undefined],
    ] as const)('answers 404 in SCIM’s shape to %s', async (method, payload) => {
      const res = await scim(method, `/scim/v2/Users/${GONE}`, payload);
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain(CT);
      expect(res.json().detail).toBe('User not found');
    });
  });

  describe('creating', () => {
    it('refuses a body that names no user', async () => {
      // The last is a JSON array rather than an object — a shape some
      // connectors send when they mean a single-element bulk create.
      for (const payload of [{}, { name: { givenName: 'No' } }, { emails: [] }, []]) {
        const res = await scim('POST', '/scim/v2/Users', payload);
        expect([JSON.stringify(payload), res.statusCode]).toEqual([JSON.stringify(payload), 400]);
        expect(res.json().detail).toBe('A userName / email is required');
      }
    });

    it('takes the primary email over the first one, and over userName', async () => {
      const res = await scim('POST', '/scim/v2/Users', {
        userName: 'login-name-only',
        emails: [{ value: 'Secondary@Corp.Example' }, { value: 'Primary@Corp.Example', primary: true }],
      });
      expect(res.statusCode).toBe(201);
      // Lower-cased, because an address is not case sensitive and two spellings
      // of one address provisioned as two accounts is the failure this avoids.
      expect(res.json().userName).toBe('primary@corp.example');
    });

    it('creates a user the IdP already suspended as suspended', async () => {
      const res = await scim('POST', '/scim/v2/Users', {
        userName: 'suspended@corp.example',
        active: false,
      });
      expect(res.statusCode).toBe(201);
      // The created body must say so too. It is assembled rather than re-read,
      // and an IdP that is told `active: true` here will not send the PATCH
      // that would have fixed it.
      expect(res.json().active).toBe(false);

      const fetched = await scim('GET', `/scim/v2/Users/${res.json().id}`);
      expect(fetched.json().active).toBe(false);
    });
  });

  describe('patching', () => {
    let id: string;

    beforeAll(async () => {
      const created = await scim('POST', '/scim/v2/Users', { userName: 'patched@corp.example' });
      id = created.json().id;
    });

    it.each([
      ['a lower-case op with a path', { Operations: [{ op: 'replace', path: 'active', value: false }] }],
      [
        'a capitalised op, which is what Entra sends',
        { Operations: [{ Op: 'x', op: 'Replace', path: 'active', value: false }] },
      ],
      [
        'an add, which is what Okta sends on reactivate',
        { Operations: [{ op: 'add', path: 'active', value: false }] },
      ],
      [
        'a pathless replace carrying the value',
        { Operations: [{ op: 'replace', value: { active: false } }] },
      ],
      [
        'the string "False", which some connectors send',
        { Operations: [{ op: 'replace', path: 'active', value: 'False' }] },
      ],
    ])('deactivates from %s', async (_label, payload) => {
      await scim('PATCH', `/scim/v2/Users/${id}`, {
        Operations: [{ op: 'replace', path: 'active', value: true }],
      });
      const res = await scim('PATCH', `/scim/v2/Users/${id}`, payload);
      expect(res.statusCode).toBe(200);
      expect(res.json().active).toBe(false);
    });

    it.each([
      ['no Operations array', {}],
      [
        'an operation it does not act on',
        { Operations: [{ op: 'replace', path: 'displayName', value: 'x' }] },
      ],
      ['a body that is an array rather than an object', []],
    ])('leaves the user alone for %s, and still answers with them', async (_label, payload) => {
      await scim('PATCH', `/scim/v2/Users/${id}`, {
        Operations: [{ op: 'replace', path: 'active', value: true }],
      });
      const res = await scim('PATCH', `/scim/v2/Users/${id}`, payload);
      expect(res.statusCode).toBe(200);
      expect(res.json().active).toBe(true);
    });
  });

  describe('deleting', () => {
    it('soft-deletes, so the user is still readable as inactive', async () => {
      const created = await scim('POST', '/scim/v2/Users', { userName: 'deleted@corp.example' });
      const id = created.json().id;

      expect((await scim('DELETE', `/scim/v2/Users/${id}`)).statusCode).toBe(204);

      const after = await scim('GET', `/scim/v2/Users/${id}`);
      expect(after.statusCode).toBe(200);
      expect(after.json().active).toBe(false);
      // History and the audit trail need the row; the IdP needs it gone from
      // sign-in. Those are different things, and this is the one that keeps both.
      expect(after.json().userName).toBe('deleted@corp.example');
    });

    it('is idempotent — a repeated deprovision is not an error', async () => {
      const created = await scim('POST', '/scim/v2/Users', { userName: 'twice@corp.example' });
      const id = created.json().id;
      expect((await scim('DELETE', `/scim/v2/Users/${id}`)).statusCode).toBe(204);
      expect((await scim('DELETE', `/scim/v2/Users/${id}`)).statusCode).toBe(204);
    });
  });
});
