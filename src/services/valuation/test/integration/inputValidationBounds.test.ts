import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The over-size input reaches the route, and the route answers 4xx.
 *
 * `emailBounds.test.ts` and `inputSizeBounds.test.ts` pin the schemas; this is
 * the half only a database can show — that the value is refused *before* the
 * INSERT rather than after it, and that what comes back is an input error and
 * not a 500.
 *
 * The failure being closed off: `users.email` is `text`, so the column takes
 * anything, but `users_email_key` is a unique b-tree over `lower(email)` and a
 * b-tree index tuple stops at 2704 bytes. An address past that failed the INSERT
 * with `54000 index row size … exceeds btree version 4 maximum`. That is not a
 * unique violation, so `isUniqueViolation` did not catch it and the 409 branch
 * never ran — the public registration form answered 500, and the log line
 * carried the whole address. `scim_external_id` has the same index and the same
 * story, with an IdP connector on the other end that retries a 500 forever.
 */
describe.skipIf(!dbUp)('input size bounds at the route', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let scimBearer: { authorization: string };

  /** Comfortably past a b-tree index tuple, and one JSON line to send. */
  const overLongLocalPart = 'a'.repeat(4000);
  const overLongEmail = `${overLongLocalPart}@corp.com`;

  /**
   * Satisfies `assertPasswordStrong` — ten characters, a letter and a digit.
   *
   * Not incidental. `/auth/register` checks the password *after* the schema, so
   * a password without a digit answers 422 whatever the address is: the
   * over-long-email case above would have passed on the password rule alone,
   * proving nothing about the bound it names.
   *
   * The same is true of `POST /users` further down, which is why that block
   * uses this constant too rather than a literal of its own. It did not, and
   * once the admin console learned the complexity rule its two 422s were being
   * answered by the password rather than by the over-long address and the
   * over-long role list they are named for.
   */
  const REGISTRABLE_PASSWORD = 'correct-horse-battery-9';

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    admin = await seedUser(ctx, { roles: ['admin'] });
    const token = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/sso/scim-tokens',
      headers: authHeader(admin.token),
      payload: { label: 'Okta' },
    });
    scimBearer = { authorization: `Bearer ${token.json().secret}` };
  });
  afterAll(async () => ctx?.teardown());

  describe('the unauthenticated registration form', () => {
    it('answers 4xx, not 500, to an address the email index cannot hold', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: overLongEmail, password: REGISTRABLE_PASSWORD },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    });

    it('never writes the row, so a later well-formed sign-up is unaffected', async () => {
      const { rows } = await ctx.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM users WHERE length(email) > 320`,
      );
      expect(Number(rows[0]!.n)).toBe(0);
    });

    it('still registers an ordinary address', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'ordinary@corp.com', password: REGISTRABLE_PASSWORD },
      });
      expect(res.statusCode).toBeLessThan(400);
    });
  });

  describe('login and password recovery', () => {
    // Not a credential oracle: after the bound, no account can carry an address
    // this long, so refusing one tells a caller nothing it did not already know.
    it.each([
      ['login', '/api/v1/auth/login', { email: overLongEmail, password: 'x' }],
      ['forgot-password', '/api/v1/auth/forgot-password', { email: overLongEmail }],
    ])('answers 4xx on %s rather than reaching the lookup', async (_name, url, payload) => {
      const res = await ctx.app.inject({ method: 'POST', url, payload });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    });
  });

  describe('admin user management', () => {
    const admins = () => authHeader(admin.token);

    it('refuses an over-long address on create', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: admins(),
        payload: {
          email: overLongEmail,
          password: REGISTRABLE_PASSWORD,
          roles: ['valuation_user'],
        },
      });
      expect(res.statusCode).toBe(422);
    });

    it('refuses an invitation to one', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/users/invite',
        headers: admins(),
        payload: { email: overLongEmail, roles: ['valuation_user'] },
      });
      expect(res.statusCode).toBe(422);
    });

    it('refuses a role list longer than there are roles', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: admins(),
        payload: {
          email: 'roles@corp.com',
          password: REGISTRABLE_PASSWORD,
          roles: Array.from({ length: 60_000 }, () => 'admin'),
        },
      });
      expect(res.statusCode).toBe(422);
    });
  });

  describe('SCIM provisioning', () => {
    const scim = (payload: unknown) =>
      ctx.app.inject({ method: 'POST', url: '/scim/v2/Users', headers: scimBearer, payload });

    it('refuses an over-long userName in SCIM’s own error shape', async () => {
      const res = await scim({ userName: overLongEmail });
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toContain('application/scim+json');
      expect(res.json().detail).toContain('at most 320 characters');
      expect(res.json().schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
    });

    it('refuses an over-long externalId, and says which field', async () => {
      const res = await scim({ userName: 'ext@corp.com', externalId: 'e'.repeat(300) });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toBe('externalId must be at most 255 characters');
    });

    it('refuses an over-long givenName, and says which field', async () => {
      const res = await scim({ userName: 'given@corp.com', name: { givenName: 'g'.repeat(500) } });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toBe('name.givenName must be at most 100 characters');
    });

    it('refuses a userName that is not an address', async () => {
      const res = await scim({ userName: 'S-1-5-21-1004336348' });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toContain('must be an email address');
    });

    it('still provisions the record an IdP actually sends', async () => {
      const res = await scim({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'Provisioned@Corp.com',
        name: { givenName: 'Ada', familyName: 'Lovelace' },
        externalId: 'ext-42',
        active: true,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().userName).toBe('provisioned@corp.com');
      expect(res.json().externalId).toBe('ext-42');
    });

    it('leaves no over-size row behind for the b-tree to choke on', async () => {
      const { rows } = await ctx.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM users
          WHERE length(email) > 320
             OR length(coalesce(scim_external_id, '')) > 255
             OR length(coalesce(first_name, '')) > 100`,
      );
      expect(Number(rows[0]!.n)).toBe(0);
    });
  });

  describe('the questionnaire an anonymous client fills in', () => {
    let valuationId: string;

    beforeAll(async () => {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(admin.token),
        payload: { kind: '409a', company_name: 'BoundsCo' },
      });
      valuationId = created.json().valuation.id;
    });

    const save = (answers: unknown) =>
      ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${valuationId}/questionnaire`,
        headers: authHeader(admin.token),
        payload: { answers },
      });

    it('refuses a single answer the size of the whole body', async () => {
      const res = await save({ legal_name: 'x'.repeat(10_001) });
      expect(res.statusCode).toBe(422);
    });

    it('accepts an answer at the bound', async () => {
      const res = await save({ legal_name: 'x'.repeat(10_000) });
      expect(res.statusCode).toBeLessThan(400);
    });

    it('refuses more keys than any questionnaire has fields', async () => {
      const wide = Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`k${i}`, 'v']));
      expect((await save(wide)).statusCode).toBe(422);
    });
  });

  describe('ASC 718 settings', () => {
    let valuationId: string;

    beforeAll(async () => {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(admin.token),
        payload: { kind: '409a', company_name: 'Asc718BoundsCo' },
      });
      valuationId = created.json().valuation.id;
    });

    const put = (body: Record<string, unknown>) =>
      ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${valuationId}/asc718/settings`,
        headers: authHeader(admin.token),
        payload: { company_type: 'private', ...body },
      });

    // The measurement endpoint caps `peers` at 50 because each one costs a
    // simulation; the saved form of the same list carried no bound at all.
    it('refuses a peer basket the TSR measurement could not price', async () => {
      const res = await put({ tsr_peer_basket: Array.from({ length: 51 }, (_, i) => ({ ticker: `T${i}` })) });
      expect(res.statusCode).toBe(422);
    });

    it('accepts a basket at the same bound the measurement uses', async () => {
      const res = await put({ tsr_peer_basket: Array.from({ length: 50 }, (_, i) => ({ ticker: `T${i}` })) });
      expect(res.statusCode).toBeLessThan(400);
    });

    it('refuses an unbounded performance-conditions map', async () => {
      const wide = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`c${i}`, 1]));
      expect((await put({ rsu_performance_conditions: wide })).statusCode).toBe(422);
    });
  });

  describe('valuation params', () => {
    let valuationId: string;

    beforeAll(async () => {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(admin.token),
        payload: { kind: '409a', company_name: 'ParamsBoundsCo' },
      });
      valuationId = created.json().valuation.id;
    });

    const patch = (body: Record<string, unknown>) =>
      ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/params`,
        headers: authHeader(admin.token),
        payload: body,
      });

    // `unlevered_beta_input` rides along because `validateWaccBuildUp` refuses a
    // build-up without a beta — an invariant that runs after the schema, and
    // would otherwise 422 the valid case for an unrelated reason.
    const buildUp = (points: number) => ({
      unlevered_beta_input: 1.1,
      treasury_curve: Object.fromEntries(Array.from({ length: points }, (_, i) => [String(i + 1), 0.04])),
    });

    it('refuses a treasury curve with more points than Treasury publishes tenors', async () => {
      expect((await patch({ wacc_inputs: buildUp(101) })).statusCode).toBe(422);
    });

    it('accepts a real curve', async () => {
      expect((await patch({ wacc_inputs: buildUp(13) })).statusCode).toBeLessThan(400);
    });
  });

  describe('the one mutation body that was read by cast', () => {
    /*
     * `POST /admin/sso/scim-tokens` took `req.body.label` through a cast and
     * `.slice(0, 200)`. Every other mutation in the service parses its body,
     * and the two things a schema does are the two things missing here: an
     * over-long value was silently shortened rather than refused, and an
     * unknown field was silently ignored where the rest of this file's bodies
     * are `.strict()`.
     */
    const mint = (payload: unknown) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/sso/scim-tokens',
        headers: authHeader(admin.token),
        payload: payload as Record<string, unknown>,
      });

    it('refuses an over-long label instead of storing a shortened one', async () => {
      const res = await mint({ label: 'x'.repeat(201) });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain('label');
    });

    it('refuses a misspelt field rather than minting a token without it', async () => {
      expect((await mint({ labell: 'Okta' })).statusCode).toBe(422);
    });

    it('refuses a label that is not a string', async () => {
      expect((await mint({ label: 42 })).statusCode).toBe(422);
    });

    it('still mints on an empty body and on a label at the bound', async () => {
      expect((await mint({})).statusCode).toBe(201);
      // Two hundred characters of astral text: 200 code points is 400 UTF-16
      // units, so the old `.slice(0, 200)` cut this in half and the `jsonb`
      // payload of `scim_token_created` would have refused the orphan.
      const res = await mint({ label: '\u{1F600}'.repeat(200) });
      expect(res.statusCode).toBe(422);
      expect((await mint({ label: '\u{1F600}'.repeat(100) })).statusCode).toBe(201);
    });
  });
});
