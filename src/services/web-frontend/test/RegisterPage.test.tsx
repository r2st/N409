import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { COMPANY_HINT_KEY, RegisterPage } from '../src/pages/RegisterPage';

/** Sign-up is gated by the `registration_enabled` system setting. */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const publicSettings = (registration_enabled: boolean, support_email = 'help@409.ai') =>
  jsonResponse({ settings: { registration_enabled, maintenance_mode: false, support_email } });

function renderRegister() {
  return render(
    <MemoryRouter initialEntries={['/register']}>
      <AuthProvider>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/login" element={<div>LOGIN</div>} />
          <Route path="/onboarding" element={<div>ONBOARDING</div>} />
          <Route path="/dashboard" element={<div>DASHBOARD</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('RegisterPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows the sign-up form when registration is open', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(publicSettings(true));
    renderRegister();
    expect(await screen.findByRole('button', { name: 'Create account' })).toBeInTheDocument();
  });

  it('replaces the form with a closed notice when registration is off', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(publicSettings(false));
    renderRegister();

    expect(await screen.findByText('Registration is closed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create account' })).not.toBeInTheDocument();
    // The support address comes from the same setting, so it stays current.
    expect(screen.getByRole('link', { name: 'help@409.ai' })).toHaveAttribute('href', 'mailto:help@409.ai');
  });

  it('falls back to showing the form if the settings call fails', async () => {
    // The API still rejects the POST, so the worst case is a clear error
    // rather than a blank page.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    renderRegister();
    expect(await screen.findByRole('button', { name: 'Create account' })).toBeInTheDocument();
  });

  it('names the generic support address when the setting carries none', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        settings: { registration_enabled: false, maintenance_mode: false, support_email: null },
      }),
    );
    renderRegister();
    expect(await screen.findByRole('link', { name: 'support@409.ai' })).toHaveAttribute(
      'href',
      'mailto:support@409.ai',
    );
  });

  it('rejects a short password on the client without calling the API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(publicSettings(true));
    renderRegister();

    await userEvent.type(await screen.findByLabelText('Work email'), 'ada@acme.com');
    await userEvent.type(screen.getByLabelText('Password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    // Next to the password box, not in the banner above the form: the message
    // is what `aria-describedby` on that control points at.
    const box = screen.getByLabelText('Password');
    await waitFor(() => expect(box).toHaveAttribute('aria-invalid', 'true'));
    expect(document.getElementById(box.getAttribute('aria-describedby')!)).toHaveTextContent(
      /at least 10 characters/i,
    );
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes('/auth/register'))).toHaveLength(
      0,
    );
  });

  it('flags a malformed email on blur, before anything is submitted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(publicSettings(true));
    renderRegister();

    await userEvent.type(await screen.findByLabelText('Work email'), 'ada@');
    await userEvent.tab();
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
  });

  it('says nothing about an email still being typed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(publicSettings(true));
    renderRegister();

    await userEvent.type(await screen.findByLabelText('Work email'), 'ada@');
    expect(screen.queryByText('Enter a valid email address.')).not.toBeInTheDocument();
  });

  it('reveals both messages on a submit of the empty form, and calls nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(publicSettings(true));
    renderRegister();

    // The button is no longer disabled while the form is incomplete — a
    // disabled button cannot say why it will not work.
    await userEvent.click(await screen.findByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Work email is required.')).toBeInTheDocument();
    expect(screen.getByText('Password is required.')).toBeInTheDocument();
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes('/auth/register'))).toHaveLength(
      0,
    );
  });

  it('registers, seeds the company hint, and lands in the guided funnel', async () => {
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/public/settings')) return publicSettings(true);
      if (u.endsWith('/auth/register')) {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ user: newUser, token: 'jwt-token' });
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    render(
      <MemoryRouter initialEntries={['/register']}>
        <AuthProvider>
          <Routes>
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/onboarding" element={<div>ONBOARDING</div>} />
            <Route path="/dashboard" element={<div>DASHBOARD</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    await userEvent.type(await screen.findByLabelText('First name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Last name'), 'Lovelace');
    await userEvent.type(screen.getByLabelText('Company'), '  Acme, Inc.  ');
    await userEvent.type(screen.getByLabelText('Work email'), 'ada@acme.com');
    await userEvent.type(screen.getByLabelText('Password'), 'hunter2hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('ONBOARDING')).toBeInTheDocument();
    expect(bodies[0]).toEqual({
      email: 'ada@acme.com',
      password: 'hunter2hunter2',
      first_name: 'Ada',
      last_name: 'Lovelace',
    });
    // Trimmed — the onboarding funnel reads this straight into a form field.
    expect(localStorage.getItem(COMPANY_HINT_KEY)).toBe('Acme, Inc.');
  });

  it('omits blank names rather than registering an empty string', async () => {
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/public/settings')) return publicSettings(true);
      if (u.endsWith('/auth/register')) {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ user: newUser, token: 'jwt-token' });
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    renderRegister();

    await userEvent.type(await screen.findByLabelText('Work email'), 'ada@acme.com');
    await userEvent.type(screen.getByLabelText('Password'), 'hunter2hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      email: 'ada@acme.com',
      password: 'hunter2hunter2',
      first_name: undefined,
      last_name: undefined,
    });
    expect(localStorage.getItem(COMPANY_HINT_KEY)).toBeNull();
  });

  it('surfaces an email the API already knows', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/public/settings')) return publicSettings(true);
      if (u.endsWith('/auth/register'))
        return jsonResponse({ title: 'Conflict', detail: 'That email is already registered.' }, 409);
      throw new Error(`unexpected fetch ${u}`);
    });
    renderRegister();

    await userEvent.type(await screen.findByLabelText('Work email'), 'ada@acme.com');
    await userEvent.type(screen.getByLabelText('Password'), 'hunter2hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That email is already registered.');
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled();
  });

  it('sends an already-signed-in visitor to the dashboard', async () => {
    localStorage.setItem('n409.token', '1');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/public/settings')) return publicSettings(true);
      if (u.endsWith('/auth/me')) return jsonResponse({ user: newUser });
      throw new Error(`unexpected fetch ${u}`);
    });
    render(
      <MemoryRouter initialEntries={['/register']}>
        <AuthProvider>
          <Routes>
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/dashboard" element={<div>DASHBOARD</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('DASHBOARD')).toBeInTheDocument();
  });
});

const newUser = {
  id: 'u1',
  email: 'ada@acme.com',
  first_name: 'Ada',
  last_name: 'Lovelace',
  verified: false,
  sso_provider: null,
  partner_id: null,
  roles: ['valuation_user'],
};
