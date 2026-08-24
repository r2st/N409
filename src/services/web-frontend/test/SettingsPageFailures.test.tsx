import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { SettingsPage } from '../src/pages/SettingsPage';
import type { User } from '../src/lib/types';

/**
 * Settings when the API says no, and the account shapes other than the default
 * one.
 *
 * `SettingsPage.test.tsx` covers seven cards saving successfully. Every one of
 * them also has a catch that writes a banner, and none of those had been
 * exercised — which matters more here than elsewhere, because three of these
 * requests rotate the session token and a silent failure leaves the page
 * looking signed in against a session that is not.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const noContent = () => new Response(null, { status: 204 });

const problem = (status: number, detail: string) => jsonResponse({ status, title: 'Error', detail }, status);

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

const TOKEN = {
  id: 't1',
  name: 'reporting script',
  token_prefix: 'n409_pat_abc123',
  created_at: '2026-07-01T00:00:00Z',
  last_used_at: null as string | null,
  revoked_at: null as string | null,
};

function mockApi(
  overrides: (path: string, method: string) => Response | undefined = () => undefined,
  user: User = baseUser,
  tokens: Array<Record<string, unknown>> = [],
) {
  const calls: Array<{ path: string; method: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ path, method });

    const override = overrides(path, method);
    if (override) return override;

    if (path.endsWith('/auth/me')) return jsonResponse({ user });
    if (path.endsWith('/me/notification-preferences')) return jsonResponse({ preferences: PREFS });
    if (path.endsWith('/me/tokens') && method === 'GET') return jsonResponse({ tokens });
    if (path.endsWith('/me/tokens') && method === 'POST')
      return jsonResponse({ token: TOKEN, secret: 'n409_pat_the-real-secret' }, 201);
    if (path.includes('/me/tokens/') && method === 'DELETE') return noContent();
    if (path.endsWith('/me/sessions/revoke')) return jsonResponse({ token: 'fresh.jwt.token' });
    if (path.endsWith('/me') && method === 'PATCH') return jsonResponse({ user });
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

const settled = () => waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());

function card(title: string): HTMLElement {
  const section = screen.getByRole('heading', { name: title, level: 2 }).closest('section');
  if (!section) throw new Error(`no <section> around the "${title}" heading`);
  return section as HTMLElement;
}

/** Refuse one request and let everything else on the page succeed. */
const refuse =
  (match: (path: string, method: string) => boolean, status: number, detail: string) =>
  (path: string, method: string) => (match(path, method) ? problem(status, detail) : undefined);

