import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthShell } from '../src/components/AuthShell';
import { LoginPage } from '../src/pages/LoginPage';
import { AuthProvider } from '../src/lib/auth';
import { DebtInstrumentsPage } from '../src/pages/DebtInstrumentsPage';
import { FundPortfolioPage } from '../src/pages/FundPortfolioPage';

/**
 * Heading structure, asserted against what is rendered rather than what is
 * written. A page's headings are assembled from several files — the shell
 * contributes one, a card component another, the page body the rest — so
 * reading a single source file cannot tell you what a reader actually meets.
 *
 * Two rules, both of them what a screen reader's heading list depends on:
 * exactly one h1, naming the page; and no level skipped on the way down, so
 * that "next heading at this level" and "up one level" mean what they say.
 */

/** Every heading on screen, in document order, as (level, text) pairs. */
function outline(): Array<[number, string]> {
  return screen
    .getAllByRole('heading')
    .map((h) => [Number(h.tagName[1]), (h.textContent ?? '').trim()] as [number, string]);
}

/**
 * The first skipped level in an outline, or null when it descends properly.
 * Climbing back up any number of levels is fine — closing three sections at
 * once is normal — so only a downward step of more than one is a skip.
 */
function firstSkip(levels: Array<[number, string]>): string | null {
  let previous = 0;
  for (const [level, text] of levels) {
    if (previous && level > previous + 1) return `h${previous} → h${level} at “${text}”`;
    previous = level;
  }
  return null;
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('AuthShell — the page title is the page heading', () => {
  /**
   * The brand panel's strapline held the h1: "Valuations built for scrutiny,
   * delivered with precision." Every signed-out page in the product runs on
   * this shell — sign in, register, both password-reset steps, accept invite,
   * verify email, the Google callback, the auditor portal — so on all of them
   * the document's one top-level heading was advertising copy, and the thing
   * the page was actually for ("Sign in") sat under it as an h2.
   */
  it('makes the shell title the h1 and leaves the strapline as prose', () => {
    render(
      <AuthShell title="Sign in" subtitle="Welcome back.">
        <p>form</p>
      </AuthShell>,
    );

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Sign in');
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    // The strapline is still on the page — it is just not a heading.
    expect(screen.getByText(/Valuations built for/)).toBeInTheDocument();
    expect(screen.getByText(/Valuations built for/).tagName).toBe('P');
  });

  /**
   * The brand panel is `hidden lg:flex`, so on a phone the old h1 was not
   * rendered at all — every signed-out page had no h1 whatsoever, and its only
   * heading was an orphaned h2. That is invisible to a source-level check and
   * is exactly the reader who most needs the landmark.
   */
  it('gives a phone-width visitor an h1 rather than an orphaned h2', () => {
    const { container } = render(
      <AuthShell title="Reset your password" subtitle="Choose a new one.">
        <p>form</p>
      </AuthShell>,
    );

    const brandPanel = container.querySelector('.hidden.lg\\:flex');
    expect(brandPanel).not.toBeNull();
    // Nothing inside the panel that a phone hides may be a heading.
    expect(brandPanel!.querySelectorAll('h1,h2,h3,h4,h5,h6')).toHaveLength(0);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Reset your password');
  });

  it('carries through to the sign-in page itself', () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <LoginPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Sign in');
    expect(firstSkip(outline())).toBeNull();
  });
});

describe('DebtInstrumentsPage — one h1, then h2 sections', () => {
  beforeEach(() => vi.restoreAllMocks());

  const instrument = {
    id: 'i1',
    name: 'Note A',
    instrument_type: 'bond',
    currency: 'USD',
    params: {},
  };

  function mockApi() {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (/\/debt\/instruments\/[^/]+$/.test(path)) {
        return jsonResponse({ instrument, credit_terms: null, valuations: [] });
      }
      return jsonResponse({ instruments: [instrument] });
    });
  }

  /**
   * Every section on this page was an h3 sitting directly under the page h1 —
   * "Bond parameters", "Sensitivity", "Valuation history", "Credit terms" —
   * with the cash-flow schedule an h4 below them. Nothing was ever an h2, so a
   * reader moving by level found the page title and then nothing at all.
   */
  it('descends without skipping a level', async () => {
    mockApi();
    render(
      <MemoryRouter>
        <DebtInstrumentsPage />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { level: 1, name: /Debt Instruments/ });
    await screen.findByRole('heading', { level: 2, name: /parameters/ });

    expect(firstSkip(outline())).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});

describe('FundPortfolioPage — one h1, then h2 sections', () => {
  beforeEach(() => vi.restoreAllMocks());

  const fund = { id: 'f1', name: 'Growth Fund I', fund_type: 'vc', currency: 'USD', vintage_year: 2021 };
  const position = {
    id: 'p1',
    company_name: 'Acme',
    security_type: 'preferred',
    quantity: '1000',
    cost_basis: '500000',
    mark_method: 'calibrated_opm',
    latest_mark: {
      id: 'm1',
      measurement_date: '2026-03-31',
      method: 'calibrated_opm',
      fair_value: '750000',
      level: 3,
    },
  };
  const nav = {
    net_asset_value: 750000,
    gross_asset_value: 800000,
    total_cost_basis: 500000,
    total_unrealized_gain: 250000,
    liabilities: 50000,
    level_breakdown: { level_1: 10000, level_2: 20000, level_3: 720000 },
  };

  function mockApi() {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/positions/') && path.endsWith('/marks')) return jsonResponse({ marks: [] });
      if (path.endsWith('/nav')) return jsonResponse({ nav });
      if (/\/funds\/[^/]+$/.test(path)) {
        return jsonResponse({ fund, lp_terms: null, positions: [position] });
      }
      return jsonResponse({ funds: [fund] });
    });
  }

  it('descends without skipping a level', async () => {
    mockApi();
    render(
      <MemoryRouter>
        <FundPortfolioPage />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { level: 1, name: /Fund Portfolios/ });
    await screen.findByRole('heading', { level: 2, name: /ASC 820 fair-value hierarchy/ });

    expect(firstSkip(outline())).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  /**
   * "Mark history" was an h5 under an h3 — two levels down in one step, and
   * only reachable after expanding a position, which is why it survived. It
   * belongs to the Positions section, so h3 is where it goes.
   */
  it('keeps the expanded position’s sub-headings one level down', async () => {
    mockApi();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <FundPortfolioPage />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { level: 2, name: 'Positions' });
    await user.click(await screen.findByRole('button', { name: /Acme/ }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Mark history' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Mark history' }).tagName).toBe('H3');
    expect(firstSkip(outline())).toBeNull();
  });
});
