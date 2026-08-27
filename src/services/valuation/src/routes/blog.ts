import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { calendarDate } from '../domain/calendarRange.js';
import type { AdminEventType } from '../domain/auditTrail.js';
import { conditionalJson, isUlid, problems, TtlCache } from '@n409/shared';
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

/**
 * The longest a slug may be, which is not this layer's choice to make.
 *
 * A slug is a path parameter, and fastify's router refuses to match one longer
 * than `maxParamLength` — 100 by default, which nothing here overrides. The
 * writer used to allow 120, so a slug of 101 to 120 characters was accepted,
 * stored, and listed on the index, and then answered 414 at its own URL: a
 * post that existed everywhere except the address it was published at, on the
 * ops preview too. Nothing in production is near it (the longest is 58), so
 * the cap moves down to what the router can actually serve rather than the
 * router being widened for every route to suit this one.
 */
const SLUG_MAX = 100;

/**
 * What a slug may be — used both to validate an author's input and to reject a
 * reader's, which is why it is a constant rather than an inline shape.
 *
 * The read guard must never be stricter than the write rule, or a post that
 * was legitimately created becomes unreachable at its own URL. Deriving both
 * from this one schema is what makes that true by construction instead of by
 * two regexes agreeing today. It matches the table's own
 * `CHECK (slug ~ '^[a-z0-9-]+$')`; the length cap is {@link SLUG_MAX}.
 */
const Slug = z
  .string()
  .min(1)
  .max(SLUG_MAX)
  .regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and dashes only');

const PostBody = z.object({
  slug: Slug,
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
  published_at: calendarDate().nullable().default(null),
});

const PatchBody = PostBody.partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'empty patch',
  });

/**
 * Reading time in whole minutes, at 220 words a minute.
 *
 * Derived here rather than stored, because it is a function of the body and a
 * stored copy is one an edit can leave behind. It is on the summary as well as
 * the article, which is the whole reason it is computed server-side: the index
 * deliberately does not carry `body_html`, so the page has nothing to count.
 *
 * Counted with a scan rather than `replace(/<[^>]*>/g, ' ')`. That tail runs to
 * the end of the input from every `<` when there is no `>` left, which is the
 * quadratic shape `domain/report.ts` documents at length after it cost 2.3
 * seconds of a single-process service on one 100KB body. A body is authored
 * HTML that has already been sanitised, so it is unlikely to hold that shape —
 * but "unlikely" is not a reason to reintroduce the pattern.
 */
function readMinutes(html: string): number {
  let words = 0;
  let inTag = false;
  let inWord = false;
  for (let i = 0; i < html.length; i++) {
    const c = html[i]!;
    if (inTag) {
      if (c === '>') inTag = false;
      continue;
    }
    if (c === '<') {
      inTag = true;
      inWord = false;
    } else if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      words++;
    }
  }
  return Math.max(1, Math.round(words / 220));
}

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
    read_minutes: readMinutes(post.body_html),
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

  // Anonymous, identical for every caller, so a shared cache may hold it —
  // hence `public` rather than the `private` default. Still `no-cache`: an
  // author who publishes a correction expects it live on the next request,
  // and revalidation costs one conditional round trip, not a re-download.
  const PUBLIC_REVALIDATE = { cacheControl: 'public, no-cache' };

  app.get('/api/v1/blog/posts', async (req, reply) => {
    const posts = (await cache.getOrLoad('list:published', () =>
      listPosts(deps.pool, { includeDrafts: false }),
    )) as BlogPostRow[];
    return conditionalJson(req, reply, { posts: posts.map(toSummary) }, PUBLIC_REVALIDATE);
  });

  app.get('/api/v1/blog/posts/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    // A slug that could not name a post does not get to ask the database
    // whether it does. This route is anonymous and caches its misses under the
    // caller's own string, so without this every made-up path is a query and a
    // cache entry; with it, anything that is not slug-shaped costs a regex.
    // The same guard `/public/branding/:key` has always had, for the same
    // reason — and a 404 rather than a 422, because the caller asked for a URL
    // that names nothing, which is not a malformed request but a missing page.
    if (!Slug.safeParse(slug).success) throw problems.notFound();
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
    return conditionalJson(req, reply, { post: toPublic(post) }, PUBLIC_REVALIDATE);
  });

  // ── Authoring (ops-only, audited) ────────────────────────────────────────

  const requireOps = (req: Parameters<typeof requirePrincipal>[0]) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('The blog is operations-only');
    return principal;
  };

  const audit = async (actorId: string, type: AdminEventType, post: BlogPostRow) => {
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
