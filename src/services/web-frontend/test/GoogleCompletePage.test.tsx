import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { GoogleCompletePage } from '../src/pages/GoogleCompletePage';

/**
 * The Google OIDC landing page. It holds a live session token in the URL
 * fragment for the length of one effect — so what matters is that the token is
 * adopted exactly once, removed from the URL before anything else can read it,
 * and that a failure lands somewhere other than a permanent spinner.
 */

const TOKEN = 'gt_01N409GOOGLETOKEN000000000';

const adoptToken = vi.fn<(token: string) => Promise<void>>();

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ adoptToken }),
}));

/** Renders the login route too, since an SSO hand-off may now end up there. */
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/auth/google/complete']}>
      <Routes>
        <Route path="/auth/google/complete" element={<GoogleCompletePage />} />
        <Route path="/" element={<div data-testid="landed">workspace</div>} />
        <Route path="/login" element={<SecondFactorProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Stands in for `LoginPage`, reporting the challenge it was handed in state. */
function SecondFactorProbe() {
  const state = useLocation().state as { mfaChallenge?: string } | null;
  return <div data-testid="second-factor">{state?.mfaChallenge ?? 'none'}</div>;
}

describe('GoogleCompletePage', () => {
  beforeEach(() => {
    adoptToken.mockReset();
    adoptToken.mockResolvedValue(undefined);
    window.history.replaceState(null, '', `/auth/google/complete#token=${TOKEN}`);
  });
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('adopts the token from the fragment and lands the user in the app', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('landed')).toBeInTheDocument());
    expect(adoptToken).toHaveBeenCalledExactlyOnceWith(TOKEN);
  });

  it('strips the token from the URL before adopting it', async () => {
    let hashAtAdopt: string | null = null;
    adoptToken.mockImplementation(async () => {
      hashAtAdopt = window.location.hash;
    });
    renderPage();

    await waitFor(() => expect(adoptToken).toHaveBeenCalled());
    // A session token left in the address bar is one bookmark or shoulder-surf
    // away from being someone else's session.
    expect(hashAtAdopt).toBe('');
    expect(window.location.pathname).toBe('/auth/google/complete');
  });

  it('shows a spinner while the token is being exchanged', () => {
    adoptToken.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('landed')).not.toBeInTheDocument();
  });

  it('adopts once even under StrictMode’s double-invoked effects', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('landed')).toBeInTheDocument());
    expect(adoptToken).toHaveBeenCalledTimes(1);
  });

  it('explains a redirect that arrived with no token', async () => {
    window.history.replaceState(null, '', '/auth/google/complete');
    renderPage();

    expect(await screen.findByText("Google sign-in didn't complete")).toBeInTheDocument();
    expect(adoptToken).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
  });

  /*
   * The second half of R354's fix, from the browser's side.
   *
   * Both SSO doors used to answer a 2FA-enabled account with `#token=` — a full
   * session that never met the factor its owner had enrolled here. They now
   * answer `#mfa=<challenge>`, and this page's job is to get that to the one
   * screen that can redeem it without leaving it in the address bar on the way.
   */
  it('carries an MFA challenge to the sign-in screen instead of adopting a session', async () => {
    const challenge = 'mfa_01N409CHALLENGE0000000000';
    window.history.replaceState(null, '', `/auth/google/complete#mfa=${challenge}`);
    renderPage();

    expect(await screen.findByTestId('second-factor')).toHaveTextContent(challenge);
    // Nothing was adopted: no session exists yet, which is the whole point.
    expect(adoptToken).not.toHaveBeenCalled();
    // And the challenge is a bearer credential for the second step, so it comes
    // out of the URL for the same reason the token does.
    expect(window.location.hash).toBe('');
  });

  it('offers a way back when the token is rejected', async () => {
    adoptToken.mockRejectedValue(new Error('expired'));
    renderPage();

    expect(await screen.findByText("Google sign-in didn't complete")).toBeInTheDocument();
    expect(screen.getByText('The sign-in link was missing or expired.')).toBeInTheDocument();
    expect(screen.queryByTestId('landed')).not.toBeInTheDocument();
  });
});
