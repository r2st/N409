import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { MarketingLayout } from '../src/components/MarketingLayout';
import { LandingPage } from '../src/pages/marketing/LandingPage';
import { ErrorBoundary } from '../src/components/ErrorBoundary';

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
