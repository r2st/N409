import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  LoadingBlock,
  PageSkeleton,
  Skeleton,
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
