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
  /**
   * A locally-registered account, held for the cases that matter most here:
   * it is `provisioned_by IS NULL`, it holds `admin`, and the whole point of
   * the boundary below is that a SCIM bearer cannot see it or switch it off.
   */
  let admin: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
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

  /**
   * The machine-readable half of an error (R350, methodology M19).
   *
   * `detail` is prose — the one field RFC 7644 does not ask to be stable, and
   * the one a connector cannot branch on. Every error under this prefix used to
   * be `{schemas, status, detail}` and nothing else, and the consequential
   * omission is the 409: a connector reading `scimType: "uniqueness"` treats an
   * address that already has an account as something to reconcile and carries
   * on, while a bare 409 goes into the admin's error queue. On a first import of
   * a directory into a platform people already had logins for, that is the whole
   * import.
   */
  describe('scimType', () => {
    it('classifies a userName that already has an account as uniqueness', async () => {
      const first = await scim('POST', '/scim/v2/Users', { userName: 'dup@corp.example' });
      expect(first.statusCode).toBe(201);
      const again = await scim('POST', '/scim/v2/Users', { userName: 'dup@corp.example' });
      expect(again.statusCode).toBe(409);
      const body = again.json();
      expect(body.scimType).toBe('uniqueness');
      // And the prose says what to do about it, which the two words it replaced
      // did not.
      expect(body.detail).toMatch(/match the existing account|change the userName/i);
    });

    it('classifies a refused field as invalidValue, naming the field', async () => {
      const res = await scim('POST', '/scim/v2/Users', { userName: 'not-an-address' });
      expect(res.statusCode).toBe(400);
      expect(res.json().scimType).toBe('invalidValue');
      expect(res.json().detail).toMatch(/userName/);
    });

    it('classifies a body that is not JSON as invalidSyntax', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/scim/v2/Users',
        headers: { ...bearer, 'content-type': CT },
        payload: '{ not json',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().scimType).toBe('invalidSyntax');
    });

    it('omits it where RFC 7644 defines none, rather than sending a null', async () => {
      // A null on a 401 asserts the field was considered and found not to
      // apply; for an auth refusal that is not a thing this service knows.
      const res = await ctx.app.inject({ method: 'GET', url: '/scim/v2/Users' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).not.toHaveProperty('scimType');
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
      //
      // Asserted against a real local account. This line used to read
      // `expect(body.totalResults).toBe(body.Resources.length)` under that same
      // comment, which `scimList` computes from the array it was handed — so it
      // held for any listing whatsoever, including one containing every
      // administrator on the platform. The claim was right and nothing checked
      // it, which is worse than not making it: the four other routes had no
      // such filter at all and this was the only place a reviewer would have
      // looked to find out (R185).
      expect(body.Resources.map((r: { userName: string }) => r.userName)).not.toContain(admin.email);
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

    /**
     * A re-asserted deactivation does not move the date it happened.
     *
     * This route already guards the *event* on the grounds that "an IdP resyncs
     * its whole directory on a schedule and re-asserts `active` for everybody
     * each pass". The column was written unconditionally under the same
     * traffic, so `users.deleted_at` — what `personalDataExport` gives the
     * subject for when they lost access, and what the console prints — reported
     * the last resync rather than the deprovision.
     */
    it('keeps the first deactivation date across an IdP resync', async () => {
      const created = await scim('POST', '/scim/v2/Users', { userName: 'resynced@corp.example' });
      const userId = created.json().id as string;
      const off = { Operations: [{ op: 'replace', path: 'active', value: false }] };

      expect((await scim('PATCH', `/scim/v2/Users/${userId}`, off)).json().active).toBe(false);
      const first = await ctx.pool.query<{ deleted_at: Date }>('SELECT deleted_at FROM users WHERE id = $1', [
        userId,
      ]);
      const at = first.rows[0]!.deleted_at;
      expect(at).not.toBeNull();

      // The next pass, and the one after it through the DELETE door — both
      // re-assert a deprovision that already happened.
      await scim('PATCH', `/scim/v2/Users/${userId}`, off);
      await scim('DELETE', `/scim/v2/Users/${userId}`);

      const again = await ctx.pool.query<{ deleted_at: Date }>('SELECT deleted_at FROM users WHERE id = $1', [
        userId,
      ]);
      expect(again.rows[0]!.deleted_at.getTime()).toBe(at.getTime());

      // And the guarded event stayed guarded: one deactivation, not three.
      const { rows } = await ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM admin_events
          WHERE subject_id = $1 AND type = 'user_deactivated'`,
        [userId],
      );
      expect(rows[0]!.n).toBe(1);
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

  /**
   * The reach of the bearer, which was the whole `users` table.
   *
   * Only the unfiltered listing ever asked what provisioned a row. `GET
   * /Users/:id`, the `userName eq` filter, `PATCH` and `DELETE` each went
   * straight to `findUserById` / `findUserByEmail`, so a SCIM token could look
   * up any account on the platform by address and `setUserActive(false)` it.
   * That is not a data leak so much as a switch: there is no last-administrator
   * guard on this path the way there is on `DELETE /me`, so the accounts most
   * worth turning off are the ones that make the console unreachable
   * afterwards. And the credential in front of it is a bearer facing the open
   * internet — the threat this endpoint's rate limiter, its audit rows and its
   * constant-time comparison are all already written for.
   *
   * A directory-provisioned account (`'scim'` or `'saml'`) stays fully
   * manageable: that is the connector doing its job, and refusing a real
   * deprovision would leave access in place, which is the worse failure.
   */
  describe('the accounts a bearer may reach', () => {
    it('does not find a locally-registered account by address', async () => {
      const res = await scim(
        'GET',
        '/scim/v2/Users?filter=' + encodeURIComponent(`userName eq "${admin.email}"`),
      );
      expect(res.statusCode).toBe(200);
      // Empty, not 403: the filter must not become an oracle for which
      // addresses have accounts here.
      expect(res.json().totalResults).toBe(0);
      expect(res.json().Resources).toEqual([]);
    });

    it('404s a locally-registered account by id', async () => {
      const res = await scim('GET', `/scim/v2/Users/${admin.id}`);
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain(CT);
    });

    it('cannot deactivate a locally-registered administrator', async () => {
      for (const [method, payload] of [
        ['PATCH', { Operations: [{ op: 'replace', path: 'active', value: false }] }],
        ['DELETE', undefined],
      ] as const) {
        const res = await scim(method, `/scim/v2/Users/${admin.id}`, payload);
        expect([method, res.statusCode]).toEqual([method, 404]);
      }

      // The refusal has to be a refusal. A 404 returned after the row was
      // already updated would read identically from outside.
      const { rows } = await ctx.pool.query<{ deleted_at: Date | null }>(
        'SELECT deleted_at FROM users WHERE id = $1',
        [admin.id],
      );
      expect(rows[0]?.deleted_at ?? null).toBeNull();

      // …and the account still signs in, which is the fact the guard exists for.
      const login = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: admin.email, password: 'test-password-123' },
      });
      expect(login.statusCode).toBe(200);
    });

    it('still manages an account the directory provisioned', async () => {
      // The other side of the boundary, stated so a fix that simply refused
      // everything would fail here rather than look like a hardened endpoint.
      const created = await scim('POST', '/scim/v2/Users', { userName: 'reachable@corp.example' });
      const id = created.json().id;
      expect((await scim('GET', `/scim/v2/Users/${id}`)).statusCode).toBe(200);
      expect((await scim('DELETE', `/scim/v2/Users/${id}`)).statusCode).toBe(204);
    });
  });
});
