import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BrandingProvider, type Branding } from '../src/lib/branding';
import { Wordmark } from '../src/components/Logo';
import { ErrorBoundary } from '../src/components/ErrorBoundary';

/**
 * A 200 from /branding carrying the wrong body used to take the whole
 * authenticated shell down.
 *
 * `api()` rejects on a network error or a non-2xx, and the provider already
 * swallowed that on purpose — "an unbranded tenant is the norm and a failed
 * lookup must never block the app". What it could not survive was a *successful*
 * response with an unexpected shape: `setBranding(res.branding)` stored
 * `undefined`, and the next render of <Wordmark> read `.name` off it. The user
 * did not get an unbranded logo, they got "Something went wrong" in place of
 * the entire workspace — sidebar, navigation and the sign-out button included —
 * and nothing in the console, because the `.catch` meant to make branding
 * optional also swallowed the TypeError raised one line later.
 *
 * Reachable in front of a reverse proxy: an error page served as 200, a
 * half-finished deploy answering the route from another service, an empty
 * tenant record.
 */

vi.mock('../src/lib/auth', async () => ({
  useAuth: () => ({ status: 'authenticated', user: { id: 'u1', roles: ['partner'] } }),
}));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const FIRM: Branding = {
  tenant_id: '01J0FIRM00000000000000000',
  name: 'Meridian Valuations',
  tagline: '409A & ASC 718',
  accent: '#101a3a',
  accent_dark: '#5f74c4',
  accent_fg: '#ffffff',
  accent_dark_fg: '#0b1220',
  logo_url: null,
  logo_dark_url: null,
  favicon_url: null,
  support_email: null,
  white_label: true,
};

function mountShell() {
  return render(
    <MemoryRouter>
      <ErrorBoundary>
        <BrandingProvider>
          <Wordmark />
        </BrandingProvider>
      </ErrorBoundary>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  document.getElementById('n409-brand-theme')?.remove();
  document.documentElement.removeAttribute('data-brand');
});

/** Every 200 body that is not a branding payload. */
const MALFORMED: Array<[string, unknown]> = [
  ['an empty object', {}],
  ['a null branding', { branding: null }],
  ['a paginated envelope from the wrong route', { items: [], total: 0, page: 1 }],
  ['branding without a name', { branding: { ...FIRM, name: undefined } }],
  ['an empty name', { branding: { ...FIRM, name: '' } }],
  ['a name that is not a string', { branding: { ...FIRM, name: 42 } }],
  ['white_label missing', { branding: { ...FIRM, white_label: undefined } }],
  ['a bare array', []],
  ['a bare string', 'ok'],
  ['null', null],
];

describe('a malformed 200 from /branding', () => {
  it.each(MALFORMED)('survives %s', async (_label, body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body));
    mountShell();

    // The shell keeps rendering, on the brand that was already showing.
    await waitFor(() => expect(screen.getByText('409A')).toBeInTheDocument());
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });

  it('does not un-brand a firm that was already resolved', async () => {
    // Replacing a bad payload with PLATFORM_BRANDING would be a quieter bug:
    // a firm's workspace silently losing its identity over one bad response.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ branding: FIRM, css: null }));
    const { rerender } = mountShell();
    await waitFor(() => expect(screen.getByText('Meridian Valuations')).toBeInTheDocument());

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ oops: true }));
    rerender(
      <MemoryRouter>
        <ErrorBoundary>
          <BrandingProvider>
            <Wordmark />
          </BrandingProvider>
        </ErrorBoundary>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Meridian Valuations')).toBeInTheDocument());
  });

  it('leaves the document unbranded rather than half-branded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ branding: { name: 'X' } }));
    mountShell();
    await waitFor(() => expect(screen.getByText('409A')).toBeInTheDocument());
    // A payload that fails the check must not have written a partial ramp.
    expect(document.documentElement.hasAttribute('data-brand')).toBe(false);
  });
});

describe('a well-formed 200 still applies', () => {
  it('brands the shell', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        branding: FIRM,
        css: { light: { '--brand-accent': '#101a3a' }, dark: { '--brand-accent': '#5f74c4' } },
      }),
    );
    mountShell();
    await waitFor(() => expect(screen.getByText('Meridian Valuations')).toBeInTheDocument());
    expect(document.documentElement.getAttribute('data-brand')).toBe('on');
  });

  it('accepts a branded tenant that sends no css', async () => {
    // css is optional in practice — an unbranded-but-named tenant. It must not
    // be the thing that trips the guard.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ branding: { ...FIRM, white_label: false } }),
    );
    mountShell();
    await waitFor(() => expect(screen.getByText('409A')).toBeInTheDocument());
    expect(document.documentElement.hasAttribute('data-brand')).toBe(false);
  });
});

describe('a rejected request is still tolerated', () => {
  it('keeps the platform brand on a network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    mountShell();
    await waitFor(() => expect(screen.getByText('409A')).toBeInTheDocument());
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });

  it('keeps the platform brand on a 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ title: 'boom' }, 500));
    mountShell();
    await waitFor(() => expect(screen.getByText('409A')).toBeInTheDocument());
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });
});
