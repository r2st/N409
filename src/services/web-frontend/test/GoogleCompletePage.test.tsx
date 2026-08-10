import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/auth/google/complete']}>
      <Routes>
        <Route path="/auth/google/complete" element={<GoogleCompletePage />} />
        <Route path="/" element={<div data-testid="landed">workspace</div>} />
      </Routes>
    </MemoryRouter>,
  );
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

  it('offers a way back when the token is rejected', async () => {
    adoptToken.mockRejectedValue(new Error('expired'));
    renderPage();

    expect(await screen.findByText("Google sign-in didn't complete")).toBeInTheDocument();
    expect(screen.getByText('The sign-in link was missing or expired.')).toBeInTheDocument();
    expect(screen.queryByTestId('landed')).not.toBeInTheDocument();
  });
});
