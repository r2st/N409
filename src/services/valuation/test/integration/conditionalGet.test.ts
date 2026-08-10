import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * ETag / If-None-Match on the two read-heavy content endpoints.
 *
 * `TtlCache` already keeps repeated reads off Postgres, but the identical
 * bytes were still serialized and sent every time: the HelpWidget refetches
 * the article list on every page mount, and the blog index is hit by anonymous
 * traffic and crawlers. These tests pin the validator round trip *and* that a
 * write still becomes visible — a cache whose invalidation is broken is worse
 * than no cache, and an ETag makes that failure mode invisible for longer.
 */
describe.skipIf(!dbUp)('conditional GET on cached content endpoints', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let reader: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    reader = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  describe('help articles', () => {
    const url = '/api/v1/help/articles';

    it('returns an ETag and a revalidating Cache-Control', async () => {
      const res = await ctx.app.inject({ method: 'GET', url, headers: authHeader(reader.token) });
      expect(res.statusCode).toBe(200);
      expect(res.headers.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
      expect(res.headers['cache-control']).toBe('private, no-cache');
    });

    it('answers a repeat request holding the validator with a bodyless 304', async () => {
      const first = await ctx.app.inject({ method: 'GET', url, headers: authHeader(reader.token) });
      const second = await ctx.app.inject({
        method: 'GET',
        url,
        headers: { ...authHeader(reader.token), 'if-none-match': first.headers.etag as string },
      });

      expect(second.statusCode).toBe(304);
      expect(second.body).toBe('');
    });

    it('still requires authentication — a validator is not a credential', async () => {
      const first = await ctx.app.inject({ method: 'GET', url, headers: authHeader(reader.token) });
      const res = await ctx.app.inject({
        method: 'GET',
        url,
        headers: { 'if-none-match': first.headers.etag as string },
      });
      expect(res.statusCode).toBe(401);
    });

    it('gives ops and non-ops different validators, since they see different lists', async () => {
      // Ops see unpublished drafts; a shared ETag would let one 304 into the
      // other's cached copy if any shared cache ever honoured it.
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/help/articles',
        headers: authHeader(ops.token),
        payload: {
          slug: 'etag-draft',
          title: 'Draft only ops can see',
          body_html: '<p>hidden</p>',
          published: false,
        },
      });

      const opsRes = await ctx.app.inject({ method: 'GET', url, headers: authHeader(ops.token) });
      const readerRes = await ctx.app.inject({
        method: 'GET',
        url,
        headers: authHeader(reader.token),
      });
      expect(opsRes.headers.etag).not.toBe(readerRes.headers.etag);
    });

    it('sends a fresh body after a write, rather than a stale 304', async () => {
      const before = await ctx.app.inject({ method: 'GET', url, headers: authHeader(reader.token) });

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/help/articles',
        headers: authHeader(ops.token),
        payload: {
          slug: 'etag-published',
          title: 'Now visible to everyone',
          body_html: '<p>body</p>',
          published: true,
        },
      });
      expect([200, 201]).toContain(created.statusCode);

      const after = await ctx.app.inject({
        method: 'GET',
        url,
        headers: { ...authHeader(reader.token), 'if-none-match': before.headers.etag as string },
      });

      expect(after.statusCode).toBe(200);
      expect(after.headers.etag).not.toBe(before.headers.etag);
      expect(JSON.stringify(after.json())).toContain('Now visible to everyone');
    });
  });

  describe('blog', () => {
    const url = '/api/v1/blog/posts';

    it('marks the anonymous index as shared-cacheable but revalidating', async () => {
      const res = await ctx.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('public, no-cache');
      expect(res.headers.etag).toBeDefined();
    });

    it('304s the index for a client that already has it', async () => {
      const first = await ctx.app.inject({ method: 'GET', url });
      const second = await ctx.app.inject({
        method: 'GET',
        url,
        headers: { 'if-none-match': first.headers.etag as string },
      });
      expect(second.statusCode).toBe(304);
      expect(second.body).toBe('');
    });

    it('revalidates a single post, and refreshes it when the author edits', async () => {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/blog/posts',
        headers: authHeader(ops.token),
        payload: {
          slug: 'etag-post',
          title: 'First title',
          body_html: '<p>hello</p>',
          published: true,
        },
      });
      expect([200, 201]).toContain(created.statusCode);
      const id = created.json().post.id as string;

      const postUrl = '/api/v1/blog/posts/etag-post';
      const before = await ctx.app.inject({ method: 'GET', url: postUrl });
      expect(before.statusCode).toBe(200);

      const unchanged = await ctx.app.inject({
        method: 'GET',
        url: postUrl,
        headers: { 'if-none-match': before.headers.etag as string },
      });
      expect(unchanged.statusCode).toBe(304);

      const patched = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/blog/posts/${id}`,
        headers: authHeader(ops.token),
        payload: { title: 'Corrected title' },
      });
      expect(patched.statusCode).toBe(200);

      // An author who publishes a correction expects it live on the next
      // request — the validator must not outlive the content it describes.
      const after = await ctx.app.inject({
        method: 'GET',
        url: postUrl,
        headers: { 'if-none-match': before.headers.etag as string },
      });
      expect(after.statusCode).toBe(200);
      expect(after.json().post.title).toBe('Corrected title');
    });
  });
});
