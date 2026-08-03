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

  it('reports a single currency roll-up alongside the scalar totals', () => {
    const report = consolidate([
      entity({ valuation_id: 'a', equity_value: 4_000_000 }),
      entity({ valuation_id: 'b', entity_type: 'subsidiary', equity_value: 1_000_000 }),
    ]);
    expect(report.mixed_currency).toBe(false);
    expect(report.total_equity_value).toBe(5_000_000);
    expect(report.consolidated_equity_value).toBe(4_000_000);
    expect(report.by_currency).toEqual([
      {
        currency: 'USD',
        entity_count: 2,
        valued_count: 2,
        total_equity_value: 5_000_000,
        consolidated_equity_value: 4_000_000,
      },
    ]);
  });

  it('refuses to add equity values denominated in different currencies', () => {
    // $10M + €5M is not $15M, and the caller labelled the sum with whichever
    // currency it saw first. There is no single total here.
    const report = consolidate([
      entity({ valuation_id: 'us', currency: 'USD', equity_value: 10_000_000 }),
      entity({ valuation_id: 'eu', currency: 'EUR', equity_value: 5_000_000 }),
    ]);
    expect(report.mixed_currency).toBe(true);
    expect(report.total_equity_value).toBeNull();
    expect(report.consolidated_equity_value).toBeNull();
    expect(report.by_entity_type.standalone.count).toBe(2);
    expect(report.by_entity_type.standalone.equity_value).toBeNull();
  });

  it('breaks a mixed-currency portfolio out per currency, largest first', () => {
    const report = consolidate([
      entity({ valuation_id: 'eu1', currency: 'EUR', equity_value: 5_000_000 }),
      entity({ valuation_id: 'us1', currency: 'USD', equity_value: 8_000_000 }),
      entity({
        valuation_id: 'us2',
        currency: 'USD',
        entity_type: 'subsidiary',
        equity_value: 2_000_000,
      }),
      entity({ valuation_id: 'gb1', currency: 'GBP', equity_value: null }),
    ]);
    expect(report.by_currency.map((c) => c.currency)).toEqual(['USD', 'EUR', 'GBP']);
    const usd = report.by_currency[0]!;
    expect(usd).toEqual({
      currency: 'USD',
      entity_count: 2,
      valued_count: 2,
      total_equity_value: 10_000_000,
      consolidated_equity_value: 8_000_000,
    });
    // An unvalued entity still contributes its currency and its head count.
    expect(report.by_currency[2]).toEqual({
      currency: 'GBP',
      entity_count: 1,
      valued_count: 0,
      total_equity_value: 0,
      consolidated_equity_value: 0,
    });
    expect(report.valued_count).toBe(3);
  });

  it('rounds each currency bucket to cents', () => {
    const report = consolidate([
      entity({ valuation_id: 'a', currency: 'USD', equity_value: 0.1 }),
      entity({ valuation_id: 'b', currency: 'USD', equity_value: 0.2 }),
      entity({ valuation_id: 'c', currency: 'JPY', equity_value: 1 }),
    ]);
    expect(report.by_currency.find((c) => c.currency === 'USD')!.total_equity_value).toBe(0.3);
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
