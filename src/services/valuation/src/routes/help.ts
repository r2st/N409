import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems, TtlCache } from '@n409/shared';
import { isOps } from '../auth/rbac.js';
import { sanitizeHtml } from '../domain/report.js';
import {
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

/**
 * Help / knowledge base (P2 #10): any signed-in user reads published
 * articles (the HelpWidget and /help section consume this); ops manage the
 * content without a deploy. Article HTML is sanitized server-side with the
 * same policy as report content.
 */

const ArticleBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and dashes only'),
  title: z.string().min(1).max(200),
  category: z.string().min(1).max(100).default('General'),
  keywords: z.string().max(500).default(''),
  body_html: z.string().min(1).max(50_000),
  sort_order: z.number().int().min(0).max(10_000).default(0),
  published: z.boolean().default(true),
});

const PatchBody = ArticleBody.partial().refine((v) => Object.keys(v).length > 0, {
  message: 'empty patch',
});

export function registerHelpRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  // Read-through cache (IMPROVEMENTS_RESEARCH §6): the HelpWidget fetches the
  // article list on every page it mounts on, for every user, against content
  // that changes at most a few times a day. Any admin write clears the whole
  // cache — 30s of cross-replica staleness on help content is acceptable.
  const cache = new TtlCache<unknown>({ ttlMs: 30_000 });

  // ── Reading (all authenticated users; drafts stay ops-only) ───────────────

  app.get('/api/v1/help/articles', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const ops = isOps(principal);
    const articles = await cache.getOrLoad(`list:${ops ? 'all' : 'published'}`, () =>
      listArticles(deps.pool, { includeUnpublished: ops }),
    );
    return { articles };
  });

  app.get('/api/v1/help/articles/:slug', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { slug } = req.params as { slug: string };
    const article = (await cache.getOrLoad(`slug:${slug}`, async () =>
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

  const audit = async (actorId: string, type: string, article: HelpArticleRow) => {
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
    if (!parsed.success) throw problems.unprocessable('Invalid article', { errors: parsed.error.issues });
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
    if (!parsed.success) throw problems.unprocessable('Invalid patch', { errors: parsed.error.issues });
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

  app.delete(
    '/api/v1/admin/help/articles/:id',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requireOps(req);
      const { id } = req.params as { id: string };
      if (!isUlid(id)) throw problems.notFound();
      const existing = await findArticleById(deps.pool, id);
      if (!existing) throw problems.notFound();
      await deleteArticle(deps.pool, id);
      await audit(principal.id, 'help_article_deleted', existing);
      cache.clear();
      return reply.status(204).send();
    },
  );
}
