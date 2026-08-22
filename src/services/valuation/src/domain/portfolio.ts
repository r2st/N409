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

/** Roll-up of the entities denominated in one currency. */
export interface CurrencyTotals {
  currency: string;
  entity_count: number;
  valued_count: number;
  total_equity_value: number;
  consolidated_equity_value: number;
}

export interface ConsolidatedReport {
  entity_count: number;
  valued_count: number;
  /**
   * Sum of the latest equity value across valued entities — `null` when the
   * organization spans more than one currency, where no single sum exists.
   */
  total_equity_value: number | null;
  /**
   * Consolidated equity, eliminating a subsidiary whose parent is rolled up
   * here too (its value is already inside that parent's). A subsidiary whose
   * parent is *not* in this roll-up is kept — see `unanchored_subsidiaries`.
   * `null` when mixed.
   */
  consolidated_equity_value: number | null;
  by_entity_type: Record<EntityType, { count: number; equity_value: number | null }>;
  /** Per-currency roll-up, ordered by descending total then currency code. */
  by_currency: CurrencyTotals[];
  currencies: string[];
  /** True when the entities are denominated in more than one currency. */
  mixed_currency: boolean;
  /**
   * Entities typed `subsidiary` whose parent is not in this roll-up — no
   * `parent_valuation_id` at all, or one naming a valuation that is archived,
   * detached, or in another organization.
   *
   * Their value is *included* in `consolidated_equity_value`, because nothing
   * here contains it. Reported rather than merely handled: the reader is
   * looking at a figure labelled "excluding subsidiaries" and these are the
   * subsidiaries it did not exclude.
   */
  unanchored_subsidiaries: Array<{ valuation_id: string; company_name: string }>;
}

const ENTITY_TYPES: EntityType[] = ['standalone', 'parent', 'subsidiary', 'portfolio_company'];

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Consolidate an organization's entities. `total_equity_value` sums every
 * valued entity; `consolidated_equity_value` eliminates a `subsidiary` on the
 * assumption a `parent` entity's valuation already consolidates it — the
 * common holding-company reporting convention.
 *
 * That elimination is only sound while the parent is actually in the set, and
 * for a long time this function never checked. `parent_valuation_id` was
 * carried on every entity, selected by `loadEntities`, returned to the client
 * — and never read here: *every* subsidiary was dropped from the consolidated
 * figure, anchored or not. Four ordinary sequences reach the unanchored state,
 * and none of them looks like a mistake while you are doing it:
 *
 *   - assign an entity with `entity_type: 'subsidiary'` and stop. The
 *     assignment route takes the type; the parent link is a second request to
 *     a different route, and nothing insists on it.
 *   - detach or archive the parent and leave the subsidiary. `loadEntities`
 *     filters `archived_at IS NULL`, so a withdrawn parent leaves the roll-up
 *     while its subsidiary stays in it.
 *   - point `parent_valuation_id` at a valuation in another organization —
 *     permitted, and invisible from inside this one.
 *   - delete the organization the parent belonged to.
 *
 * In each case the subsidiary's equity was eliminated as double-counted
 * against a parent that is not there, so the consolidated equity of the
 * holding company came back understated by the whole subsidiary, silently, in
 * the figure this file's own comments call the one an auditor relies on.
 *
 * Equity values carry the currency of their own valuation, and an organization
 * may well hold a US subsidiary next to a European one. Adding those figures
 * produces a number in no currency at all, and the caller cannot tell: it used
 * to receive a single total plus a list of currencies and would label the sum
 * with whichever one came back first, so a $10M + €5M portfolio reported
 * "$15,000,000". The scalar totals are therefore only populated when a single
 * currency is in play; when more than one is, they are `null` and the honest
 * figures live in `by_currency`, one roll-up per currency.
 */
export function consolidate(entities: PortfolioEntity[]): ConsolidatedReport {
  const byType = Object.fromEntries(ENTITY_TYPES.map((t) => [t, { count: 0, equity_value: 0 }])) as Record<
    EntityType,
    { count: number; equity_value: number }
  >;

  let total = 0;
  let consolidated = 0;
  let valued = 0;
  const perCurrency = new Map<string, CurrencyTotals>();
  // The ids present in this roll-up. A subsidiary is only double-counted by a
  // parent that is here to double-count it.
  //
  // "Here" means this page of entities: `loadEntities` caps at
  // ORG_ENTITY_PAGE_LIMIT, so a parent past the cap reads as absent and its
  // subsidiary is counted. That is the safe direction — the totals already
  // cover a prefix, and the page says so above them — and it is the same answer
  // the roll-up gives for a parent that is genuinely gone.
  const present = new Set(entities.map((e) => e.valuation_id));
  const unanchored: Array<{ valuation_id: string; company_name: string }> = [];

  for (const e of entities) {
    byType[e.entity_type].count += 1;
    let bucket = perCurrency.get(e.currency);
    if (!bucket) {
      bucket = {
        currency: e.currency,
        entity_count: 0,
        valued_count: 0,
        total_equity_value: 0,
        consolidated_equity_value: 0,
      };
      perCurrency.set(e.currency, bucket);
    }
    bucket.entity_count += 1;
    // Decided per entity, not per value: an unvalued subsidiary is still
    // unanchored and still worth naming, and the reader who fixes the link is
    // the same reader who will later give it a number.
    const anchored = e.parent_valuation_id !== null && present.has(e.parent_valuation_id);
    const eliminated = e.entity_type === 'subsidiary' && anchored;
    if (e.entity_type === 'subsidiary' && !anchored) {
      unanchored.push({ valuation_id: e.valuation_id, company_name: e.company_name });
    }
    if (e.equity_value !== null) {
      valued += 1;
      total += e.equity_value;
      bucket.valued_count += 1;
      bucket.total_equity_value += e.equity_value;
      byType[e.entity_type].equity_value += e.equity_value;
      if (!eliminated) {
        consolidated += e.equity_value;
        bucket.consolidated_equity_value += e.equity_value;
      }
    }
  }

  const byCurrency = [...perCurrency.values()]
    .map((b) => ({
      ...b,
      total_equity_value: round2(b.total_equity_value),
      consolidated_equity_value: round2(b.consolidated_equity_value),
    }))
    .sort((a, b) =>
      b.total_equity_value !== a.total_equity_value
        ? b.total_equity_value - a.total_equity_value
        : a.currency.localeCompare(b.currency),
    );
  const mixed = perCurrency.size > 1;

  return {
    entity_count: entities.length,
    valued_count: valued,
    total_equity_value: mixed ? null : round2(total),
    consolidated_equity_value: mixed ? null : round2(consolidated),
    by_entity_type: mixed
      ? (Object.fromEntries(
          ENTITY_TYPES.map((t) => [t, { count: byType[t].count, equity_value: null }]),
        ) as Record<EntityType, { count: number; equity_value: number | null }>)
      : byType,
    by_currency: byCurrency,
    currencies: [...perCurrency.keys()],
    mixed_currency: mixed,
    unanchored_subsidiaries: unanchored,
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
