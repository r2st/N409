import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import {
  applyBrandingCss,
  BrandingProvider,
  brandLogo,
  PLATFORM_BRANDING,
  useBranding,
  type Branding,
  type BrandingCss,
} from '../src/lib/branding';
import { BrandingPage } from '../src/pages/BrandingPage';
import { Wordmark } from '../src/components/Logo';
import { isFirmAdmin } from '../src/lib/rbac';

/**
 * White-label branding in the SPA. The property under test throughout is that
 * the *server's* resolved brand is what reaches the DOM — the client applies,
 * it never derives, so a firm's accent cannot drift between app and report.
 */

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
  logo_url: 'https://cdn.example.com/meridian.svg',
  logo_dark_url: 'https://cdn.example.com/meridian-dark.svg',
  favicon_url: 'https://cdn.example.com/favicon.png',
  support_email: 'valuations@meridian.example.com',
  white_label: true,
};

const FIRM_CSS: BrandingCss = {
  light: {
    '--brand-accent': '#101a3a',
    '--brand-accent-fg': '#ffffff',
    '--brand-accent-soft': '#e7e8ed',
    '--brand-accent-muted': '#b6bac9',
    '--brand-accent-strong': '#0d1530',
  },
  dark: {
    '--brand-accent': '#5f74c4',
    '--brand-accent-fg': '#0b1220',
    '--brand-accent-soft': '#15192b',
    '--brand-accent-muted': '#2b3458',
    '--brand-accent-strong': '#6f82ca',
  },
};

/** The provider reads auth status, and only fetches once authenticated. */
vi.mock('../src/lib/auth', async () => ({
  useAuth: () => ({ status: 'authenticated', user: { id: 'u1', roles: ['partner'] } }),
}));

function brandStyleText(): string {
  return document.getElementById('n409-brand-theme')?.textContent ?? '';
}

afterEach(() => {
  vi.restoreAllMocks();
  document.getElementById('n409-brand-theme')?.remove();
  document.documentElement.removeAttribute('data-brand');
  document.querySelector("link[rel~='icon']")?.remove();
});

describe('applyBrandingCss', () => {
  it('writes a light and a dark rule, and flags the document', () => {
    applyBrandingCss(FIRM, FIRM_CSS);

    expect(document.documentElement.getAttribute('data-brand')).toBe('on');
    const css = brandStyleText();
    // The dark rule carries the extra attribute so it wins when both match —
    // that is what lets index.css map the accent tokens exactly once.
    expect(css).toContain(":root[data-brand='on']{");
    expect(css).toContain(":root[data-brand='on'][data-theme='dark']{");
    expect(css).toContain('--brand-accent:#101a3a;');
    expect(css).toContain('--brand-accent:#5f74c4;');
  });

  it('removes the stylesheet and the flag when branding is cleared', () => {
    applyBrandingCss(FIRM, FIRM_CSS);
    applyBrandingCss(PLATFORM_BRANDING, null);

    expect(document.getElementById('n409-brand-theme')).toBeNull();
    expect(document.documentElement.hasAttribute('data-brand')).toBe(false);
  });

  it('drops anything that is not a hex value, so a rule cannot be broken out of', () => {
    applyBrandingCss(FIRM, {
      light: { '--brand-accent': '#ff0000', '--brand-accent-fg': 'red;} body{display:none' },
      dark: FIRM_CSS.dark,
    });

    const css = brandStyleText();
    expect(css).toContain('--brand-accent:#ff0000;');
    expect(css).not.toContain('display:none');
  });

  it('does not apply a tenant ramp when the tenant has not gone live', () => {
    applyBrandingCss({ ...FIRM, white_label: false }, FIRM_CSS);
    expect(document.documentElement.hasAttribute('data-brand')).toBe(false);
  });
});

