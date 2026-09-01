import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import {
  HierarchyCycleError,
  assignValuationToOrg,
  createOrganization,
  deleteOrganization,
  organizationContents,
  findOrganization,
  listOrganizations,
  ORG_ENTITY_PAGE_LIMIT,
  ORG_PAGE_LIMIT,
  listPortfolioEntities,
  setEntityRelationship,
  updateOrganization,
  type OrganizationRow,
} from '../repos/organizations.js';
import { findValuationById } from '../repos/valuations.js';
import { buildEntityTree, consolidate, labelEntities } from '../domain/portfolio.js';
import { requirePrincipal } from '../plugins/auth.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { ulidField } from '../domain/ulidField.js';
import { flagParam } from '../domain/queryFlag.js';

/**
 * Multi-entity / fund portfolio (feature 6). An organization (holding company
 * or fund) groups valuations-as-businesses; the portfolio + consolidated views
 * roll them up. Organizations are owned by a user; ops see and manage all.
 */

const OrgTypeEnum = z.enum(['holding_company', 'fund', 'operating_group']);
const EntityTypeEnum = z.enum(['standalone', 'parent', 'subsidiary', 'portfolio_company']);

/*
 * Every id on these four bodies is `ulidField()` rather than `z.string()`.
 *
 * Both re-parenting routes guard the parent with `if (body.parent_…_id)` and
 * then hand the same field to the write, and `''` is falsy — so a blank id
 * skipped the ownership check, the self-parent check and (on the entity route)
 * the "a standalone entity has no parent" refusal, and was then written into a
 * `ulid` column, whose CHECK answered 23514 and the caller "Internal Server
 * Error". See domain/ulidField.ts.
 */
const CreateOrgBody = z.object({
  name: z.string().trim().min(1).max(200),
  entity_type: OrgTypeEnum.default('holding_company'),
  parent_org_id: ulidField().optional(),
});
const UpdateOrgBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  entity_type: OrgTypeEnum.optional(),
  parent_org_id: ulidField().nullable().optional(),
});
const AssignBody = z.object({
  valuation_id: ulidField(),
  entity_type: EntityTypeEnum.optional(),
});
const EntityBody = z.object({
  entity_type: EntityTypeEnum,
  parent_valuation_id: ulidField().nullable().optional(),
});
/**
 * `?detach=true` on the delete: the acknowledgement that this is dissolving a
 * group rather than tidying an empty one. Query rather than body because a
 * DELETE body is not reliably sent by the clients that would use this.
 */
const DeleteQuery = z.object({ detach: flagParam(false) });

