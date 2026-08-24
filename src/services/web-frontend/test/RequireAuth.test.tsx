import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, MAX_SESSION_MS, useAuth } from '../src/lib/auth';
import { UNAUTHORIZED_EVENT, getToken, setToken } from '../src/lib/api';
import { RequireAuth } from '../src/components/RequireAuth';

/**
 * The gate every authenticated route sits behind, and the session lifecycle it
 * reads: restore-from-cookie, the global 401, and the expiry sign-out.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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

/** Prints where the login redirect landed, and what it remembered. */
function LoginProbe() {
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? 'none';
  return <div>LOGIN from={from}</div>;
}

function renderGate(entry = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <Routes>
          <Route
            path="/dashboard"
            element={
              <RequireAuth>
                <div>DASHBOARD</div>
              </RequireAuth>
            }
          />
          <Route path="/login" element={<LoginProbe />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** A signed JWT-shaped token whose `exp` is `seconds` from now. */
function tokenExpiringIn(seconds: number) {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds }));
  return `header.${payload}.signature`;
}

describe('RequireAuth', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends an anonymous visitor to login, remembering where they were headed', async () => {
    renderGate('/dashboard');
    expect(await screen.findByText('LOGIN from=/dashboard')).toBeInTheDocument();
    expect(screen.queryByText('DASHBOARD')).not.toBeInTheDocument();
  });

  it('holds the route with a spinner while the session is being restored', async () => {
    localStorage.setItem('n409.token', '1');
    let release: (r: Response) => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    renderGate();

    // Neither the page nor the login redirect — the gate waits.
    expect(screen.queryByText('DASHBOARD')).not.toBeInTheDocument();
    expect(screen.queryByText(/^LOGIN/)).not.toBeInTheDocument();

    await act(async () => release(jsonResponse({ user: me })));
    expect(await screen.findByText('DASHBOARD')).toBeInTheDocument();
  });

  it('renders the route once the session is restored from the cookie', async () => {
    localStorage.setItem('n409.token', '1');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ user: me }));
    renderGate();
    expect(await screen.findByText('DASHBOARD')).toBeInTheDocument();
  });

  it('drops a session marker whose cookie the server no longer honours', async () => {
    localStorage.setItem('n409.token', '1');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/auth/me')
        ? jsonResponse({ title: 'Unauthorized' }, 401)
        : jsonResponse({ ok: true }),
    );
    renderGate();
    expect(await screen.findByText('LOGIN from=/dashboard')).toBeInTheDocument();
    expect(localStorage.getItem('n409.token')).toBeNull();
  });
});