describe('BrandingProvider', () => {
  function Probe() {
    const branding = useBranding();
    return <span data-testid="brand">{branding.name}</span>;
  }

  it('applies the tenant brand fetched from the API', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ branding: FIRM, css: FIRM_CSS }));

    render(
      <BrandingProvider>
        <Probe />
      </BrandingProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('brand')).toHaveTextContent('Meridian Valuations'));
    expect(document.documentElement.getAttribute('data-brand')).toBe('on');
  });

  it('swaps the favicon and can restore the platform icon', async () => {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = 'https://app.example.com/favicon.ico';
    document.head.append(link);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ branding: FIRM, css: FIRM_CSS }));
    const { unmount } = render(
      <BrandingProvider>
        <Probe />
      </BrandingProvider>,
    );
    await waitFor(() => expect(link.href).toBe('https://cdn.example.com/favicon.png'));
    unmount();

    // The original href is remembered, so clearing branding is a true revert.
    expect(link.dataset.platformHref).toBe('https://app.example.com/favicon.ico');
  });

  it('stays on platform branding when the lookup fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 500 }, 500));

    render(
      <BrandingProvider>
        <Probe />
      </BrandingProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('brand')).toHaveTextContent('N409'));
    expect(document.documentElement.hasAttribute('data-brand')).toBe(false);
  });
});

