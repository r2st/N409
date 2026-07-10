import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { SettingsPage } from '../src/pages/SettingsPage';
import type { User } from '../src/lib/types';

/**
 * Self-service account settings: profile, email change, personal API tokens,
 * session revocation and closing an account.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const noContent = () => new Response(null, { status: 204 });

const baseUser: User = {
  id: 'u1',
  email: 'ada@acme.com',
  first_name: 'Ada',
  last_name: 'Lovelace',
  phone: null,
  job_title: null,
  company_name: null,
  timezone: null,
  verified: true,
  sso_provider: null,
  partner_id: null,
  roles: ['valuation_user'],
};

const PREFS = [{ event_type: 'draft_ready', in_app: true, email: true }];

interface Call {
  path: string;
  method: string;
  body?: Record<string, unknown>;
}

/** Routes every request the page makes; `overrides` win over the defaults. */
function mockApi(
  overrides: (path: string, method: string, body?: Record<string, unknown>) => Response | undefined = () =>
    undefined,
  user: User = baseUser,
) {
  const calls: Call[] = [];
  let tokens: Array<Record<string, unknown>> = [];

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ path, method, body });

    const override = overrides(path, method, body);
    if (override) return override;

    if (path.endsWith('/auth/me')) return jsonResponse({ user });
    if (path.endsWith('/me/notification-preferences')) return jsonResponse({ preferences: PREFS });
    if (path.endsWith('/me/tokens') && method === 'GET') return jsonResponse({ tokens });
    if (path.endsWith('/me/tokens') && method === 'POST') {
      const token = {
        id: 't1',
        name: body!.name,
        token_prefix: 'n409_pat_abc123',
        created_at: '2026-07-01T00:00:00Z',
        last_used_at: null,
        revoked_at: null,
      };
      tokens = [token];
      return jsonResponse({ token, secret: 'n409_pat_the-real-secret' }, 201);
    }
    if (path.includes('/me/tokens/') && method === 'DELETE') {
      tokens = [];
      return noContent();
    }
    if (path.endsWith('/me/sessions/revoke')) return jsonResponse({ token: 'fresh.jwt.token' });
    if (path.endsWith('/me') && method === 'PATCH') return jsonResponse({ user: { ...user, ...body } });
    if (path.endsWith('/me') && method === 'DELETE') return noContent();
    if (path.endsWith('/auth/change-password')) return jsonResponse({ token: 'rotated.jwt.token' });
    throw new Error(`unexpected fetch ${method} ${path}`);
  });
  return calls;
}

function renderSettings() {
  localStorage.setItem('n409.token', 'header.payload.sig');
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <AuthProvider>
        <Routes>
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/login" element={<div>LOGIN</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** The page renders nothing until AuthProvider has loaded /auth/me. */
const settled = () => waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());

/**
 * Scope a query to one card. "Current password" appears on both the email and
 * the password card, so a page-wide query would be ambiguous — or worse, would
 * silently hit the wrong form.
 */
function card(title: string): HTMLElement {
  const section = screen.getByRole('heading', { name: title, level: 2 }).closest('section');
  if (!section) throw new Error(`no <section> around the "${title}" heading`);
  return section as HTMLElement;
}

describe('SettingsPage — profile', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('pre-fills the form from the signed-in user', async () => {
    mockApi(() => undefined, { ...baseUser, company_name: 'Acme', job_title: 'CEO' });
    renderSettings();
    await settled();

    expect(await screen.findByLabelText('First name')).toHaveValue('Ada');
    expect(screen.getByLabelText('Company')).toHaveValue('Acme');
    expect(screen.getByLabelText('Job title')).toHaveValue('CEO');
  });

  it('saves profile edits and confirms', async () => {
    const calls = mockApi();
    renderSettings();
    await settled();

    await userEvent.clear(await screen.findByLabelText('Job title'));
    await userEvent.type(screen.getByLabelText('Job title'), 'Founder');
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await screen.findByText('Profile updated.');
    const patch = calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/me'));
    expect(patch?.body).toMatchObject({ job_title: 'Founder', first_name: 'Ada' });
    // The profile form must never try to change the email — that path
    // demands the current password.
    expect(patch?.body).not.toHaveProperty('email');
  });

  it('surfaces a server-side validation error', async () => {
    mockApi((path, method) =>
      path.endsWith('/me') && method === 'PATCH'
        ? jsonResponse({ status: 422, detail: 'Unknown time zone' }, 422)
        : undefined,
    );
    renderSettings();
    await settled();

    await userEvent.click(await screen.findByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText('Unknown time zone')).toBeInTheDocument();
  });
});

