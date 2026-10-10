import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { MarketingLayout } from '../src/components/MarketingLayout';
import { LandingPage } from '../src/pages/marketing/LandingPage';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { Heatmap, type HeatCell } from '../src/components/charts';

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({
    status: 'anonymous',
    user: null,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    viewMode: 'normal',
    setViewMode: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<MarketingLayout />}>
          <Route path="/" element={<LandingPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('M15: landing page tab ARIA', () => {
  it('exposes sign-in / register as a tablist with selectable tabs', () => {
    renderLanding();
    const tablist = screen.getByRole('tablist', { name: 'Sign in or create account' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent('Sign in');
    expect(tabs[1]).toHaveTextContent('Create account');
  });

  it('marks the active tab as selected and the other as not', () => {
    renderLanding();
    const signIn = screen.getByRole('tab', { name: 'Sign in' });
    const create = screen.getByRole('tab', { name: 'Create account' });
    expect(signIn).toHaveAttribute('aria-selected', 'true');
    expect(create).toHaveAttribute('aria-selected', 'false');
  });

  it('switches aria-selected when the other tab is clicked', async () => {
    renderLanding();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Create account' }));
    expect(screen.getByRole('tab', { name: 'Create account' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Sign in' })).toHaveAttribute('aria-selected', 'false');
  });

  it('connects tabs to the panel via aria-controls', () => {
    renderLanding();
    const tabs = screen.getAllByRole('tab');
    const panelId = tabs[0]!.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId!)).toBeInTheDocument();
    expect(document.getElementById(panelId!)!.getAttribute('role')).toBe('tabpanel');
    expect(tabs[1]!.getAttribute('aria-controls')).toBe(panelId);
  });
});

describe('M15: ErrorBoundary uses theme tokens', () => {
  function Boom(): never {
    throw new Error('kaboom');
  }

  it('generic fallback uses ink/paper/bond tokens, not slate', () => {
    const { container } = render(
      <ErrorBoundary onError={() => {}}>
        <Boom />
      </ErrorBoundary>,
    );
    const html = container.innerHTML;
    expect(html).not.toMatch(/text-slate-/);
    expect(html).not.toMatch(/border-slate-/);
    expect(html).not.toMatch(/bg-slate-/);
    expect(html).toMatch(/text-ink-/);
    expect(html).toMatch(/border-ink-/);
  });

  it('chunk-load fallback uses ink/bond tokens, not slate', () => {
    function ChunkBoom(): never {
      throw new Error('Failed to fetch dynamically imported module: https://409.doaide.com/assets/X.js');
    }
    const { container } = render(
      <ErrorBoundary onError={() => {}}>
        <ChunkBoom />
      </ErrorBoundary>,
    );
    const html = container.innerHTML;
    expect(html).not.toMatch(/text-slate-/);
    expect(html).toMatch(/text-ink-/);
  });
});

const HEAT_CELLS: HeatCell[][] = [
  [
    { value: 100, delta: 0 },
    { value: 120, delta: 0.2 },
    { value: 80, delta: -0.2 },
  ],
  [
    { value: 110, delta: 0.1 },
    { value: 150, delta: 0.8 },
    { value: 60, delta: -0.4 },
  ],
];

function renderHeatmap(cells = HEAT_CELLS) {
  return render(
    <Heatmap
      title="Sensitivity"
      rowLabel="DLOM"
      colLabel="Discount Rate"
      rowValues={['10%', '20%']}
      colValues={['8%', '10%', '12%']}
      cells={cells}
      format={(v) => `$${v}`}
    />,
  );
}

describe('M15: heatmap accessibility', () => {
  it('uses ink-900 for all cell text, never white', () => {
    renderHeatmap();
    const table = screen.getByRole('table');
    const dataCells = within(table).getAllByRole('cell');
    for (const td of dataCells) {
      const color = (td as HTMLElement).style.color;
      if (color) {
        expect(color).toBe('var(--color-ink-900)');
      }
    }
  });

  it('includes sr-only delta percentages for screen readers', () => {
    renderHeatmap();
    expect(screen.getByText('(+20.0%)')).toHaveClass('sr-only');
    expect(screen.getByText('(-20.0%)')).toHaveClass('sr-only');
    expect(screen.getByText('(+80.0%)')).toHaveClass('sr-only');
    expect(screen.getByText('(-40.0%)')).toHaveClass('sr-only');
  });

  it('shows +0.0% for base-case cells', () => {
    renderHeatmap();
    const zeroDelta = screen.getAllByText('(+0.0%)');
    expect(zeroDelta.length).toBeGreaterThanOrEqual(1);
    for (const el of zeroDelta) {
      expect(el).toHaveClass('sr-only');
    }
  });

  it('exposes the reason for null cells to screen readers', () => {
    const nullRow: HeatCell[][] = [
      [
        { value: null, delta: null, note: 'Below terminal growth' },
        { value: 100, delta: 0 },
      ],
    ];
    renderHeatmap(nullRow);
    expect(screen.getByText('Below terminal growth')).toHaveClass('sr-only');
  });

  it('does not add a delta span for null-delta cells', () => {
    const nullRow: HeatCell[][] = [
      [
        { value: null, delta: null, note: 'Below terminal growth' },
        { value: 100, delta: 0 },
      ],
    ];
    renderHeatmap(nullRow);
    const table = screen.getByRole('table');
    const cells = within(table).getAllByRole('cell');
    const nullCell = cells.find((c) => c.textContent?.includes('—'));
    expect(nullCell).toBeDefined();
    const srSpans = nullCell!.querySelectorAll('.sr-only');
    const deltaSpans = Array.from(srSpans).filter((s) => s.textContent?.includes('%'));
    expect(deltaSpans).toHaveLength(0);
  });

  it('sets title attributes for hover tooltips', () => {
    renderHeatmap();
    const table = screen.getByRole('table');
    const cells = within(table).getAllByRole('cell');
    const titledCells = cells.filter((c) => c.hasAttribute('title'));
    expect(titledCells.length).toBeGreaterThan(0);
    const titles = titledCells.map((c) => c.getAttribute('title'));
    expect(titles).toContain('+20.0%');
    expect(titles).toContain('-20.0%');
  });
});
