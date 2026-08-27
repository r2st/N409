import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The behavioural half of `resourceScopeAuthorization.test.ts`.
 *
 * That sweep reads every route keyed on a non-valuation row and asserts the
 * handler consults the caller before answering. What a source scan cannot say
 * is whether the check it found is the *right* one — a handler comparing
 * `owner_id` to the wrong field, or 403-ing where it should 404, passes the
 * scan and still hands one firm another firm's row.
 *
 * So this drives the resources where two tenants can both name a row, with two
 * accounts that share nothing: firm A's administrator holding a valid session,
 * aimed at ids belonging to firm B.
 *
 * Two invariants, and the second is the one people drop:
 *
 *   1. The answer is a refusal.
 *   2. The refusal is **404 and not 403**, on everything whose existence is
 *      itself scoped. A 403 confirms the id names a real row — it is an
 *      enumeration oracle for a caller who is already inside the product and
 *      can walk ULIDs. The three routes that answer 403 on purpose are named
 *      below with the reason, because "you may not manage this firm" discloses
 *      nothing a partner user did not already know about their own tenancy.
 *
 * Every case pairs the refusal with the owner making the same request, so a
 * route that is simply broken — 404 for everybody — cannot pass. That is the
 * R89 lesson applied to scoping instead of retirement.
 */
