import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapTableGraph, type CapTableGraphData } from '../src/components/CapTableGraph';

/**
 * `as_converted_shares` defaults to the node's own share count — the 1:1 case,
 * which is every class on this fixture unless a test says otherwise. Applied
 * after the spread reads `shares` so an override of one still lands, and
 * overridable itself for the tests that want the two to differ.
 */
const node = (over: Partial<CapTableGraphData['nodes'][number]> & { id: string; label: string }) => {
  const base = {
    kind: 'share_class' as const,
    rank: 1,
    shares: 1_000_000,
    ownership: 0.1,
    class_type: 'preferred',
    seniority: null,
    liquidation_preference: null,
    price_per_share: null,
    invested_amount: null,
    conversion_ratio: null,
    ...over,
  };
  return { as_converted_shares: base.shares, ...base };
};

const GRAPH: CapTableGraphData = {
  nodes: [
    node({
      id: 'company:acme',
      label: 'Acme Corp',
      kind: 'company',
      rank: 0,
      class_type: null,
      ownership: 1,
    }),
    node({
      id: 'class:series-a',
      label: 'Series A',
      rank: 1,
      seniority: 2,
      invested_amount: 9_000_000,
      liquidation_preference: 9_000_000,
      price_per_share: 3,
      conversion_ratio: 1,
    }),
    node({ id: 'class:series-seed', label: 'Series Seed', rank: 2, seniority: 1 }),
    node({
      id: 'class:common',
      label: 'Common',
      rank: 3,
      class_type: 'common',
      ownership: 0.57,
      shares: 8_000_000,
    }),
    node({ id: 'class:pool', label: 'Option Pool', rank: 3, kind: 'option_pool', class_type: 'option' }),
  ],
  edges: [
    { from: 'company:acme', to: 'class:series-a', kind: 'issued', label: 'issued' },
    { from: 'class:series-a', to: 'class:series-seed', kind: 'senior_to', label: 'senior to' },
    { from: 'class:series-a', to: 'class:common', kind: 'converts_to', label: 'converts 1:1' },
    { from: 'class:pool', to: 'class:common', kind: 'converts_to', label: 'exercises into' },
  ],
  issues: [],
};

