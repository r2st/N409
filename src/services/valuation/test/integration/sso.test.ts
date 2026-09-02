import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeader,
  isDbAvailable,
  SEEDED_PASSWORD,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('enterprise SSO — SCIM + admin config (feature 9)', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let plain: Awaited<ReturnType<typeof seedUser>>;
  let scimToken: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    plain = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  it('gates SSO admin config to admins and mints a SCIM token', async () => {
    const denied = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/sso/scim-tokens',
      headers: authHeader(plain.token),
    });
    expect(denied.statusCode).toBe(403);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/sso/scim-tokens',
      headers: authHeader(admin.token),
      payload: { label: 'Okta', current_password: SEEDED_PASSWORD },
    });
    expect(created.statusCode).toBe(201);
    scimToken = created.json().secret;
    expect(scimToken).toMatch(/^scim_/);
  });

  /**
   * The two guards every other credential mint carries (round 359, M4).
   *
   * The docstring on `routes/adminSso.ts` already called a SCIM token "a
   * standing bearer grant to create and deactivate users" and this route had
   * neither guard, while `POST /me/tokens` — a credential that can do strictly
   * less — has had both since R262.
   */
  describe('minting a SCIM token', () => {
    const mint = (token: string, payload: Record<string, unknown>) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/sso/scim-tokens',
        headers: authHeader(token),
        payload,
      });

    it('refuses without the current password, and names the field', async () => {
      const res = await mint(admin.token, { label: 'No password' });
      expect(res.statusCode, res.body).toBe(422);
      const body = res.json() as { detail: string; errors?: Array<{ path: string[] }> };
      expect(body.detail).toContain('current password');
      expect(body.errors?.[0]?.path).toEqual(['current_password']);
    });

    it('refuses a wrong password', async () => {
      const res = await mint(admin.token, {
        label: 'Guessed',
        current_password: `${SEEDED_PASSWORD}-wrong`,
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().detail).toContain('Current password is incorrect');
    });

    it('refuses an API key minting one, whatever password it carries', async () => {
      // No key mints its successor: SCIM tokens have their own revocation, so
      // one issued by a leaked API key would survive that key being withdrawn.
      const key = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/me/tokens',
        headers: authHeader(admin.token),
        payload: { name: 'admin key', current_password: SEEDED_PASSWORD },
      });
      expect(key.statusCode, key.body).toBe(201);
      const secret = key.json().secret as string;

      const res = await mint(secret, { label: 'Successor', current_password: SEEDED_PASSWORD });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().detail).toContain('cannot mint a SCIM token');
    });
  });

  it('rejects SCIM calls without a valid bearer token', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/scim/v2/Users' });
    expect(res.statusCode).toBe(401);
  });

  it('provisions, looks up, deactivates and deletes a user via SCIM', async () => {
    const bearer = { authorization: `Bearer ${scimToken}` };

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: bearer,
      payload: {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'jit@corp.com',
        externalId: 'okta-123',
        name: { givenName: 'Jit', familyName: 'User' },
        emails: [{ value: 'jit@corp.com', primary: true }],
        active: true,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(created.json().active).toBe(true);

    // Duplicate → 409.
    const dupe = await ctx.app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: bearer,
      payload: { userName: 'jit@corp.com' },
    });
    expect(dupe.statusCode).toBe(409);

    // Filter lookup.
    const filtered = await ctx.app.inject({
      method: 'GET',
      url: '/scim/v2/Users?filter=' + encodeURIComponent('userName eq "jit@corp.com"'),
      headers: bearer,
    });
    expect(filtered.json().totalResults).toBe(1);

    // PATCH active=false (deprovision).
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/scim/v2/Users/${id}`,
      headers: bearer,
      payload: { Operations: [{ op: 'replace', path: 'active', value: false }] },
    });
    expect(patched.json().active).toBe(false);

    // DELETE (soft).
    const del = await ctx.app.inject({ method: 'DELETE', url: `/scim/v2/Users/${id}`, headers: bearer });
    expect(del.statusCode).toBe(204);
  });

  it('stores SAML config and reflects it in /auth/providers', async () => {
    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/sso/saml',
      headers: authHeader(admin.token),
      payload: {
        enabled: true,
        idp_sso_url: 'https://idp.example.com/sso',
        idp_cert: 'MIIC-fake-cert-body',
        allowed_domain: 'corp.com',
        default_role: 'valuation_user',
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().config.enabled).toBe(true);

    const providers = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/providers' });
    expect(providers.json().saml).toBe(true);

    // Metadata is public XML.
    const meta = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/saml/metadata' });
    expect(meta.statusCode).toBe(200);
    expect(meta.headers['content-type']).toContain('xml');
    expect(meta.body).toContain('EntityDescriptor');
  });

  it('refuses an http IdP entry point', async () => {
    // The AuthnRequest, the relay state and the fact of who is signing in all
    // ride on this redirect. Over `http:` they ride in clear text, and the
    // sign-in page is where that is least acceptable.
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/sso/saml',
      headers: authHeader(admin.token),
      payload: {
        enabled: true,
        idp_sso_url: 'http://idp.example.com/sso',
        idp_cert: 'MIIC-fake-cert-body',
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("won't enable SAML without an IdP URL + cert", async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/sso/saml',
      headers: authHeader(admin.token),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(422);
  });
});
