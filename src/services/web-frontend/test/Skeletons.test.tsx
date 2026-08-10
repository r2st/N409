import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  LoadingBlock,
  PageSkeleton,
  Skeleton,
  SkeletonCardList,
  SkeletonDividedList,
  SkeletonStatStrip,
  SkeletonTable,
  SkeletonText,
  StatCardSkeleton,
  TableSkeleton,
} from '../src/components/ui';
import { DashboardPage } from '../src/pages/DashboardPage';
import type { User, Valuation } from '../src/lib/types';

let mockUser: User;
vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

const clientUser = {
  id: '01N409USER00000000000000CL',
  email: 'client@example.com',
  first_name: 'Cleo',
  last_name: 'Client',
  roles: ['valuation_user'],
} as unknown as User;

const opsUser = {
  id: '01N409USER00000000000000OP',
  email: 'ops@example.com',
  first_name: 'Otto',
  last_name: 'Ops',
  roles: ['admin'],
} as unknown as User;

/**
 * The contract every skeleton has to keep: exactly one announcement for the
 * whole placeholder, and none of the decoration exposed. A screen reader user
 * should hear "Loading valuations…" once, not thirty empty table cells.
 */
describe('skeleton accessibility', () => {
  it('announces once for a group of placeholders', () => {
    render(
      <LoadingBlock label="Loading valuations…">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-20" />
        <SkeletonText lines={4} />
      </LoadingBlock>,
    );
    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading valuations…')).toBeInTheDocument();
  });

  it('hides the placeholder blocks themselves from assistive tech', () => {
    const { container } = render(<SkeletonText lines={3} />);
    const blocks = container.querySelectorAll('.skeleton');
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      // Either the block or an ancestor carries aria-hidden.
      expect(block.closest('[aria-hidden]')).not.toBeNull();
    }
  });

  it('does not expose the placeholder table as a table', () => {
    render(<TableSkeleton columns={4} rows={3} label="Loading rows…" />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('nests without producing a second live region', () => {
    // PageSkeleton composes a table into a larger placeholder; if it reached
    // for TableSkeleton instead of SkeletonTable there would be two.
    render(<PageSkeleton />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });
});

describe('skeleton geometry', () => {
  it('draws a header row plus the requested body rows and columns', () => {
    const { container } = render(<SkeletonTable columns={3} rows={5} />);
    const rows = container.querySelectorAll('tr');
    expect(rows).toHaveLength(6); // 5 body rows + the header row
    expect(rows[0]!.querySelectorAll('td')).toHaveLength(3);
  });

  it('renders line widths deterministically across renders', () => {
    // A skeleton that reshuffles its widths on every render reads as flicker.
    const first = render(<SkeletonText lines={5} />).container.innerHTML;
    const second = render(<SkeletonText lines={5} />).container.innerHTML;
    expect(first).toBe(second);
  });

  it('matches StatCard box styling so the grid does not shift on load', () => {
    const { container } = render(<StatCardSkeleton />);
    const card = container.firstElementChild!;
    expect(card.className).toContain('rounded-lg');
    expect(card.className).toContain('border-paper-300');
    expect(card.className).toContain('shadow-card');
  });

  it('draws a card list as n separately bordered cards', () => {
    const { container } = render(<SkeletonCardList rows={4} lines={2} badges={2} />);
    const cards = container.querySelectorAll('.shadow-card');
    expect(cards).toHaveLength(4);
    // One title line + one meta line + two badge pills per card.
    expect(cards[0]!.querySelectorAll('.skeleton')).toHaveLength(4);
  });

  it('draws a divided list as one box with rules, not n shadows', () => {
    // The distinction is the point of having both: Documents and Tasks render
    // a single bordered container, so n cards would be the wrong picture.
    const { container } = render(<SkeletonDividedList rows={4} />);
    const boxes = container.querySelectorAll('.shadow-card');
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.className).toContain('divide-y');
    expect(boxes[0]!.children).toHaveLength(4);
  });

  it('draws the stat strip unboxed, so it sits where a bare <dl> will', () => {
    const { container } = render(<SkeletonStatStrip count={3} />);
    expect(container.querySelectorAll('.shadow-card')).toHaveLength(0);
    expect(container.firstElementChild!.children).toHaveLength(3);
  });

  it('keeps the new list primitives out of the accessibility tree', () => {
    const { container } = render(
      <>
        <SkeletonCardList rows={2} />
        <SkeletonDividedList rows={2} />
        <SkeletonStatStrip count={2} />
      </>,
    );
    for (const block of container.querySelectorAll('.skeleton')) {
      expect(block.closest('[aria-hidden]')).not.toBeNull();
    }
    // None of them owns a live region — that belongs to the LoadingBlock above.
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('dashboard loading state', () => {
  beforeEach(() => {
    mockUser = clientUser;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the stat-card placeholders while valuations are in flight, then the counts', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const valuations = [
      {
        id: '01N409VAL000000000000000AA',
        company_name: 'Acme',
        kind: '409a',
        state: 'started',
        waiting_on_client: false,
        created_at: '2026-06-01T00:00:00Z',
        due_date: null,
      },
    ] as unknown as Valuation[];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await gate;
      return new Response(JSON.stringify({ valuations, total: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const { container } = render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Loading your dashboard…')).toBeInTheDocument();
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
    // The heading is up before the data is — that is the point of the swap.
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();

    release!();
    await waitFor(() => expect(screen.getByText('Total')).toBeInTheDocument());
    expect(screen.queryByText('Loading your dashboard…')).toBeNull();
    expect(container.querySelectorAll('.skeleton')).toHaveLength(0);
  });
});

/**
 * The analytics pivot is a second, independent fetch that only ops and partners
 * make. It used to pop in with nothing holding its place; now it has one, which
 * makes *taking the placeholder down again* the thing worth pinning — the pivot
 * is null both while it loads and when it fails, so a placeholder keyed off the
 * data alone would stay up forever on an error.
 */
describe('dashboard analytics loading state', () => {
  const valuations = [
    {
      id: '01N409VAL000000000000000AA',
      company_name: 'Acme',
      kind: '409a',
      state: 'started',
      waiting_on_client: false,
      created_at: '2026-06-01T00:00:00Z',
      due_date: null,
    },
  ] as unknown as Valuation[];

  const analytics = {
    total: 1,
    by_kind: [{ kind: '409a', open: 1, in_review: 0, drafted: 0, published: 0, closed: 0, total: 1 }],
    by_source: { direct: 1 },
    by_state: { started: 1 },
  };

  /** Routes the two dashboard fetches; `stats` decides the pivot's fate. */
  const mockFetch = (stats: 'ok' | 'fail', gate?: Promise<void>) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/stats/dashboard')) {
        if (gate) await gate;
        if (stats === 'fail') {
          return new Response(JSON.stringify({ title: 'boom' }), {
            status: 500,
            headers: { 'content-type': 'application/problem+json' },
          });
        }
        return new Response(JSON.stringify(analytics), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ valuations, total: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

  beforeEach(() => {
    mockUser = opsUser;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('holds the pivot’s place while it loads, then shows it', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockFetch('ok', gate);

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Loading analytics…')).toBeInTheDocument());

    release!();
    await waitFor(() =>
      expect(
        screen.getByRole('table', { name: /Valuations by product and workflow stage/ }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('Loading analytics…')).toBeNull();
  });

  it('takes the placeholder down when the pivot fails', async () => {
    mockFetch('fail');

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    // The rest of the dashboard still arrives …
    await waitFor(() => expect(screen.getByText('Total')).toBeInTheDocument());
    // … and the analytics placeholder does not outlive the failed request.
    await waitFor(() => expect(screen.queryByText('Loading analytics…')).toBeNull());
    expect(screen.queryByRole('table', { name: /Valuations by product and workflow stage/ })).toBeNull();
  });

  it('keeps the loaded pivot on screen while a date-range change refetches', async () => {
    // Collapsing a table the reader is comparing against back to grey blocks
    // is worse than a moment of staleness.
    mockFetch('ok');
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole('table', { name: /Valuations by product and workflow stage/ }),
      ).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText('Analytics from'), { target: { value: '2026-01-01' } });

    expect(
      screen.getByRole('table', { name: /Valuations by product and workflow stage/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Loading analytics…')).toBeNull();
  });
});