export function registerOrganizationRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const loadOwnedOrg = async (principal: Principal, id: string): Promise<OrganizationRow> => {
    if (!isUlid(id)) throw problems.notFound();
    const org = await findOrganization(deps.pool, id);
    if (!org || (org.owner_user_id !== principal.id && !isOps(principal))) throw problems.notFound();
    return org;
  };

  // The caller must own the valuation (or be ops) to organize it.
  const loadEditableValuation = async (principal: Principal, id: string) => {
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation || (valuation.user_id !== principal.id && !isOps(principal))) {
      throw problems.notFound();
    }
    return valuation;
  };

  app.post('/api/v1/organizations', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const parsed = CreateOrgBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid organization', parsed.error);
    if (parsed.data.parent_org_id) await loadOwnedOrg(principal, parsed.data.parent_org_id);
    const org = await createOrganization(deps.pool, {
      name: parsed.data.name,
      entityType: parsed.data.entity_type,
      parentOrgId: parsed.data.parent_org_id ?? null,
      ownerUserId: principal.id,
      createdBy: principal.id,
    });
    return reply.status(201).send({ organization: org });
  });

  app.get('/api/v1/organizations', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = z
      .object({ limit: z.coerce.number().int().min(1).max(ORG_PAGE_LIMIT).default(ORG_PAGE_LIMIT) })
      .safeParse(req.query ?? {});
    if (!parsed.success) throw invalidQuery(parsed.error);
    return listOrganizations(deps.pool, isOps(principal) ? null : principal.id, {
      limit: parsed.data.limit,
    });
  });

  /**
   * The entity list, and the two things computed from it.
   *
   * `truncated` is reported rather than swallowed: `consolidated` sums equity
   * across exactly these rows, so a capped read is a roll-up that is short by an
   * unknown amount, and a screen drawing what it is given cannot tell that from
   * a small portfolio.
   */
  const loadEntities = async (orgId: string, limit?: number) =>
    listPortfolioEntities(deps.pool, orgId, { limit });

  const EntityQuery = z.object({
    limit: z.coerce.number().int().min(1).max(ORG_ENTITY_PAGE_LIMIT).optional(),
  });

  app.get('/api/v1/organizations/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const query = EntityQuery.safeParse(req.query ?? {});
    if (!query.success) throw invalidQuery(query.error);
    const org = await loadOwnedOrg(principal, id);
    const { entities, truncated } = await loadEntities(org.id, query.data.limit);
    return {
      organization: org,
      // Labelled on the way out: the table below heads two columns with the
      // 409A names of these columns, and on a specialty row that is not what
      // the figure is (`labelEntities`). `consolidate` gets the raw rows — it
      // asks a different question of the same column.
      entities: labelEntities(entities),
      consolidated: consolidate(entities),
      tree: buildEntityTree(entities),
      truncated,
      entity_page_limit: ORG_ENTITY_PAGE_LIMIT,
    };
  });

  app.patch('/api/v1/organizations/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadOwnedOrg(principal, id);
    const parsed = UpdateOrgBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid update', parsed.error);
    if (parsed.data.parent_org_id) {
      if (parsed.data.parent_org_id === id)
        throw problems.unprocessable('An organization cannot be its own parent');
      await loadOwnedOrg(principal, parsed.data.parent_org_id);
    }
    /*
     * Longer loops are just as damaging as self-parenting and just as easy to
     * create two requests apart — and, until round 328, easier still to create
     * with two at once: the check was a read here and the write was
     * unconditional, so `A.parent := B` and `B.parent := A` issued together
     * both saw no loop and together closed one. It now runs inside
     * `updateOrganization`'s transaction under the hierarchy lock; this is
     * where its refusal is worded, because the sentence has to name the tree
     * the caller is editing.
     */
    const updated = await updateOrganization(deps.pool, id, {
      name: parsed.data.name,
      entityType: parsed.data.entity_type,
      parentOrgId: parsed.data.parent_org_id,
    }).catch((err: unknown) => {
      if (err instanceof HierarchyCycleError) {
        throw problems.unprocessable(
          'That parent sits below this organization — the hierarchy would loop back on itself',
        );
      }
      throw err;
    });
    return { organization: updated };
  });

  /**
   * Delete an organization.
   *
   * Refuses while it still holds anything, unless the caller says `detach=true`.
   * The database's `ON DELETE SET NULL` made this succeed on a populated
   * organization and take every member's membership with it, unannounced and
   * with no way back — organizations have no restore, unlike a retired
   * engagement. Deleting an empty container and dissolving a holding company
   * are different requests and were the same one.
   *
   * The 409 names the counts, so a caller who meant it can say so in a second
   * request that reads as the thing it does.
   */
  app.delete('/api/v1/organizations/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadOwnedOrg(principal, id);
    const query = DeleteQuery.safeParse(req.query ?? {});
    if (!query.success) throw invalidQuery(query.error);
    const holding = await organizationContents(deps.pool, id);
    if (!query.data.detach && (holding.entities > 0 || holding.children > 0)) {
      throw problems.conflict(
        `This organization still holds ${holding.entities} ${
          holding.entities === 1 ? 'engagement' : 'engagements'
        } and ${holding.children} sub-${holding.children === 1 ? 'organization' : 'organizations'}. ` +
          'Deleting it returns every engagement to standalone and cannot be undone — repeat with ' +
          '?detach=true to go ahead.',
      );
    }
    const result = await deleteOrganization(deps.pool, id);
    return reply.status(200).send({
      deleted: result.deleted,
      detached_entities: result.detachedEntities,
      reparented_organizations: result.reparentedOrganizations,
    });
  });

  app.get('/api/v1/organizations/:id/consolidated', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const query = EntityQuery.safeParse(req.query ?? {});
    if (!query.success) throw invalidQuery(query.error);
    const org = await loadOwnedOrg(principal, id);
    const { entities, truncated } = await loadEntities(org.id, query.data.limit);
    return {
      organization_id: org.id,
      name: org.name,
      consolidated: consolidate(entities),
      entities: labelEntities(entities),
      truncated,
      entity_page_limit: ORG_ENTITY_PAGE_LIMIT,
    };
  });

  app.post('/api/v1/organizations/:id/entities', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const org = await loadOwnedOrg(principal, id);
    const parsed = AssignBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid assignment', parsed.error);
    // The same write as `PATCH /valuations/:id/entity` below, through the other
    // door: both set the engagement's `organization_id` and `entity_type`, and
    // only that one is under a valuation id — so only that one was swept, and
    // only that one refused. Withdrawn work could still be added to a
    // consolidation group and counted into a roll-up from here.
    refuseIfRetired(await loadEditableValuation(principal, parsed.data.valuation_id), 'accepting changes');
    await assignValuationToOrg(deps.pool, parsed.data.valuation_id, org.id, parsed.data.entity_type);
    return reply.status(204).send();
  });

  /**
   * Remove one engagement from this organization.
   *
   * Both ids are authorized — the caller owns the organization, and owns the
   * engagement — and until R185 neither was checked against the *other*. The
   * handler read `:valuationId`, confirmed the caller could edit it, and then
   * cleared `organization_id` unconditionally: whatever roll-up the engagement
   * was actually a member of, not the one the URL named. So a stale tab, a
   * copied link, or a bulk script iterating the wrong roster detached an
   * engagement from an organization the request never mentioned, and answered
   * 204 as though it had done what was asked.
   *
   * It is not a privilege escalation — ops can edit every organization and
   * every engagement, and a client can only reach their own — which is exactly
   * why it survived three authorization sweeps: every id in the request passes
   * its own check, and the bug is in the relationship between them. For ops it
   * is the sharpest case rather than the mildest, because they hold every
   * organization on the platform, so the engagement silently removed belongs to
   * a firm that did not ask.
   *
   * 404 rather than 409: to a caller who may see both rows, "that engagement is
   * not in this organization" and "that engagement is not there" are the same
   * fact about this URL. With a detail rather than bare, for the same reason —
   * this is precisely the case `errorMessageQuality`'s bare-404 ratchet is
   * written for, a 404 on a sub-resource whose parent the caller can already
   * see, where nothing is being protected by saying nothing.
   */
  app.delete(
    '/api/v1/organizations/:id/entities/:valuationId',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { id, valuationId } = req.params as { id: string; valuationId: string };
      const org = await loadOwnedOrg(principal, id);
      const valuation = await loadEditableValuation(principal, valuationId);
      if (valuation.organization_id !== org.id)
        throw problems.notFound('That engagement is not part of this organization.');
      await assignValuationToOrg(deps.pool, valuationId, null);
      return reply.status(204).send();
    },
  );

  // Inter-company relationship: set a valuation's entity role + parent ref.
  app.patch('/api/v1/valuations/:id/entity', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    refuseIfRetired(await loadEditableValuation(principal, id), 'accepting changes');
    const parsed = EntityBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid entity', parsed.error);
    if (parsed.data.parent_valuation_id) {
      // A standalone company with a parent is a contradiction the roll-up has
      // no reading of: `consolidate` eliminates on the type, so the link would
      // be stored, shown in the tree, and counted as if it were not there.
      if (parsed.data.entity_type === 'standalone')
        throw problems.unprocessable(
          'A standalone entity has no parent — set its type to subsidiary or portfolio company first',
        );
      if (parsed.data.parent_valuation_id === id)
        throw problems.unprocessable('A valuation cannot be its own parent');
      await loadEditableValuation(principal, parsed.data.parent_valuation_id);
    }
    // A subsidiary cannot also be its own parent's parent: the entity tree
    // drops any branch that loops, so the consolidated roll-up would quietly
    // stop counting both entities. Checked inside `setEntityRelationship`'s
    // transaction, under the hierarchy lock, for the reason the organization
    // patch above gives.
    await setEntityRelationship(
      deps.pool,
      id,
      parsed.data.entity_type,
      parsed.data.parent_valuation_id ?? null,
    ).catch((err: unknown) => {
      if (err instanceof HierarchyCycleError) {
        throw problems.unprocessable(
          'That entity sits below this one — the inter-company hierarchy would loop back on itself',
        );
      }
      throw err;
    });
    return {
      entity_type: parsed.data.entity_type,
      parent_valuation_id: parsed.data.parent_valuation_id ?? null,
    };
  });
}
