import type pg from 'pg';
import { newUlid } from '@n409/shared';
import type { EntityType, PortfolioEntity } from '../domain/portfolio.js';
import { invalidateValuation } from './valuations.js';
import { withTransaction, type Queryable } from '../db/pool.js';
import { recordEvent, recordEvents, type EventActor } from '../events/record.js';

/**
 * Lock class for the two single-parent hierarchies. Distinct from every other
 * class in this service — `pg_advisory_xact_lock(key1, key2)` shares one
 * namespace across the database — and split by `key2` so a re-parent in the
 * organization tree does not wait on one in the inter-company tree.
 */
const HIERARCHY_LOCK = 0x7472_6565; // 'tree'
const ORG_TREE = 1;
const ENTITY_TREE = 2;

/**
 * Raised when the re-parent this transaction is about to write would close a
 * loop. Carries no detail: the two callers word the refusal for their own
 * hierarchy, and the sentence a user reads names the tree they are editing.
 */
export class HierarchyCycleError extends Error {
  constructor() {
    super('re-parenting would close a cycle');
    this.name = 'HierarchyCycleError';
  }
}

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

/**
 * Patch an organization, re-parenting it under the hierarchy lock when asked.
 *
 * A patch that moves `parent_org_id` to a non-null value runs in a transaction
 * that holds {@link HIERARCHY_LOCK} and re-asks {@link wouldCycle} there,
 * throwing {@link HierarchyCycleError} rather than writing a loop. Detaching
 * (`null`) and every other field need neither: nothing can be made cyclic by
 * removing an edge.
 */
export async function updateOrganization(
  pool: pg.Pool,
  id: string,
  patch: { name?: string; entityType?: OrgEntityType; parentOrgId?: string | null },
): Promise<OrganizationRow | null> {
  const parent = patch.parentOrgId;
  if (parent) {
    return withTransaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [HIERARCHY_LOCK, ORG_TREE]);
      if (await wouldCycle(client, 'organizations', 'parent_org_id', id, parent)) {
        throw new HierarchyCycleError();
      }
      return writeOrganizationPatch(client, id, patch);
    });
  }
  return writeOrganizationPatch(pool, id, patch);
}