describe('SettingsPage — email change', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('requires the current password and a changed address before submitting', async () => {
    mockApi();
    renderSettings();
    await settled();

    const form = within(card('Email address'));
    const button = form.getByRole('button', { name: 'Update email' });
    // Unchanged email, no password — nothing to do.
    expect(button).toBeDisabled();

    await userEvent.type(form.getByLabelText(/^Current password/), 'secret-password');
    expect(button).toBeDisabled();

    await userEvent.clear(form.getByLabelText('Email'));
    await userEvent.type(form.getByLabelText('Email'), 'new@acme.com');
    expect(button).toBeEnabled();
  });

  it('sends the new address with the current password', async () => {
    const calls = mockApi();
    renderSettings();
    await settled();

    const form = within(card('Email address'));
    await userEvent.type(form.getByLabelText(/^Current password/), 'secret-password');
    await userEvent.clear(form.getByLabelText('Email'));
    await userEvent.type(form.getByLabelText('Email'), 'new@acme.com');
    await userEvent.click(form.getByRole('button', { name: 'Update email' }));

    await screen.findByText(/Check your inbox to verify/);
    const patch = calls.find((c) => c.method === 'PATCH' && c.body?.email === 'new@acme.com');
    expect(patch?.body).toMatchObject({ current_password: 'secret-password' });
  });

  it('is hidden for a Google SSO account, along with the password form', async () => {
    mockApi(() => undefined, { ...baseUser, sso_provider: 'google' });
    renderSettings();
    await settled();

    await screen.findByText('Profile');
    expect(screen.queryByRole('button', { name: 'Update email' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update password' })).not.toBeInTheDocument();
  });
});

describe('SettingsPage — password change', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('adopts the replacement token so the session survives the change', async () => {
    mockApi();
    renderSettings();
    await settled();

    const form = within(card('Change password'));
    await userEvent.type(form.getByLabelText(/^Current password/), 'old-password');
    await userEvent.type(form.getByLabelText(/^New password/), 'brand-new-password');
    await userEvent.type(form.getByLabelText(/^Confirm new password/), 'brand-new-password');
    await userEvent.click(form.getByRole('button', { name: 'Update password' }));

    await screen.findByText(/Other sessions have been signed out/);
    // Without this the very next request would 401 and bounce us to /login.
    expect(localStorage.getItem('n409.token')).toBe('rotated.jwt.token');
  });

  it('rejects a mismatched confirmation before calling the API', async () => {
    const calls = mockApi();
    renderSettings();
    await settled();

    const form = within(card('Change password'));
    await userEvent.type(form.getByLabelText(/^Current password/), 'old-password');
    await userEvent.type(form.getByLabelText(/^New password/), 'brand-new-password');
    await userEvent.type(form.getByLabelText(/^Confirm new password/), 'different-password');
    await userEvent.click(form.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText("New passwords don't match.")).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/auth/change-password'))).toBe(false);
  });
});

describe('SettingsPage — personal API tokens', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows the secret exactly once, on creation', async () => {
    mockApi();
    renderSettings();
    await settled();

    expect(await screen.findByText('You have no active tokens.')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('New token name'), 'reporting script');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));

    expect(await screen.findByText('n409_pat_the-real-secret')).toBeInTheDocument();
    expect(screen.getByText(/won't be shown again/)).toBeInTheDocument();

    const table = await screen.findByRole('table', { name: 'Personal API tokens' });
    expect(within(table).getByText('reporting script')).toBeInTheDocument();
    expect(within(table).getByText('Never')).toBeInTheDocument();
  });

  it('revokes a token after confirmation', async () => {
    const calls = mockApi();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSettings();
    await settled();

    await userEvent.type(await screen.findByLabelText('New token name'), 'temp');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await screen.findByRole('table', { name: 'Personal API tokens' });

    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await screen.findByText('You have no active tokens.');
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/me/tokens/t1'))).toBe(true);
  });

  it('does not revoke when the confirmation is dismissed', async () => {
    const calls = mockApi();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderSettings();
    await settled();

    await userEvent.type(await screen.findByLabelText('New token name'), 'temp');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await screen.findByRole('table', { name: 'Personal API tokens' });

    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('SettingsPage — sessions and account closure', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('signs out other sessions and adopts the replacement token', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockApi();
    renderSettings();
    await settled();

    await userEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere else' }));
    await screen.findByText('Other sessions have been signed out.');
    expect(localStorage.getItem('n409.token')).toBe('fresh.jwt.token');
  });

  it('closes the account behind a confirmation step and signs out', async () => {
    const calls = mockApi();
    renderSettings();
    await settled();

    // The destructive action is behind a second click plus a password.
    await userEvent.click(await screen.findByRole('button', { name: 'Close my account' }));
    await userEvent.type(screen.getByLabelText('Confirm your password'), 'secret-password');
    await userEvent.click(screen.getByRole('button', { name: 'Permanently close account' }));

    await screen.findByText('LOGIN');
    const del = calls.find((c) => c.method === 'DELETE' && c.path.endsWith('/me'));
    expect(del?.body).toEqual({ current_password: 'secret-password' });
    expect(localStorage.getItem('n409.token')).toBeNull();
  });

  it('keeps the user on the page when closing fails', async () => {
    mockApi((path, method) =>
      path.endsWith('/me') && method === 'DELETE'
        ? jsonResponse({ status: 422, detail: 'You are the only administrator' }, 422)
        : undefined,
    );
    renderSettings();
    await settled();

    await userEvent.click(await screen.findByRole('button', { name: 'Close my account' }));
    await userEvent.type(screen.getByLabelText('Confirm your password'), 'secret-password');
    await userEvent.click(screen.getByRole('button', { name: 'Permanently close account' }));

    expect(await screen.findByText('You are the only administrator')).toBeInTheDocument();
    expect(screen.queryByText('LOGIN')).not.toBeInTheDocument();
  });

  it('asks a Google SSO user for no password when closing', async () => {
    mockApi(() => undefined, { ...baseUser, sso_provider: 'google' });
    renderSettings();
    await settled();

    await userEvent.click(await screen.findByRole('button', { name: 'Close my account' }));
    expect(screen.queryByLabelText('Confirm your password')).not.toBeInTheDocument();
  });
});
