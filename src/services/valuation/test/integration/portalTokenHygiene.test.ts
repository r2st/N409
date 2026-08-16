import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Credential hygiene for the links that authenticate somebody with no account.
 *
 * The portals' *behaviour* is covered — `auditorPortal` and the `clientIntake`
 * files between them pin expiry, revocation, a garbage token, firm scope and
 * the archived-firm cases. What none of them pin is the property underneath:
 * that the string in the auditor's inbox is a real secret and that it is not
 * sitting in the database in the clear.
 *
 * Both halves are upheld today, by convention, in eight separate repos —
 * `auditorAccess`, `clientIntake`, `boardApprovals`, `passwordResets`,
 * `emailVerifications`, `invitations`, `apiTokens`, `ssoConfig` each mint
 * `randomBytes(≥24)` and store a SHA-256. Convention held across eight is
 * convention that will be broken by the ninth, and the failure is silent in
 * both directions: a token stored raw still works, and a token minted from a
 * weaker source still works. Nothing about a passing suite would change.
 *
 * So these assert the two properties directly, against the database, for the
 * two portals a client or an outside auditor actually holds a link to.
 */

/** Minimum length of a base64url encoding of 32 random bytes. */
const MIN_TOKEN_CHARS = 43;

describe.skipIf(!dbUp)('portal token hygiene', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  describe('the auditor portal link', () => {
    let token: string;
    let valuationId: string;

    beforeAll(async () => {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(ops.token),
        payload: { kind: '409a', company_name: 'Audited Co' },
      });
      valuationId = created.json().valuation.id;
      const minted = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/auditor-access`,
        headers: authHeader(ops.token),
        payload: { label: 'Auditor', expires_in_days: 30 },
      });
      expect(minted.statusCode, minted.body).toBe(201);
      token = minted.json().token as string;
    });

    it('is long enough to be worth guessing at', () => {
      // 32 bytes base64url. The redeem endpoint is rate-limited at 30 per IP
      // per 10 minutes, but a limiter is a brake on an online attack, not a
      // substitute for entropy — the token is the only thing standing between
      // an unauthenticated caller and an entire client valuation.
      expect(token.length).toBeGreaterThanOrEqual(MIN_TOKEN_CHARS);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('is different every time', async () => {
      const second = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/auditor-access`,
        headers: authHeader(ops.token),
        payload: { label: 'Second auditor', expires_in_days: 30 },
      });
      expect(second.json().token).not.toBe(token);
    });

    /**
     * The one that would go unnoticed. A row storing the raw token works
     * identically — the portal still redeems, every existing test still passes
     * — and it turns any read of this table into a set of live credentials for
     * other firms' valuations.
     */
    it('is stored as a hash, never in the clear', async () => {
      const { rows } = await ctx.pool.query<{ token_hash: string }>(
        'SELECT token_hash FROM auditor_access WHERE valuation_id = $1',
        [valuationId],
      );
      expect(rows.length).toBeGreaterThan(0);
      const digest = createHash('sha256').update(token).digest('hex');
      expect(rows.map((r) => r.token_hash)).toContain(digest);
      for (const row of rows) expect(row.token_hash).not.toBe(token);
    });

    /** And the API never hands the token back after the one time it is minted. */
    it('is not echoed by the management list', async () => {
      const listed = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/auditor-access`,
        headers: authHeader(ops.token),
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.body).not.toContain(token);
      // The hash is not a substitute for the token, but publishing it hands an
      // attacker the value to match against and costs nothing to withhold.
      expect(listed.body).not.toContain('token_hash');
    });

    it('still redeems, so none of the above is achieved by breaking it', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auditor/portal',
        payload: { token },
      });
      expect(res.statusCode, res.body).toBe(200);
    });
  });

  describe('the client intake link', () => {
    let token: string;
    let partnerId: string;

    beforeAll(async () => {
      partnerId = await seedPartner(ctx, 'Intake Firm');
      // The firm is named on the query string, not in the body — an ops caller
      // can act for any firm and so must say which.
      const minted = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/firm/intake-links?partner_id=${partnerId}`,
        headers: authHeader(ops.token),
        payload: { client_name: 'Prospect Co' },
      });
      expect(minted.statusCode, minted.body).toBe(201);
      token = minted.json().token as string;
    });

    it('is long enough to be worth guessing at', () => {
      expect(token.length).toBeGreaterThanOrEqual(MIN_TOKEN_CHARS);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('is stored as a hash, never in the clear', async () => {
      const { rows } = await ctx.pool.query<{ token_hash: string }>(
        'SELECT token_hash FROM client_intake_links WHERE partner_id = $1',
        [partnerId],
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((r) => r.token_hash)).toContain(
        createHash('sha256').update(token).digest('hex'),
      );
      for (const row of rows) expect(row.token_hash).not.toBe(token);
    });

    it('is not echoed by the firm-side list', async () => {
      const listed = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/firm/intake-links?partner_id=${partnerId}`,
        headers: authHeader(ops.token),
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.body).not.toContain(token);
      expect(listed.body).not.toContain('token_hash');
    });

    it('still opens the portal', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/intake/portal',
        payload: { token },
      });
      expect(res.statusCode, res.body).toBe(200);
    });
  });

  /**
   * Both portals authenticate on the request *body*, never the query string.
   *
   * The links themselves put the token in a URL fragment (`/auditor#token=…`),
   * which the browser does not send to the server — so the token reaches the
   * API only because the SPA reads the fragment and POSTs it. A route that also
   * accepted `?token=` would undo that quietly: fragments stay out of access
   * logs, `Referer` headers and proxy records, and query strings do not.
   */
  it('refuses a token offered in the query string', async () => {
    const firmId = await seedPartner(ctx, 'Query String Firm');
    const minted = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/firm/intake-links?partner_id=${firmId}`,
      headers: authHeader(ops.token),
      payload: { client_name: 'QS Co' },
    });
    expect(minted.statusCode, minted.body).toBe(201);
    const queryToken = minted.json().token as string;

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/intake/portal?token=${encodeURIComponent(queryToken)}`,
      payload: {},
    });
    expect(res.statusCode).not.toBe(200);
  });
});
