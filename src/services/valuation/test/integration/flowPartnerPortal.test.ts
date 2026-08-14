import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * What a firm sees when it signs in, and what it does not.
 *
 * The partner *API* surface is covered at length — partnerApi.test.ts and
 * partnerApiScoping.test.ts walk the key-authenticated routes and their
 * tenancy. The signed-in surface is the other half and has nothing comparable:
 * a `partner` or `member` principal is an ordinary session against the same
 * routes the console and the clients use, and its scope comes from one policy
 * layer that every one of those routes consults separately.
 *
 * That is exactly the arrangement where a permission gap is invisible. Each
 * route looks correct on its own; what nobody checks is whether the same
 * principal, holding the same session, is refused consistently across all of
 * them. So this asserts one firm against another firm's engagement and against
 * operations' own tooling, route by route, and asserts the two seats inside a
 * firm are actually different — `partner` administers the firm, `member` works
 * in it, and a model that collapses them hands every seat the firm's
 * credentials.
 */

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('the partner portal', () => {
  let ctx: TestApp;
  let firmId: string;
  let rivalFirmId: string;
  /** Firm administrator. */
  let partner: Awaited<ReturnType<typeof seedUser>>;
  /** Ordinary seat in the same firm. */
  let member: Awaited<ReturnType<typeof seedUser>>;
  /** Administrator of a different firm. */
  let rival: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  /** Belongs to the firm. */
  let ours: string;
  /** Belongs to the rival firm. */
  let theirs: string;

  const as = (
    token: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => ctx.app.inject({ method, url, headers: authHeader(token), ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    firmId = await seedPartner(ctx, 'Keystone Advisors');
    rivalFirmId = await seedPartner(ctx, 'Longbow Capital Advisory');
    partner = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
    member = await seedUser(ctx, { roles: ['member'], partnerId: firmId });
    rival = await seedUser(ctx, { roles: ['partner'], partnerId: rivalFirmId });
    ops = await seedUser(ctx, { roles: ['admin'] });

    const mine = await as(partner.token, 'POST', '/api/v1/valuations', {
      kind: '409a',
      company_name: 'Keystone Client One, Inc.',
    });
    expect(mine.statusCode).toBe(201);
    ours = mine.json().valuation.id as string;

    const other = await as(rival.token, 'POST', '/api/v1/valuations', {
      kind: '409a',
      company_name: 'Longbow Client One, Inc.',
    });
    theirs = other.json().valuation.id as string;
  });
  afterAll(async () => ctx?.teardown());

  // ── What the firm is ──────────────────────────────────────────────────────

  it('tells a firm account which firm it is in, and nothing about any other', async () => {
    const res = await as(partner.token, 'GET', '/api/v1/partners/mine');
    expect(res.statusCode).toBe(200);
    expect(res.json().partner.id).toBe(firmId);
    expect(res.json().partner.name).toBe('Keystone Advisors');

    // The firm roster itself is platform administration, not self-service.
    expect((await as(partner.token, 'GET', '/api/v1/partners')).statusCode).toBe(403);
    expect((await as(partner.token, 'GET', `/api/v1/partners/${rivalFirmId}`)).statusCode).toBe(403);
  });

  it('stamps a firm’s new engagement with the firm, not with whatever was asked for', async () => {
    const res = await as(member.token, 'POST', '/api/v1/valuations', {
      kind: '409a',
      company_name: 'Keystone Client Two, Inc.',
      // A non-ops principal creates inside their own scope; naming somebody
      // else's firm here must not move the engagement into it.
      partner_id: rivalFirmId,
      user_id: rival.id,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().valuation.partner_id).toBe(firmId);
    expect(res.json().valuation.user_id).toBe(member.id);
  });

  // ── The firm's own engagements, and only those ────────────────────────────

  it('lists the firm’s engagements to everybody in the firm', async () => {
    for (const token of [partner.token, member.token]) {
      const ids = (
        (await as(token, 'GET', '/api/v1/valuations')).json().valuations as Array<{
          id: string;
        }>
      ).map((v) => v.id);
      // A member sees the firm's book, not only what they opened themselves —
      // that is what makes it a firm account rather than a set of logins.
      expect(ids).toContain(ours);
      expect(ids).not.toContain(theirs);
    }
  });

  /**
   * The read routes an engagement page is built from. Asserted twice — against
   * the firm's own engagement and against the rival's — because a 404 alone
   * proves nothing: a route that does not exist, or one that rejects every
   * caller, answers 404 too and would make the scoping test pass by accident.
   */
  const ENGAGEMENT_READS = ['', '/events', '/comments', '/cap-table', '/params', '/questionnaire'];

  it('serves the firm its own engagement on every route the page reads', async () => {
    for (const suffix of ENGAGEMENT_READS) {
      const url = `/api/v1/valuations/${ours}${suffix}`;
      const res = await as(partner.token, 'GET', url);
      expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
    }
  });

  it('404s another firm’s engagement on all of them', async () => {
    for (const suffix of [...ENGAGEMENT_READS, '/report.pdf']) {
      const url = `/api/v1/valuations/${theirs}${suffix}`;
      const res = await as(partner.token, 'GET', url);
      // 404 rather than 403 throughout: a 403 confirms the id exists, which is
      // itself a fact about another firm's book.
      expect({ url, status: res.statusCode }).toEqual({ url, status: 404 });
    }
  });

  it('refuses to let one firm write to another’s engagement', async () => {
    expect(
      (await as(partner.token, 'PATCH', `/api/v1/valuations/${theirs}`, { company_name: 'Taken' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await as(partner.token, 'POST', `/api/v1/valuations/${theirs}/comments`, { kind: 'chat', body: 'hi' }))
        .statusCode,
    ).toBe(404);
  });

  // ── What a firm may not do to its own engagement ──────────────────────────

  it('keeps the analyst’s tooling out of the firm’s hands', async () => {
    // Every one of these is on an engagement the firm can read. The refusal is
    // about the *action*, not about the tenancy — a firm that could run the
    // engine or edit the report would be signing its own valuations.
    const denied: Array<[string, string, unknown?]> = [
      ['POST', `/api/v1/valuations/${ours}/calculations`],
      ['POST', `/api/v1/valuations/${ours}/report/render`],
      ['PUT', `/api/v1/valuations/${ours}/report`, { content: { title: 'x', sections: [] } }],
      ['POST', `/api/v1/valuations/${ours}/workflow/advance`],
      ['POST', `/api/v1/valuations/${ours}/review/decision`, { decision: 'approve' }],
      [
        'POST',
        `/api/v1/valuations/${ours}/signatures`,
        { role: 'main', signer_name: 'A Partner', signature_text: 'A Partner' },
      ],
      ['POST', `/api/v1/valuations/${ours}/comments`, { kind: 'note', body: 'internal' }],
    ];
    for (const [method, url, payload] of denied) {
      const res = await as(partner.token, method as 'POST', url, payload);
      expect({ url, status: res.statusCode }).toEqual({ url, status: 403 });
    }
  });

  it('keeps operations’ own screens to operations', async () => {
    for (const url of ['/api/v1/reviews', '/api/v1/admin/billing', '/api/v1/admin/api-tokens']) {
      const res = await as(partner.token, 'GET', url);
      expect({ url, status: res.statusCode }).toEqual({ url, status: 403 });
    }
  });

  it('shows the firm the client-facing thread and not the internal one', async () => {
    const note = await as(ops.token, 'POST', `/api/v1/valuations/${ours}/comments`, {
      kind: 'note',
      body: 'Internal: chase the 2025 option grants.',
    });
    expect(note.statusCode).toBe(201);
    const chat = await as(ops.token, 'POST', `/api/v1/valuations/${ours}/comments`, {
      kind: 'chat',
      body: 'Could you send the latest grant register?',
    });
    expect(chat.statusCode).toBe(201);

    const seen = (await as(partner.token, 'GET', `/api/v1/valuations/${ours}/comments`)).json()
      .comments as Array<{ id: string }>;
    expect(seen.map((c) => c.id)).toContain(chat.json().comment.id);
    expect(seen.map((c) => c.id)).not.toContain(note.json().comment.id);
  });

  // ── The deliverable, when it is ready and not before ──────────────────────

  it('withholds the report until a draft is shared, then serves it', async () => {
    expect((await as(ops.token, 'GET', `/api/v1/valuations/${ours}/report`)).statusCode).toBe(200);
    expect((await as(ops.token, 'POST', `/api/v1/valuations/${ours}/report/render`)).statusCode).toBe(200);

    // Rendered, but still an internal draft: the firm sees nothing.
    expect((await as(partner.token, 'GET', `/api/v1/valuations/${ours}/report.pdf`)).statusCode).toBe(404);
    expect((await as(member.token, 'GET', `/api/v1/valuations/${ours}/report.pdf`)).statusCode).toBe(404);

    expect(
      (await as(ops.token, 'PATCH', `/api/v1/valuations/${ours}`, { state: 'drafted' })).statusCode,
    ).toBe(200);

    for (const token of [partner.token, member.token]) {
      const pdf = await as(token, 'GET', `/api/v1/valuations/${ours}/report.pdf`);
      expect(pdf.statusCode).toBe(200);
      expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    }
    // Sharing one firm's draft does not share it with the other.
    expect((await as(rival.token, 'GET', `/api/v1/valuations/${ours}/report.pdf`)).statusCode).toBe(404);
  });

  // ── Two seats, two sets of keys ───────────────────────────────────────────

  describe('the firm administrator’s seat', () => {
    it('brands its own firm and not another', async () => {
      const mine = await as(partner.token, 'PATCH', '/api/v1/branding', { brand_color: '#1B4D3E' });
      expect(mine.statusCode).toBe(200);

      const theirBrand = await as(partner.token, 'PATCH', `/api/v1/branding?partner_id=${rivalFirmId}`, {
        brand_color: '#000000',
      });
      expect(theirBrand.statusCode).toBe(403);
    });

    it('mints API credentials for its own firm and not another', async () => {
      const mine = await as(partner.token, 'POST', `/api/v1/partners/${firmId}/tokens`, {
        name: 'Keystone integration',
      });
      expect(mine.statusCode).toBe(201);
      // Shown once, on creation, and never listed again.
      expect(mine.json().secret).toBeTruthy();
      const listed = await as(partner.token, 'GET', `/api/v1/partners/${firmId}/tokens`);
      expect(listed.statusCode).toBe(200);
      expect(JSON.stringify(listed.json())).not.toContain(mine.json().secret);

      const theirs_ = await as(partner.token, 'POST', `/api/v1/partners/${rivalFirmId}/tokens`, {
        name: 'Not mine',
      });
      expect(theirs_.statusCode).toBe(403);
    });
  });

  describe('the ordinary seat', () => {
    it('cannot brand the firm', async () => {
      // `member` is a seat inside the firm, not its administrator. Collapsing
      // the two is how every employee gets to repoint the firm's subdomain.
      expect(
        (await as(member.token, 'PATCH', '/api/v1/branding', { brand_color: '#FF0000' })).statusCode,
      ).toBe(403);
    });

    it('cannot mint API credentials for it', async () => {
      const res = await as(member.token, 'POST', `/api/v1/partners/${firmId}/tokens`, {
        name: 'From a seat',
      });
      expect(res.statusCode).toBe(403);
      expect((await as(member.token, 'GET', `/api/v1/partners/${firmId}/tokens`)).statusCode).toBe(403);
    });

    it('still reads the firm it belongs to', async () => {
      const res = await as(member.token, 'GET', '/api/v1/partners/mine');
      expect(res.statusCode).toBe(200);
      expect(res.json().partner.id).toBe(firmId);
    });
  });

  // ── A seat with no firm behind it ─────────────────────────────────────────

  describe('a partner account with no organisation', () => {
    let orphan: Awaited<ReturnType<typeof seedUser>>;

    beforeAll(async () => {
      // The roles are checked at the boundary, but the scope is derived from
      // `partner_id` — so a partner-role user with no firm resolves to no
      // scope at all rather than, say, to every firm.
      orphan = await seedUser(ctx, { roles: ['member'], partnerId: null });
    });

    it('sees nothing rather than everything', async () => {
      const res = await as(orphan.token, 'GET', '/api/v1/valuations');
      expect(res.statusCode).toBe(200);
      expect(res.json().valuations).toEqual([]);
      expect(res.json().total).toBe(0);
    });

    it('cannot open a named engagement either', async () => {
      expect((await as(orphan.token, 'GET', `/api/v1/valuations/${ours}`)).statusCode).toBe(404);
    });

    it('cannot create one, because there is nothing to create it in', async () => {
      const res = await as(orphan.token, 'POST', '/api/v1/valuations', {
        kind: '409a',
        company_name: 'Orphan Co',
      });
      expect(res.statusCode).toBe(403);
    });

    it('has no firm to report', async () => {
      expect((await as(orphan.token, 'GET', '/api/v1/partners/mine')).statusCode).toBe(404);
    });
  });
});
