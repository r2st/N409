import { describe, it, expect } from 'vitest';
import { buildEntityTree, consolidate, type PortfolioEntity } from '../../src/domain/portfolio.js';

const entity = (over: Partial<PortfolioEntity> & { valuation_id: string }): PortfolioEntity => ({
  valuation_id: over.valuation_id,
  number: over.number ?? over.valuation_id,
  company_name: over.company_name ?? 'Co',
  entity_type: over.entity_type ?? 'standalone',
  parent_valuation_id: over.parent_valuation_id ?? null,
  state: over.state ?? 'draft',
  equity_value: over.equity_value ?? null,
  fmv_per_share: over.fmv_per_share ?? null,
  as_of: over.as_of ?? null,
  currency: over.currency ?? 'USD',
});

describe('portfolio consolidation (feature 6)', () => {
  it('sums total equity but excludes subsidiaries from the consolidated figure', () => {
    const report = consolidate([
      entity({ valuation_id: 'p', entity_type: 'parent', equity_value: 10_000_000 }),
      entity({ valuation_id: 's', entity_type: 'subsidiary', equity_value: 3_000_000 }),
      entity({ valuation_id: 'x', entity_type: 'portfolio_company', equity_value: 5_000_000 }),
    ]);
    expect(report.entity_count).toBe(3);
    expect(report.valued_count).toBe(3);
    expect(report.total_equity_value).toBe(18_000_000);
    // subsidiary excluded → 10M + 5M
    expect(report.consolidated_equity_value).toBe(15_000_000);
    expect(report.by_entity_type.subsidiary.equity_value).toBe(3_000_000);
  });

  it('ignores unvalued entities in the totals', () => {
    const report = consolidate([
      entity({ valuation_id: 'a', equity_value: 1_000_000 }),
      entity({ valuation_id: 'b', equity_value: null }),
    ]);
    expect(report.entity_count).toBe(2);
    expect(report.valued_count).toBe(1);
    expect(report.total_equity_value).toBe(1_000_000);
  });

  it('collects the distinct currencies present', () => {
    const report = consolidate([
      entity({ valuation_id: 'a', currency: 'USD' }),
      entity({ valuation_id: 'b', currency: 'EUR' }),
      entity({ valuation_id: 'c', currency: 'USD' }),
    ]);
    expect(report.currencies.sort()).toEqual(['EUR', 'USD']);
  });

  it('builds a parent → children tree from inter-company references', () => {
    const { roots, childrenOf } = buildEntityTree([
      entity({ valuation_id: 'parent', entity_type: 'parent' }),
      entity({ valuation_id: 'sub1', entity_type: 'subsidiary', parent_valuation_id: 'parent' }),
      entity({ valuation_id: 'sub2', entity_type: 'subsidiary', parent_valuation_id: 'parent' }),
      entity({ valuation_id: 'orphan', parent_valuation_id: 'not-in-set' }),
    ]);
    expect(roots.sort()).toEqual(['orphan', 'parent']);
    expect(childrenOf['parent']!.sort()).toEqual(['sub1', 'sub2']);
  });

  it('still surfaces entities caught in a parent cycle', () => {
    // Rows predating the API's cycle check: a↔b parent each other, so neither
    // is a root by the naive rule and the whole branch would disappear from
    // the portfolio view. Every entity must remain reachable.
    const { roots, childrenOf } = buildEntityTree([
      entity({ valuation_id: 'top' }),
      entity({ valuation_id: 'a', parent_valuation_id: 'b' }),
      entity({ valuation_id: 'b', parent_valuation_id: 'a' }),
    ]);
    expect(roots).toContain('top');
    // Exactly one of the pair is promoted; the other hangs off it as a child.
    expect(roots).toContain('a');
    expect(roots).not.toContain('b');
    expect(childrenOf['a']).toEqual(['b']);
  });

  it('reaches every entity from some root, cycles included', () => {
    const entities = [
      entity({ valuation_id: 'root' }),
      entity({ valuation_id: 'child', parent_valuation_id: 'root' }),
      entity({ valuation_id: 'x', parent_valuation_id: 'y' }),
      entity({ valuation_id: 'y', parent_valuation_id: 'z' }),
      entity({ valuation_id: 'z', parent_valuation_id: 'x' }),
    ];
    const { roots, childrenOf } = buildEntityTree(entities);

    const seen = new Set<string>();
    const walk = (id: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const child of childrenOf[id] ?? []) walk(child);
    };
    for (const r of roots) walk(r);

    expect([...seen].sort()).toEqual(['child', 'root', 'x', 'y', 'z']);
  });
});
