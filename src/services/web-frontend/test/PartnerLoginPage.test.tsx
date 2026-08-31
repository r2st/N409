import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PartnerLoginPage } from '../src/pages/PartnerLoginPage';

/** Improvement 8 — white-label login at /partner/:slug/login. */

const login = vi.fn();

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ status: 'unauthenticated', user: null, login }),
}));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** As `/api/v1/public/branding/:key` resolves it — the whole brand, not four columns. */
const branding = {
  branding: {
    tenant_id: 'ptr-1',
    name: 'Bridge Advisors',
    tagline: null,
    accent: '#1f6f54',
    accent_dark: '#43cca0',
    accent_fg: '#ffffff',
    accent_dark_fg: '#08251c',
    logo_url: 'https://cdn.example.com/bridge.png',
    logo_dark_url: null,
    favicon_url: null,
    support_email: null,
    white_label: true,
  },
  css: { light: {}, dark: {} },
};

function renderAt(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/partner/${slug}/login`]}>
      <Routes>
        <Route path="/partner/:slug/login" element={<PartnerLoginPage />} />
        <Route path="/login" element={<div>standard login</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PartnerLoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('renders the partner name, logo, and brand accent from the public endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(branding));
    renderAt('bridge-advisors');

    expect(await screen.findByRole('heading', { name: 'Bridge Advisors' })).toBeInTheDocument();
    expect(screen.getByAltText('Bridge Advisors logo')).toHaveAttribute(
      'src',
      'https://cdn.example.com/bridge.png',
    );
    expect(screen.getByTestId('brand-accent')).toHaveStyle({ backgroundColor: '#1f6f54' });
    expect(screen.getByText(/Powered by/)).toBeInTheDocument();
    // The filled button carries the foreground the server resolved for that
    // accent; a pale brand otherwise gets default ink on its own colour.
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveStyle({
      backgroundColor: '#1f6f54',
      color: '#ffffff',
    });
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('/api/v1/public/branding/bridge-advisors');
  });

  it('signs in through the shared auth flow', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(branding));
    login.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderAt('bridge-advisors');

    await screen.findByRole('heading', { name: 'Bridge Advisors' });
    await user.type(screen.getByLabelText('Email'), 'pat@bridge.example');
    await user.type(screen.getByLabelText('Password'), 'hunter2hunter2');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(login).toHaveBeenCalledWith('pat@bridge.example', 'hunter2hunter2'));
  });

  it('falls back to the standard login for unknown slugs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 404 }, 404));
    renderAt('nobody');
    expect(await screen.findByText('standard login')).toBeInTheDocument();
  });

  /*
   * R270 — a slug that is not a firm and a brand we could not read were the
   * same answer here, and the answer navigates. A 503 took the analyst off the
   * address their firm gave them, onto the platform's own page, with nothing
   * said and the URL already out of the bar.
   */
  it('keeps the analyst on their firm’s address when the brand cannot be read', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ title: 'Down' }, 503));
    renderAt('bridge-advisors');

    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByText('standard login')).not.toBeInTheDocument();
    expect(screen.getByText(/couldn’t load your firm’s branding/i)).toHaveTextContent(
      /still the right page/i,
    );
  });

  it('does not sit on a spinner when the request never lands', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network'));
    renderAt('bridge-advisors');

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('says nothing about branding when there was nothing wrong with it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(branding));
    renderAt('bridge-advisors');

    await screen.findByRole('heading', { name: 'Bridge Advisors' });
    expect(screen.queryByText(/couldn’t load your firm’s branding/i)).not.toBeInTheDocument();
  });
});
