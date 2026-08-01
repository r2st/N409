import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { getToken } from '../src/lib/api';
import { LoginPage } from '../src/pages/LoginPage';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>ROLE_LANDING</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const me = {
  id: 'u1',
  email: 'ada@acme.com',
  first_name: 'Ada',
  last_name: 'Lovelace',
  verified: true,
  sso_provider: null,
  partner_id: null,
  roles: ['valuation_user'],
};

describe('LoginPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the sign-in form and hides Google when not configured', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/providers')) return jsonResponse({ password: true, google: false });
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    renderLogin();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Continue with Google')).not.toBeInTheDocument());
  });

  it('shows the Google button when the provider is configured', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/providers')) return jsonResponse({ password: true, google: true });
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    renderLogin();
    expect(await screen.findByText('Continue with Google')).toBeInTheDocument();
  });

  it('logs in and redirects to the role-aware landing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/auth/providers')) return jsonResponse({ password: true, google: false });
      if (u.endsWith('/auth/login')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ email: 'ada@acme.com', password: 'hunter2hunter2' });
        return jsonResponse({ user: me, token: 'jwt-token' });
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    renderLogin();
    await userEvent.type(screen.getByLabelText('Email'), 'ada@acme.com');
    await userEvent.type(screen.getByLabelText('Password'), 'hunter2hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('ROLE_LANDING')).toBeInTheDocument();
    // The JWT is held in memory (audit F-2), not localStorage; only a session
    // marker persists there.
    expect(getToken()).toBe('jwt-token');
    expect(localStorage.getItem('n409.token')).not.toBeNull();
  });

  it('surfaces the API problem detail on bad credentials', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/auth/providers')) return jsonResponse({ password: true, google: false });
      if (u.endsWith('/auth/login'))
        return jsonResponse({ title: 'Unauthorized', status: 401, detail: 'Invalid email or password' }, 401);
      throw new Error(`unexpected fetch ${u}`);
    });
    renderLogin();
    await userEvent.type(screen.getByLabelText('Email'), 'ada@acme.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
  });
});
