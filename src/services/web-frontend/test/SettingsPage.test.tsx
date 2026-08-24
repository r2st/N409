import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { getToken } from '../src/lib/api';
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
    await userEvent.type(form.getByLabelText(/^New password/), 'brand-new-password-1');
    await userEvent.type(form.getByLabelText(/^Confirm new password/), 'brand-new-password-1');
    await userEvent.click(form.getByRole('button', { name: 'Update password' }));

    await screen.findByText(/Other sessions have been signed out/);
    // Without this the very next request would 401 and bounce us to /login.
    expect(getToken()).toBe('rotated.jwt.token');
  });

  it('rejects a mismatched confirmation before calling the API', async () => {
    const calls = mockApi();
    renderSettings();
    await settled();

    const form = within(card('Change password'));
    await userEvent.type(form.getByLabelText(/^Current password/), 'old-password');
    await userEvent.type(form.getByLabelText(/^New password/), 'brand-new-password-1');
    await userEvent.type(form.getByLabelText(/^Confirm new password/), 'different-password');
    await userEvent.click(form.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText("New passwords don't match.")).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/auth/change-password'))).toBe(false);
  });
});

describe('SettingsPage — notification preferences', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('says there is nothing to configure rather than rendering a headed, empty table', async () => {
    mockApi((path) =>
      path.endsWith('/me/notification-preferences') ? jsonResponse({ preferences: [] }) : undefined,
    );
    renderSettings();
    await settled();

    expect(await screen.findByText('No notification events')).toBeInTheDocument();
    // The three column headers are the tell: they used to render over nothing.
    expect(screen.queryByRole('table', { name: 'Notification preferences' })).not.toBeInTheDocument();
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
    expect(getToken()).toBe('fresh.jwt.token');
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

/**
 * R29 — four of the five forms on this page carried `noValidate` together with
 * `required`, which between them meant nothing checked anything: the email card
 * sent a malformed address to the API and rendered the 422, and the close-account
 * card sent an empty password. The password card did check, but as a banner above
 * three password boxes that never said which one it meant.
 */
describe('SettingsPage — form validation', () => {
  beforeEach(() => vi.restoreAllMocks());

  const wrote = (calls: Call[], method: string, fragment: string) =>
    calls.filter((c) => c.method === method && c.path.includes(fragment));

  it('refuses a malformed new email instead of letting the API answer', async () => {
    const calls = mockApi();
    renderSettings();
    await settled();

    const emailCard = card('Email address');
    await userEvent.clear(within(emailCard).getByLabelText('Email'));
    await userEvent.type(within(emailCard).getByLabelText('Email'), 'ada@');
    await userEvent.type(within(emailCard).getByLabelText('Current password'), 'hunter2hunter2');
    await userEvent.click(within(emailCard).getByRole('button', { name: 'Update email' }));

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(wrote(calls, 'PATCH', '/me')).toHaveLength(0);
  });

  it('names the empty password box on the email card rather than sending nothing', async () => {
    const calls = mockApi();
    renderSettings();
    await settled();

    const emailCard = card('Email address');
    await userEvent.clear(within(emailCard).getByLabelText('Email'));
    await userEvent.type(within(emailCard).getByLabelText('Email'), 'ada@newcorp.com');
    await userEvent.click(within(emailCard).getByRole('button', { name: 'Update email' }));

    expect(await within(emailCard).findByText('Current password is required.')).toBeInTheDocument();
    expect(wrote(calls, 'PATCH', '/me')).toHaveLength(0);
  });

  it('still changes the email when both boxes are good', async () => {
    const calls = mockApi();
    renderSettings();
    await settled();

    const emailCard = card('Email address');
    await userEvent.clear(within(emailCard).getByLabelText('Email'));
    await userEvent.type(within(emailCard).getByLabelText('Email'), 'ada@newcorp.com');
    await userEvent.type(within(emailCard).getByLabelText('Current password'), 'hunter2hunter2');
    await userEvent.click(within(emailCard).getByRole('button', { name: 'Update email' }));

    await waitFor(() => expect(wrote(calls, 'PATCH', '/me')).toHaveLength(1));
    expect(wrote(calls, 'PATCH', '/me')[0]!.body).toMatchObject({
      email: 'ada@newcorp.com',
      current_password: 'hunter2hunter2',
    });
  });

  it('puts the short-password message on the box it is about', async () => {
    // It used to be a banner above three password boxes reading "New password
    // must be at least 10 characters", with nothing tying it to the middle one.
    const calls = mockApi();
    renderSettings();
    await settled();

    const pw = card('Change password');
    await userEvent.type(within(pw).getByLabelText('Current password'), 'oldpassword');
    await userEvent.type(within(pw).getByLabelText('New password'), 'short');
    await userEvent.type(within(pw).getByLabelText('Confirm new password'), 'short');
    await userEvent.click(within(pw).getByRole('button', { name: 'Update password' }));

    const box = within(pw).getByLabelText('New password');
    await waitFor(() => expect(box).toHaveAttribute('aria-invalid', 'true'));
    expect(document.getElementById(box.getAttribute('aria-describedby')!)).toHaveTextContent(
      'New password must be at least 10 characters.',
    );
    expect(wrote(calls, 'POST', '/auth/change-password')).toHaveLength(0);
  });

  it('puts the mismatch message on the confirmation box', async () => {
    const calls = mockApi();
    renderSettings();
    await settled();

    const pw = card('Change password');
    await userEvent.type(within(pw).getByLabelText('Current password'), 'oldpassword');
    await userEvent.type(within(pw).getByLabelText('New password'), 'correcthorse1');
    await userEvent.type(within(pw).getByLabelText('Confirm new password'), 'correcthorsf1');
    await userEvent.click(within(pw).getByRole('button', { name: 'Update password' }));

    const box = within(pw).getByLabelText('Confirm new password');
    await waitFor(() => expect(box).toHaveAttribute('aria-invalid', 'true'));
    expect(document.getElementById(box.getAttribute('aria-describedby')!)).toHaveTextContent(
      "New passwords don't match.",
    );
    expect(wrote(calls, 'POST', '/auth/change-password')).toHaveLength(0);
  });

  it('clears the mismatch when the first box is corrected, not only the second', async () => {
    mockApi();
    renderSettings();
    await settled();

    const pw = card('Change password');
    await userEvent.type(within(pw).getByLabelText('Current password'), 'oldpassword');
    await userEvent.type(within(pw).getByLabelText('New password'), 'correcthorse1');
    await userEvent.type(within(pw).getByLabelText('Confirm new password'), 'correcthorsf1');
    await userEvent.click(within(pw).getByRole('button', { name: 'Update password' }));
    expect(await within(pw).findByText("New passwords don't match.")).toBeInTheDocument();

    await userEvent.clear(within(pw).getByLabelText('New password'));
    await userEvent.type(within(pw).getByLabelText('New password'), 'correcthorsf1');
    expect(within(pw).queryByText("New passwords don't match.")).not.toBeInTheDocument();
  });

  it('does not re-raise every message on the emptied boxes after a successful change', async () => {
    // The card stays mounted and the three boxes are cleared on success, so
    // without a reset the form fills with "is required" the moment it works.
    mockApi();
    renderSettings();
    await settled();

    const pw = card('Change password');
    await userEvent.type(within(pw).getByLabelText('Current password'), 'oldpassword');
    await userEvent.type(within(pw).getByLabelText('New password'), 'correcthorse1');
    await userEvent.type(within(pw).getByLabelText('Confirm new password'), 'correcthorse1');
    await userEvent.click(within(pw).getByRole('button', { name: 'Update password' }));

    expect(await within(pw).findByText(/Password updated/)).toBeInTheDocument();
    expect(within(pw).queryByText('Current password is required.')).not.toBeInTheDocument();
    expect(within(pw).queryByText('New password is required.')).not.toBeInTheDocument();
    expect(within(pw).queryByText('Confirmation is required.')).not.toBeInTheDocument();
  });

  it('will not close an account on an empty password confirmation', async () => {
    const calls = mockApi();
    renderSettings();
    await settled();

    await userEvent.click(await screen.findByRole('button', { name: 'Close my account' }));
    await userEvent.click(screen.getByRole('button', { name: 'Permanently close account' }));

    expect(await screen.findByText('Password is required.')).toBeInTheDocument();
    expect(wrote(calls, 'DELETE', '/me')).toHaveLength(0);
    expect(screen.queryByText('LOGIN')).not.toBeInTheDocument();
  });

  it('closes a Google SSO account, which has no password to confirm', async () => {
    // The rule has to ask who is signed in — demanding a field that is not
    // rendered would make the button do nothing with nothing to show for it.
    const calls = mockApi(() => undefined, { ...baseUser, sso_provider: 'google' });
    renderSettings();
    await settled();

    await userEvent.click(await screen.findByRole('button', { name: 'Close my account' }));
    await userEvent.click(screen.getByRole('button', { name: 'Permanently close account' }));

    await waitFor(() => expect(wrote(calls, 'DELETE', '/me')).toHaveLength(1));
  });

  it('will not mint a token with a whitespace-only name', async () => {
    const calls = mockApi();
    renderSettings();
    await settled();

    const tokensCard = card('API tokens');
    await userEvent.type(within(tokensCard).getByLabelText('New token name'), '   ');
    await userEvent.click(within(tokensCard).getByRole('button', { name: 'Create token' }));

    expect(await within(tokensCard).findByText('Token name is required.')).toBeInTheDocument();
    expect(wrote(calls, 'POST', '/me/tokens')).toHaveLength(0);
  });

  it('flags a non-E.164 phone number on blur and refuses the save', async () => {
    const calls = mockApi();
    renderSettings();
    await settled();

    // PhoneInput is a country select plus a number box, so the field is
    // addressed by the inner control's own label rather than the Field's.
    const profile = card('Profile');
    await userEvent.type(within(profile).getByLabelText('Phone number'), '555');
    await userEvent.tab();
    expect(await within(profile).findByText(/too short/i)).toBeInTheDocument();

    await userEvent.click(within(profile).getByRole('button', { name: /Save/ }));
    expect(wrote(calls, 'PATCH', '/me')).toHaveLength(0);
  });
});

/**
 * Subject access (GDPR Art. 15). The privacy page has long said a user may
 * "request a copy or deletion of your personal data at any time"; deletion was
 * the Close account card, and the copy had nothing behind it at all.
 */
describe('SettingsPage — download your data', () => {
  beforeEach(() => vi.restoreAllMocks());

  /** jsdom has neither of the two things apiDownload needs to save a file. */
  function stubDownload() {
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    return vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  }

  it('downloads the export, named from the response', async () => {
    const click = stubDownload();
    const calls = mockApi((path) =>
      path.endsWith('/me/data-export')
        ? new Response(JSON.stringify({ subject_user_id: 'u1' }), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'content-disposition': 'attachment; filename="n409-data-export-2026-08-14.json"',
            },
          })
        : undefined,
    );
    renderSettings();
    await settled();

    const section = card('Download your data');
    await userEvent.click(within(section).getByRole('button', { name: /Download my data/ }));

    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(calls.filter((c) => c.path.endsWith('/me/data-export'))).toHaveLength(1);
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe('n409-data-export-2026-08-14.json');
  });

  it('reports a failure instead of silently saving nothing', async () => {
    stubDownload();
    mockApi((path) =>
      path.endsWith('/me/data-export')
        ? new Response(JSON.stringify({ status: 500, title: 'Internal Server Error' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        : undefined,
    );
    renderSettings();
    await settled();

    const section = card('Download your data');
    await userEvent.click(within(section).getByRole('button', { name: /Download my data/ }));
    expect(await within(section).findByText(/Internal Server Error|Could not build/)).toBeInTheDocument();
  });

  it('offers the copy above the irreversible half', async () => {
    // Somebody taking a copy before closing their account wants that order,
    // and will not get it if they meet Close account first.
    mockApi();
    renderSettings();
    await settled();

    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf('Download your data')).toBeLessThan(headings.indexOf('Close account'));
  });
});
