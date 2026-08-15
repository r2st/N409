import type pg from 'pg';
import { newUlid } from '@n409/shared';
import type { EntityType, PortfolioEntity } from '../domain/portfolio.js';
import { invalidateValuation } from './valuations.js';

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
  input: {
    name: string;
    entityType: OrgEntityType;
    parentOrgId?: string | null;
    ownerUserId: string;
    createdBy: string;
  },
): Promise<OrganizationRow> {
  const { rows } = await pool.query<OrganizationRow>(
    `INSERT INTO organizations (id, name, entity_type, parent_org_id, owner_user_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [newUlid(), input.name, input.entityType, input.parentOrgId ?? null, input.ownerUserId, input.createdBy],
  );
  return rows[0]!;
}

/** Ceiling on one page of the organization list. */
export const ORG_PAGE_LIMIT = 200;

/**
 * Organizations a user owns; ops (no ownerUserId) see all.
 *
 * The owner-scoped read is bounded by how many organizations one person set up.
 * The ops read is bounded by nothing at all — it is every organization on the
 * platform — and it feeds a `<select>`, so it is capped on the same terms as
 * the other pickers and reports whether it had to cut anything.
 */
export async function listOrganizations(
  pool: pg.Pool,
  ownerUserId: string | null,
  opts: { limit?: number } = {},
): Promise<{ organizations: OrganizationRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? ORG_PAGE_LIMIT, 1), ORG_PAGE_LIMIT);
  const { rows } = ownerUserId
    ? await pool.query<OrganizationRow>(
        'SELECT * FROM organizations WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT $2',
        [ownerUserId, limit + 1],
      )
    : await pool.query<OrganizationRow>('SELECT * FROM organizations ORDER BY created_at DESC LIMIT $1', [
        limit + 1,
      ]);
  return { organizations: rows.slice(0, limit), truncated: rows.length > limit };
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

/**
 * Would making `candidateParentId` the parent of `id` close a loop?
 *
 * Both hierarchies here are self-referencing single-parent trees, and nothing
 * in the schema prevents A→B→A. A cycle is not merely untidy: `buildEntityTree`
 * finds a root by looking for a node whose parent is outside the set, so a
 * cycle leaves every node in it parented and the whole branch vanishes from
 * the portfolio view — entities silently missing from a consolidated report,
 * which is precisely the number an auditor relies on.
 *
 * Walks up from the candidate parent; if we reach `id`, the candidate is
 * already a descendant. `UNION` (not `UNION ALL`) terminates on any pre-existing
 * cycle rather than recursing forever.
 */
async function wouldCycle(
  pool: pg.Pool,
  table: 'organizations' | 'valuations',
  parentColumn: 'parent_org_id' | 'parent_valuation_id',
  id: string,
  candidateParentId: string,
): Promise<boolean> {
  if (id === candidateParentId) return true;
  const { rows } = await pool.query<{ hit: boolean }>(
    `WITH RECURSIVE ancestors(id) AS (
       SELECT $1::text
       UNION
       SELECT t.${parentColumn} FROM ${table} t
         JOIN ancestors a ON a.id = t.id
        WHERE t.${parentColumn} IS NOT NULL
     )
     SELECT true AS hit FROM ancestors WHERE id = $2 LIMIT 1`,
    [candidateParentId, id],
  );
  return rows.length > 0;
}

/** True when re-parenting `orgId` under `candidateParentId` would close a loop. */
export function organizationParentWouldCycle(
  pool: pg.Pool,
  orgId: string,
  candidateParentId: string,
): Promise<boolean> {
  return wouldCycle(pool, 'organizations', 'parent_org_id', orgId, candidateParentId);
}

/** True when re-parenting `valuationId` under `candidateParentId` would close a loop. */
export function entityParentWouldCycle(
  pool: pg.Pool,
  valuationId: string,
  candidateParentId: string,
): Promise<boolean> {
  return wouldCycle(pool, 'valuations', 'parent_valuation_id', valuationId, candidateParentId);
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
    await pool.query('UPDATE valuations SET organization_id = $2, entity_type = $3 WHERE id = $1', [
      valuationId,
      orgId,
      entityType,
    ]);
  } else {
    await pool.query('UPDATE valuations SET organization_id = $2 WHERE id = $1', [valuationId, orgId]);
  }
  invalidateValuation(valuationId);
}

/** Set the inter-company relationship (entity type + parent valuation). */
export async function setEntityRelationship(
  pool: pg.Pool,
  valuationId: string,
  entityType: EntityType,
  parentValuationId: string | null,
): Promise<void> {
  await pool.query('UPDATE valuations SET entity_type = $2, parent_valuation_id = $3 WHERE id = $1', [
    valuationId,
    entityType,
    parentValuationId,
  ]);
  invalidateValuation(valuationId);
}

/**
 * Ceiling on one organization's entity list.
 *
 * The last list on the client-facing surface that read a whole set. Every other
 * one was bounded (`listCaps.test.ts` names the nine); this one was missed
 * because it looks like it is scoped — `WHERE organization_id = $1` reads as a
 * small set — and nothing bounds how many engagements a user assigns to one
 * organization. It is also the most expensive shape of the family: a LATERAL
 * subquery runs per row, so the cost is a query per entity, not one query.
 *
 * Far above any real holding company. It exists to stop unbounded growth, not
 * to ration a portfolio.
 */
export const ORG_ENTITY_PAGE_LIMIT = 500;

/**
 * The organization's entities with their latest successful valuation figures.
 *
 * Retired engagements are excluded. `archived_at` is this platform's soft
 * delete, applied by `buildValuationWhere` for the list, the counts, the
 * buckets and the export, and swept into every repo that builds its own WHERE
 * (R55/R56) — every repo but this one, which was left unjudged. It is judged
 * now, and the reason is stronger here than for the queues that round finished:
 * those show a stale row, this one *adds it up*. `consolidate()` sums
 * `equity_value` across these rows, so a withdrawn engagement that is gone from
 * the list, the search, the dashboard and the export was still inside the
 * consolidated equity value of the holding company that owned it — a number
 * that reconciles against none of those surfaces, in the one place the file
 * already calls "precisely the number an auditor relies on".
 *
 * `truncated` rides along for the same reason every other capped list carries
 * it: a roll-up computed over a short set is not slow, it is wrong, and the
 * caller cannot tell a short page from a short portfolio.
 */
export async function listPortfolioEntities(
  pool: pg.Pool,
  orgId: string,
  opts: { limit?: number } = {},
): Promise<{ entities: PortfolioEntity[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? ORG_ENTITY_PAGE_LIMIT, 1), ORG_ENTITY_PAGE_LIMIT);
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
      WHERE v.organization_id = $1 AND v.archived_at IS NULL
      ORDER BY v.created_at ASC, v.id ASC
      LIMIT $2`,
    [orgId, limit + 1],
  );
  return {
    entities: rows.slice(0, limit).map((r) => ({
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
    })),
    truncated: rows.length > limit,
  };
}