describe('Wordmark', () => {
  it('shows the platform mark by default', () => {
    render(<Wordmark />);
    expect(screen.getByText('N409')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows the firm name and logo once branding resolves', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ branding: FIRM, css: FIRM_CSS }));

    render(
      <BrandingProvider>
        <Wordmark />
      </BrandingProvider>,
    );

    await waitFor(() => expect(screen.getByText('Meridian Valuations')).toBeInTheDocument());
    expect(screen.getByText('409A & ASC 718')).toBeInTheDocument();
    expect(document.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example.com/meridian.svg');
  });
});

describe('brandLogo', () => {
  it('falls back to the light asset for dark chrome', () => {
    expect(brandLogo({ ...FIRM, logo_dark_url: null }, 'dark')).toBe(FIRM.logo_url);
    expect(brandLogo(FIRM, 'dark')).toBe('https://cdn.example.com/meridian-dark.svg');
  });
});

describe('isFirmAdmin', () => {
  it('admits a firm partner and platform admins, but not an ordinary member', () => {
    expect(isFirmAdmin({ roles: ['partner'] })).toBe(true);
    expect(isFirmAdmin({ roles: ['admin'] })).toBe(true);
    expect(isFirmAdmin({ roles: ['member'] })).toBe(false);
    expect(isFirmAdmin({ roles: ['valuation_user'] })).toBe(false);
    expect(isFirmAdmin(null)).toBe(false);
  });
});

describe('BrandingPage', () => {
  const SETTINGS = {
    id: FIRM.tenant_id,
    name: 'Meridian Valuation LLP',
    brand_name: 'Meridian Valuations',
    brand_tagline: null,
    brand_color: '#101a3a',
    accent_color_dark: null,
    logo_url: null,
    logo_dark_url: null,
    favicon_url: null,
    support_email: null,
    white_label_enabled: false,
  };

  interface Call {
    path: string;
    method: string;
    body?: Record<string, unknown>;
  }

  function mockApi(): Call[] {
    const calls: Call[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const path = String(url);
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ path, method, body });

      if (path.includes('/branding/settings'))
        return jsonResponse({ settings: SETTINGS, preview: FIRM, defaults: PLATFORM_BRANDING });
      if (method === 'PATCH') return jsonResponse({ settings: { ...SETTINGS, ...body }, branding: FIRM });
      return jsonResponse({ branding: FIRM, css: FIRM_CSS });
    });
    return calls;
  }

  const renderPage = () =>
    render(
      <MemoryRouter>
        <BrandingProvider>
          <BrandingPage />
        </BrandingProvider>
      </MemoryRouter>,
    );

  it('previews the resolved colours rather than the typed ones', async () => {
    mockApi();
    renderPage();

    // accent_color_dark is unset, yet the preview shows the derived value the
    // firm will actually get on the dark sidebar.
    await waitFor(() => expect(screen.getByText(/Dark mode #5f74c4/)).toBeInTheDocument());
    expect(screen.getByText(/Accent #101a3a/)).toBeInTheDocument();
  });

  it('sends only the changed fields, and turns an emptied field into null', async () => {
    const calls = mockApi();
    renderPage();
    await screen.findByLabelText(/^Firm name/);

    await userEvent.clear(screen.getByLabelText(/^Firm name/));
    await userEvent.click(screen.getByRole('button', { name: 'Save branding' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    // An empty box means "unset" — '' would store a blank name and defeat the
    // fallback to the channel name.
    expect(patch.body).toEqual({ brand_name: null });
  });

  it('keeps save disabled until something changes', async () => {
    mockApi();
    renderPage();
    await screen.findByLabelText(/^Firm name/);
    expect(screen.getByRole('button', { name: 'Save branding' })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/^Tagline/), 'Independent');
    expect(screen.getByRole('button', { name: 'Save branding' })).toBeEnabled();
  });

  it('refuses an http logo before the round trip, beside the box it means', async () => {
    const calls = mockApi();
    renderPage();
    await screen.findByLabelText(/^Logo URL$/);

    await userEvent.type(screen.getByLabelText(/^Logo URL$/), 'http://cdn.example.com/a.svg');
    await userEvent.click(screen.getByRole('button', { name: 'Save branding' }));

    // The service rejects this too, but as "Invalid branding" above a form
    // with eight boxes on it. An http image is also the quietest failure the
    // page has: it saves, and then the browser blocks it as mixed content and
    // the firm sees the default mark with nothing to explain why.
    expect(await screen.findByText(/Logo URL must be a full https:\/\/ address\./)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('names the failing box to a screen reader, not just in red', async () => {
    mockApi();
    renderPage();
    await screen.findByLabelText(/^Favicon URL$/);

    const box = screen.getByLabelText(/^Favicon URL$/);
    await userEvent.type(box, 'cdn.example.com/f.ico');
    await userEvent.tab();

    expect(box).toHaveAttribute('aria-invalid', 'true');
    const describedBy = box.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent(/must be a full https/);
  });

  it('checks the colour boxes, which are not Fields and were wired by hand', async () => {
    const calls = mockApi();
    renderPage();
    const hex = await screen.findByLabelText('Accent colour');

    await userEvent.clear(hex);
    await userEvent.type(hex, 'purple');
    await userEvent.click(screen.getByRole('button', { name: 'Save branding' }));

    expect(await screen.findByText('Enter a colour as #rrggbb.')).toBeInTheDocument();
    expect(hex).toHaveAttribute('aria-invalid', 'true');
    expect(document.getElementById(hex.getAttribute('aria-describedby')!)).toHaveTextContent(
      'Enter a colour as #rrggbb.',
    );
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('takes focus to the failing box when the save is refused', async () => {
    mockApi();
    renderPage();
    await screen.findByLabelText(/^Support email$/);

    await userEvent.type(screen.getByLabelText(/^Support email$/), 'not-an-address');
    await userEvent.click(screen.getByRole('button', { name: 'Save branding' }));

    expect(screen.getByLabelText(/^Support email$/)).toHaveFocus();
  });

  it('still saves a well-formed brand', async () => {
    const calls = mockApi();
    renderPage();
    await screen.findByLabelText(/^Logo URL$/);

    await userEvent.type(screen.getByLabelText(/^Logo URL$/), 'https://cdn.example.com/a.svg');
    await userEvent.click(screen.getByRole('button', { name: 'Save branding' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      logo_url: 'https://cdn.example.com/a.svg',
    });
  });

  it('leaves every box optional — an unset brand is a valid one', async () => {
    const calls = mockApi();
    renderPage();
    await screen.findByLabelText(/^Tagline/);

    // Nothing here is required; emptying a box means "use the default", and a
    // rule that read blank as missing would make the page unsavable.
    await userEvent.type(screen.getByLabelText(/^Tagline/), 'Independent valuations');
    await userEvent.click(screen.getByRole('button', { name: 'Save branding' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
  });

  it('explains a 403 instead of showing an empty form', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 403 }, 403));
    renderPage();
    expect(await screen.findByText(/Only firm administrators/)).toBeInTheDocument();
  });
});
