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

  /*
   * R270 — this used to end at `expect(queryByText('Sign in with SSO')).not
   * .toBeInTheDocument()` and nothing else, which is the bug written down as a
   * requirement: a probe that never answered was rendered as "there is no SSO
   * here". The page still cannot draw a button it does not know exists; what it
   * must not do is let the absence pass as an answer.
   */
  it('keeps the password form when the provider probe fails, and says the rest is unknown', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/providers')) return jsonResponse({ title: 'Down' }, 503);
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    renderLogin();
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Continue with Google')).not.toBeInTheDocument());
    expect(screen.queryByText('Sign in with SSO')).not.toBeInTheDocument();
    const note = await screen.findByText(/couldn’t load the other ways to sign in/i);
    expect(note).toHaveTextContent(/reload this page/i);
  });

  it('says nothing about other doors when the probe answered', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/providers'))
        return jsonResponse({ password: true, google: false, saml: false });
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    renderLogin();
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/couldn’t load the other ways/i)).not.toBeInTheDocument());
  });

  it('offers the SAML entry point when the tenant has it configured', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/providers'))
        return jsonResponse({ password: true, google: false, saml: true });
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    renderLogin();
    const sso = await screen.findByText('Sign in with SSO');
    expect(sso).toHaveAttribute('href', '/api/v1/auth/saml/login');
  });

  /*
   * R270 — the sign-in page is where an SSO refusal lands now.
   *
   * Every one of them used to end at the API's problem body, drawn as text in
   * the window the person was signing in through: no sentence, no way back.
   */
  describe('a refusal handed back by an identity provider flow', () => {
    const withProviders = (entry: string) => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).endsWith('/auth/providers'))
          return jsonResponse({ password: true, google: false, saml: true });
        throw new Error(`unexpected fetch ${String(url)}`);
      });
      return render(
        <MemoryRouter initialEntries={[entry]}>
          <AuthProvider>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>,
      );
    };

    it('says which of the causes it was, and what to do about it', async () => {
      withProviders('/login?sso_error=domain_not_allowed');
      const note = await screen.findByRole('alert');
      expect(note).toHaveTextContent(/restricted to a different email domain/);
      expect(note).toHaveTextContent(/administrator/);
    });

    it('tells a deactivated account apart from an unverifiable assertion', async () => {
      withProviders('/login?sso_error=account_deactivated');
      expect(await screen.findByRole('alert')).toHaveTextContent(/deactivated/);
    });

    it('answers an unknown code with the general sentence rather than echoing it', async () => {
      withProviders('/login?sso_error=<img src=x>');
      const note = await screen.findByRole('alert');
      expect(note).toHaveTextContent(/Single sign-on did not complete/);
      expect(note.textContent).not.toContain('img src');
    });

    it('draws nothing when the visitor simply came to sign in', async () => {
      withProviders('/login');
      expect(await screen.findByLabelText('Password')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('sends an already-authenticated visitor to the page they were bounced from', async () => {
    localStorage.setItem('n409.token', '1');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/auth/providers')) return jsonResponse({ password: true, google: false });
      if (u.endsWith('/auth/me')) return jsonResponse({ user: me });
      throw new Error(`unexpected fetch ${u}`);
    });
    render(
      <MemoryRouter initialEntries={[{ pathname: '/login', state: { from: '/valuations' } }]}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/valuations" element={<div>VALUATIONS</div>} />
            <Route path="/" element={<div>ROLE_LANDING</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('VALUATIONS')).toBeInTheDocument();
  });

  describe('the second factor', () => {
    /** Password step answers with a challenge instead of a token. */
    function mockMfaLogin(verify: (body: Record<string, unknown>) => Response) {
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const u = String(url);
        if (u.endsWith('/auth/providers')) return jsonResponse({ password: true, google: false });
        if (u.endsWith('/auth/login')) return jsonResponse({ mfa_required: true, challenge: 'ch-1' });
        if (u.endsWith('/auth/mfa/verify'))
          return verify(JSON.parse(String(init?.body)) as Record<string, unknown>);
        throw new Error(`unexpected fetch ${u}`);
      });
    }

    async function reachTheCodeStep() {
      renderLogin();
      await userEvent.type(screen.getByLabelText('Email'), 'ada@acme.com');
      await userEvent.type(screen.getByLabelText('Password'), 'hunter2hunter2');
      await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      expect(await screen.findByRole('heading', { name: 'Two-factor authentication' })).toBeInTheDocument();
    }

    it('asks for a code rather than signing in, and redeems the challenge', async () => {
      const bodies: Record<string, unknown>[] = [];
      mockMfaLogin((body) => {
        bodies.push(body);
        return jsonResponse({ user: me, token: 'jwt-token' });
      });
      await reachTheCodeStep();
      // The password step must not have issued a session on its own.
      expect(getToken()).toBeNull();

      await userEvent.type(screen.getByLabelText('Authenticator code'), '123456');
      await userEvent.click(screen.getByLabelText(/Remember this device/i));
      await userEvent.click(screen.getByRole('button', { name: 'Verify' }));

      expect(await screen.findByText('ROLE_LANDING')).toBeInTheDocument();
      expect(bodies[0]).toEqual({
        challenge: 'ch-1',
        code: '123456',
        backup_code: undefined,
        remember_device: true,
      });
      expect(getToken()).toBe('jwt-token');
    });

    it('sends a backup code under its own field, not as a TOTP code', async () => {
      const bodies: Record<string, unknown>[] = [];
      mockMfaLogin((body) => {
        bodies.push(body);
        return jsonResponse({ user: me, token: 'jwt-token' });
      });
      await reachTheCodeStep();

      await userEvent.type(screen.getByLabelText('Authenticator code'), '000000');
      await userEvent.click(screen.getByRole('button', { name: /use a backup code instead/i }));
      // Switching wipes the half-typed TOTP so it cannot be sent as a backup code.
      expect(screen.getByLabelText('Backup code')).toHaveValue('');

      await userEvent.type(screen.getByLabelText('Backup code'), 'AAAA-BBBB');
      await userEvent.click(screen.getByRole('button', { name: 'Verify' }));

      expect(await screen.findByText('ROLE_LANDING')).toBeInTheDocument();
      expect(bodies[0]).toEqual({
        challenge: 'ch-1',
        code: undefined,
        backup_code: 'AAAA-BBBB',
        remember_device: false,
      });
    });

    it('reports a rejected code and keeps the analyst on the second step', async () => {
      mockMfaLogin(() =>
        jsonResponse({ title: 'Unauthorized', status: 401, detail: 'That code is not valid.' }, 401),
      );
      await reachTheCodeStep();

      await userEvent.type(screen.getByLabelText('Authenticator code'), '999999');
      await userEvent.click(screen.getByRole('button', { name: 'Verify' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('That code is not valid.');
      expect(screen.getByRole('heading', { name: 'Two-factor authentication' })).toBeInTheDocument();
      expect(getToken()).toBeNull();
    });

    it('clears the error when the analyst switches code type', async () => {
      mockMfaLogin(() => jsonResponse({ title: 'Unauthorized', detail: 'Nope.' }, 401));
      await reachTheCodeStep();

      await userEvent.type(screen.getByLabelText('Authenticator code'), '999999');
      await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
      expect(await screen.findByRole('alert')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /use a backup code instead/i }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      // And back again, so the label round-trips.
      await userEvent.click(screen.getByRole('button', { name: /use your authenticator app instead/i }));
      expect(screen.getByLabelText('Authenticator code')).toBeInTheDocument();
    });

    it('will not submit an empty code, and says why', async () => {
      const verify = vi.fn(() => jsonResponse({ user: me, token: 'jwt-token' }));
      mockMfaLogin(verify);
      await reachTheCodeStep();

      // The button is live rather than disabled: a disabled button cannot tell
      // anyone what it is waiting for. Submitting is what reveals the message.
      await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
      expect(await screen.findByText('Authenticator code is required.')).toBeInTheDocument();
      expect(verify).not.toHaveBeenCalled();
    });
  });
});
