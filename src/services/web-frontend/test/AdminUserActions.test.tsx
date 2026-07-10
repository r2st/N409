import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { AdminUsersPage } from '../src/pages/AdminUsersPage';
import type { AdminUser, User } from '../src/lib/types';

/** Admin console: send a reset link, force-sign-out a user. */

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
}

function mockApi(users: AdminUser[], actionStatus = 200) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ path, method });

    if (path.endsWith('/auth/me')) return jsonResponse({ user: admin });
    if (path.includes('/users/invitations')) return jsonResponse({ invitations: [] });
    if (path.endsWith('/partners')) return jsonResponse({ partners: [] });
    if (path.includes('/send-password-reset')) {
      return actionStatus === 200
        ? jsonResponse({ message: 'Reset link sent to ada@acme.com.' })
        : jsonResponse({ status: actionStatus, detail: 'Nope' }, actionStatus);
    }
    if (path.includes('/revoke-sessions')) {
      return actionStatus === 200
        ? jsonResponse({ message: 'Signed ada@acme.com out of all sessions.' })
        : jsonResponse({ status: actionStatus, detail: 'Nope' }, actionStatus);
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

/** The row for the target user, once the table has loaded. */
const targetRow = async () =>
  within((await screen.findByText('ada@acme.com')).closest('tr') as HTMLElement);

describe('AdminUsersPage — password reset and force sign-out', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('sends a reset link and confirms', async () => {
    const calls = mockApi([row()]);
    renderPage();

    await userEvent.click((await targetRow()).getByRole('button', { name: 'Send reset' }));

    await screen.findByText('Reset link sent to ada@acme.com.');
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/users/u2/send-password-reset'))).toBe(
      true,
    );
  });

  it('force-signs-out a user and confirms', async () => {
    const calls = mockApi([row()]);
    renderPage();

    await userEvent.click((await targetRow()).getByRole('button', { name: 'Sign out' }));

    await screen.findByText('Signed ada@acme.com out of all sessions.');
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/users/u2/revoke-sessions'))).toBe(
      true,
    );
  });

  it('does nothing when the confirmation is dismissed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const calls = mockApi([row()]);
    renderPage();

    await userEvent.click((await targetRow()).getByRole('button', { name: 'Send reset' }));
    expect(calls.some((c) => c.path.includes('send-password-reset'))).toBe(false);
  });

  it('hides "Send reset" for an SSO account, which has no password to reset', async () => {
    mockApi([row({ sso_provider: 'google' })]);
    renderPage();

    const target = await targetRow();
    expect(target.queryByRole('button', { name: 'Send reset' })).not.toBeInTheDocument();
    expect(target.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('offers neither destructive action on the admin’s own row', async () => {
    mockApi([row({ id: admin.id, email: admin.email })]);
    renderPage();

    const self = within((await screen.findByText('admin@409.ai')).closest('tr') as HTMLElement);
    // Self-service sign-out lives in Settings, where it issues a replacement token.
    expect(self.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(self.queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument();
    // …but they may still email themselves a reset link.
    expect(self.getByRole('button', { name: 'Send reset' })).toBeInTheDocument();
  });

  it('offers no actions but Restore on a deactivated row', async () => {
    mockApi([row({ deleted_at: '2026-06-01T00:00:00Z' })]);
    renderPage();

    const target = await targetRow();
    expect(target.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(target.queryByRole('button', { name: 'Send reset' })).not.toBeInTheDocument();
    expect(target.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  });

  it('surfaces a rejected action', async () => {
    mockApi([row()], 403);
    renderPage();

    await userEvent.click((await targetRow()).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.getByText('Nope')).toBeInTheDocument());
  });
});
