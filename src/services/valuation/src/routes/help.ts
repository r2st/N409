import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { AdminEventType } from '../domain/auditTrail.js';
import { conditionalJson, isUlid, problems, TtlCache } from '@n409/shared';
import { isOps } from '../auth/rbac.js';
import { sanitizeHtml } from '../domain/report.js';
import {
  ARTICLE_PAGE_LIMIT,
  createArticle,
  deleteArticle,
  findArticleById,
  findArticleBySlug,
  listArticles,
  type HelpArticleRow,
} from '../repos/helpArticles.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { requirePrincipal } from '../plugins/auth.js';
import { updateArticle } from '../repos/helpArticles.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { nonBlankText } from '../domain/nonBlankText.js';

/**
 * Help / knowledge base (P2 #10): any signed-in user reads published
 * articles (the HelpWidget and /help section consume this); ops manage the
 * content without a deploy. Article HTML is sanitized server-side with the
 * same policy as report content.
 */

/**
 * What an article slug may be — used both to validate an author's input and to
 * reject a reader's, which is why it is a constant rather than an inline shape.
 *
 * The read guard must never be stricter than the write rule, or an article that
 * was legitimately created becomes unreachable at its own URL; deriving both
 * from this one schema is what makes that true by construction. The 100 is also
 * `maxParamLength`, which is what fastify's router will match at all.
 */
const Slug = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and dashes only');

const ArticleBody = z
  .object({
    slug: Slug,
    title: nonBlankText(1, 200),
    category: z.string().min(1).max(100).default('General'),
    keywords: z.string().max(500).default(''),
    body_html: z.string().min(1).max(50_000),
    sort_order: z.number().int().min(0).max(10_000).default(0),
    published: z.boolean().default(true),
  })
  .strict();

const PatchBody = ArticleBody.partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'empty patch',
  });

export function registerHelpRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  // Read-through cache (IMPROVEMENTS_RESEARCH §6): the HelpWidget fetches the
  // article list on every page it mounts on, for every user, against content
  // that changes at most a few times a day. Any admin write clears the whole
  // cache — 30s of cross-replica staleness on help content is acceptable.
  const cache = new TtlCache<unknown>({ ttlMs: 30_000 });

  // ── Reading (all authenticated users; drafts stay ops-only) ───────────────

  app.get('/api/v1/help/articles', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const ops = isOps(principal);
    const parsedQuery = z
      .object({ limit: z.coerce.number().int().min(1).max(ARTICLE_PAGE_LIMIT).default(ARTICLE_PAGE_LIMIT) })
      .safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      throw invalidQuery(parsedQuery.error);
    }
    const { limit } = parsedQuery.data;
    // The limit is part of the key: without it the first caller's page size is
    // served to everyone for the next 30 seconds, which is a short list to one
    // reader and somebody else's truncation flag to the next.
    const page = (await cache.getOrLoad(`list:${ops ? 'all' : 'published'}:${limit}`, () =>
      listArticles(deps.pool, { includeUnpublished: ops, limit }),
    )) as Awaited<ReturnType<typeof listArticles>>;
    // The widget refetches this on every page mount; 304 keeps that free.
    return conditionalJson(req, reply, {
      articles: page.articles,
      truncated: page.truncated,
      page_limit: ARTICLE_PAGE_LIMIT,
    });
  });

  app.get('/api/v1/help/articles/:slug', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { slug } = req.params as { slug: string };
    // A slug that could not name an article does not get to ask the database
    // whether it does — and, more to the point, does not get to put its own
    // string in the cache. Every other path parameter in this service is shape-
    // checked or enum-checked before it is used (`/blog/posts/:slug` and
    // `/public/branding/:key` carry the same guard for the same reason); this
    // one was the exception, so any signed-in caller could spend a query and a
    // cache slot per made-up path. A 404 rather than a 422, because the caller
    // asked for a URL that names nothing, which is not a malformed request but
    // a missing page.
    if (!Slug.safeParse(slug).success) throw problems.notFound();
    const article = (await cache.getOrLoad(
      `slug:${slug}`,
      async () =>
        // Cache the miss too (null), so unknown slugs don't hammer the DB.
        (await findArticleBySlug(deps.pool, slug)) ?? null,
    )) as HelpArticleRow | null;
    if (!article || (!article.published && !isOps(principal))) throw problems.notFound();
    return { article };
  });

  // ── Management (ops-only, audited) ─────────────────────────────────────────

  const requireOps = (req: Parameters<typeof requirePrincipal>[0]) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Help articles are operations-only');
    return principal;
  };

  const audit = async (actorId: string, type: AdminEventType, article: HelpArticleRow) => {
    await recordAdminEvent(deps.pool, {
      type,
      actor: { actorType: 'human', actorId },
      subjectType: 'help_article',
      subjectId: article.id,
      subjectLabel: article.title,
      payload: { slug: article.slug, published: article.published },
    });
  };

  app.post('/api/v1/admin/help/articles', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireOps(req);
    const parsed = ArticleBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid article', parsed.error);
    if (await findArticleBySlug(deps.pool, parsed.data.slug))
      throw problems.conflict('An article with this slug already exists');

    const article = await createArticle(
      deps.pool,
      { ...parsed.data, body_html: sanitizeHtml(parsed.data.body_html) },
      principal.id,
    );
    await audit(principal.id, 'help_article_created', article);
    cache.clear();
    return reply.status(201).send({ article });
  });

  app.patch('/api/v1/admin/help/articles/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requireOps(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const existing = await findArticleById(deps.pool, id);
    if (!existing) throw problems.notFound();

    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid patch', parsed.error);
    if (parsed.data.slug && parsed.data.slug !== existing.slug) {
      if (await findArticleBySlug(deps.pool, parsed.data.slug))
        throw problems.conflict('An article with this slug already exists');
    }

    const patch = { ...parsed.data };
    if (patch.body_html !== undefined) patch.body_html = sanitizeHtml(patch.body_html);
    const article = await updateArticle(deps.pool, id, patch, principal.id);
    if (!article) throw problems.notFound();
    await audit(principal.id, 'help_article_updated', article);
    cache.clear();
    return { article };
  });

  app.delete('/api/v1/admin/help/articles/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireOps(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const existing = await findArticleById(deps.pool, id);
    if (!existing) throw problems.notFound();
    // Once per removal — see `deleteOnceCensus.test.ts`. The cache is cleared
    // either way: the row is gone whichever request took it.
    const removed = await deleteArticle(deps.pool, id);
    if (removed) await audit(principal.id, 'help_article_deleted', existing);
    cache.clear();
    return reply.status(204).send();
  });
}
