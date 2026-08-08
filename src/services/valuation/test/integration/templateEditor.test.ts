import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Email/SMS template editing (409.ai §14) — categories, the variable palette,
 * and preview against a real engagement.
 */
describe.skipIf(!dbUp)('communication template editor', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const createTemplate = async (payload: Record<string, unknown>) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/communication-templates',
      headers: authHeader(admin.token),
      payload,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().template as { id: string; key: string; category: string };
  };

  const list = async (query = '') => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/admin/communication-templates${query}`,
      headers: authHeader(admin.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      templates: Array<{ key: string; category: string; unknown_variables: string[] }>;
      categories: Array<{ key: string; label: string; count: number }>;
    };
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '718', company_name: 'Preview Industries Incorporated' },
    });
    valuationId = created.json().valuation.id;
    await ctx.pool.query('UPDATE valuations SET due_date = $2 WHERE id = $1', [valuationId, '2026-09-30']);
    await ctx.pool.query(
      `UPDATE valuation_params SET engine_inputs = '{"valuation_date":"2026-08-07"}'::jsonb
       WHERE valuation_id = $1`,
      [valuationId],
    );
  });
  afterAll(async () => ctx?.teardown());

  describe('categories', () => {
    it('defaults a new template to account and stores what is asked for', async () => {
      const account = await createTemplate({ key: 'welcome_note', body: 'Hi', subject: 'Hi' });
      expect(account.category).toBe('account');

      const drafted = await createTemplate({
        key: 'send_draft',
        subject: 'Your draft',
        body: 'Draft attached.',
        category: 'drafted',
      });
      expect(drafted.category).toBe('drafted');
    });

    it('groups the list by category, in lifecycle order', async () => {
      await createTemplate({ key: 'final_report', subject: 'Final', body: 'x', category: 'published' });
      const body = await list();
      const order = body.templates.map((t) => t.category);
      // 'account' rows come before 'drafted' before 'published' — the order an
      // engagement passes through, not alphabetical.
      expect(order.indexOf('account')).toBeLessThan(order.indexOf('drafted'));
      expect(order.indexOf('drafted')).toBeLessThan(order.indexOf('published'));
    });

    it('returns per-category counts for the tab strip', async () => {
      const body = await list();
      expect(body.categories.map((c) => c.key)).toEqual([
        'account',
        'open',
        'in_review',
        'drafted',
        'published',
        'closed',
      ]);
      const counts = Object.fromEntries(body.categories.map((c) => [c.key, c.count]));
      expect(counts.drafted).toBe(body.templates.filter((t) => t.category === 'drafted').length);
      expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(body.templates.length);
    });

    it('backfills the seeded workflow templates to the state that sends them', async () => {
      // 0113's backfill, checked against a migrated database rather than
      // asserted from the migration's own SQL.
      const all = await list();
      const byKey = Object.fromEntries(all.templates.map((t) => [t.key, t.category]));
      expect(byKey.valuation_started).toBe('open');
      expect(byKey.review_needed).toBe('in_review');
      expect(byKey.draft_ready).toBe('drafted');
      expect(byKey.valuation_completed).toBe('published');
      expect(byKey.valuation_cancelled).toBe('closed');
      // Not about an engagement at all, so no lifecycle state gates it.
      // Drip templates and the account emails alike: nothing in the RULES map
      // sends them on a transition, so they stay on the default.
      expect(byKey.welcome).toBe('account');
      expect(byKey.intake_reminder).toBe('account');
    });

    it('filters to one category', async () => {
      const body = await list('?category=published');
      expect(body.templates.map((t) => t.key)).toContain('final_report');
      expect(body.templates.every((t) => t.category === 'published')).toBe(true);
    });

    it('recategorises on patch', async () => {
      const t = await createTemplate({ key: 'nudge', subject: 'Nudge', body: 'x' });
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/communication-templates/${t.id}`,
        headers: authHeader(admin.token),
        payload: { category: 'open' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().template.category).toBe('open');
    });

    it('rejects a category that is not one of the six', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/communication-templates',
        headers: authHeader(admin.token),
        payload: { key: 'bad_cat', subject: 's', body: 'b', category: 'incomplete' },
      });
      expect(res.statusCode).toBe(422);
    });
  });

  describe('variable palette', () => {
    it('serves the catalog so the editor and the renderer cannot drift', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/communication-templates/variables',
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(200);
      const names = (res.json().variables as Array<{ name: string; scope: string }>).map((v) => v.name);
      expect(names).toContain('company_name');
      expect(names).toContain('payment_link');
    });

    it('is operations-only', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/communication-templates/variables',
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(403);
    });

    it('flags a misspelled variable on the listing, without refusing the save', async () => {
      // renderTemplate leaves an unknown name verbatim at send time, and the
      // first report of that used to be the client who received it.
      await createTemplate({ key: 'typo_template', subject: 'Hi {{company_nmae}}', body: 'x' });
      const body = await list();
      const row = body.templates.find((t) => t.key === 'typo_template')!;
      expect(row.unknown_variables).toEqual(['company_nmae']);
    });
  });

  describe('preview', () => {
    let templateId: string;
    beforeAll(async () => {
      const t = await createTemplate({
        key: 'preview_me',
        subject: 'Your {{kind_label}} for {{company_name}}',
        body: 'Measured as of {{valuation_date}}, due {{due_date}}. State: {{state_label}}. Questions: {{support_email}}',
        category: 'open',
      });
      templateId = t.id;
    });

    const preview = async (payload: Record<string, unknown> = {}) => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/admin/communication-templates/${templateId}/preview`,
        headers: authHeader(admin.token),
        payload,
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as { subject: string; body: string; unknown_variables: string[] };
    };

    it('renders from the catalog samples when given nothing', async () => {
      const out = await preview();
      expect(out.subject).toBe('Your 409A for Acme Corp');
      expect(out.body).not.toMatch(/\{\{/);
    });

    it('renders against a real engagement when given one', async () => {
      // A template reads fine against "Acme Corp" and falls apart against a
      // company whose legal name runs to sixty characters.
      const out = await preview({ valuation_id: valuationId });
      expect(out.subject).toBe('Your 718 for Preview Industries Incorporated');
      expect(out.body).toContain('Measured as of 2026-08-07');
      expect(out.body).toContain('due 2026-09-30');
      expect(out.body).toContain('State: Pending');
    });

    it('fills a variable the engagement cannot answer from the samples', async () => {
      // Rather than leaving braces mid-sentence for a variable that simply is
      // not a property of a valuation row.
      const out = await preview({ valuation_id: valuationId });
      expect(out.body).toContain('Questions: support@n409.local');
    });

    it('previews unsaved editor content without touching the stored row', async () => {
      const out = await preview({ body: 'Draft body for {{company_name}}' });
      expect(out.body).toBe('Draft body for Acme Corp');
      // The subject falls back to the stored one, so a body edit does not
      // blank it.
      expect(out.subject).toBe('Your 409A for Acme Corp');

      const stored = await list('?category=open');
      expect(stored.templates.find((t) => t.key === 'preview_me')).toBeTruthy();
    });

    it('lets explicit vars win over both the engagement and the samples', async () => {
      const out = await preview({ valuation_id: valuationId, vars: { company_name: 'Override Ltd' } });
      expect(out.subject).toContain('Override Ltd');
    });

    it('reports unknown variables alongside the render', async () => {
      const out = await preview({ body: 'Hello {{not_a_thing}}' });
      expect(out.unknown_variables).toEqual(['not_a_thing']);
      expect(out.body).toBe('Hello {{not_a_thing}}');
    });

    it('404s a preview against an engagement that does not exist', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/admin/communication-templates/${templateId}/preview`,
        headers: authHeader(admin.token),
        payload: { valuation_id: '01JQZZZZZZZZZZZZZZZZZZZZZZ' },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