describe('CapTableGraph', () => {
  it('draws a node per security and labels the picture for assistive tech', () => {
    render(<CapTableGraph graph={GRAPH} />);
    expect(screen.getByRole('img', { name: /liquidation order/i })).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Series A')).toBeInTheDocument();
    expect(screen.getByText('Option Pool')).toBeInTheDocument();
  });

  it('columns nodes by rank, so payment order is left to right', () => {
    const { container } = render(<CapTableGraph graph={GRAPH} />);
    const x = (label: string) => {
      const text = [...container.querySelectorAll('text')].find((t) => t.textContent === label)!;
      const transform = text.closest('g')!.getAttribute('transform')!;
      return Number(/translate\(([-\d.]+)/.exec(transform)![1]);
    };
    expect(x('Acme Corp')).toBeLessThan(x('Series A'));
    expect(x('Series A')).toBeLessThan(x('Series Seed'));
    expect(x('Series Seed')).toBeLessThan(x('Common'));
    // Same rank, same column.
    expect(x('Common')).toBe(x('Option Pool'));
  });

  it('states each class’s seniority on the node', () => {
    render(<CapTableGraph graph={GRAPH} />);
    expect(screen.getByText('sr 2')).toBeInTheDocument();
    expect(screen.getByText('sr 1')).toBeInTheDocument();
  });

  it('shows fully-diluted ownership without a percentage on the company itself', () => {
    render(<CapTableGraph graph={GRAPH} />);
    expect(screen.getByText('57.0%')).toBeInTheDocument();
    expect(screen.queryByText('100.0%')).toBeNull();
  });

  it('opens the detail panel on selection and closes it on a second click', async () => {
    const user = userEvent.setup();
    render(<CapTableGraph graph={GRAPH} />);
    await user.click(screen.getByRole('button', { name: /Series A/ }));
    expect(screen.getByText('Liquidation preference')).toBeInTheDocument();
    // Preference and invested happen to be equal here (a 1× stack), so both
    // cells carry the same figure.
    expect(screen.getAllByText('$9,000,000')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: /Series A/ }));
    expect(screen.queryByText('Liquidation preference')).toBeNull();
  });

  it('says an unstated seniority is unstated rather than showing a zero', async () => {
    // The difference between "last in the stack" and "nobody filled this
    // column in" is the whole reason the graph warns about partial stacks.
    const user = userEvent.setup();
    render(<CapTableGraph graph={GRAPH} />);
    await user.click(screen.getByRole('button', { name: /Common/ }));
    expect(screen.getByText('Not stated')).toBeInTheDocument();
  });

  /**
   * The node prints a share count and, beside it, a percentage struck on the
   * as-converted count. For a class converting at other than 1:1 those are two
   * different numbers, so the one shown has to be the one the percentage came
   * from — otherwise the node reads as arithmetic that does not check out.
   */
  describe('a class converting at other than 1:1', () => {
    const RATCHET: CapTableGraphData = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) =>
        n.label === 'Series A'
          ? { ...n, shares: 1_250_000, as_converted_shares: 2_500_000, conversion_ratio: 2, ownership: 0.2 }
          : n,
      ),
    };

    it('labels the node with the count the percentage was struck on', () => {
      render(<CapTableGraph graph={RATCHET} />);
      expect(screen.getByText('2,500,000 sh a/c')).toBeInTheDocument();
      // The outstanding count is not what sits beside the percentage.
      expect(screen.queryByText('1,250,000 sh')).toBeNull();
    });

    it('gives the detail panel both counts, each named', async () => {
      const user = userEvent.setup();
      render(<CapTableGraph graph={RATCHET} />);
      await user.click(screen.getByRole('button', { name: /Series A/ }));
      expect(screen.getByText('Shares (outstanding)')).toBeInTheDocument();
      expect(screen.getByText('1,250,000')).toBeInTheDocument();
      expect(screen.getByText('Shares (as-converted)')).toBeInTheDocument();
      expect(screen.getByText('2,500,000')).toBeInTheDocument();
    });

    it('does not split the column for a class that converts 1:1', async () => {
      const user = userEvent.setup();
      render(<CapTableGraph graph={RATCHET} />);
      await user.click(screen.getByRole('button', { name: /Common/ }));
      expect(screen.getByText('Shares')).toBeInTheDocument();
      expect(screen.queryByText('Shares (as-converted)')).toBeNull();
    });
  });

  it('marks an assumed conversion ratio as assumed', async () => {
    const user = userEvent.setup();
    render(<CapTableGraph graph={GRAPH} />);
    await user.click(screen.getByRole('button', { name: /Option Pool/ }));
    expect(screen.getByText('1:1 (assumed)')).toBeInTheDocument();
  });

  it('renders structural issues above the drawing, by severity', () => {
    render(
      <CapTableGraph
        graph={{
          ...GRAPH,
          issues: [
            { severity: 'warning', code: 'partial_seniority', message: '2 of 3 state a seniority.' },
            { severity: 'error', code: 'no_common', message: 'No common class.' },
          ],
        }}
      />,
    );
    expect(screen.getByText('2 of 3 state a seniority.')).toBeInTheDocument();
    expect(screen.getByText('No common class.')).toBeInTheDocument();
  });

  it('legends the edge kinds, because the line style carries the meaning', () => {
    render(<CapTableGraph graph={GRAPH} />);
    expect(screen.getByText('Issued by the company')).toBeInTheDocument();
    expect(screen.getByText('Converts / exercises into')).toBeInTheDocument();
    expect(screen.getByText('Paid before')).toBeInTheDocument();
  });

  it('survives a cap table with nothing but the company in it', () => {
    render(
      <CapTableGraph
        graph={{
          nodes: [
            node({
              id: 'company:x',
              label: 'Empty Co',
              kind: 'company',
              rank: 0,
              class_type: null,
              ownership: null,
              shares: 0,
            }),
          ],
          edges: [],
          issues: [],
        }}
      />,
    );
    expect(screen.getByText('Empty Co')).toBeInTheDocument();
  });
});
