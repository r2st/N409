import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppLayout } from '../src/components/AppLayout';
import { MarketingHeader } from '../src/components/MarketingLayout';

/**
 * Keyboard behaviour of the two mobile nav drawers.
 *
 * Both are full-width overlays opened by a hamburger. A mouse user dismisses
 * one by tapping the same button; a keyboard user has no such affordance
 * unless Escape works, and if closing does not hand focus back to the trigger
 * the next Tab restarts from the top of the document. Neither failure is
 * visible in a pointer walkthrough, so they are pinned here.
 */

const OPS_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({
    status: 'authenticated',
    viewMode: 'real',
    logout: vi.fn(),
    user: {
      id: OPS_ID,
      email: 'ops@n409.example',
      first_name: 'Olive',
      last_name: 'Ops',
      verified: true,
      sso_provider: null,
      partner_id: null,
      roles: ['admin'],
    },
  }),
}));

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify({ unread_count: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  localStorage.clear();
});

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/dashboard" element={<div>Dashboard body</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('AppLayout mobile drawer', () => {
  it('reports its expanded state and what it controls', async () => {
    renderApp();
    const toggle = screen.getByRole('button', { name: 'Toggle navigation' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'mobile-nav-drawer');

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('mobile-nav-drawer')).not.toBeNull();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    renderApp();
    const toggle = screen.getByRole('button', { name: 'Toggle navigation' });
    await userEvent.click(toggle);
    expect(document.getElementById('mobile-nav-drawer')).not.toBeNull();

    await userEvent.keyboard('{Escape}');
    expect(document.getElementById('mobile-nav-drawer')).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });

  it('names both nav landmarks so they are distinguishable', async () => {
    renderApp();
    // The sidebar is `hidden lg:flex`, not unmounted, so opening the drawer
    // puts two <nav> elements in the tree at once.
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Toggle navigation' }));
    const navs = screen.getAllByRole('navigation');
    const names = navs.map((n) => n.getAttribute('aria-label'));
    expect(names).toContain('Main');
    expect(names).toContain('Mobile');
    expect(new Set(names).size).toBe(names.length);
  });

  it('exposes the skip link ahead of the navigation', () => {
    renderApp();
    const link = screen.getByRole('link', { name: 'Skip to main content' });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    // DOCUMENT_POSITION_FOLLOWING === 4: the nav comes after the link.
    expect(link.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('MarketingHeader mobile menu', () => {
  const renderHeader = () =>
    render(
      <MemoryRouter>
        <MarketingHeader />
      </MemoryRouter>,
    );

  it('reports its expanded state and what it controls', async () => {
    renderHeader();
    const toggle = screen.getByRole('button', { name: 'Toggle menu' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'marketing-mobile-menu');

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('marketing-mobile-menu')).not.toBeNull();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    renderHeader();
    const toggle = screen.getByRole('button', { name: 'Toggle menu' });
    await userEvent.click(toggle);
    await userEvent.keyboard('{Escape}');
    expect(document.getElementById('marketing-mobile-menu')).toBeNull();
    expect(toggle).toHaveFocus();
  });
});
