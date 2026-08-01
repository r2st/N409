import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import {
  assignValuationToOrg,
  createOrganization,
  deleteOrganization,
  findOrganization,
  listOrganizations,
  listPortfolioEntities,
  setEntityRelationship,
  updateOrganization,
  type OrganizationRow,
} from '../repos/organizations.js';
import { findValuationById } from '../repos/valuations.js';
import { buildEntityTree, consolidate } from '../domain/portfolio.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * Multi-entity / fund portfolio (feature 6). An organization (holding company
 * or fund) groups valuations-as-businesses; the portfolio + consolidated views
 * roll them up. Organizations are owned by a user; ops see and manage all.
 */

const OrgTypeEnum = z.enum(['holding_company', 'fund', 'operating_group']);
const EntityTypeEnum = z.enum(['standalone', 'parent', 'subsidiary', 'portfolio_company']);

const CreateOrgBody = z.object({
  name: z.string().trim().min(1).max(200),
  entity_type: OrgTypeEnum.default('holding_company'),
  parent_org_id: z.string().optional(),
});
const UpdateOrgBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  entity_type: OrgTypeEnum.optional(),
  parent_org_id: z.string().nullable().optional(),
});
const AssignBody = z.object({
  valuation_id: z.string(),
  entity_type: EntityTypeEnum.optional(),
});
const EntityBody = z.object({
  entity_type: EntityTypeEnum,
  parent_valuation_id: z.string().nullable().optional(),
});

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
    if (!parsed.success)
      throw problems.unprocessable('Invalid organization', { errors: parsed.error.issues });
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
    return { organizations: await listOrganizations(deps.pool, isOps(principal) ? null : principal.id) };
  });

  app.get('/api/v1/organizations/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const org = await loadOwnedOrg(principal, id);
    const entities = await listPortfolioEntities(deps.pool, org.id);
    return {
      organization: org,
      entities,
      consolidated: consolidate(entities),
      tree: buildEntityTree(entities),
    };
  });

  app.patch('/api/v1/organizations/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadOwnedOrg(principal, id);
    const parsed = UpdateOrgBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid update', { errors: parsed.error.issues });
    if (parsed.data.parent_org_id) {
      if (parsed.data.parent_org_id === id)
        throw problems.unprocessable('An organization cannot be its own parent');
      await loadOwnedOrg(principal, parsed.data.parent_org_id);
    }
    const updated = await updateOrganization(deps.pool, id, {
      name: parsed.data.name,
      entityType: parsed.data.entity_type,
      parentOrgId: parsed.data.parent_org_id,
    });
    return { organization: updated };
  });

  app.delete('/api/v1/organizations/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadOwnedOrg(principal, id);
    await deleteOrganization(deps.pool, id);
    return reply.status(204).send();
  });

  app.get('/api/v1/organizations/:id/consolidated', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const org = await loadOwnedOrg(principal, id);
    const entities = await listPortfolioEntities(deps.pool, org.id);
    return { organization_id: org.id, name: org.name, consolidated: consolidate(entities), entities };
  });

  app.post('/api/v1/organizations/:id/entities', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const org = await loadOwnedOrg(principal, id);
    const parsed = AssignBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid assignment', { errors: parsed.error.issues });
    await loadEditableValuation(principal, parsed.data.valuation_id);
    await assignValuationToOrg(deps.pool, parsed.data.valuation_id, org.id, parsed.data.entity_type);
    return reply.status(204).send();
  });

  app.delete(
    '/api/v1/organizations/:id/entities/:valuationId',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { id, valuationId } = req.params as { id: string; valuationId: string };
      await loadOwnedOrg(principal, id);
      await loadEditableValuation(principal, valuationId);
      await assignValuationToOrg(deps.pool, valuationId, null);
      return reply.status(204).send();
    },
  );

  // Inter-company relationship: set a valuation's entity role + parent ref.
  app.patch('/api/v1/valuations/:id/entity', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadEditableValuation(principal, id);
    const parsed = EntityBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid entity', { errors: parsed.error.issues });
    if (parsed.data.parent_valuation_id) {
      if (parsed.data.parent_valuation_id === id)
        throw problems.unprocessable('A valuation cannot be its own parent');
      await loadEditableValuation(principal, parsed.data.parent_valuation_id);
    }
    await setEntityRelationship(
      deps.pool,
      id,
      parsed.data.entity_type,
      parsed.data.parent_valuation_id ?? null,
    );
    return {
      entity_type: parsed.data.entity_type,
      parent_valuation_id: parsed.data.parent_valuation_id ?? null,
    };
  });
}