async function writeOrganizationPatch(
  db: Queryable,
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
  const { rows } = await db.query<OrganizationRow>(
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
 *
 * WHERE THIS HAS TO RUN (round 328). This is a read, and the re-parent that
 * acts on it is a write, and neither hierarchy has any constraint behind them:
 * two requests that each ask this question before either answer is written both
 * get "no loop", and the pair of writes closes one. `A.parent := B` and
 * `B.parent := A`, issued together, is all it takes — two tabs, a retried
 * request, or two people tidying one holdco tree. The route comments already
 * said a loop is "just as easy to create two requests apart"; concurrently it
 * needs no second request at all, because neither read can see the other's
 * write.
 *
 * And a cycle here is silent by construction: `buildEntityTree` finds a root by
 * looking for a node whose parent is outside the set, so every node in the loop
 * looks parented and the whole branch drops out of the portfolio view. What an
 * auditor is handed is a consolidated figure with entities missing from it and
 * nothing on the page saying so.
 *
 * So it runs on the transaction that performs the write, under
 * {@link HIERARCHY_LOCK}, and never against the caller's own earlier reading —
 * the same rule as `saveVersion` and the publish gate. The lock is per tree and
 * not per node: a loop is a property of a path, so the two writes that close
 * one need not touch a row in common, and there is nothing narrower to hold.
 * Re-parenting is a rare administrative act on a small table, so a tree-wide
 * lock costs nothing anybody can observe.
 */
async function wouldCycle(
  db: Queryable,
  table: 'organizations' | 'valuations',
  parentColumn: 'parent_org_id' | 'parent_valuation_id',
  id: string,
  candidateParentId: string,
): Promise<boolean> {
  if (id === candidateParentId) return true;
  const { rows } = await db.query<{ hit: boolean }>(
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

/**
 * What a delete would take with it.
 *
 * THE COUNT AND THE STATEMENT IT DESCRIBES READ DIFFERENT POPULATIONS (R388,
 * methodology M3). This counted live members only, and `deleteOrganization`'s
 * detach has no `archived_at` predicate at all — it rewrites `organization_id`,
 * `entity_type` and `parent_valuation_id` on every member the organization
 * holds, retired ones included, and records a `portfolio_membership_changed`
 * for each.
 *
 * So the refusal the route exists to raise — "deleting an empty container and
 * dissolving a holding company are different requests and were the same one" —
 * was measuring the wrong thing twice over. A roll-up holding nothing but
 * retired engagements reported itself empty and deleted on the first press,
 * with no `?detach=true` and no warning; one holding two live and five retired
 * said "two engagements" and then rewrote seven. Retirement is not a delete —
 * `restoreValuations` brings an engagement back — so what comes back is a
 * standalone with its membership and its inter-company link gone, and the
 * operator was told the container was empty.
 *
 * Counted apart rather than summed, because the two are different sentences to
 * an operator: live members are work in flight, retired ones are a reason to
 * think about what a restore will find.
 */
export interface OrganizationContents {
  /** Live (non-archived) valuations whose `organization_id` is this one. */
  entities: number;
  /** Retired members. Detached by the same statement, and restorable after it. */
  retiredEntities: number;
  /** Organizations whose `parent_org_id` is this one. */
  children: number;
}

export async function organizationContents(pool: pg.Pool, id: string): Promise<OrganizationContents> {
  const { rows } = await pool.query<{ entities: string; retired: string; children: string }>(
    `SELECT (SELECT count(*) FROM valuations
              WHERE organization_id = $1 AND archived_at IS NULL) AS entities,
            (SELECT count(*) FROM valuations
              WHERE organization_id = $1 AND archived_at IS NOT NULL) AS retired,
            (SELECT count(*) FROM organizations WHERE parent_org_id = $1) AS children`,
    [id],
  );
  const row = rows[0];
  return {
    entities: Number(row?.entities ?? 0),
    retiredEntities: Number(row?.retired ?? 0),
    children: Number(row?.children ?? 0),
  };
}

/** Outcome of a delete, so the caller can say what went with the container. */
export interface DeleteOrganizationResult {
  deleted: boolean;
  /** Valuations detached and returned to `standalone`. */
  detachedEntities: string[];
  /** Child organizations moved up to this one's parent. */
  reparentedOrganizations: string[];
}

/**
 * Delete an organization, accounting for what it was holding.
 *
 * Both foreign keys into this table are `ON DELETE SET NULL`, so a plain
 * `DELETE` succeeded on a populated organization and did three things quietly:
 * every member valuation lost its `organization_id`, every child organization
 * was re-rooted to the top of the tree, and both kept the entity type they had
 * been given as members of the thing that no longer exists. A valuation typed
 * `subsidiary` or `portfolio_company` belonging to no portfolio is a state the
 * product has no reading of — and one that used to be worth real money in the
 * consolidated figure, see domain/portfolio.ts.
 *
 * Done explicitly and in one transaction instead:
 *
 *   - members are detached *and* returned to `standalone`, because the type
 *     described a membership and the membership is what is being removed. The
 *     inter-company `parent_valuation_id` is cleared with it for the same
 *     reason — it named a parent inside this organization.
 *   - children are re-parented to this organization's own parent rather than to
 *     null. A holdco tree that loses a middle node should close up, not
 *     scatter; SET NULL was the database's default answer, not a decision.
 */
export async function deleteOrganization(
  pool: pg.Pool,
  id: string,
  actor: EventActor,
): Promise<DeleteOrganizationResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const org = await client.query<{ parent_org_id: string | null }>(
      'SELECT parent_org_id FROM organizations WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (org.rowCount === 0) {
      await client.query('ROLLBACK');
      return { deleted: false, detachedEntities: [], reparentedOrganizations: [] };
    }
    /*
     * Read before the write, because the event has to say what the membership
     * *was*: `UPDATE … RETURNING` hands back the row as it now is, and the
     * whole content of this event is the three columns this statement is about
     * to overwrite. Bounded by the same thing the `UPDATE` below is — how many
     * engagements one organization holds — so it adds a round trip rather than
     * a new ceiling.
     */
    const members = await client.query<{ id: string } & StructureRow>(
      `SELECT id, organization_id, entity_type, parent_valuation_id
         FROM valuations WHERE organization_id = $1 FOR UPDATE`,
      [id],
    );
    const detached = await client.query<{ id: string }>(
      `UPDATE valuations
          SET organization_id = NULL, entity_type = 'standalone', parent_valuation_id = NULL
        WHERE organization_id = $1
        RETURNING id`,
      [id],
    );
    /*
     * One row per engagement rather than one per organization: the spine is
     * keyed on `valuation_id`, and "this engagement left a roll-up" is the
     * question asked of an engagement's own trail. `recordEvents` writes the
     * batch in one statement, which is what it exists for — a holding company
     * being wound up detaches its whole book at once.
     */
    await recordEvents(
      client,
      members.rows.map((row) => ({
        valuationId: row.id,
        type: 'portfolio_membership_changed' as const,
        actor,
        payload: {
          ...structureChange(row, {
            organization_id: null,
            entity_type: 'standalone',
            parent_valuation_id: null,
          }),
          // Why the membership ended, which the before/after pair cannot say:
          // this is not somebody removing one engagement from a roll-up, it is
          // the roll-up ceasing to exist. Beside `changes` rather than inside
          // it — nothing moved from one value to another here.
          organization_deleted: true,
        },
      })),
    );
    const reparented = await client.query<{ id: string }>(
      'UPDATE organizations SET parent_org_id = $2 WHERE parent_org_id = $1 RETURNING id',
      [id, org.rows[0]?.parent_org_id ?? null],
    );
    await client.query('DELETE FROM organizations WHERE id = $1', [id]);
    await client.query('COMMIT');
    const detachedEntities = detached.rows.map((r) => r.id);
    // The read-through cache holds the row this just rewrote; without the drop
    // every reader keeps seeing the old membership for a full TTL.
    for (const valuationId of detachedEntities) invalidateValuation(valuationId);
    return {
      deleted: true,
      detachedEntities,
      reparentedOrganizations: reparented.rows.map((r) => r.id),
    };
  } catch (err) {
    // swallow: ROLLBACK in a catch that is re-raising the error that caused it.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Assign a valuation to an organization (or detach with orgId = null).
 *
 * THE TYPE AND THE PARENT LINK ARE ONE FACT, AND THIS DOOR WROTE HALF OF IT
 * (round 380, methodology M3).
 *
 * `entity_type` and `parent_valuation_id` describe a single relationship, and
 * the other two doors onto it both say so. `PATCH /valuations/:id/entity`
 * refuses the pair `standalone` + a parent outright — "A standalone entity has
 * no parent" — on the grounds that `consolidate` reads the type, so the link
 * would be "stored, shown in the tree, and counted as if it were not there".
 * `deleteOrganization` states the other half: a member returned to `standalone`
 * has its `parent_valuation_id` cleared with it, "because the type described a
 * membership and the membership is what is being removed".
 *
 * This statement wrote `entity_type` alone and left the link where it was, so
 * both halves were reachable through it:
 *
 *   - `POST /organizations/:id/entities` with `entity_type: 'standalone'` on an
 *     engagement that already has a parent — the exact state the sibling route
 *     refuses, and one press of a `<select>` away: `OrgAssignmentCard` offers
 *     "Standalone" in its Entity role picker and knows nothing about the link.
 *     The roll-up then counts the entity in full (elimination is keyed on
 *     `subsidiary`) while the tree draws it inside its parent, and
 *     `unanchored_subsidiaries` — the list that exists to name a subsidiary the
 *     totals did *not* eliminate — says nothing, because it is keyed on the
 *     type too. A holding company's consolidated equity therefore carries the
 *     subsidiary twice, silently, in the figure domain/portfolio.ts calls the
 *     one an auditor relies on.
 *   - `DELETE /organizations/:id/entities/:valuationId` — the one-engagement
 *     form of the removal `deleteOrganization` performs in bulk — cleared the
 *     membership and left the engagement typed `subsidiary` with a parent
 *     inside the organization it had just left. That is the same "state the
 *     product has no reading of" the bulk door was fixed not to create.
 *
 * So the rule is applied where every door passes rather than at each of them:
 * ending a membership ends the type and the link, and writing `standalone`
 * clears the link, because that is what the word means.
 */
export async function assignValuationToOrg(
  pool: pg.Pool,
  valuationId: string,
  orgId: string | null,
  entityType: EntityType | undefined,
  actor: EventActor,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    const { rows } = await client.query<StructureRow>(
      `SELECT organization_id, entity_type, parent_valuation_id
         FROM valuations WHERE id = $1 FOR UPDATE`,
      [valuationId],
    );
    const before = rows[0];
    if (!before) return;

    // The four branches this used to be, as the triple each of them wrote.
    // `standalone` clears the link for the reason the header gives; an
    // assignment that names no type leaves the relationship alone.
    const after: StructureRow =
      orgId === null
        ? { organization_id: null, entity_type: 'standalone', parent_valuation_id: null }
        : entityType === 'standalone'
          ? { organization_id: orgId, entity_type: 'standalone', parent_valuation_id: null }
          : {
              organization_id: orgId,
              entity_type: entityType ?? before.entity_type,
              parent_valuation_id: before.parent_valuation_id,
            };
    if (unchanged(before, after)) return;

    await client.query(
      `UPDATE valuations
          SET organization_id = $2, entity_type = $3, parent_valuation_id = $4
        WHERE id = $1`,
      [valuationId, after.organization_id, after.entity_type, after.parent_valuation_id],
    );
    await recordEvent(client, {
      valuationId,
      type: 'portfolio_membership_changed',
      actor,
      payload: structureChange(before, after),
    });
  });
  invalidateValuation(valuationId);
}

/**
 * The three columns `domain/portfolio.ts` reads to decide how an engagement is
 * counted in a roll-up. They move together and they are recorded together.
 */
interface StructureRow {
  organization_id: string | null;
  entity_type: EntityType;
  parent_valuation_id: string | null;
}

const unchanged = (a: StructureRow, b: StructureRow): boolean =>
  a.organization_id === b.organization_id &&
  a.entity_type === b.entity_type &&
  a.parent_valuation_id === b.parent_valuation_id;

/**
 * Before and after, side by side, in the shape the trail can already read.
 *
 * `{ fields: [...] }` is a payload shape this estate has written before and it
 * cannot answer the question the trail is read for — a roll-up that changed by
 * one engagement being retyped needs to say *what it was*, because the row
 * itself now holds only the new value. So does a pair of flat
 * `x`/`previous_x` keys, which is worse: `extractChanges` recognises
 * `{ changes: { field: { from, to } } }`, `{ from, to }` and `{ fields }`, and
 * anything else yields no changes at all — the change log, the evidence bundle
 * and the audit CSV would print the label over an empty summary, which is the
 * silence this event exists to end wearing a name.
 *
 * Only the columns that moved. All three are written on every one of these
 * statements, and a membership ending is not also a statement that the entity
 * type it had is unchanged.
 */
function structureChange(before: StructureRow, after: StructureRow): Record<string, unknown> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of ['organization_id', 'entity_type', 'parent_valuation_id'] as const) {
    if (before[field] !== after[field]) changes[field] = { from: before[field], to: after[field] };
  }
  return { changes };
}

