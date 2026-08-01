/**
 * Portfolio consolidation (feature 6): roll up the entities (valuations) that
 * belong to an organization into a single consolidated view. Pure functions so
 * the aggregation is unit-testable independent of the DB.
 */

export type EntityType = 'standalone' | 'parent' | 'subsidiary' | 'portfolio_company';

export interface PortfolioEntity {
  valuation_id: string;
  number: string;
  company_name: string;
  entity_type: EntityType;
  parent_valuation_id: string | null;
  state: string;
  /** Latest successful valuation figures, when one exists. */
  equity_value: number | null;
  fmv_per_share: number | null;
  as_of: string | null;
  currency: string;
}

export interface ConsolidatedReport {
  entity_count: number;
  valued_count: number;
  /** Sum of the latest equity value across valued entities. */
  total_equity_value: number;
  /** Consolidated equity excluding subsidiaries (avoids double counting a
   *  parent that already includes its subsidiaries). */
  consolidated_equity_value: number;
  by_entity_type: Record<EntityType, { count: number; equity_value: number }>;
  currencies: string[];
}

const ENTITY_TYPES: EntityType[] = ['standalone', 'parent', 'subsidiary', 'portfolio_company'];

/**
 * Consolidate an organization's entities. `total_equity_value` sums every
 * valued entity; `consolidated_equity_value` excludes `subsidiary` entities on
 * the assumption a `parent` entity's valuation already consolidates them —
 * the common holding-company reporting convention.
 */
export function consolidate(entities: PortfolioEntity[]): ConsolidatedReport {
  const byType = Object.fromEntries(ENTITY_TYPES.map((t) => [t, { count: 0, equity_value: 0 }])) as Record<
    EntityType,
    { count: number; equity_value: number }
  >;

  let total = 0;
  let consolidated = 0;
  let valued = 0;
  const currencies = new Set<string>();

  for (const e of entities) {
    byType[e.entity_type].count += 1;
    currencies.add(e.currency);
    if (e.equity_value !== null) {
      valued += 1;
      total += e.equity_value;
      byType[e.entity_type].equity_value += e.equity_value;
      if (e.entity_type !== 'subsidiary') consolidated += e.equity_value;
    }
  }

  return {
    entity_count: entities.length,
    valued_count: valued,
    total_equity_value: Math.round(total * 100) / 100,
    consolidated_equity_value: Math.round(consolidated * 100) / 100,
    by_entity_type: byType,
    currencies: [...currencies],
  };
}

/**
 * Build a parent → children adjacency map from the inter-company references,
 * for rendering the entity tree. Entities with a parent outside the set (or
 * none) surface as roots.
 *
 * A cycle (A parents B parents A) leaves every member of the loop parented, so
 * a naive pass finds no root for that branch and the caller renders nothing —
 * entities silently absent from a portfolio view. The API refuses to create
 * one, but rows predating that check still exist, so anything unreachable from
 * a genuine root is promoted to a root of its own. Showing a wrong-looking
 * tree beats showing a company that isn't there.
 */
export function buildEntityTree(entities: PortfolioEntity[]): {
  roots: string[];
  childrenOf: Record<string, string[]>;
} {
  const ids = new Set(entities.map((e) => e.valuation_id));
  const childrenOf: Record<string, string[]> = {};
  const roots: string[] = [];
  for (const e of entities) {
    if (e.parent_valuation_id && ids.has(e.parent_valuation_id)) {
      (childrenOf[e.parent_valuation_id] ??= []).push(e.valuation_id);
    } else {
      roots.push(e.valuation_id);
    }
  }

  // Promote the first member of each orphaned cycle, in input order, so the
  // result is deterministic and every entity is reachable exactly once.
  const reachable = new Set<string>();
  const walk = (id: string): void => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const child of childrenOf[id] ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  for (const e of entities) {
    if (!reachable.has(e.valuation_id)) {
      roots.push(e.valuation_id);
      walk(e.valuation_id);
    }
  }

  return { roots, childrenOf };
}
