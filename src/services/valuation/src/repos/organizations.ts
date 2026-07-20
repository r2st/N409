import type pg from 'pg';
import { newUlid } from '@n409/shared';
import type { EntityType, PortfolioEntity } from '../domain/portfolio.js';

export type OrgEntityType = 'holding_company' | 'fund' | 'operating_group';

export interface OrganizationRow {
  id: string;
  name: string;
  entity_type: OrgEntityType;
  parent_org_id: string | null;
  owner_user_id: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function createOrganization(
  pool: pg.Pool,
  input: { name: string; entityType: OrgEntityType; parentOrgId?: string | null; ownerUserId: string; createdBy: string },
): Promise<OrganizationRow> {
  const { rows } = await pool.query<OrganizationRow>(
    `INSERT INTO organizations (id, name, entity_type, parent_org_id, owner_user_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [newUlid(), input.name, input.entityType, input.parentOrgId ?? null, input.ownerUserId, input.createdBy],
  );
  return rows[0]!;
}

/** Organizations a user owns; ops (no ownerUserId) see all. */
export async function listOrganizations(
  pool: pg.Pool,
  ownerUserId: string | null,
): Promise<OrganizationRow[]> {
  const { rows } = ownerUserId
    ? await pool.query<OrganizationRow>(
        'SELECT * FROM organizations WHERE owner_user_id = $1 ORDER BY created_at DESC',
        [ownerUserId],
      )
    : await pool.query<OrganizationRow>('SELECT * FROM organizations ORDER BY created_at DESC');
  return rows;
}

export async function findOrganization(pool: pg.Pool, id: string): Promise<OrganizationRow | null> {
  const { rows } = await pool.query<OrganizationRow>('SELECT * FROM organizations WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function updateOrganization(
  pool: pg.Pool,
  id: string,
  patch: { name?: string; entityType?: OrgEntityType; parentOrgId?: string | null },
): Promise<OrganizationRow | null> {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    params.push(patch.name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.entityType !== undefined) {
    params.push(patch.entityType);
    sets.push(`entity_type = $${params.length}`);
  }
  if (patch.parentOrgId !== undefined) {
    params.push(patch.parentOrgId);
    sets.push(`parent_org_id = $${params.length}`);
  }
  params.push(id);
  const { rows } = await pool.query<OrganizationRow>(
    `UPDATE organizations SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );
  return rows[0] ?? null;
}

export async function deleteOrganization(pool: pg.Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM organizations WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

/** Assign a valuation to an organization (or detach with orgId = null). */
export async function assignValuationToOrg(
  pool: pg.Pool,
  valuationId: string,
  orgId: string | null,
  entityType?: EntityType,
): Promise<void> {
  if (entityType) {
    await pool.query(
      'UPDATE valuations SET organization_id = $2, entity_type = $3 WHERE id = $1',
      [valuationId, orgId, entityType],
    );
  } else {
    await pool.query('UPDATE valuations SET organization_id = $2 WHERE id = $1', [valuationId, orgId]);
  }
}

/** Set the inter-company relationship (entity type + parent valuation). */
export async function setEntityRelationship(
  pool: pg.Pool,
  valuationId: string,
  entityType: EntityType,
  parentValuationId: string | null,
): Promise<void> {
  await pool.query(
    'UPDATE valuations SET entity_type = $2, parent_valuation_id = $3 WHERE id = $1',
    [valuationId, entityType, parentValuationId],
  );
}

/** The organization's entities with their latest successful valuation figures. */
export async function listPortfolioEntities(
  pool: pg.Pool,
  orgId: string,
): Promise<PortfolioEntity[]> {
  const { rows } = await pool.query<{
    valuation_id: string;
    number: string;
    company_name: string;
    entity_type: EntityType;
    parent_valuation_id: string | null;
    state: string;
    currency: string;
    equity_value: string | null;
    fmv_per_share: string | null;
    as_of: Date | null;
  }>(
    `SELECT v.id AS valuation_id, v.number, v.company_name, v.entity_type,
            v.parent_valuation_id, v.state, v.currency,
            c.equity_value, c.fmv_per_share, c.created_at AS as_of
       FROM valuations v
       LEFT JOIN LATERAL (
         SELECT equity_value, fmv_per_share, created_at
           FROM calculations
          WHERE valuation_id = v.id AND status = 'succeeded'
          ORDER BY created_at DESC LIMIT 1
       ) c ON true
      WHERE v.organization_id = $1
      ORDER BY v.created_at ASC`,
    [orgId],
  );
  return rows.map((r) => ({
    valuation_id: r.valuation_id,
    number: r.number,
    company_name: r.company_name,
    entity_type: r.entity_type,
    parent_valuation_id: r.parent_valuation_id,
    state: r.state,
    currency: r.currency,
    equity_value: r.equity_value !== null ? Number(r.equity_value) : null,
    fmv_per_share: r.fmv_per_share !== null ? Number(r.fmv_per_share) : null,
    as_of: r.as_of ? new Date(r.as_of).toISOString() : null,
  }));
}
