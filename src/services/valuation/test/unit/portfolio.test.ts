import { describe, it, expect } from 'vitest';
import { buildEntityTree, consolidate, type PortfolioEntity } from '../../src/domain/portfolio.js';

const entity = (over: Partial<PortfolioEntity> & { valuation_id: string }): PortfolioEntity => ({
  valuation_id: over.valuation_id,
  number: over.number ?? over.valuation_id,
  company_name: over.company_name ?? 'Co',
  entity_type: over.entity_type ?? 'standalone',
  parent_valuation_id: over.parent_valuation_id ?? null,
  state: over.state ?? 'draft',
  kind: over.kind ?? '409a',
  equity_value: over.equity_value ?? null,
  fmv_per_share: over.fmv_per_share ?? null,
  as_of: over.as_of ?? null,
  currency: over.currency ?? 'USD',
});

describe('portfolio consolidation (feature 6)', () => {
  it('sums total equity but excludes subsidiaries from the consolidated figure', () => {
    const report = consolidate([
      entity({ valuation_id: 'p', entity_type: 'parent', equity_value: 10_000_000 }),
      entity({
        valuation_id: 's',
        entity_type: 'subsidiary',
        parent_valuation_id: 'p',
        equity_value: 3_000_000,
      }),
      entity({ valuation_id: 'x', entity_type: 'portfolio_company', equity_value: 5_000_000 }),
    ]);
    expect(report.entity_count).toBe(3);
    expect(report.valued_count).toBe(3);
    expect(report.total_equity_value).toBe(18_000_000);
    // subsidiary excluded → 10M + 5M
    expect(report.consolidated_equity_value).toBe(15_000_000);
    expect(report.by_entity_type.subsidiary.equity_value).toBe(3_000_000);
    expect(report.unanchored_subsidiaries).toEqual([]);
  });

  describe('a subsidiary is only eliminated by a parent that is present', () => {
    // The elimination exists to avoid double counting. Applied to a subsidiary
    // whose parent is not in the roll-up it does the opposite — it removes a
    // value nothing else contains — and the holding company's consolidated
    // equity comes back short by the whole subsidiary with nothing said.
    it('counts a subsidiary that was never given a parent', () => {
      const report = consolidate([
        entity({ valuation_id: 'p', entity_type: 'parent', equity_value: 10_000_000 }),
        // Assigned with `entity_type: 'subsidiary'` and never linked: the
        // assignment route takes the type, the parent link is a second call to
        // a different route, and nothing insists on it.
        entity({ valuation_id: 's', entity_type: 'subsidiary', equity_value: 3_000_000 }),
      ]);
      expect(report.total_equity_value).toBe(13_000_000);
      expect(report.consolidated_equity_value).toBe(13_000_000);
      expect(report.unanchored_subsidiaries).toEqual([{ valuation_id: 's', company_name: 'Co' }]);
    });

    it('counts a subsidiary whose parent has left the roll-up', () => {
      // The parent was archived or detached; `loadEntities` filters it out and
      // the subsidiary stays. Same arithmetic, arrived at by doing nothing.
      const report = consolidate([
        entity({
          valuation_id: 's',
          company_name: 'Sub Ltd',
          entity_type: 'subsidiary',
          parent_valuation_id: 'gone',
          equity_value: 3_000_000,
        }),
      ]);
      expect(report.consolidated_equity_value).toBe(3_000_000);
      expect(report.unanchored_subsidiaries).toEqual([{ valuation_id: 's', company_name: 'Sub Ltd' }]);
    });

    it('reports an unvalued unanchored subsidiary too', () => {
      // Nothing to add to the total, but the link is still missing, and the
      // reader who fixes it is the one who will later give this a number.
      const report = consolidate([
        entity({ valuation_id: 's', entity_type: 'subsidiary', equity_value: null }),
      ]);
      expect(report.valued_count).toBe(0);
      expect(report.unanchored_subsidiaries).toHaveLength(1);
    });

    it('applies the same rule inside each currency bucket', () => {
      // The per-currency roll-up is the figure a mixed portfolio is actually
      // read from — the scalars are null there — so a fix that only reached
      // the scalars would leave the bug where it is most often seen.
      const report = consolidate([
        entity({ valuation_id: 'p', entity_type: 'parent', equity_value: 10_000_000 }),
        entity({
          valuation_id: 's',
          entity_type: 'subsidiary',
          parent_valuation_id: 'p',
          equity_value: 3_000_000,
        }),
        entity({
          valuation_id: 'u',
          entity_type: 'subsidiary',
          parent_valuation_id: 'elsewhere',
          equity_value: 4_000_000,
        }),
      ]);
      const usd = report.by_currency.find((c) => c.currency === 'USD')!;
      expect(usd.total_equity_value).toBe(17_000_000);
      // 10M parent + 4M unanchored; only the anchored 3M is eliminated.
      expect(usd.consolidated_equity_value).toBe(14_000_000);
      expect(report.consolidated_equity_value).toBe(14_000_000);
    });
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
      entity({ valuation_id: 'a', entity_type: 'parent', equity_value: 4_000_000 }),
      entity({
        valuation_id: 'b',
        entity_type: 'subsidiary',
        parent_valuation_id: 'a',
        equity_value: 1_000_000,
      }),
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
      entity({ valuation_id: 'us1', currency: 'USD', entity_type: 'parent', equity_value: 8_000_000 }),
      entity({
        valuation_id: 'us2',
        currency: 'USD',
        entity_type: 'subsidiary',
        parent_valuation_id: 'us1',
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

/**
 * Only an equity value may be added to an equity value.
 *
 * `equity_value` is a 409A column by name and every specialty engine writes
 * into it, because it is the column the row has (`specialtyHeadline`). On three
 * kinds what lands there is not an equity value at all — an IFRS 2 total
 * share-based-payment expense, an ASC 820 portfolio total, the value of the
 * interest a gift & estate appraisal transferred. All three are positive, so
 * summing them left the holding company's consolidated equity plausibly
 * overstated rather than obviously broken, in the figure this module's own
 * comments call the one an auditor relies on.
 *
 * A group having those engagements alongside its 409As is ordinary, not exotic:
 * a UK subsidiary files an IFRS 2 memo, a founder makes a gift of stock.
 */
describe('consolidation adds up only figures that are equity values', () => {
  it('keeps an IFRS 2 total expense out of the consolidated equity', () => {
    const report = consolidate([
      entity({ valuation_id: 'p', entity_type: 'parent', kind: '409a', equity_value: 50_000_000 }),
      entity({
        valuation_id: 'x',
        company_name: 'Northwind UK Ltd',
        kind: 'ifrs2',
        equity_value: 420_000,
      }),
    ]);
    expect(report.total_equity_value).toBe(50_000_000);
    expect(report.consolidated_equity_value).toBe(50_000_000);
    // The entity is real and stays counted; it is what it concluded that
    // cannot be added up.
    expect(report.entity_count).toBe(2);
    expect(report.valued_count).toBe(1);
    expect(report.by_entity_type.standalone.equity_value).toBe(0);
    expect(report.non_equity_entities).toEqual([
      {
        valuation_id: 'x',
        company_name: 'Northwind UK Ltd',
        kind: 'ifrs2',
        figure: 'Total expense',
      },
    ]);
  });

  it('names what each excluded entity concluded instead', () => {
    // The caption is the deliverable's own, so the banner and the exhibit say
    // the same thing about the same figure.
    const report = consolidate([
      entity({ valuation_id: 'a', kind: '409a', equity_value: 10_000_000 }),
      entity({ valuation_id: 'b', kind: '820', equity_value: 7_000_000 }),
      entity({ valuation_id: 'c', kind: 'gifts', equity_value: 2_500_000 }),
    ]);
    expect(report.total_equity_value).toBe(10_000_000);
    expect(report.non_equity_entities.map((e) => e.figure)).toEqual([
      'Total fair value',
      'Concluded value of the transferred interest',
    ]);
  });

  it('still adds the kinds whose column really is this entity’s equity', () => {
    /*
     * The rule is about the figure, not about whether the engine is a specialty
     * one. An ESOP's *appraised* equity value and the equity value an EMI
     * scheme valuation struck its AMV from are both this company's equity, and
     * both belong in a roll-up; a small-business FMV concludes one outright.
     */
    const report = consolidate([
      entity({ valuation_id: 'a', kind: '409a', equity_value: 10_000_000 }),
      entity({ valuation_id: 'b', kind: 'esop', equity_value: 8_000_000 }),
      entity({ valuation_id: 'c', kind: 'emi', equity_value: 6_000_000 }),
      entity({ valuation_id: 'd', kind: 'fmv', equity_value: 1_000_000 }),
    ]);
    expect(report.total_equity_value).toBe(25_000_000);
    expect(report.valued_count).toBe(4);
    expect(report.non_equity_entities).toEqual([]);
  });

  it('reports nothing where there is no figure to exclude', () => {
    // A QSBS attestation writes no equity column at all, so it is an unvalued
    // entity like any other — not an exclusion the reader needs explaining.
    const report = consolidate([
      entity({ valuation_id: 'a', kind: '409a', equity_value: 10_000_000 }),
      entity({ valuation_id: 'b', kind: 'qsbs', equity_value: null }),
    ]);
    expect(report.entity_count).toBe(2);
    expect(report.valued_count).toBe(1);
    expect(report.non_equity_entities).toEqual([]);
  });

  it('excludes a non-equity figure from its currency roll-up too', () => {
    const report = consolidate([
      entity({ valuation_id: 'a', kind: '409a', equity_value: 10_000_000, currency: 'USD' }),
      entity({ valuation_id: 'b', kind: 'ifrs2', equity_value: 420_000, currency: 'USD' }),
    ]);
    const usd = report.by_currency.find((c) => c.currency === 'USD')!;
    expect(usd.total_equity_value).toBe(10_000_000);
    expect(usd.consolidated_equity_value).toBe(10_000_000);
    expect(usd.entity_count).toBe(2);
    expect(usd.valued_count).toBe(1);
  });

  it('does not eliminate a subsidiary twice over', () => {
    // A subsidiary excluded for its *kind* must not also be reported as one
    // whose equity was eliminated against a parent — it was never added.
    const report = consolidate([
      entity({ valuation_id: 'p', entity_type: 'parent', kind: '409a', equity_value: 50_000_000 }),
      entity({
        valuation_id: 's',
        entity_type: 'subsidiary',
        parent_valuation_id: 'p',
        kind: 'ifrs2',
        equity_value: 420_000,
      }),
    ]);
    expect(report.consolidated_equity_value).toBe(50_000_000);
    expect(report.total_equity_value).toBe(50_000_000);
    expect(report.unanchored_subsidiaries).toEqual([]);
    expect(report.non_equity_entities).toHaveLength(1);
  });
});
