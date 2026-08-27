import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { findValuationById } from '../repos/valuations.js';
import {
  deleteValuationTag,
  findValuationTag,
  listValuationTags,
  upsertValuationTag,
  type ValuationTagRow,
} from '../repos/valuationTags.js';
import {
  EXCLUSIVE_TAG_CATEGORIES,
  TAGS_BY_SLUG,
  tagCataloguePayload,
  type TagStatus,
} from '../domain/valuationTags.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { requirePrincipal } from '../plugins/auth.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { invalidBody } from '../domain/validationProblem.js';

/**
 * Engagement tags — 409.ai parity gap #23.
 *
 * Reading is open to anyone who can read the engagement; writing is
 * operations-only. A tag drives the list filter and the precedent query, so a
 * client able to tag their own engagement could move it in and out of a firm's
 * internal views, which is not a thing the client relationship should decide.
 *
 * The interesting rules are all about *not* silently undoing a human:
 *
 *   * an AI tag arrives `suggested` and has to be accepted (routes/ai.ts);
 *   * a tag an analyst rejected stays rejected through a re-run;
 *   * an AI-sourced row is rejected rather than deleted, so the model's output
 *     stays visible as evidence of what was proposed — the same rule the peer
 *     set follows for an AI-suggested comparable.
 */

const SlugParam = z.object({ slug: z.string().min(1).max(64) });

const AddBody = z
  .object({
    slug: z.string().min(1).max(64),
    rationale: z.string().max(600).nullish(),
  })
  .strict();

const DecideBody = z.object({ status: z.enum(['accepted', 'rejected']) }).strict();

/**
 * The catalogue as the UI renders it: grouped, with the definitions.
 *
 * The same structure the `tagging` agent is given as its specification — see
 * `tagCataloguePayload`. The analyst's tooltip and the model's instruction are
 * one string by construction, so the two cannot come to mean different things.
 */
const catalogue = tagCataloguePayload;

/**
 * A stored tag, with the catalogue entry resolved onto it.
 *
 * `known: false` is the case a reader has to be shown rather than protected
 * from: a slug that has left the catalogue since it was written still describes
 * something an analyst concluded, and dropping it from the response would make
 * a decision disappear silently. It is presented, labelled by its slug, and
 * excluded from nothing except a filter it can no longer participate in.
 */
export function presentValuationTag(row: ValuationTagRow) {
  const def = TAGS_BY_SLUG.get(row.slug);
  return {
    slug: row.slug,
    label: def?.label ?? row.slug,
    definition: def?.definition ?? null,
    category: def?.category ?? null,
    known: def !== undefined,
    source: row.source,
    status: row.status,
    confidence: row.confidence,
    rationale: row.rationale,
    evidence: row.evidence,
    decided_at: row.decided_at,
    created_at: row.created_at,
  };
}

