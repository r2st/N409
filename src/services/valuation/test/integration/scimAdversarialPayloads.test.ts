import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * What an identity provider actually puts on the wire (round 201, M6).
 *
 * `scimEdges.test.ts` covers the bodies. This covers everything around them —
 * the media type, the error shape, the paging fields — because that is the
 * half a connector reads and the half nothing here ever exercised.
 *
 * The shape of the gap is worth stating once: `app.inject({ payload })`
 * serialises as `application/json`, so every SCIM test in this suite was
 * sending a media type no IdP sends. `application/scim+json` is what RFC 7644
 * §3.1 names and what Okta, Microsoft Entra ID and OneLogin put on every
 * create and every deprovision, and this service had no parser for it: 415,
 * before routing, with a problem+json body. Provisioning was broken for every
 * real client and green for every test.
 */

const dbUp = await isDbAvailable();
const CT = 'application/scim+json';
const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

describe.skipIf(!dbUp)('SCIM adversarial payloads', () => {
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

  /** A request sent the way a connector sends it: raw body, SCIM media type. */
  const scimSend = (
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    body: unknown,
    contentType = CT,
  ) =>
    ctx.app.inject({
      method,
      url,
      headers: { ...bearer, 'content-type': contentType },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  describe('the media type every IdP sends', () => {
    it('provisions a user from an application/scim+json body', async () => {
      const res = await scimSend('POST', '/scim/v2/Users', {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'ct-plain@example.com',
        name: { givenName: 'Cee', familyName: 'Tee' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().userName).toBe('ct-plain@example.com');
    });

    it('accepts the charset parameter Entra appends', async () => {
      const res = await scimSend(
        'POST',
        '/scim/v2/Users',
        { userName: 'ct-charset@example.com' },
        'application/scim+json; charset=utf-8',
      );
      expect(res.statusCode).toBe(201);
    });

    it('deprovisions from a PatchOp sent as application/scim+json', async () => {
      const created = await scimSend('POST', '/scim/v2/Users', { userName: 'ct-patch@example.com' });
      expect(created.statusCode).toBe(201);
      const res = await scimSend('PATCH', `/scim/v2/Users/${created.json().id}`, {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().active).toBe(false);
    });

    /*
     * The one status this route cannot afford. `Operations: [null]` reached
     * `op.path` in `activeFromPatch` and threw, and a `TypeError` under this
     * prefix leaves as a 500 — which Okta and Entra retry indefinitely, so the
     * account the directory is trying to offboard stays live for the whole of
     * the loop while the loop hammers the pool.
     */
    it('answers a PatchOp with an unreadable operation rather than a 500', async () => {
      const created = await scimSend('POST', '/scim/v2/Users', { userName: 'ct-nullop@example.com' });
      expect(created.statusCode).toBe(201);
      const res = await scimSend('PATCH', `/scim/v2/Users/${created.json().id}`, {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [null],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().active).toBe(true);
    });

    it('deprovisions from a PatchOp whose list also holds an unreadable operation', async () => {
      const created = await scimSend('POST', '/scim/v2/Users', { userName: 'ct-mixedop@example.com' });
      const res = await scimSend('PATCH', `/scim/v2/Users/${created.json().id}`, {
        Operations: [null, { op: 'replace', path: 'active', value: false }],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().active).toBe(false);
    });

    it('still accepts application/json, which is what the older connectors send', async () => {
      const res = await scimSend(
        'POST',
        '/scim/v2/Users',
        { userName: 'ct-json@example.com' },
        'application/json',
      );
      expect(res.statusCode).toBe(201);
    });
  });

  describe('every refusal is a document the connector can parse', () => {
    /**
     * The matrix is deliberately the *framework's* refusals rather than the
     * handlers'. The handlers always answered in SCIM's shape; 415, a body that
     * is not JSON, and a path that is not a route were raised before or around
     * them and left as problem+json, which an IdP logs as an unintelligible
     * response and — on a deprovision — retries forever.
     */
    const cases: Array<[string, () => Promise<{ statusCode: number; body: string }>, number]> = [
      ['a body that is not JSON at all', () => scimSend('POST', '/scim/v2/Users', '{"userName":'), 400],
      [
        'a media type nothing here parses',
        () => scimSend('POST', '/scim/v2/Users', 'userName=x', 'application/x-www-form-urlencoded'),
        415,
      ],
      [
        'a resource type this service does not provide',
        () => ctx.app.inject({ method: 'GET', url: '/scim/v2/Groups', headers: bearer }),
        404,
      ],
      [
        'a group push, which is the one Okta actually tries',
        () => scimSend('POST', '/scim/v2/Groups', { displayName: 'Engineering', members: [] }),
        404,
      ],
      [
        'a method the resource does not answer',
        () => scimSend('PUT', '/scim/v2/ServiceProviderConfig', {}),
        404,
      ],
      [
        'a user id that is not an id',
        () => ctx.app.inject({ method: 'GET', url: '/scim/v2/Users/not-an-id', headers: bearer }),
        404,
      ],
      ['no credential', () => ctx.app.inject({ method: 'GET', url: '/scim/v2/Users' }), 401],
    ];

    it.each(cases)('answers %s in the SCIM error schema', async (_label, send, status) => {
      const res = await send();
      expect(res.statusCode).toBe(status);
      const body = JSON.parse(res.body) as { schemas?: string[]; status?: string; detail?: string };
      expect(body.schemas).toEqual([SCIM_ERROR_SCHEMA]);
      // SCIM sends the status as a string in the body, and the two must agree —
      // a connector reads the body, not the status line.
      expect(body.status).toBe(String(status));
      expect(typeof body.detail).toBe('string');
      expect(body.detail!.length).toBeGreaterThan(0);
    });

    it('leaves the rest of the API answering problem+json', async () => {
      // The scoped handlers must not have escaped their prefix: a human client
      // reads problem+json and nothing else.
      const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/valuations/nope' });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(JSON.parse(res.body)).toHaveProperty('type');
    });
  });

  describe('the listing tells the truth about how many there are', () => {
    /**
     * `totalResults` is the size of the match set, not of the page (RFC 7644
     * §3.4.2.4). It was `Resources.length`, so a page that had been cut short
     * reported itself as complete — and an Okta reconciliation reads exactly
     * this to decide which accounts this service no longer has.
     */
    let total: number;

    beforeAll(async () => {
      for (const n of [1, 2, 3, 4, 5]) {
        await scimSend('POST', '/scim/v2/Users', { userName: `page-${n}@example.com` });
      }
      const all = await ctx.app.inject({ method: 'GET', url: '/scim/v2/Users', headers: bearer });
      total = all.json().totalResults as number;
      expect(total).toBeGreaterThanOrEqual(5);
    });

    it('reports the whole count when the page is smaller than it', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/scim/v2/Users?count=2',
        headers: bearer,
      });
      const body = res.json();
      expect(body.Resources).toHaveLength(2);
      expect(body.itemsPerPage).toBe(2);
      expect(body.totalResults).toBe(total);
      expect(body.startIndex).toBe(1);
    });

    it('honours startIndex, so paging terminates instead of looping', async () => {
      const first = await ctx.app.inject({
        method: 'GET',
        url: '/scim/v2/Users?count=2&startIndex=1',
        headers: bearer,
      });
      const second = await ctx.app.inject({
        method: 'GET',
        url: '/scim/v2/Users?count=2&startIndex=3',
        headers: bearer,
      });
      expect(second.json().startIndex).toBe(3);
      const ids = (b: { Resources: Array<{ id: string }> }) => b.Resources.map((r) => r.id);
      expect(ids(second.json())).not.toEqual(ids(first.json()));
      expect(ids(second.json()).filter((id) => ids(first.json()).includes(id))).toEqual([]);
    });

    it('answers count=0 with the total and no resources', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/scim/v2/Users?count=0',
        headers: bearer,
      });
      expect(res.json().Resources).toEqual([]);
      expect(res.json().itemsPerPage).toBe(0);
      expect(res.json().totalResults).toBe(total);
    });

    it.each([
      ['a startIndex that is not a number', '?startIndex=abc'],
      ['a negative startIndex', '?startIndex=-4'],
      ['a startIndex past the end', '?startIndex=999999'],
      ['a count in exponent notation', '?count=1e9'],
      ['a repeated count', '?count=2&count=3'],
      ['an empty count', '?count='],
      ['a page larger than the service will build', '?count=100000'],
    ])('survives %s', async (_label, query) => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/scim/v2/Users${query}`,
        headers: bearer,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totalResults).toBe(total);
      expect(body.startIndex).toBeGreaterThanOrEqual(1);
      expect(body.Resources.length).toBe(body.itemsPerPage);
      expect(body.Resources.length).toBeLessThanOrEqual(200);
    });
  });
});
