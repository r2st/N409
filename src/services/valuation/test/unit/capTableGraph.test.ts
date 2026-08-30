import { describe, expect, it } from 'vitest';
import { buildCapTableGraph } from '../../src/domain/capTableGraph.js';
import { toWaterfallInputs, type CapTableEntry } from '../../src/domain/capTable.js';

const entry = (
  over: Partial<CapTableEntry> & Pick<CapTableEntry, 'security_class' | 'class_type'>,
): CapTableEntry => ({
  shares: 1_000_000,
  price_per_share: null,
  invested_amount: null,
  liquidation_multiple: null,
  seniority: null,
  conversion_ratio: null,
  ...over,
});

const COMMON = entry({ security_class: 'Common', class_type: 'common', shares: 8_000_000 });
const SEED = entry({
  security_class: 'Series Seed',
  class_type: 'preferred',
  shares: 2_000_000,
  seniority: 1,
  invested_amount: 2_000_000,
  liquidation_multiple: 1,
});
const A = entry({
  security_class: 'Series A',
  class_type: 'preferred',
  shares: 3_000_000,
  seniority: 2,
  invested_amount: 9_000_000,
  liquidation_multiple: 1,
});
const B = entry({
  security_class: 'Series B',
  class_type: 'preferred',
  shares: 4_000_000,
  seniority: 3,
  invested_amount: 20_000_000,
  liquidation_multiple: 1,
});
const POOL = entry({ security_class: 'Option Pool', class_type: 'option', shares: 1_000_000 });

const build = (entries: CapTableEntry[], rounds?: Parameters<typeof buildCapTableGraph>[0]['rounds']) =>
  buildCapTableGraph({ companyName: 'Acme Corp', entries, rounds });