/**
 * Set the inter-company relationship (entity type + parent valuation).
 *
 * Both branches run in a transaction now, where the clearing one used to write
 * on the pool: the event belongs in the same transaction as the change it
 * describes (`events/record.ts`), and detaching a subsidiary from its parent
 * moves the consolidated total exactly as much as attaching one does.
 */
export async function setEntityRelationship(
  pool: pg.Pool,
  valuationId: string,
  entityType: EntityType,
  parentValuationId: string | null,
  actor: EventActor,
): Promise<void> {
  const write = async (client: pg.PoolClient) => {
    const { rows } = await client.query<StructureRow>(
      `SELECT organization_id, entity_type, parent_valuation_id
         FROM valuations WHERE id = $1 FOR UPDATE`,
      [valuationId],
    );
    const before = rows[0];
    if (!before) return;
    const after: StructureRow = {
      organization_id: before.organization_id,
      entity_type: entityType,
      parent_valuation_id: parentValuationId,
    };
    if (unchanged(before, after)) return;
    await client.query('UPDATE valuations SET entity_type = $2, parent_valuation_id = $3 WHERE id = $1', [
      valuationId,
      entityType,
      parentValuationId,
    ]);
    await recordEvent(client, {
      valuationId,
      type: 'entity_relationship_changed',
      actor,
      payload: structureChange(before, after),
    });
  };
  // Same rule as `updateOrganization`: the loop check belongs on the
  // transaction that writes the edge, not on a reading the caller took earlier.
  // Clearing the parent cannot close anything, so it skips the lock.
  await withTransaction(pool, async (client) => {
    if (parentValuationId) {
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [HIERARCHY_LOCK, ENTITY_TREE]);
      if (await wouldCycle(client, 'valuations', 'parent_valuation_id', valuationId, parentValuationId)) {
        throw new HierarchyCycleError();
      }
    }
    await write(client);
  });
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
    kind: string;
    currency: string;
    equity_value: string | null;
    fmv_per_share: string | null;
    as_of: Date | null;
  }>(
    `SELECT v.id AS valuation_id, v.number, v.company_name, v.entity_type,
            v.parent_valuation_id, v.state, v.kind, v.currency,
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
      // What the equity figure below *is* — `consolidate` refuses to add a
      // figure that is not an equity value to one that is.
      kind: r.kind,
      currency: r.currency,
      equity_value: r.equity_value !== null ? Number(r.equity_value) : null,
      fmv_per_share: r.fmv_per_share !== null ? Number(r.fmv_per_share) : null,
      as_of: r.as_of ? new Date(r.as_of).toISOString() : null,
    })),
    truncated: rows.length > limit,
  };
}
