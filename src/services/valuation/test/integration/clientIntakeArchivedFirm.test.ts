import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Client intake after the firm behind it is archived.
 *
 * The three public endpoints each re-resolve the token rather than trusting an
 * id — the right discipline — and each asked only whether the *link* was alive:
 * `revoked_at IS NULL AND expires_at > now()`. Never whether the firm was.
 *
 * `partners.archived_at` is the platform's soft delete for a firm. An archived
 * partner takes no new user assignments and cannot have its branding edited,
 * and is gone from the branding list, so the intent is not in doubt. Its
 * outstanding intake links kept working: a public, unauthenticated form wearing
 * that firm's name and colours, collecting a prospect's cap table and
 * financials on behalf of a firm the platform has withdrawn — for up to the
 * link's full expiry — and then offering the result for conversion into a live
 * engagement under it.
 *
 * Same mint-and-redeem shape as the auditor portal and the board sign-off, and
 * gated at both ends for the same reason: nothing revokes the links already in
 * prospects' inboxes, so the check has to happen when they are used.
 */
const COMPLETE_ANSWERS = {
  legal_name: 'Northwind Robotics, Inc.',
  state_of_incorporation: 'Delaware',
  incorporation_date: '2021-03-04',
  industry: 'Robotics',
  business_description: 'Autonomous warehouse robots.',
  revenue_status: 'post_revenue',
  total_shares_outstanding: 10_000_000,
  has_articles: true,
};

describe.skipIf(!dbUp)('client intake when the firm has been archived', () => {
  let ctx: TestApp;
  let firmId: string;
  let firmAdmin: { id: string; token: string };

  beforeAll(async () => {
    ctx = await setupTestApp();
    firmId = await seedPartner(ctx, 'Meridian Valuation');
    firmAdmin = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
  });
  afterAll(async () => ctx?.teardown());

  const mint = (payload: object = {}) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/firm/intake-links',
      headers: authHeader(firmAdmin.token),
      payload,
    });
  const openPortal = (token: string) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/intake/portal', payload: { token } });
  const save = (token: string, answers: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/intake/portal/answers', payload: { token, answers } });
  const submit = (token: string) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/intake/portal/submit', payload: { token } });

  const archiveFirm = () =>
    ctx.pool.query('UPDATE partners SET archived_at = now() WHERE id = $1', [firmId]);
  const reviveFirm = () =>
    ctx.pool.query('UPDATE partners SET archived_at = NULL WHERE id = $1', [firmId]);

  it('closes a link already in a prospect’s inbox', async () => {
    const created = await mint({ client_name: 'Northwind' });
    expect(created.statusCode).toBe(201);
    const token = created.json().token as string;

    // Live firm: the whole flow works. Without this the assertions below would
    // hold for a link that never worked in the first place.
    expect((await openPortal(token)).statusCode).toBe(200);
    expect((await save(token, { legal_name: 'Northwind Robotics, Inc.' })).statusCode).toBe(200);

    await archiveFirm();
    try {
      // Opening, saving and submitting all stop — and stop identically. These
      // are unauthenticated endpoints, so "the firm is gone" and "no such
      // token" deliberately answer the same way; telling them apart tells a
      // guesser which of their guesses was once real.
      expect((await openPortal(token)).statusCode).toBe(401);
      expect((await save(token, { industry: 'Robotics' })).statusCode).toBe(401);
      expect((await submit(token)).statusCode).toBe(401);

      // Nothing was written on the way past the gate.
      const { rows } = await ctx.pool.query<{ answers: Record<string, unknown>; submitted_at: Date | null }>(
        'SELECT answers, submitted_at FROM client_intake_links WHERE partner_id = $1',
        [firmId],
      );
      expect(rows[0]!.answers).not.toHaveProperty('industry');
      expect(rows[0]!.submitted_at).toBeNull();
    } finally {
      await reviveFirm();
    }
  });

  it('refuses to mint a new link for an archived firm', async () => {
    await archiveFirm();
    try {
      const res = await mint({ client_name: 'Too Late, Inc.' });
      expect(res.statusCode).toBe(409);
      expect(res.json().detail).toContain('archived');
      // The point is that no token exists, not that one exists and is refused.
      const { rows } = await ctx.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM client_intake_links
          WHERE partner_id = $1 AND client_name = 'Too Late, Inc.'`,
        [firmId],
      );
      expect(rows[0]!.n).toBe('0');
    } finally {
      await reviveFirm();
    }
  });

  it('refuses to convert a submitted intake into work for an archived firm', async () => {
    const created = await mint({ client_name: 'Converted Co' });
    const token = created.json().token as string;
    const linkId = created.json().link.id as string;
    expect((await save(token, COMPLETE_ANSWERS)).statusCode).toBe(200);
    expect((await submit(token)).statusCode).toBe(200);

    await archiveFirm();
    try {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/firm/intake-links/${linkId}/convert`,
        headers: authHeader(firmAdmin.token),
        payload: { kind: '409a' },
      });
      expect(res.statusCode).toBe(404);

      // A withdrawn firm acquiring fresh work is the thing being prevented, so
      // the absence of the engagement is the assertion.
      const { rows } = await ctx.pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM valuations WHERE partner_id = $1',
        [firmId],
      );
      expect(rows[0]!.n).toBe('0');
    } finally {
      await reviveFirm();
    }

    // And once the firm is live again the same conversion goes through, so the
    // refusal above was the archive rather than something else about the link.
    const after = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/firm/intake-links/${linkId}/convert`,
      headers: authHeader(firmAdmin.token),
      payload: { kind: '409a' },
    });
    expect(after.statusCode).toBe(201);
  });

  it('still lists an archived firm’s links for the firm itself', async () => {
    // Reads stay open, as with the board resolution and the payment receipts:
    // the answers a prospect already sent are a record of what happened, and
    // the console is where an operator sees what to revoke.
    await archiveFirm();
    try {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/firm/intake-links',
        headers: authHeader(firmAdmin.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().links.length).toBeGreaterThan(0);
    } finally {
      await reviveFirm();
    }
  });
});
