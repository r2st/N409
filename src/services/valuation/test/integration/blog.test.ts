import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The marketing blog (design §16.2, P2-20).
 *
 * The two properties worth defending are the public/private boundary — an
 * anonymous reader gets published posts and nothing else, ever — and the
 * publication date, which is what a reader and a crawler both judge an article
 * by and which a later edit must not move.
 */
describe.skipIf(!dbUp)('marketing blog', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  const create = async (body: Record<string, unknown>, token = admin.token) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/blog/posts',
      headers: authHeader(token),
      payload: body,
    });

  const patch = async (id: string, body: Record<string, unknown>, token = admin.token) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/blog/posts/${id}`,
      headers: authHeader(token),
      payload: body,
    });

  const publicList = async () => ctx.app.inject({ method: 'GET', url: '/api/v1/blog/posts' });
  const publicPost = async (slug: string) =>
    ctx.app.inject({ method: 'GET', url: `/api/v1/blog/posts/${slug}` });

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  describe('the seeded first post', () => {
    it('makes /blog a page rather than an empty state on day one', async () => {
      const res = await publicList();
      expect(res.statusCode).toBe(200);
      const posts = res.json().posts as Array<{ slug: string; published: boolean }>;
      expect(posts.some((p) => p.slug === 'what-a-409a-valuation-actually-defends')).toBe(true);
      expect(posts.every((p) => p.published)).toBe(true);
    });
  });

  describe('public reading', () => {
    it('needs no session at all', async () => {
      // Not "authentication that usually fails" — genuinely none, so nothing
      // in front of us can cache a signed-in response for a stranger.
      expect((await publicList()).statusCode).toBe(200);
      expect((await publicPost('what-a-409a-valuation-actually-defends')).statusCode).toBe(200);
    });

    it('omits the body from the index', async () => {
      const posts = (await publicList()).json().posts as Array<Record<string, unknown>>;
      expect(posts[0]).not.toHaveProperty('body_html');
      expect(posts[0]).toHaveProperty('excerpt');
    });

    it('serves the body on the article itself', async () => {
      const post = (await publicPost('what-a-409a-valuation-actually-defends')).json().post as {
        body_html: string;
        author: string;
      };
      expect(post.body_html).toContain('<p>');
      expect(post.author).toBe('The N409 team');
    });

    it('never exposes who edited the row', async () => {
      const res = await publicPost('what-a-409a-valuation-actually-defends');
      expect(res.body).not.toMatch(/author_id/);
      expect(res.body).not.toMatch(/updated_at/);
    });

    it('404s an unknown slug', async () => {
      expect((await publicPost('no-such-post')).statusCode).toBe(404);
    });
  });

  describe('drafts', () => {
    let draftId: string;

    it('are created unpublished and stay off the public index', async () => {
      const res = await create({
        slug: 'a-draft-in-progress',
        title: 'A draft in progress',
        body_html: '<p>Not finished.</p>',
        published: false,
      });
      expect(res.statusCode, res.body).toBe(201);
      draftId = res.json().post.id;

      const posts = (await publicList()).json().posts as Array<{ slug: string }>;
      expect(posts.map((p) => p.slug)).not.toContain('a-draft-in-progress');
      expect((await publicPost('a-draft-in-progress')).statusCode).toBe(404);
    });

    it('carry no publication date until they are published', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/blog/posts',
        headers: authHeader(admin.token),
      });
      const draft = (res.json().posts as Array<{ id: string; published_at: string | null }>).find(
        (p) => p.id === draftId,
      );
      expect(draft?.published_at).toBeNull();
    });

    it('are previewable by ops at their real slug, and by nobody else', async () => {
      const preview = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/blog/posts/a-draft-in-progress',
        headers: authHeader(admin.token),
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().post.published).toBe(false);

      const refused = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/blog/posts/a-draft-in-progress',
        headers: authHeader(client.token),
      });
      expect(refused.statusCode).toBe(403);
    });

    it('appear the moment they are published, cache notwithstanding', async () => {
      // The public list is cached; a write has to clear it, or an author
      // refreshing the live page concludes publishing did not work.
      expect((await patch(draftId, { published: true })).statusCode).toBe(200);
      const posts = (await publicList()).json().posts as Array<{ slug: string }>;
      expect(posts.map((p) => p.slug)).toContain('a-draft-in-progress');
      expect((await publicPost('a-draft-in-progress')).statusCode).toBe(200);
    });
  });

  describe('the publication date', () => {
    it('is stamped on first publish', async () => {
      const res = await create({
        slug: 'dated-on-publish',
        title: 'Dated on publish',
        body_html: '<p>Body.</p>',
        published: true,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().post.published_at).not.toBeNull();
    });

    it('survives a later edit — a typo fixed in March does not re-date January', async () => {
      const created = (
        await create({
          slug: 'stable-date',
          title: 'Stable date',
          body_html: '<p>Body.</p>',
          published: true,
        })
      ).json().post as { id: string; published_at: string };

      const edited = (await patch(created.id, { title: 'Stable date, corrected' })).json().post as {
        published_at: string;
      };
      expect(edited.published_at).toBe(created.published_at);
    });

    it('survives an unpublish and re-publish', async () => {
      // Otherwise correcting a live post re-dates it and reorders the index
      // for every crawler that had already indexed it.
      const created = (
        await create({
          slug: 'unpublish-cycle',
          title: 'Unpublish cycle',
          body_html: '<p>Body.</p>',
          published: true,
        })
      ).json().post as { id: string; published_at: string };

      await patch(created.id, { published: false });
      const back = (await patch(created.id, { published: true })).json().post as {
        published_at: string;
      };
      expect(back.published_at).toBe(created.published_at);
    });

    it('accepts an explicit date, for a migrated article', async () => {
      const res = await create({
        slug: 'back-dated',
        title: 'Back dated',
        body_html: '<p>Body.</p>',
        published: true,
        published_at: '2024-03-01T00:00:00.000Z',
      });
      expect(new Date(res.json().post.published_at).toISOString()).toBe('2024-03-01T00:00:00.000Z');
    });
  });

  describe('authoring', () => {
    it('sanitises the body with the report-content policy', async () => {
      const res = await create({
        slug: 'sanitised',
        title: 'Sanitised',
        body_html: '<p>Fine.</p><script>alert(1)</script><img src=x onerror="alert(1)">',
        published: true,
      });
      expect(res.statusCode).toBe(201);
      const body = res.json().post.body_html as string;
      expect(body).toContain('Fine.');
      expect(body).not.toMatch(/<script/i);
      expect(body).not.toMatch(/onerror/i);
    });

    it('refuses a slug that is not URL-safe', async () => {
      const res = await create({
        slug: 'Not A Slug',
        title: 'Bad slug',
        body_html: '<p>x</p>',
      });
      expect(res.statusCode).toBe(422);
    });

    it('refuses a duplicate slug rather than shadowing a live URL', async () => {
      const res = await create({
        slug: 'dated-on-publish',
        title: 'Collision',
        body_html: '<p>x</p>',
      });
      expect(res.statusCode).toBe(409);
    });

    it('refuses a card image that is not an https URL or a site path', async () => {
      // og:image is a brand-controlled field; an unvalidated one points the
      // link card wherever the author typed.
      const res = await create({
        slug: 'bad-image',
        title: 'Bad image',
        body_html: '<p>x</p>',
        og_image: 'javascript:alert(1)',
      });
      expect(res.statusCode).toBe(422);
      expect(
        (
          await create({
            slug: 'good-image',
            title: 'Good image',
            body_html: '<p>x</p>',
            og_image: '/og/post.png',
          })
        ).statusCode,
      ).toBe(201);
    });

    it('is operations-only', async () => {
      expect(
        (await create({ slug: 'nope', title: 'Nope', body_html: '<p>x</p>' }, client.token)).statusCode,
      ).toBe(403);
      const list = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/blog/posts',
        headers: authHeader(client.token),
      });
      expect(list.statusCode).toBe(403);
    });

    it('records the write on the admin trail', async () => {
      const { rows } = await ctx.pool.query(
        `SELECT type, subject_label FROM admin_events
          WHERE subject_type = 'blog_post' ORDER BY id DESC LIMIT 1`,
      );
      expect(rows[0]?.type).toMatch(/^blog_post_/);
    });

    it('deletes a post and takes it off the public index', async () => {
      const created = (
        await create({
          slug: 'to-be-deleted',
          title: 'To be deleted',
          body_html: '<p>x</p>',
          published: true,
        })
      ).json().post as { id: string };

      const res = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/blog/posts/${created.id}`,
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(204);
      expect((await publicPost('to-be-deleted')).statusCode).toBe(404);
    });
  });
});