describe.skipIf(!dbUp)('a second tenant naming the first tenant’s rows', () => {
  let ctx: TestApp;
  let app: FastifyInstance;

  /** Firm A: owns everything created in beforeAll. */
  let owner: Awaited<ReturnType<typeof seedUser>>;
  /** Firm B: a legitimate, signed-in, entirely unrelated account. */
  let stranger: Awaited<ReturnType<typeof seedUser>>;
  let ownerPartnerId: string;
  let strangerPartnerId: string;

  const ids = {
    organization: '',
    savedView: '',
    comment: '',
    valuation: '',
    partnerToken: '',
    personalToken: '',
    intakeLink: '',
    invoice: '',
  };

  const as = (
    who: { token: string },
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: authHeader(who.token),
      ...(payload === undefined ? {} : { payload }),
    });

  beforeAll(async () => {
    ctx = await setupTestApp({ EMAIL_MODE: 'off' });
    app = ctx.app;

    ownerPartnerId = await seedPartner(ctx, 'Tenant A Advisors');
    strangerPartnerId = await seedPartner(ctx, 'Tenant B Advisors');
    owner = await seedUser(ctx, { roles: ['partner'], partnerId: ownerPartnerId });
    stranger = await seedUser(ctx, { roles: ['partner'], partnerId: strangerPartnerId });

    // ── Firm A's rows ──────────────────────────────────────────────────────
    const org = await as(owner, 'POST', '/api/v1/organizations', { name: 'A Holdings' });
    expect(org.statusCode, org.body).toBe(201);
    ids.organization = org.json().organization.id;

    const view = await as(owner, 'POST', '/api/v1/saved-views', {
      name: 'A queue',
      query: 'state=pending',
    });
    expect(view.statusCode, view.body).toBe(201);
    ids.savedView = view.json().view.id;

    const valuation = await as(owner, 'POST', '/api/v1/valuations', {
      kind: '409a',
      company_name: 'A Portfolio Co',
    });
    expect(valuation.statusCode, valuation.body).toBe(201);
    ids.valuation = valuation.json().valuation.id;

    const comment = await as(owner, 'POST', `/api/v1/valuations/${ids.valuation}/comments`, {
      kind: 'chat',
      body: 'A private thread.',
    });
    expect(comment.statusCode, comment.body).toBe(201);
    ids.comment = comment.json().comment.id;

    const partnerToken = await as(owner, 'POST', `/api/v1/partners/${ownerPartnerId}/tokens`, {
      name: 'A integration',
    });
    expect(partnerToken.statusCode, partnerToken.body).toBe(201);
    ids.partnerToken = partnerToken.json().token.id;

    // Re-authenticated since R185; the password is `seedUser`'s.
    const personalToken = await as(owner, 'POST', '/api/v1/me/tokens', {
      name: 'A personal',
      current_password: 'test-password-123',
    });
    expect(personalToken.statusCode, personalToken.body).toBe(201);
    ids.personalToken = personalToken.json().token.id;

    const link = await as(owner, 'POST', '/api/v1/firm/intake-links', {
      client_name: 'A Prospect',
      client_email: 'prospect@a.example.com',
    });
    expect(link.statusCode, link.body).toBe(201);
    ids.intakeLink = link.json().link.id;

    // Invoices are written by the billing pipeline, not by a route, so this one
    // is seeded directly — what matters here is that a row exists with firm A's
    // user on it.
    const { rows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO invoices (id, user_id, number, amount_cents, currency, status, issued_at, line_items)
       VALUES ($1, $2, 'INV-XT-1', 100000, 'usd', 'paid', now(), '[]'::jsonb)
       RETURNING id`,
      [newUlid(), owner.id],
    );
    ids.invoice = rows[0]!.id;
  }, 120_000);

  afterAll(async () => ctx?.teardown());

  /**
   * `METHOD url` for firm B, the status it must get, and the same request the
   * owner makes to prove the route works at all.
   *
   * Written as one table rather than a case each because the value is in the
   * breadth: every resource on the non-valuation id-keyed surface that a second
   * tenant can name, asked the same question the same way.
   */
  type Probe = {
    name: string;
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    url: () => string;
    payload?: () => unknown;
    /** 404 unless the route deliberately discloses the refusal — see the header. */
    expected?: number;
    /** Why a 403 is right here. Required whenever `expected` is 403. */
    disclosureReason?: string;
    /** Status the owner gets, proving the request is well-formed and routed. */
    ownerExpected: number | number[];
  };

  const probes: Probe[] = [
    {
      name: 'read an organization',
      method: 'GET',
      url: () => `/api/v1/organizations/${ids.organization}`,
      ownerExpected: 200,
    },
    {
      name: 'rename an organization',
      method: 'PATCH',
      url: () => `/api/v1/organizations/${ids.organization}`,
      payload: () => ({ name: 'Renamed by a stranger' }),
      ownerExpected: 200,
    },
    {
      name: 'read a consolidated roll-up',
      method: 'GET',
      url: () => `/api/v1/organizations/${ids.organization}/consolidated`,
      ownerExpected: 200,
    },
    {
      name: 'move an engagement into an organization',
      method: 'POST',
      url: () => `/api/v1/organizations/${ids.organization}/entities`,
      payload: () => ({ valuation_id: ids.valuation }),
      ownerExpected: 204,
    },
    {
      name: 'edit a saved view',
      method: 'PATCH',
      url: () => `/api/v1/saved-views/${ids.savedView}`,
      payload: () => ({ name: 'Taken over' }),
      ownerExpected: 200,
    },
    {
      name: 'delete a saved view',
      method: 'DELETE',
      url: () => `/api/v1/saved-views/${ids.savedView}`,
      ownerExpected: 204,
    },
    {
      name: 'edit a comment on another firm’s engagement',
      method: 'PATCH',
      url: () => `/api/v1/comments/${ids.comment}`,
      payload: () => ({ body: 'Rewritten by a stranger' }),
      ownerExpected: 200,
    },
    {
      name: 'delete a comment on another firm’s engagement',
      method: 'DELETE',
      url: () => `/api/v1/comments/${ids.comment}`,
      ownerExpected: 204,
    },
    {
      name: 'revoke another firm’s API token',
      method: 'DELETE',
      url: () => `/api/v1/api-tokens/${ids.partnerToken}`,
      ownerExpected: 204,
    },
    {
      name: 'revoke another user’s personal token',
      method: 'DELETE',
      url: () => `/api/v1/me/tokens/${ids.personalToken}`,
      ownerExpected: 204,
    },
    {
      name: 'read another firm’s intake questionnaire',
      method: 'GET',
      url: () => `/api/v1/firm/intake-links/${ids.intakeLink}`,
      ownerExpected: 200,
    },
    {
      name: 'withdraw another firm’s intake link',
      method: 'DELETE',
      url: () => `/api/v1/firm/intake-links/${ids.intakeLink}`,
      ownerExpected: 204,
    },
    {
      name: 'download another user’s invoice PDF',
      method: 'GET',
      url: () => `/api/v1/billing/invoices/${ids.invoice}/pdf`,
      ownerExpected: 200,
    },
    {
      name: 'list another firm’s API tokens',
      method: 'GET',
      url: () => `/api/v1/partners/${ownerPartnerId}/tokens`,
      expected: 403,
      disclosureReason:
        'the partner id is in the URL and a firm user already knows their own; refusing by name says ' +
        'nothing about whether that firm holds tokens',
      ownerExpected: 200,
    },
    {
      name: 'mint a token against another firm',
      method: 'POST',
      url: () => `/api/v1/partners/${ownerPartnerId}/tokens`,
      payload: () => ({ name: 'stolen' }),
      expected: 403,
      disclosureReason: 'same as the listing above — the refusal is about the caller, not about the row',
      ownerExpected: 201,
    },
    {
      name: 'read another firm’s branding settings',
      method: 'GET',
      url: () => `/api/v1/branding/settings?partner_id=${ownerPartnerId}`,
      expected: 403,
      disclosureReason:
        'canManageBranding refuses by tenancy rather than by row; every firm’s brand is already public ' +
        'on its own login page',
      ownerExpected: 200,
    },
    {
      name: 'edit another firm’s branding',
      method: 'PATCH',
      url: () => `/api/v1/branding?partner_id=${ownerPartnerId}`,
      payload: () => ({ brand_name: 'Repainted' }),
      expected: 403,
      disclosureReason: 'same predicate as the read above',
      ownerExpected: 200,
    },
  ];

  it('covers every resource the scope census found a second tenant for', () => {
    // The list is the test. A resource dropping out of it is a surface that
    // stopped being asked, and nothing else would notice.
    const covered = new Set(probes.map((p) => p.url().split('?')[0]!.split('/').slice(0, 4).join('/')));
    for (const collection of [
      '/api/v1/organizations',
      '/api/v1/saved-views',
      '/api/v1/comments',
      '/api/v1/api-tokens',
      '/api/v1/me',
      '/api/v1/firm',
      '/api/v1/billing',
      '/api/v1/partners',
      '/api/v1/branding',
    ]) {
      expect([...covered], collection).toContain(collection);
    }
  });

  it('refuses firm B every one of them', async () => {
    const served: string[] = [];
    for (const probe of probes) {
      const payload = probe.payload?.();
      const res = await as(stranger, probe.method, probe.url(), payload);
      const expected = probe.expected ?? 404;
      if (res.statusCode !== expected) {
        served.push(`${probe.name}: expected ${expected}, got ${res.statusCode} ${res.body.slice(0, 100)}`);
      }
    }
    expect(served).toEqual([]);
  }, 120_000);

  it('every 403 in that table says why it is not a 404', () => {
    // The exemption contract the rest of this service uses: a route that
    // discloses the row exists has to have written down what makes that safe.
    for (const probe of probes.filter((p) => p.expected === 403)) {
      expect(probe.disclosureReason, probe.name).toBeTruthy();
    }
    // …and the default is the other way round, so a new probe added without an
    // opinion is asserted to 404.
    expect(probes.filter((p) => p.expected === undefined).length).toBeGreaterThan(10);
  });

  /**
   * The half that makes the refusals mean something.
   *
   * Runs last, because several of these probes are destructive — the owner
   * deleting their own saved view, comment, tokens and intake link is the
   * proof that the route works, and it is also the end of those fixtures.
   */
  it('serves the owner the same requests, so the refusals are scoping', async () => {
    const broken: string[] = [];
    for (const probe of probes) {
      const payload = probe.payload?.();
      const res = await as(owner, probe.method, probe.url(), payload);
      const allowed = Array.isArray(probe.ownerExpected) ? probe.ownerExpected : [probe.ownerExpected];
      if (!allowed.includes(res.statusCode)) {
        broken.push(
          `${probe.name}: owner expected ${allowed.join('/')}, got ${res.statusCode} ${res.body.slice(0, 140)}`,
        );
      }
    }
    expect(broken).toEqual([]);
  }, 120_000);
});
