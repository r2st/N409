import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { AppLayout } from '../src/components/AppLayout';
import type { User } from '../src/lib/types';

/** Admin / normal-user view toggle (admin-role-management feature B). */

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const makeUser = (roles: string[]): User => ({
  id: 'me-1',
  email: 'me@409.ai',
  first_name: 'Mo',
  last_name: 'Admin',
  phone: null,
  job_title: null,
  company_name: null,
  timezone: null,
  verified: true,
  sso_provider: null,
  partner_id: null,
  roles,
});

function mockApi(user: User) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    if (path.endsWith('/auth/me')) return jsonResponse({ user });
    if (path.includes('/notifications/unread-count')) return jsonResponse({ unread_count: 0 });
    return jsonResponse({});
  });
}

function renderLayout(roles: string[], initialPath = '/admin/users') {
  mockApi(makeUser(roles));
  localStorage.setItem('n409.token', 'header.payload.sig');
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/admin/users" element={<div>Admin console</div>} />
            <Route path="/dashboard" element={<div>Dashboard home</div>} />
            <Route path="/valuations" element={<div>Valuations list</div>} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const toggle = () => screen.getByRole('switch');

describe('ViewModeToggle', () => {
  beforeEach(() => vi.restoreAllMocks());

  // #18
  it('renders the toggle for an ops/admin user', async () => {
    renderLayout(['admin']);
    await waitFor(() => expect(toggle()).toBeInTheDocument());
    expect(screen.getByText('Admin view')).toBeInTheDocument();
  });

  // #19
  it('does not render the toggle for a plain client', async () => {
    renderLayout(['valuation_user']);
    // The nav renders (Workspace label) but no toggle switch.
    await screen.findByText('Workspace');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  // #20 / #21 — switching to User view hides the elevated nav sections.
  it('hides Operations and Administration nav in User view', async () => {
    renderLayout(['admin'], '/valuations');
    await screen.findByText('Operations');
    expect(screen.getByText('Administration')).toBeInTheDocument();

    await userEvent.click(toggle());

    expect(screen.queryByText('Operations')).not.toBeInTheDocument();
    expect(screen.queryByText('Administration')).not.toBeInTheDocument();
    // Workspace + Account stay.
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.getByText('Account')).toBeInTheDocument();
  });

  // #22
  it('keeps the toggle visible in User view so the admin can switch back', async () => {
    renderLayout(['admin'], '/valuations');
    await waitFor(() => expect(toggle()).toBeInTheDocument());
    await userEvent.click(toggle());
    expect(screen.getByText('User view')).toBeInTheDocument();
    expect(toggle()).toBeInTheDocument();
    // …and back again.
    await userEvent.click(toggle());
    expect(screen.getByText('Admin view')).toBeInTheDocument();
  });

  // #23 — switching while on an admin-only route redirects to /dashboard.
  it('redirects to /dashboard when switching to User view on an admin route', async () => {
    renderLayout(['admin'], '/admin/users');
    await screen.findByText('Admin console');
    await userEvent.click(toggle());
    expect(await screen.findByText('Dashboard home')).toBeInTheDocument();
  });

  // #24 — the toggle defaults to Admin view (state is never persisted).
  it('defaults to Admin view on a fresh mount', async () => {
    renderLayout(['admin']);
    await waitFor(() => expect(screen.getByText('Admin view')).toBeInTheDocument());
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
  });

  // Regression: on a short viewport the fixed sidebar's nav must scroll
  // internally (min-h-0 + overflow-y-auto) instead of growing past the column
  // and pushing the user card / bottom items below the fold.
  it('makes the sidebar nav scrollable so bottom menu items stay reachable', async () => {
    renderLayout(['admin']);
    const nav = await screen.findByRole('navigation');
    expect(nav.className).toContain('overflow-y-auto');
    // Without min-h-0 the flex child can't shrink, so overflow never engages.
    expect(nav.className).toContain('min-h-0');
    expect(nav.className).toContain('flex-1');
  });
});
