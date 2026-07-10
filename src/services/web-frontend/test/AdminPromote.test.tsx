import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { AdminUsersPage } from '../src/pages/AdminUsersPage';
import type { AdminUser, User } from '../src/lib/types';

/** Admin console: one-click promote/demote (admin-role-management feature A). */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const admin: User = {
  id: 'admin-1',
  email: 'admin@409.ai',
  first_name: 'Ana',
  last_name: 'Admin',
  phone: null,
  job_title: null,
  company_name: null,
  timezone: null,
  verified: true,
  sso_provider: null,
  partner_id: null,
  roles: ['admin'],
};

const row = (over: Partial<AdminUser> = {}): AdminUser => ({
  id: 'u2',
  email: 'ada@acme.com',
  first_name: 'Ada',
  last_name: 'Lovelace',
  phone: null,
  job_title: null,
  company_name: null,
  verified: true,
  sso_provider: null,
  partner_id: null,
  partner_name: null,
  roles: ['valuation_user'],
  created_at: '2026-01-01T00:00:00Z',
  deleted_at: null,
  ...over,
});

interface Call {
  path: string;
  method: string;
  body: unknown;
}

function mockApi(users: AdminUser[], actionStatus = 200) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (path.endsWith('/auth/me')) return jsonResponse({ user: admin });
    if (path.includes('/users/invitations')) return jsonResponse({ invitations: [] });
    if (path.endsWith('/partners')) return jsonResponse({ partners: [] });
    if (path.includes('/promote') || path.includes('/demote')) {
      return actionStatus === 200
        ? jsonResponse({ user: row() })
        : jsonResponse({ status: actionStatus, detail: 'Already an admin' }, actionStatus);
    }
    if (path.includes('/users?')) {
      return jsonResponse({ users, page: 1, per_page: 25, total: users.length });
    }
    throw new Error(`unexpected fetch ${method} ${path}`);
  });
  return calls;
}

function renderPage() {
  localStorage.setItem('n409.token', 'header.payload.sig');
  return render(
    <MemoryRouter initialEntries={['/admin/users']}>
      <AuthProvider>
        <AdminUsersPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

const targetRow = async () =>
  within((await screen.findByText('ada@acme.com')).closest('tr') as HTMLElement);

describe('AdminUsersPage — promote / demote', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  // #12 / #13
  it('shows "Promote to admin" for a non-admin and hides it for an admin', async () => {
    mockApi([row()]);
    renderPage();
    expect((await targetRow()).getByRole('button', { name: 'Promote to admin' })).toBeInTheDocument();
  });

  it('hides "Promote to admin" once the user is already an admin', async () => {
    mockApi([row({ roles: ['admin', 'valuation_user'] })]);
    renderPage();
    const target = await targetRow();
    expect(target.queryByRole('button', { name: 'Promote to admin' })).not.toBeInTheDocument();
    expect(target.getByRole('button', { name: 'Remove admin' })).toBeInTheDocument();
  });

  // #16
  it('confirms and calls the promote endpoint with role=admin', async () => {
    const calls = mockApi([row()]);
    renderPage();
    await userEvent.click((await targetRow()).getByRole('button', { name: 'Promote to admin' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === 'POST' && c.path.endsWith('/users/u2/promote') && (c.body as { role: string }).role === 'admin',
        ),
      ).toBe(true),
    );
  });

  // #15
  it('does not call the API when the confirmation is dismissed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const calls = mockApi([row()]);
    renderPage();
    await userEvent.click((await targetRow()).getByRole('button', { name: 'Promote to admin' }));
    expect(calls.some((c) => c.path.includes('/promote'))).toBe(false);
  });

  it('calls the demote endpoint when removing admin', async () => {
    const calls = mockApi([row({ roles: ['admin', 'valuation_user'] })]);
    renderPage();
    await userEvent.click((await targetRow()).getByRole('button', { name: 'Remove admin' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/users/u2/demote'))).toBe(true),
    );
  });

  // #17
  it('hides "Remove admin" on the admin’s own row', async () => {
    mockApi([row({ id: admin.id, email: admin.email, roles: ['admin'] })]);
    renderPage();
    const self = within((await screen.findByText('admin@409.ai')).closest('tr') as HTMLElement);
    expect(self.queryByRole('button', { name: 'Remove admin' })).not.toBeInTheDocument();
    expect(self.queryByRole('button', { name: 'Promote to admin' })).not.toBeInTheDocument();
  });

  it('surfaces a 409 from a promote race gracefully', async () => {
    mockApi([row()], 409);
    renderPage();
    await userEvent.click((await targetRow()).getByRole('button', { name: 'Promote to admin' }));
    await waitFor(() => expect(screen.getByText('Already an admin')).toBeInTheDocument());
  });
});
