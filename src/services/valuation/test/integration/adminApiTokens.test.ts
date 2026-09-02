import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Cross-partner API token listing (design §14.1, P2-14).
 *
 * The listing exists so "who holds credentials against this platform" has an
 * answer that is not "open twenty-four partner pages". What the tests hold to
 * is the part that would be a security defect if it drifted: the digest is
 * never served, the listing is administrator-only rather than merely ops, and
 * the dormancy figure counts what an operator would act on.
 */
describe.skipIf(!dbUp)('admin API token listing', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let reviewer: Awaited<ReturnType<typeof seedUser>>;
  let partnerA: string;
  let partnerB: string;

  const list = async (token: string, query = '') =>
    ctx.app.inject({ method: 'GET', url: `/api/v1/admin/api-tokens${query}`, headers: authHeader(token) });

  const issue = async (partnerId: string, name: string) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/partners/${partnerId}/tokens`,
      headers: authHeader(admin.token),
      payload: { name },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { token: { id: string }; secret: string };
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'], email: 'tokens-admin@test.example.com' });
    reviewer = await seedUser(ctx, { roles: ['reviewer'] });
    partnerA = await seedPartner(ctx, 'Alpha Advisors');
    partnerB = await seedPartner(ctx, 'Beta Partners');
    await issue(partnerA, 'Portfolio sync');
    await issue(partnerB, 'Nightly export');
  });
  afterAll(async () => ctx?.teardown());

  it('lists every partner’s tokens in one call', async () => {
    const res = await list(admin.token);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tokens: Array<{ partner_name: string; name: string }>; live: number };
    expect(body.tokens.map((t) => t.partner_name).sort()).toEqual(['Alpha Advisors', 'Beta Partners']);
    expect(body.live).toBe(2);
  });

  it('joins the issuing user so the row names a person, not a ULID', async () => {
    const body = (await list(admin.token)).json() as {
      tokens: Array<{ created_by_email: string; created_by: string }>;
    };
    for (const t of body.tokens) {
      expect(t.created_by_email).toBe('tokens-admin@test.example.com');
      expect(t.created_by).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    }
  });

  it('never serves the token hash', async () => {
    const res = await list(admin.token);
    // Asserted on the raw body rather than a parsed field: the risk is a
    // `SELECT *` creeping into the repo, which no per-field assertion catches.
    expect(res.body).not.toMatch(/token_hash/);
    const body = res.json() as { tokens: Array<{ token_prefix: string }> };
    expect(body.tokens[0]!.token_prefix.startsWith('n409_pat_')).toBe(true);
  });

  it('is administrator-only — a reviewer is ops but has no business here', async () => {
    const res = await list(reviewer.token);
    expect(res.statusCode).toBe(403);
  });

  it('hides revoked tokens by default and shows them on request', async () => {
    const { token } = await issue(partnerA, 'Decommissioned');
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/api-tokens/${token.id}`,
      headers: authHeader(admin.token),
    });
    expect(del.statusCode).toBe(204);

    const live = (await list(admin.token)).json() as { tokens: Array<{ id: string }>; live: number };
    expect(live.tokens.map((t) => t.id)).not.toContain(token.id);
    expect(live.live).toBe(2);

    const all = (await list(admin.token, '?revoked=true')).json() as {
      tokens: Array<{ id: string; revoked_at: string | null }>;
      live: number;
      total: number;
    };
    const row = all.tokens.find((t) => t.id === token.id);
    expect(row?.revoked_at).not.toBeNull();
    // Live stays 2 with the revoked row included — the summary counts what is
    // usable, not what is listed.
    expect(all.live).toBe(2);
    expect(all.total).toBe(3);
  });

  it('counts a long-unused live token as dormant, and a fresh one as not', async () => {
    const { token } = await issue(partnerB, 'Forgotten integration');
    const before = (await list(admin.token)).json() as { dormant: number; dormant_after_days: number };
    expect(before.dormant).toBe(0);

    await ctx.pool.query(
      `UPDATE api_tokens SET created_at = now() - interval '400 days', last_used_at = now() - interval '200 days'
        WHERE id = $1`,
      [token.id],
    );
    const after = (await list(admin.token)).json() as { dormant: number };
    expect(after.dormant).toBe(1);
    expect(before.dormant_after_days).toBe(90);
  });

  it('counts a never-used token as dormant only once it is older than the window', async () => {
    const { token } = await issue(partnerA, 'Never wired up');
    expect(((await list(admin.token)).json() as { dormant: number }).dormant).toBe(1);

    await ctx.pool.query(
      `UPDATE api_tokens SET created_at = now() - interval '400 days', last_used_at = NULL WHERE id = $1`,
      [token.id],
    );
    expect(((await list(admin.token)).json() as { dormant: number }).dormant).toBe(2);
  });

  it('sorts live tokens ahead of revoked ones', async () => {
    const body = (await list(admin.token, '?revoked=true')).json() as {
      tokens: Array<{ revoked_at: string | null }>;
    };
    const firstRevoked = body.tokens.findIndex((t) => t.revoked_at !== null);
    const lastLive = body.tokens.map((t) => t.revoked_at === null).lastIndexOf(true);
    expect(firstRevoked).toBeGreaterThan(lastLive);
  });

  it('rejects an unparseable revoked filter rather than silently ignoring it', async () => {
    const res = await list(admin.token, '?revoked=maybe');
    expect(res.statusCode).toBe(400);
  });

  /**
   * The listing reads a page; the figures still describe the platform.
   *
   * This is the whole reason the read could not just be given a `LIMIT`. Every
   * figure here used to be counted in JavaScript over the rows that came back —
   * `tokens.length`, `tokens.filter(live)`, `tokens.filter(dormant)` — so a cap
   * on the query would have capped the answers with it, and a credential
   * inventory that under-reports how many live tokens exist is a worse failure
   * than the slow query it replaced. The counts moved into SQL; these cases pin
   * the two apart.
   */
  describe('bounded reads', () => {
    it('counts the whole platform even when the page shows one row', async () => {
      const whole = (await list(admin.token, '?revoked=true')).json() as {
        tokens: unknown[];
        total: number;
        live: number;
        dormant: number;
      };
      expect(whole.tokens.length).toBeGreaterThan(1);

      const page = (await list(admin.token, '?revoked=true&limit=1')).json() as {
        tokens: unknown[];
        total: number;
        live: number;
        dormant: number;
        truncated: boolean;
      };
      expect(page.tokens).toHaveLength(1);
      expect(page.truncated).toBe(true);
      // The figures are identical to the unbounded read's, which is the point.
      expect(page.total).toBe(whole.total);
      expect(page.live).toBe(whole.live);
      expect(page.dormant).toBe(whole.dormant);
    });

    it('does not claim truncation when the page holds everything', async () => {
      const whole = (await list(admin.token, '?revoked=true')).json() as {
        tokens: unknown[];
        truncated: boolean;
      };
      expect(whole.truncated).toBe(false);
      const exact = (await list(admin.token, `?revoked=true&limit=${whole.tokens.length}`)).json() as {
        tokens: unknown[];
        truncated: boolean;
      };
      expect(exact.tokens).toHaveLength(whole.tokens.length);
      expect(exact.truncated).toBe(false);
    });

    it('keeps the live-first ordering under a cap, so the page is the useful end', async () => {
      // A capped listing that handed back revoked rows first would be a page of
      // exactly the credentials nobody needs to see.
      const page = (await list(admin.token, '?revoked=true&limit=2')).json() as {
        tokens: Array<{ revoked_at: string | null }>;
      };
      expect(page.tokens.every((t) => t.revoked_at === null)).toBe(true);
    });

    it('refuses a limit above the ceiling rather than honouring it', async () => {
      expect((await list(admin.token, '?limit=100000')).statusCode).toBe(400);
      expect((await list(admin.token, '?limit=0')).statusCode).toBe(400);
    });
  });

  /**
   * No key mints its successor.
   *
   * A partner key is handed to an integration, lives outside anybody's browser
   * session, and reads the firm's whole book — and `POST /partners/:id/tokens`
   * is self-service for a firm's org admin. So the credential could issue its
   * own replacement, and revoking a leaked one ended nothing: whoever held it
   * had already minted the next. The refusal is what makes revocation the end
   * of the story, and `POST /me/tokens` states the same rule for the personal
   * half.
   */
  describe('a token cannot mint a token', () => {
    it('refuses a partner mint authenticated by an API key', async () => {
      // The key has to be minted by a member of the firm it is scoped to —
      // `resolveApiToken` re-reads that on every request, so a key created by a
      // platform admin with no partner does not resolve at all.
      const orgAdmin = await seedUser(ctx, { roles: ['partner'], partnerId: partnerA });
      const minted = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/partners/${partnerA}/tokens`,
        headers: authHeader(orgAdmin.token),
        payload: { name: 'integration' },
      });
      expect(minted.statusCode, minted.body).toBe(201);
      const secret = minted.json().secret as string;

      // The key works — otherwise the refusal below would prove nothing.
      const whoami = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: authHeader(secret),
      });
      expect(whoami.statusCode).toBe(200);
      expect(whoami.json().user.id).toBe(orgAdmin.id);

      const second = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/partners/${partnerA}/tokens`,
        headers: authHeader(secret),
        payload: { name: 'successor' },
      });
      expect(second.statusCode).toBe(403);
      expect(second.json().detail).toContain('cannot mint another API token');
    });
  });

  it('withdraws a credential once, however many times the control is pressed', async () => {
    // `findApiTokenById` returns revoked rows and the listing puts them back on
    // screen, so revoking one already revoked used to answer 204 and write a
    // second `api_token_revoked` — two answers to "who withdrew this credential
    // and when", the later one naming whoever pressed a stale button (round
    // 356, methodology M3). The SCIM-token door beside it has always asked.
    const { token } = await issue(partnerA, 'Twice Revoked');
    const revoke = () =>
      ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/api-tokens/${token.id}`,
        headers: authHeader(admin.token),
      });
    expect((await revoke()).statusCode).toBe(204);
    const again = await revoke();
    expect(again.statusCode).toBe(404);
    expect(again.json().detail).toMatch(/already been revoked/i);

    const { rows } = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM admin_events
        WHERE type = 'api_token_revoked' AND subject_id = $1`,
      [token.id],
    );
    expect(rows[0]!.n).toBe('1');
  });
});