describe('cap table graph', () => {
  it('ranks the preference stack in payment order, not name order', () => {
    // Seed is seniority 1, A is 2, B is 3 — and seniority 1 pays first, which
    // is the engine's rule (`waterfall.py` sorts the ranks ascending under
    // "1 = most senior"), the rule the importer states in `bad_seniority`, and
    // the rule Exhibit A prints. So the money goes Seed, A, B, and the first
    // column of the diagram is the first class paid.
    const { nodes } = build([COMMON, SEED, A, B]);
    const stack = nodes
      .filter((n) => n.class_type === 'preferred')
      .sort((x, y) => x.rank - y.rank)
      .map((n) => n.label);
    expect(stack).toEqual(['Series Seed', 'Series A', 'Series B']);
  });

  it('draws the stack in the order the engine would pay it', () => {
    // Tied directly to `toWaterfallInputs`, which is the projection the engine
    // consumes: whatever order it hands over, the diagram must match.
    const entries = [COMMON, B, SEED, A]; // deliberately not in stack order
    const drawn = build(entries)
      .nodes.filter((n) => n.class_type === 'preferred')
      .sort((x, y) => x.rank - y.rank)
      .map((n) => n.label);
    const paid = [...toWaterfallInputs(entries).preferred]
      .sort((x, y) => x.seniority - y.seniority)
      .map((p) => p.security_class);
    expect(drawn).toEqual(paid);
  });

  /**
   * The same parity, on the tables the test above cannot reach.
   *
   * `drawn` is a strict order and `paid` is a set of ranks, so once any class
   * leaves its seniority blank the two stop being comparable as lists — a pari
   * passu group has no order to compare. What must still hold is that the
   * picture never draws one class ahead of another the projection pays later:
   * seniority is non-decreasing along the drawn order.
   *
   * That is the case a blank Seniority column produces, and it is the ordinary
   * one — the Pulley preset maps no seniority at all. `toWaterfallInputs` used
   * to number unstated ranks by row position, so on `[B(2), Seed(blank)]` the
   * diagram drew B first while the engine feed had Seed at rank 2 alongside it,
   * and on a table with no stated seniority anywhere the feed invented a strict
   * stack out of the order the file happened to list its rounds in.
   */
  it('never draws a class ahead of one the engine feed pays later', () => {
    const rankOf = (entries: CapTableEntry[]) => {
      const paid = new Map(toWaterfallInputs(entries).preferred.map((p) => [p.security_class, p.seniority]));
      return build(entries)
        .nodes.filter((n) => n.class_type === 'preferred')
        .sort((x, y) => x.rank - y.rank)
        .map((n) => paid.get(n.label)!);
    };
    const blank = (name: string, invested: number): CapTableEntry =>
      entry({
        security_class: name,
        class_type: 'preferred',
        shares: 1_000_000,
        invested_amount: invested,
        liquidation_multiple: 1,
      });

    for (const table of [
      [COMMON, blank('Series B', 20_000_000), blank('Series Seed', 2_000_000)],
      [COMMON, blank('Series Seed', 2_000_000), blank('Series B', 20_000_000)],
      [COMMON, A, blank('Series Seed', 2_000_000)],
      [COMMON, blank('Series Seed', 2_000_000), B, blank('Series C', 40_000_000)],
    ]) {
      const ranks = rankOf(table);
      expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    }
  });

  /**
   * `rank` is the column a node is drawn in, and the type has always said
   * "nodes sharing a rank are drawn side by side". The drawing never produced
   * one: it numbered the sorted classes `i + 1`, so two classes explicitly at
   * seniority 2 came back in separate columns with a "senior to" arrow between
   * them — on a response whose own `duplicate_seniority` issue says they "will
   * be paid pari passu".
   */
  describe('a pari passu rank', () => {
    const pari = (name: string, seniority: number | null, invested: number) =>
      entry({
        security_class: name,
        class_type: 'preferred',
        shares: 1_000_000,
        seniority,
        invested_amount: invested,
        liquidation_multiple: 1,
      });

    it('draws classes sharing a stated rank side by side, not one behind the other', () => {
      const { nodes, edges } = build([COMMON, SEED, pari('Series A', 2, 9e6), pari('Series A-1', 2, 3e6)]);
      const rank = (label: string) => nodes.find((n) => n.label === label)!.rank;
      expect(rank('Series Seed')).toBe(1);
      expect(rank('Series A')).toBe(2);
      expect(rank('Series A-1')).toBe(2);
      // The stack is two columns deep, so common sits in the third.
      expect(rank('Common')).toBe(3);
      expect(
        edges.some(
          (e) => e.kind === 'senior_to' && [e.from, e.to].every((id) => id.startsWith('class:series-a')),
        ),
      ).toBe(false);
      // Seed is still drawn ahead of both.
      expect(edges.filter((e) => e.kind === 'senior_to')).toHaveLength(2);
    });

    it('puts a wholly unstated stack in one column', () => {
      const { nodes, edges } = build([COMMON, pari('Series Seed', null, 2e6), pari('Series B', null, 20e6)]);
      const rank = (label: string) => nodes.find((n) => n.label === label)!.rank;
      expect(rank('Series Seed')).toBe(1);
      expect(rank('Series B')).toBe(1);
      expect(rank('Common')).toBe(2);
      expect(edges.filter((e) => e.kind === 'senior_to')).toHaveLength(0);
    });

    it('still ranks an unstated class behind every stated one', () => {
      const { nodes } = build([COMMON, pari('Series B', 2, 20e6), pari('Series Seed', null, 2e6)]);
      const rank = (label: string) => nodes.find((n) => n.label === label)!.rank;
      expect(rank('Series B')).toBe(1);
      expect(rank('Series Seed')).toBe(2);
    });
  });

  it('puts common and the derivatives behind the whole stack', () => {
    const { nodes } = build([COMMON, SEED, A, B, POOL]);
    const commonRank = nodes.find((n) => n.label === 'Common')!.rank;
    expect(commonRank).toBe(4); // three preferred classes at 1..3
    expect(nodes.find((n) => n.label === 'Option Pool')!.rank).toBe(commonRank);
    expect(nodes.find((n) => n.kind === 'company')!.rank).toBe(0);
  });

  it('chains seniority between consecutive classes only', () => {
    // n² arrows between eight classes is a picture nobody can read, and the
    // chain carries the same ordering.
    const { edges } = build([COMMON, SEED, A, B]);
    const senior = edges.filter((e) => e.kind === 'senior_to');
    expect(senior).toHaveLength(2);
    // The arrow reads "is senior to", so it runs from the class paid first to
    // the one behind it: Seed (rank 1) is senior to A, and A to B.
    expect(senior.map((e) => `${e.from}→${e.to}`)).toEqual([
      'class:series-seed→class:series-a',
      'class:series-a→class:series-b',
    ]);
  });

  it('converts every non-common security into the single common class', () => {
    const { edges } = build([COMMON, SEED, A, POOL]);
    const converts = edges.filter((e) => e.kind === 'converts_to');
    expect(converts.map((e) => e.from).sort()).toEqual([
      'class:option-pool',
      'class:series-a',
      'class:series-seed',
    ]);
    expect(converts.every((e) => e.to === 'class:common')).toBe(true);
    // Options exercise, they do not convert — the label says which.
    expect(edges.find((e) => e.from === 'class:option-pool')!.label).toBe('exercises into');
  });

  it('states a non-unit conversion ratio on the edge', () => {
    const ratchet = entry({ ...A, conversion_ratio: 1.5 });
    const { edges } = build([COMMON, ratchet]);
    expect(edges.find((e) => e.kind === 'converts_to')!.label).toBe('converts 1.5:1');
  });

  it('draws no conversion arrows when the target is ambiguous', () => {
    // A dual-class charter makes the target a genuine question, and an arrow
    // drawn to a guess reads as a fact.
    const classB = entry({ security_class: 'Common B', class_type: 'common', shares: 1_000_000 });
    const graph = build([COMMON, classB, A]);
    expect(graph.edges.filter((e) => e.kind === 'converts_to')).toHaveLength(0);
    expect(graph.issues.map((i) => i.code)).toContain('multiple_common');
  });

  it('computes fully-diluted ownership across every class', () => {
    const { nodes } = build([COMMON, SEED, POOL]); // 8M + 2M + 1M
    expect(nodes.find((n) => n.label === 'Common')!.ownership).toBeCloseTo(8 / 11, 10);
    expect(nodes.find((n) => n.label === 'Option Pool')!.ownership).toBeCloseTo(1 / 11, 10);
    expect(nodes.find((n) => n.kind === 'company')!.shares).toBe(11_000_000);
  });

  /*
   * The graph draws the conversion ratio on the edge, so it cannot compute the
   * percentage on the node as though the ratio were 1 — the two would be the
   * same picture contradicting itself, and both are read at a glance.
   */
  describe('a class converting at other than 1:1', () => {
    const RATCHET = entry({ ...SEED, conversion_ratio: 2 });

    it('counts it as-converted in every ownership figure', () => {
      // 8M common + 2M seed at 2:1 + 1M pool = 13M as-converted, not 11M.
      const { nodes } = build([COMMON, RATCHET, POOL]);
      expect(nodes.find((n) => n.kind === 'company')!.shares).toBe(13_000_000);
      expect(nodes.find((n) => n.label === 'Common')!.ownership).toBeCloseTo(8 / 13, 10);
      expect(nodes.find((n) => n.label === 'Series Seed')!.ownership).toBeCloseTo(4 / 13, 10);
      expect(nodes.find((n) => n.label === 'Option Pool')!.ownership).toBeCloseTo(1 / 13, 10);
    });

    it('agrees with the edge label it draws for the same class', () => {
      const { edges } = build([COMMON, RATCHET, POOL]);
      const conversion = edges.find((e) => e.kind === 'converts_to' && e.from.includes('series-seed'));
      expect(conversion!.label).toBe('converts 2:1');
    });

    it('leaves the class its pre-conversion share count', () => {
      // `shares` is what the sheet says; `ownership` is what it converts into.
      expect(build([COMMON, RATCHET]).nodes.find((n) => n.label === 'Series Seed')!.shares).toBe(2_000_000);
    });

    /**
     * And carries the count in between, because `shares` and `ownership` are
     * now quoted on different bases and the node draws them side by side. The
     * ratio does not close that gap on its own: it says the two can differ,
     * not which of them the denominator used.
     */
    it('carries the as-converted count the ownership figure was struck on', () => {
      const { nodes } = build([COMMON, RATCHET, POOL]);
      const seed = nodes.find((n) => n.label === 'Series Seed')!;
      expect(seed.shares).toBe(2_000_000);
      expect(seed.as_converted_shares).toBe(4_000_000);
      // And it reconciles: the count over the company's total is the percentage.
      const total = nodes.find((n) => n.kind === 'company')!.shares;
      expect(seed.as_converted_shares! / total).toBeCloseTo(seed.ownership!, 10);
    });

    it('leaves a 1:1 class the same figure on both counts', () => {
      const { nodes } = build([COMMON, RATCHET, POOL]);
      for (const label of ['Common', 'Option Pool']) {
        const n = nodes.find((x) => x.label === label)!;
        expect(n.as_converted_shares).toBe(n.shares);
      }
    });

    /** Neither holds a class, so neither has a converted count to state. */
    it('leaves the company and a funding round without one', () => {
      const { nodes } = build(
        [COMMON, RATCHET],
        [{ id: 'r1', name: 'Seed', closed_on: null, shares_issued: 100 }],
      );
      expect(nodes.find((n) => n.kind === 'company')!.as_converted_shares).toBeNull();
      expect(nodes.find((n) => n.kind === 'funding_round')!.as_converted_shares).toBeNull();
    });

    it('sums every class to the whole company', () => {
      const { nodes } = build([COMMON, RATCHET, A, B, POOL]);
      const classes = nodes.filter((n) => n.kind !== 'company' && n.kind !== 'funding_round');
      expect(classes.reduce((sum, n) => sum + (n.ownership ?? 0), 0)).toBeCloseTo(1, 10);
    });
  });

  it('multiplies the preference out rather than showing the multiple alone', () => {
    const participating = entry({ ...A, liquidation_multiple: 2, invested_amount: 9_000_000 });
    const { nodes } = build([COMMON, participating]);
    expect(nodes.find((n) => n.label === 'Series A')!.liquidation_preference).toBe(18_000_000);
  });

  /**
   * The preference the *engine* will pay, defaults included.
   *
   * This is the one picture on the platform whose subject is the preference
   * stack, and it required both columns to be stated before it would draw one.
   * Neither is, on an ordinary export: Carta leaves "Amount Invested" blank and
   * carries the round price, and a 1× preference is usually stated by omission.
   * `toWaterfallInputs` fills both gaps, so the waterfall paid a class the
   * diagram drew as holding nothing.
   */
  describe('the preference a node draws', () => {
    const engineFor = (e: CapTableEntry) => {
      const p = toWaterfallInputs([COMMON, e]).preferred[0]!;
      return p.invested_amount * p.liquidation_multiple;
    };
    const drawnFor = (e: CapTableEntry) =>
      build([COMMON, e]).nodes.find((n) => n.label === e.security_class)!.liquidation_preference;

    it('reads a priced class with no stated amount as the engine does', () => {
      const priced = entry({
        security_class: 'Series A',
        class_type: 'preferred',
        shares: 2_000_000,
        price_per_share: 1.5,
        seniority: 1,
      });
      expect(engineFor(priced)).toBe(3_000_000);
      expect(drawnFor(priced)).toBe(3_000_000);
    });

    it('defaults an unstated multiple to 1×, as the engine does', () => {
      const noMultiple = entry({ ...A, liquidation_multiple: null });
      expect(engineFor(noMultiple)).toBe(9_000_000);
      expect(drawnFor(noMultiple)).toBe(9_000_000);
    });

    it('still draws nothing where there is neither an amount nor a price', () => {
      // `validateCapTable` raises `no_investment` on this row. An absent
      // preference is the truth about it, and showing it as $0 would read as a
      // measured figure rather than a missing one.
      const bare = entry({ ...A, invested_amount: null, price_per_share: null });
      expect(engineFor(bare)).toBe(0);
      expect(drawnFor(bare)).toBeNull();
    });
  });

  it('sorts unstated seniorities behind stated ones, by cheque size', () => {
    // An unstated seniority is far more often an unfilled column than a
    // genuine last place; ordering the unknowns by money at least puts the
    // largest cheque where an analyst looks.
    const stated = entry({ ...SEED, seniority: 5 });
    const bigUnstated = entry({ ...A, seniority: null, invested_amount: 20_000_000 });
    const smallUnstated = entry({ ...B, seniority: null, invested_amount: 1_000_000 });
    const { nodes } = build([COMMON, stated, smallUnstated, bigUnstated]);
    const order = nodes
      .filter((n) => n.class_type === 'preferred')
      .sort((x, y) => x.rank - y.rank)
      .map((n) => n.label);
    expect(order).toEqual(['Series Seed', 'Series A', 'Series B']);
  });

  it('warns when only some of the stack states a seniority', () => {
    const graph = build([COMMON, SEED, entry({ ...A, seniority: null })]);
    expect(graph.issues.map((i) => i.code)).toContain('partial_seniority');
  });

  it('warns on a duplicated seniority rank', () => {
    const graph = build([COMMON, SEED, entry({ ...A, seniority: 1 })]);
    expect(graph.issues.map((i) => i.code)).toContain('duplicate_seniority');
  });

  it('errors when nothing has anywhere to convert into', () => {
    const graph = build([SEED, A]);
    const issue = graph.issues.find((i) => i.code === 'no_common');
    expect(issue?.severity).toBe('error');
  });

  it('errors on a conversion ratio that converts into nothing', () => {
    const graph = build([COMMON, entry({ ...A, conversion_ratio: 0 })]);
    expect(graph.issues.find((i) => i.code === 'bad_conversion_ratio')?.severity).toBe('error');
  });

  it('hangs rounds off the company without inventing a class link', () => {
    // The stored rounds carry no link to the class they bought, and matching
    // "Series A" the round to "Series A" the class is a guess.
    const { nodes, edges } = build(
      [COMMON, A],
      [{ id: 'R1', name: 'Series A', closed_on: '2025-03-04', shares_issued: '3000000' }],
    );
    const round = nodes.find((n) => n.kind === 'funding_round')!;
    expect(round.label).toBe('Series A (2025-03-04)');
    expect(edges.filter((e) => e.from === round.id)).toEqual([
      { from: round.id, to: 'company:acme-corp', kind: 'funded', label: 'funded' },
    ]);
  });

  it('gives duplicate class names distinct node ids', () => {
    // Class names are user text off a spreadsheet, and two rows called
    // "Common" would otherwise collapse into one node.
    const { nodes } = build([COMMON, entry({ security_class: 'Common', class_type: 'common' })]);
    const ids = nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('handles an empty cap table without dividing by zero', () => {
    const graph = build([]);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]!.ownership).toBeNull();
    expect(graph.issues).toEqual([]);
  });
});
