import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems, TtlCache } from '@n409/shared';
import { isOps } from '../auth/rbac.js';
import { sanitizeHtml } from '../domain/report.js';
import {
  createPost,
  deletePost,
  findPostById,
  findPostBySlug,
  listPosts,
  updatePost,
  type BlogPostRow,
} from '../repos/blogPosts.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * The marketing blog (design §16.2, P2-20).
 *
 * The reading half is **unauthenticated**, unlike the help centre it is shaped
 * on. That is the whole point of a blog: it is a public marketing surface a
 * search engine and a stranger both have to be able to read. So the public
 * endpoints serve published posts only, and they serve a *projection* rather
 * than the row — an author's user id and the row's edit history are not part
 * of an article, and a public endpoint that returns the whole row is how they
 * end up in a page's JSON payload.
 *
 * Drafts are served only from the admin endpoints. The public routes carry no
 * authentication at all — not "authentication that usually fails" — because a
 * public endpoint whose response depends on a session is a public endpoint
 * that can be cached wrong, by us or by anything in front of us. A writer
 * previews an unpublished post through `/admin/blog/posts/:slug`, which the
 * blog page falls back to when it is signed in as ops and the public read
 * 404s; the same component renders it, so the preview is the real page.
 *
 * Body HTML is sanitised on write with the same policy as report content —
 * once, at the boundary, so nothing downstream has to remember to escape it.
 */

const PostBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and dashes only'),
  title: z.string().min(1).max(200),
  excerpt: z.string().max(500).default(''),
  body_html: z.string().min(1).max(200_000),
  category: z.string().min(1).max(100).default('General'),
  keywords: z.string().max(500).default(''),
  author: z.string().max(200).default(''),
  // Relative path or absolute URL to the card image. Validated as a shape
  // rather than fetched: a broken image is a bad preview, an unvalidated one
  // that reaches `og:image` is a way to point the brand's link card anywhere.
  og_image: z
    .string()
    .max(500)
    .regex(/^(https:\/\/|\/)/, 'must be an https URL or a site-relative path')
    .nullable()
    .default(null),
  published: z.boolean().default(false),
  published_at: z.coerce.date().nullable().default(null),
});

const PatchBody = PostBody.partial().refine((v) => Object.keys(v).length > 0, {
  message: 'empty patch',
});

/**
 * What a public reader gets. Everything a page needs to render and nothing
 * about who edited the row.
 */
function toPublic(post: BlogPostRow) {
  return {
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    body_html: post.body_html,
    category: post.category,
    keywords: post.keywords,
    author: post.author,
    og_image: post.og_image,
    published: post.published,
    published_at: post.published_at,
  };
}

/** The index needs everything but the body; sending it is a wasted payload. */
function toSummary(post: BlogPostRow) {
  const { body_html: _body, ...rest } = toPublic(post);
  return rest;
}

export function registerBlogRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  // Read-through cache, same reasoning as the help centre: an index page for
  // anonymous traffic, over content that changes a few times a month. Any
  // write clears it, so an author never has to wonder whether the live page
  // has caught up.
  const cache = new TtlCache<unknown>({ ttlMs: 60_000 });

  // ── Public reading (no auth) ─────────────────────────────────────────────

  app.get('/api/v1/blog/posts', async () => {
    const posts = (await cache.getOrLoad('list:published', () =>
      listPosts(deps.pool, { includeDrafts: false }),
    )) as BlogPostRow[];
    return { posts: posts.map(toSummary) };
  });

  app.get('/api/v1/blog/posts/:slug', async (req) => {
    const { slug } = req.params as { slug: string };
    const post = (await cache.getOrLoad(
      `slug:${slug}`,
      // The miss is cached too (null), so a crawler walking dead links does
      // not turn into a query per 404. A draft is cached as a miss for the
      // same reason and cleared the moment it is published.
      async () => {
        const row = await findPostBySlug(deps.pool, slug);
        return row?.published ? row : null;
      },
    )) as BlogPostRow | null;
    if (!post) throw problems.notFound();
    return { post: toPublic(post) };
  });

  // ── Authoring (ops-only, audited) ────────────────────────────────────────

  const requireOps = (req: Parameters<typeof requirePrincipal>[0]) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('The blog is operations-only');
    return principal;
  };

  const audit = async (actorId: string, type: string, post: BlogPostRow) => {
    await recordAdminEvent(deps.pool, {
      type,
      actor: { actorType: 'human', actorId },
      subjectType: 'blog_post',
      subjectId: post.id,
      subjectLabel: post.title,
      payload: { slug: post.slug, published: post.published },
    });
  };

  /** The authoring list — full rows, drafts included. */
  app.get('/api/v1/admin/blog/posts', { preHandler: app.authenticate }, async (req) => {
    requireOps(req);
    return { posts: await listPosts(deps.pool, { includeDrafts: true }) };
  });

  /**
   * Draft preview by slug. Uncached and ops-only: the point is to see the row
   * as it is right now, and a writer refreshing a preview that is up to a
   * minute stale would conclude their edit did not save.
   */
  app.get('/api/v1/admin/blog/posts/:slug', { preHandler: app.authenticate }, async (req) => {
    requireOps(req);
    const { slug } = req.params as { slug: string };
    const post = await findPostBySlug(deps.pool, slug);
    if (!post) throw problems.notFound();
    return { post: toPublic(post) };
  });

  app.post('/api/v1/admin/blog/posts', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireOps(req);
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid post', { errors: parsed.error.issues });
    if (await findPostBySlug(deps.pool, parsed.data.slug)) {
      throw problems.conflict('A post with this slug already exists');
    }

    const post = await createPost(
      deps.pool,
      { ...parsed.data, body_html: sanitizeHtml(parsed.data.body_html) },
      principal.id,
    );
    await audit(principal.id, 'blog_post_created', post);
    cache.clear();
    return reply.status(201).send({ post });
  });

  app.patch('/api/v1/admin/blog/posts/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requireOps(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const existing = await findPostById(deps.pool, id);
    if (!existing) throw problems.notFound();

    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid patch', { errors: parsed.error.issues });
    if (parsed.data.slug && parsed.data.slug !== existing.slug) {
      if (await findPostBySlug(deps.pool, parsed.data.slug)) {
        throw problems.conflict('A post with this slug already exists');
      }
    }

    const patch = { ...parsed.data };
    if (patch.body_html !== undefined) patch.body_html = sanitizeHtml(patch.body_html);
    const post = await updatePost(deps.pool, id, patch, principal.id);
    if (!post) throw problems.notFound();
    await audit(principal.id, 'blog_post_updated', post);
    cache.clear();
    return { post };
  });

  app.delete('/api/v1/admin/blog/posts/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireOps(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const existing = await findPostById(deps.pool, id);
    if (!existing) throw problems.notFound();
    await deletePost(deps.pool, id);
    await audit(principal.id, 'blog_post_deleted', existing);
    cache.clear();
    return reply.status(204).send();
  });
}
