import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Help / knowledge base (P2 #10): seeded articles, ops CRUD without a deploy,
 * publish gating for non-ops readers, server-side HTML sanitization.
 */

const dbUp = await isDbAvailable();

interface ArticleJson {
  id: string;
  slug: string;
  title: string;
  category: string;
  body_html: string;
  published: boolean;
}

describe.skipIf(!dbUp)('help articles', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  const list = async (token: string) =>
    ctx.app.inject({ method: 'GET', url: '/api/v1/help/articles', headers: authHeader(token) });

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  it('seeds the seven starter topics, readable by any signed-in user', async () => {
    const res = await list(client.token);
    expect(res.statusCode).toBe(200);
    const articles = res.json().articles as ArticleJson[];
    expect(articles).toHaveLength(7);
    expect(articles.map((a) => a.slug)).toContain('getting-started');
  });

  it('requires authentication to read', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/help/articles' });
    expect(res.statusCode).toBe(401);
  });

  it('restricts management to ops', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/help/articles',
      headers: authHeader(client.token),
      payload: { slug: 'nope', title: 'Nope', body_html: '<p>hi</p>' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('creates, edits, and serves an article without a deploy', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/help/articles',
      headers: authHeader(ops.token),
      payload: {
        slug: 'billing-faq',
        title: 'Billing FAQ',
        category: 'Billing',
        keywords: 'invoice payment receipt',
        body_html: '<p>Pay by card or invoice.</p>',
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().article.id as string;

    const fetched = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/help/articles/billing-faq',
      headers: authHeader(client.token),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().article.title).toBe('Billing FAQ');

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/help/articles/${id}`,
      headers: authHeader(ops.token),
      payload: { title: 'Billing & receipts FAQ' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().article.title).toBe('Billing & receipts FAQ');
  });

  it('rejects duplicate slugs with a conflict', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/help/articles',
      headers: authHeader(ops.token),
      payload: { slug: 'billing-faq', title: 'Duplicate', body_html: '<p>x</p>' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('sanitizes article HTML with the report-content policy', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/help/articles',
      headers: authHeader(ops.token),
      payload: {
        slug: 'xss-check',
        title: 'XSS check',
        body_html: '<p onclick="evil()">safe</p><script>alert(1)</script>',
      },
    });
    expect(res.statusCode).toBe(201);
    const html = res.json().article.body_html as string;
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).toContain('safe');
  });

  it('hides unpublished articles from non-ops in both list and detail', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/help/articles',
      headers: authHeader(ops.token),
      payload: { slug: 'draft-only', title: 'Draft', body_html: '<p>wip</p>', published: false },
    });
    expect(created.statusCode).toBe(201);

    const clientList = (await list(client.token)).json().articles as ArticleJson[];
    expect(clientList.some((a) => a.slug === 'draft-only')).toBe(false);
    const clientDetail = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/help/articles/draft-only',
      headers: authHeader(client.token),
    });
    expect(clientDetail.statusCode).toBe(404);

    // Ops see drafts (with the flag) so they can preview before publishing.
    const opsList = (await list(ops.token)).json().articles as ArticleJson[];
    expect(opsList.find((a) => a.slug === 'draft-only')?.published).toBe(false);
  });

  it('deletes an article and audits the change', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/help/articles',
      headers: authHeader(ops.token),
      payload: { slug: 'to-delete', title: 'Bye', body_html: '<p>x</p>' },
    });
    const id = created.json().article.id as string;
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/help/articles/${id}`,
      headers: authHeader(ops.token),
    });
    expect(del.statusCode).toBe(204);

    const events = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/events?scope=admin&type=help_article_deleted',
      headers: authHeader(ops.token),
    });
    const rows = events.json().events as Array<{ subject_id: string }>;
    expect(rows.some((e) => e.subject_id === id)).toBe(true);
  });
});