export function registerValuationTagRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const loadValuation = async (principal: Principal, id: string) => {
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (
      !valuation ||
      !canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })
    ) {
      throw problems.notFound();
    }
    return valuation;
  };

  const requireOps = (principal: Principal) => {
    if (!isOps(principal)) throw problems.forbidden('Only operations can change engagement tags');
  };

  /** The vocabulary itself — static, and the same list the agent is given. */
  app.get('/api/v1/tag-catalogue', { preHandler: app.authenticate }, async () => ({
    categories: catalogue(),
  }));

  app.get('/api/v1/valuations/:id/tags', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadValuation(principal, id);
    const rows = await listValuationTags(deps.pool, id);
    return {
      tags: rows.map(presentValuationTag),
      accepted: rows.filter((r) => r.status === 'accepted').map((r) => r.slug),
      categories: catalogue(),
    };
  });

  /**
   * Tag the engagement by hand.
   *
   * Accepted immediately, because an analyst adding a tag *is* the decision an
   * AI suggestion is waiting for; routing their own conclusion through a
   * suggestion state would be ceremony with no reviewer at the end of it.
   */
  app.post('/api/v1/valuations/:id/tags', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(principal, id);
    refuseIfRetired(valuation, 'accepting changes');

    const body = AddBody.safeParse(req.body ?? {});
    if (!body.success) throw invalidBody('Invalid tag', body.error);

    const def = TAGS_BY_SLUG.get(body.data.slug);
    if (!def) {
      // Named rather than a bare 422: the catalogue is closed on purpose and a
      // caller that guessed a slug needs to be told where the real list is.
      throw problems.unprocessable(`'${body.data.slug}' is not a tag in the catalogue`, {
        catalogue: '/api/v1/tag-catalogue',
      });
    }

    await enforceExclusivity(deps.pool, id, def.slug, principal);

    const row = await upsertValuationTag(
      deps.pool,
      id,
      { slug: def.slug, source: 'manual', status: 'accepted', rationale: body.data.rationale ?? null },
      principal.id,
    );
    await recordAdminEvent(deps.pool, {
      type: 'valuation_tagged',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'valuation',
      subjectId: valuation.id,
      subjectLabel: valuation.company_name,
      payload: { slug: def.slug, source: 'manual', status: 'accepted' },
    });
    return { tag: presentValuationTag(row) };
  });

  /**
   * Accept or reject a tag — the decision an AI suggestion is waiting for.
   *
   * Also the only way an AI-sourced tag leaves the list: `rejected`, not gone.
   */
  app.patch('/api/v1/valuations/:id/tags/:slug', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const params = SlugParam.safeParse(req.params);
    if (!params.success) throw problems.notFound();
    const valuation = await loadValuation(principal, id);
    refuseIfRetired(valuation, 'accepting changes');

    const body = DecideBody.safeParse(req.body ?? {});
    if (!body.success) throw invalidBody('Invalid decision', body.error);

    const existing = await findValuationTag(deps.pool, id, params.data.slug);
    if (!existing) throw problems.notFound();

    const status: TagStatus = body.data.status;
    if (status === 'accepted') await enforceExclusivity(deps.pool, id, existing.slug, principal);

    const row = await upsertValuationTag(
      deps.pool,
      id,
      {
        slug: existing.slug,
        // The source stays what it was. "The model proposed this and an analyst
        // agreed" and "an analyst concluded this" are different facts, and
        // rewriting the first into the second on acceptance would erase the
        // only record of which one happened.
        source: existing.source,
        status,
        confidence: existing.confidence,
        rationale: existing.rationale,
        evidence: existing.evidence,
      },
      principal.id,
    );
    await recordAdminEvent(deps.pool, {
      type: 'valuation_tag_decided',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'valuation',
      subjectId: valuation.id,
      subjectLabel: valuation.company_name,
      payload: { slug: existing.slug, source: existing.source, status },
    });
    return { tag: presentValuationTag(row) };
  });

  /**
   * Remove a tag a human put there.
   *
   * Refused for an AI-sourced row, which is rejected instead. The agent's
   * output is evidence of what the model proposed on this engagement; a list an
   * operator can prune to the flattering half is not a classification, it is a
   * conclusion with tags under it. Same rule, same wording, as
   * `DELETABLE_SOURCES` on the peer set.
   */
  app.delete('/api/v1/valuations/:id/tags/:slug', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const params = SlugParam.safeParse(req.params);
    if (!params.success) throw problems.notFound();
    const valuation = await loadValuation(principal, id);

    const existing = await findValuationTag(deps.pool, id, params.data.slug);
    if (!existing) throw problems.notFound();
    if (existing.source === 'ai') {
      throw problems.unprocessable(
        'An AI-suggested tag is rejected rather than deleted, so the record of what the model proposed survives — PATCH it with status "rejected"',
      );
    }

    await deleteValuationTag(deps.pool, id, existing.slug);
    await recordAdminEvent(deps.pool, {
      type: 'valuation_tag_removed',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'valuation',
      subjectId: valuation.id,
      subjectLabel: valuation.company_name,
      payload: { slug: existing.slug },
    });
    return reply.code(204).send();
  });

  /**
   * At most one accepted tag from an exclusive category.
   *
   * Applied by demoting the incumbent to `rejected` rather than by refusing the
   * new tag: a company that was `seed` last year and is `series_a` now has not
   * made an error, and an API that made them delete the old tag first would
   * have every caller implement this dance. The demotion is recorded, so the
   * history still shows what the engagement used to be classified as.
   */
  async function enforceExclusivity(
    pool: pg.Pool,
    valuationId: string,
    slug: string,
    principal: Principal,
  ): Promise<void> {
    const def = TAGS_BY_SLUG.get(slug);
    if (!def || !EXCLUSIVE_TAG_CATEGORIES.has(def.category)) return;

    const rows = await listValuationTags(pool, valuationId);
    for (const row of rows) {
      if (row.slug === slug || row.status !== 'accepted') continue;
      if (TAGS_BY_SLUG.get(row.slug)?.category !== def.category) continue;
      await upsertValuationTag(
        pool,
        valuationId,
        {
          slug: row.slug,
          source: row.source,
          status: 'rejected',
          confidence: row.confidence,
          rationale: row.rationale,
          evidence: row.evidence,
        },
        principal.id,
      );
    }
  }
}
