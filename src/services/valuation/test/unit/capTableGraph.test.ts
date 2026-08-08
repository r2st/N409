import { describe, expect, it } from 'vitest';
import { buildCapTableGraph } from '../../src/domain/capTableGraph.js';
import type { CapTableEntry } from '../../src/domain/capTable.js';

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
    // Sorted by name a table shows "Series A, Series B, Series Seed" while the
    // money goes B, A, Seed. That inversion is the reason the graph exists.
    const { nodes } = build([COMMON, SEED, A, B]);
    const stack = nodes
      .filter((n) => n.class_type === 'preferred')
      .sort((x, y) => x.rank - y.rank)
      .map((n) => n.label);
    expect(stack).toEqual(['Series B', 'Series A', 'Series Seed']);
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
    expect(senior.map((e) => `${e.from}→${e.to}`)).toEqual([
      'class:series-b→class:series-a',
      'class:series-a→class:series-seed',
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

  it('multiplies the preference out rather than showing the multiple alone', () => {
    const participating = entry({ ...A, liquidation_multiple: 2, invested_amount: 9_000_000 });
    const { nodes } = build([COMMON, participating]);
    expect(nodes.find((n) => n.label === 'Series A')!.liquidation_preference).toBe(18_000_000);
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