describe('SettingsPage — a save the API refuses', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reports a rejected profile save', async () => {
    mockApi(refuse((p, m) => m === 'PATCH' && p.endsWith('/me'), 422, 'That time zone is not one we know.'));
    renderSettings();
    await settled();

    await userEvent.click(await screen.findByRole('button', { name: 'Save profile' }));

    expect(await screen.findByText('That time zone is not one we know.')).toBeInTheDocument();
    // Not "Profile updated." — the two must never be on screen together.
    expect(screen.queryByText('Profile updated.')).not.toBeInTheDocument();
  });

  it('reports a rejected email change without clearing the password box', async () => {
    mockApi(refuse((p, m) => m === 'PATCH' && p.endsWith('/me'), 403, 'That password is wrong.'));
    renderSettings();
    await settled();

    const email = card('Email address');
    await userEvent.clear(within(email).getByLabelText('Email'));
    await userEvent.type(within(email).getByLabelText('Email'), 'ada@newco.com');
    await userEvent.type(within(email).getByLabelText('Current password'), 'hunter2hunter2');
    await userEvent.click(within(email).getByRole('button', { name: 'Update email' }));

    expect(await screen.findByText('That password is wrong.')).toBeInTheDocument();
    // The address is still the typed one: a failed change must not look like it
    // reverted, or the user retypes it and wonders which one is live.
    expect(within(email).getByLabelText('Email')).toHaveValue('ada@newco.com');
  });

  it('reports a rejected password change', async () => {
    mockApi(refuse((p) => p.endsWith('/auth/change-password'), 403, 'Your current password is wrong.'));
    renderSettings();
    await settled();

    const pw = card('Change password');
    await userEvent.type(within(pw).getByLabelText('Current password'), 'wrong-one');
    await userEvent.type(within(pw).getByLabelText('New password'), 'a-long-enough-one-1');
    await userEvent.type(within(pw).getByLabelText('Confirm new password'), 'a-long-enough-one-1');
    await userEvent.click(within(pw).getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText('Your current password is wrong.')).toBeInTheDocument();
    expect(
      screen.queryByText('Password updated. Other sessions have been signed out.'),
    ).not.toBeInTheDocument();
  });

  it('reports a rejected token creation', async () => {
    mockApi(refuse((p, m) => m === 'POST' && p.endsWith('/me/tokens'), 409, 'You already have ten tokens.'));
    renderSettings();
    await settled();

    const tokensCard = card('API tokens');
    await userEvent.type(within(tokensCard).getByLabelText('New token name'), 'reporting script');
    await userEvent.click(within(tokensCard).getByRole('button', { name: 'Create token' }));

    expect(await screen.findByText('You already have ten tokens.')).toBeInTheDocument();
    // The secret panel must not appear: nothing was minted.
    expect(screen.queryByText(/won't be shown again/)).not.toBeInTheDocument();
  });

  it('reports a rejected token revocation, and keeps the token listed', async () => {
    mockApi(
      refuse((p, m) => m === 'DELETE' && p.includes('/me/tokens/'), 500, 'boom'),
      baseUser,
      [TOKEN],
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSettings();
    await settled();

    const tokensCard = card('API tokens');
    await userEvent.click(await within(tokensCard).findByRole('button', { name: 'Revoke' }));

    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(within(card('API tokens')).getByText('reporting script')).toBeInTheDocument();
  });

  it('reports a rejected sign-out-everywhere', async () => {
    mockApi(refuse((p) => p.endsWith('/me/sessions/revoke'), 503, 'Sessions are read-only right now.'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSettings();
    await settled();

    await userEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere else' }));

    expect(await screen.findByText('Sessions are read-only right now.')).toBeInTheDocument();
    // Crucially not the confirmation: this session's token was not rotated, so
    // saying the other sessions are gone would be a lie about a security action.
    expect(screen.queryByText('Other sessions have been signed out.')).not.toBeInTheDocument();
  });

  it('sends nothing when the sign-out-everywhere confirm is declined', async () => {
    const calls = mockApi();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderSettings();
    await settled();

    await userEvent.click(screen.getByRole('button', { name: 'Sign out everywhere else' }));
    expect(calls.some((c) => c.path.endsWith('/me/sessions/revoke'))).toBe(false);
  });

  it('reports a rejected account closure, and stays on the page', async () => {
    mockApi(
      refuse((p, m) => m === 'DELETE' && p.endsWith('/me'), 409, 'Close the two open valuations first.'),
    );
    renderSettings();
    await settled();

    const close = card('Close account');
    await userEvent.click(within(close).getByRole('button', { name: 'Close my account' }));
    await userEvent.type(
      within(card('Close account')).getByLabelText('Confirm your password'),
      'hunter2hunter2',
    );
    await userEvent.click(
      within(card('Close account')).getByRole('button', { name: 'Permanently close account' }),
    );

    expect(await screen.findByText('Close the two open valuations first.')).toBeInTheDocument();
    expect(screen.queryByText('LOGIN')).not.toBeInTheDocument();
  });

  it('rolls a notification toggle back when the save fails', async () => {
    mockApi(refuse((p, m) => m === 'PUT' && p.endsWith('/me/notification-preferences'), 500, 'boom'));
    renderSettings();
    await settled();

    const box = await screen.findByLabelText('Email — Draft report ready');
    expect(box).toBeChecked();
    await userEvent.click(box);

    expect(await screen.findByText('boom')).toBeInTheDocument();
    // The optimistic flip is undone: a checkbox that stays flipped after a
    // failed save is a preference the user believes they set.
    expect(screen.getByLabelText('Email — Draft report ready')).toBeChecked();
  });
});

describe('SettingsPage — lists that will not load', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('says so when the notification preferences fail', async () => {
    mockApi((p, m) =>
      m === 'GET' && p.endsWith('/me/notification-preferences') ? problem(500, 'boom') : undefined,
    );
    renderSettings();
    await settled();

    expect(await screen.findByText('Could not load your notification preferences.')).toBeInTheDocument();
    // The table is not rendered half-empty beside the message.
    expect(screen.queryByRole('table', { name: 'Notification preferences' })).not.toBeInTheDocument();
  });

  it('says so when the personal tokens fail', async () => {
    mockApi((p, m) => (m === 'GET' && p.endsWith('/me/tokens') ? problem(500, 'boom') : undefined));
    renderSettings();
    await settled();

    expect(await screen.findByText('Could not load your API tokens.')).toBeInTheDocument();
    expect(screen.queryByText('You have no active tokens.')).not.toBeInTheDocument();
  });

  it('has a message for an account with no notification events at all', async () => {
    mockApi((p, m) =>
      m === 'GET' && p.endsWith('/me/notification-preferences')
        ? jsonResponse({ preferences: [] })
        : undefined,
    );
    renderSettings();
    await settled();

    expect(await screen.findByText('No notification events')).toBeInTheDocument();
  });

  it('names an event type it has no label for, rather than showing a blank row', async () => {
    mockApi((p, m) =>
      m === 'GET' && p.endsWith('/me/notification-preferences')
        ? jsonResponse({ preferences: [{ event_type: 'board_pack_ready', in_app: true, email: false }] })
        : undefined,
    );
    renderSettings();
    await settled();

    expect(await screen.findByText('board_pack_ready')).toBeInTheDocument();
    expect(screen.getByLabelText('In-app — board_pack_ready')).toBeChecked();
    expect(screen.getByLabelText('Email — board_pack_ready')).not.toBeChecked();
  });

  it('shows when a live token was last used', async () => {
    mockApi(() => undefined, baseUser, [{ ...TOKEN, last_used_at: '2026-07-04T10:30:00Z' }]);
    renderSettings();
    await settled();

    const table = await screen.findByRole('table', { name: 'Personal API tokens' });
    expect(table).not.toHaveTextContent('Never');
  });
});

describe('SettingsPage — the account summary for other kinds of account', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('tags an operations account, and says it can administer the platform', async () => {
    mockApi(() => undefined, { ...baseUser, roles: ['admin'] });
    renderSettings();
    await settled();

    expect(screen.getByText('Operations')).toBeInTheDocument();
    expect(screen.getByText('All valuations (operations)')).toBeInTheDocument();
    expect(
      screen.getByText('You can administer users, roles, partners and system settings.'),
    ).toBeInTheDocument();
  });

  it('tags a partner account and names the firm it belongs to', async () => {
    mockApi(() => undefined, { ...baseUser, roles: ['partner'], partner_id: 'p-vestd' });
    renderSettings();
    await settled();

    // The access tag, not the "Partner" definition-list term beside the id.
    expect(screen.getByText('Access').parentElement).toHaveTextContent('Partner');
    expect(screen.getByText('Your partner portfolio')).toBeInTheDocument();
    expect(screen.getByText('p-vestd')).toBeInTheDocument();
    // A partner is not a user administrator.
    expect(
      screen.queryByText('You can administer users, roles, partners and system settings.'),
    ).not.toBeInTheDocument();
  });

  it('says so when an account carries no role at all', async () => {
    mockApi(() => undefined, { ...baseUser, roles: [] });
    renderSettings();
    await settled();

    expect(screen.getByText('No roles assigned.')).toBeInTheDocument();
    expect(screen.getByText('Client')).toBeInTheDocument();
  });

  it('says an unverified address is not verified yet', async () => {
    mockApi(() => undefined, { ...baseUser, verified: false });
    renderSettings();
    await settled();

    expect(screen.getByText('Not yet')).toBeInTheDocument();
  });

  it('leaves the profile boxes empty for a user with nothing on file', async () => {
    mockApi(() => undefined, {
      ...baseUser,
      first_name: null,
      last_name: null,
      company_name: null,
      job_title: null,
      phone: null,
    });
    renderSettings();
    await settled();

    expect(await screen.findByLabelText('First name')).toHaveValue('');
    expect(screen.getByLabelText('Last name')).toHaveValue('');
    // The avatar and heading fall back to the address rather than rendering a
    // blank circle.
    expect(screen.getAllByText('ada@acme.com').length).toBeGreaterThan(0);
  });

  it('hides the password-backed cards from a Google SSO account', async () => {
    mockApi(() => undefined, { ...baseUser, sso_provider: 'google' });
    renderSettings();
    await settled();

    expect(screen.getByText('Google SSO')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Email address', level: 2 })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Change password', level: 2 })).not.toBeInTheDocument();
    // Closing the account is still offered, without a password box — there is
    // no password on the account to confirm with.
    await userEvent.click(screen.getByRole('button', { name: 'Close my account' }));
    expect(within(card('Close account')).queryByLabelText('Confirm your password')).not.toBeInTheDocument();
    expect(
      within(card('Close account')).getByRole('button', { name: 'Permanently close account' }),
    ).toBeEnabled();
  });
});