describe('AuthProvider session lifecycle', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.useRealTimers());

  /** Renders a probe that reports status and can drive logout. */
  function renderProbe(replacement?: string) {
    function Probe() {
      const { status, user, logout, viewMode, setViewMode, replaceToken } = useAuth();
      return (
        <div>
          <span data-testid="status">{status}</span>
          <span data-testid="user">{user?.email ?? 'none'}</span>
          <span data-testid="view-mode">{viewMode}</span>
          <button onClick={() => setViewMode('normal')}>preview as user</button>
          <button onClick={logout}>sign out</button>
          {replacement && <button onClick={() => replaceToken(replacement)}>change password</button>}
        </div>
      );
    }
    return render(
      <MemoryRouter>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </MemoryRouter>,
    );
  }

  it('starts anonymous with no session marker and never calls /auth/me', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ user: me }));
    renderProbe();
    expect(screen.getByTestId('status')).toHaveTextContent('anonymous');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('signs out globally when any request anywhere answers 401', async () => {
    localStorage.setItem('n409.token', '1');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ user: me }));
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    act(() => {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    });

    expect(screen.getByTestId('status')).toHaveTextContent('anonymous');
    expect(screen.getByTestId('user')).toHaveTextContent('none');
  });

  it('clears the cookie server-side on an explicit sign-out', async () => {
    localStorage.setItem('n409.token', '1');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ user: me }));
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    await userEvent.click(screen.getByRole('button', { name: 'sign out' }));

    expect(screen.getByTestId('status')).toHaveTextContent('anonymous');
    expect(localStorage.getItem('n409.token')).toBeNull();
    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/auth/logout', expect.objectContaining({ method: 'POST' }));
  });

  it('does not carry a "normal view" preview across a sign-out', async () => {
    localStorage.setItem('n409.token', '1');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ user: me }));
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    await userEvent.click(screen.getByRole('button', { name: 'preview as user' }));
    expect(screen.getByTestId('view-mode')).toHaveTextContent('normal');

    await userEvent.click(screen.getByRole('button', { name: 'sign out' }));
    expect(screen.getByTestId('view-mode')).toHaveTextContent('admin');
  });

  it('signs out on the spot when the restored token has already expired', async () => {
    localStorage.setItem('n409.token', String(Date.now() - 1000));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ user: me }));
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
  });

  it('schedules a clean sign-out for the moment the token expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem('n409.token', '1');
    setToken(tokenExpiringIn(60));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ user: me }));
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });

    expect(screen.getByTestId('status')).toHaveTextContent('anonymous');
    expect(getToken()).toBeNull();
  });

  /*
   * Changing a password, and signing out other sessions, both invalidate the
   * token in hand and hand back its successor. The successor carries a full
   * fresh lifetime — so a session that survives one of those must not end when
   * the token it replaced would have.
   */
  it('reschedules the sign-out when a token is replaced in place', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem('n409.token', '1');
    setToken(tokenExpiringIn(60));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ user: me }));
    renderProbe(tokenExpiringIn(3600));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    await act(async () => {
      screen.getByRole('button', { name: 'change password' }).click();
    });

    // Well past the replaced token's expiry, comfortably inside the new one's.
    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated');

    // …and the replacement's own expiry still ends the session.
    await act(async () => {
      vi.advanceTimersByTime(3_600_000);
    });
    expect(screen.getByTestId('status')).toHaveTextContent('anonymous');
  });

  /*
   * A `setTimeout` delay is held as a signed 32-bit integer. Hand it more than
   * 2147483647 ms — a little under 25 days — and it does not schedule far
   * ahead, it fires on the next tick.
   *
   * `exp` is an absolute epoch and `Date.now()` is only the client's opinion of
   * the time, so a device whose clock is behind by a month or more computed
   * exactly such a delay: the sign-out fired about a millisecond after the
   * sign-in, bouncing the user back to a login page carrying no error, for
   * every attempt, with nothing pointing at the clock.
   *
   * The assertion is on the delay rather than on the outcome deliberately: fake
   * timers store the delay as an ordinary number and do not reproduce the
   * truncation, so a behavioural test here would pass with or without the
   * clamp. What has to hold is that the number handed to `setTimeout` is one
   * `setTimeout` can represent.
   */
  it('never hands setTimeout a delay it would truncate', async () => {
    const scheduled: number[] = [];
    const realSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (typeof ms === 'number') scheduled.push(ms);
      // Short delays are passed straight through, because `waitFor` below
      // schedules its own and would never poll otherwise. The sign-out delay
      // is kept, not collapsed: firing it at 0 ms signed the probe out on the
      // next tick, and the `waitFor` was then racing a session that had
      // already ended — it usually caught the moment in between and
      // intermittently did not. This test asserts on the number handed to
      // `setTimeout`, never on what the timer goes on to do.
      return realSetTimeout(fn, typeof ms === 'number' && ms > 1000 ? ms : 0);
    }) as typeof window.setTimeout);

    localStorage.setItem('n409.token', '1');
    // A clock 40 days behind: the token is fine, `exp - now` is not.
    setToken(tokenExpiringIn(40 * 24 * 60 * 60));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ user: me }));
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    const signOutDelays = scheduled.filter((ms) => ms > 1000);
    expect(signOutDelays.length).toBeGreaterThan(0);
    for (const ms of signOutDelays) {
      expect(ms).toBeLessThanOrEqual(MAX_SESSION_MS);
      expect(ms).toBeLessThanOrEqual(2_147_483_647);
    }
  });

  it('still schedules the real expiry when the clock is sane', async () => {
    const scheduled: number[] = [];
    const realSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (typeof ms === 'number') scheduled.push(ms);
      // Short delays are passed straight through, because `waitFor` below
      // schedules its own and would never poll otherwise. The sign-out delay
      // is kept, not collapsed: firing it at 0 ms signed the probe out on the
      // next tick, and the `waitFor` was then racing a session that had
      // already ended — it usually caught the moment in between and
      // intermittently did not. This test asserts on the number handed to
      // `setTimeout`, never on what the timer goes on to do.
      return realSetTimeout(fn, typeof ms === 'number' && ms > 1000 ? ms : 0);
    }) as typeof window.setTimeout);

    localStorage.setItem('n409.token', '1');
    setToken(tokenExpiringIn(8 * 60 * 60));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ user: me }));
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    // The clamp is a ceiling, not the value: an ordinary 8-hour session is
    // still scheduled for 8 hours.
    expect(scheduled.some((ms) => Math.abs(ms - 8 * 60 * 60 * 1000) < 5_000)).toBe(true);
  });

  it('stays signed in when no expiry is known at all', async () => {
    localStorage.setItem('n409.token', '1');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ user: me }));
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('user')).toHaveTextContent('ada@acme.com');
  });

  it('refuses to be used outside its provider rather than handing back a null context', () => {
    function Orphan() {
      useAuth();
      return null;
    }
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Orphan />)).toThrow(/must be used inside <AuthProvider>/);
    quiet.mockRestore();
  });
});

/**
 * The clamp is only safe because it is the server's own ceiling: if the API
 * could ever issue a session longer than `MAX_SESSION_MS`, the timer would cut
 * a legitimate one short. The two numbers live in different services, so this
 * reads the authority rather than restating it.
 */
describe('the sign-out ceiling matches the API', () => {
  it('equals the maximum JWT_TTL_SECONDS the valuation service will accept', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const config = readFileSync(path.resolve(here, '../../valuation/src/config.ts'), 'utf8');
    const cap = /JWT_TTL_SECONDS[\s\S]*?\.max\((\d+)/.exec(config)?.[1];
    // Vacuity guard: a renamed variable or a restructured schema must fail
    // here, not silently stop checking.
    expect(cap, 'could not find the .max() on JWT_TTL_SECONDS').toBeDefined();
    expect(MAX_SESSION_MS).toBe(Number(cap) * 1000);
  });
});
