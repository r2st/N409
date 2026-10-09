import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { MarketingLayout } from '../src/components/MarketingLayout';
import { LandingPage } from '../src/pages/marketing/LandingPage';
import { PricingPage } from '../src/pages/marketing/PricingPage';
import { ProductPage } from '../src/pages/marketing/ProductPage';
import { WhichValuationPage } from '../src/pages/marketing/WhichValuationPage';
import { ComparePage } from '../src/pages/marketing/ComparePage';
import { CompareHubPage } from '../src/pages/marketing/CompareHubPage';
import { AUDIT_DEFENCE_RATE_USD, COMPARISONS, PRICING_FAQ, PRODUCTS, formatUsd } from '../src/lib/marketing';
import { EXPRESS_DELIVERY_CENTS, QSBS_ADDON_CENTS, RAISE_BANDS, quote } from '../src/lib/marketingContent';
import { PRODUCT_CONTENT } from '../src/lib/productContent';

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ status: 'anonymous', user: null, login: vi.fn(), register: vi.fn(), logout: vi.fn(), viewMode: 'normal', setViewMode: vi.fn() }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<MarketingLayout />}>
          <Route path="/" element={<LandingPage />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/which-valuation" element={<WhichValuationPage />} />
          <Route path="/products/:slug" element={<ProductPage />} />
          <Route path="/compare/409a-valuation-providers" element={<CompareHubPage />} />
          <Route path="/compare/:slug" element={<ComparePage />} />
        </Route>
        <Route path="*" element={<div>redirected-home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('marketing data (§22)', () => {
  it('quotes base price plus add-ons', () => {
    const p409a = PRODUCTS.find((p) => p.kind === '409a')!;
    expect(quote(p409a, { express: false, qsbsLetter: false })).toEqual({
      totalCents: 4_900,
      deliveryDays: 7,
      bandUpliftCents: 0,
    });
    expect(quote(p409a, { express: true, qsbsLetter: true })).toEqual({
      totalCents: 4_900 + EXPRESS_DELIVERY_CENTS + QSBS_ADDON_CENTS,
      deliveryDays: 1,
      bandUpliftCents: 0,
    });
  });

  it('flat pricing — no band uplift at any raise level', () => {
    const p409a = PRODUCTS.find((p) => p.kind === '409a')!;
    const ladder = RAISE_BANDS.map(
      (_, i) => quote(p409a, { express: false, qsbsLetter: false, raiseBand: i }).totalCents,
    );
    expect(ladder).toEqual([4_900, 4_900, 4_900, 4_900, 4_900]);
  });

  it('mirrors the server ladder exactly — all zero uplifts', () => {
    expect(RAISE_BANDS.map((b) => b.upliftCents)).toEqual([0, 0, 0, 0, 0]);
  });

  it('clamps an out-of-range band instead of quoting NaN', () => {
    const p409a = PRODUCTS.find((p) => p.kind === '409a')!;
    expect(quote(p409a, { express: false, qsbsLetter: false, raiseBand: -3 }).totalCents).toBe(4_900);
    expect(quote(p409a, { express: false, qsbsLetter: false, raiseBand: 99 }).totalCents).toBe(4_900);
  });

  it('stacks the base and add-ons (band uplift is zero)', () => {
    const p409a = PRODUCTS.find((p) => p.kind === '409a')!;
    expect(quote(p409a, { express: true, qsbsLetter: true, raiseBand: 3 })).toEqual({
      totalCents: 4_900 + EXPRESS_DELIVERY_CENTS + QSBS_ADDON_CENTS,
      deliveryDays: 1,
      bandUpliftCents: 0,
    });
  });

  it('never double-charges the QSBS add-on on the QSBS product', () => {
    const qsbs = PRODUCTS.find((p) => p.kind === 'qsbs')!;
    expect(quote(qsbs, { express: false, qsbsLetter: true }).totalCents).toBe(qsbs.priceCents);
  });

  it('has a product page for every valuation kind and 8 comparisons', () => {
    expect(new Set(PRODUCTS.map((p) => p.kind)).size).toBe(14);
    expect(COMPARISONS).toHaveLength(8);
  });

  it('sells one product per kind — no kind is listed twice', () => {
    // Two entries on the same kind would quote two prices for one checkout
    // path, and the cheaper one is the one a prospect would find.
    expect(new Set(PRODUCTS.map((p) => p.kind)).size).toBe(PRODUCTS.length);
  });
});

describe('landing page', () => {
  it('renders hero, CTA, and proof points', () => {
    renderAt('/');
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/valuations/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /free valuation estimator/i })).toHaveAttribute(
      'href',
      '/tools/startup-valuation-estimator',
    );
    expect(screen.getByText('Dual analyst sign-off')).toBeInTheDocument();
  });
});

describe('pricing calculator', () => {
  it('updates the quote when add-ons are toggled', async () => {
    const user = userEvent.setup();
    renderAt('/pricing');

    const total = () => screen.getByTestId('quote-total').textContent;
    expect(total()).toBe(formatUsd(PRODUCTS[0]!.priceCents));

    await user.click(screen.getByRole('checkbox', { name: /Express delivery/ }));
    expect(total()).toBe(formatUsd(PRODUCTS[0]!.priceCents + EXPRESS_DELIVERY_CENTS));

    await user.click(screen.getByRole('checkbox', { name: /QSBS attestation letter/ }));
    expect(total()).toBe(formatUsd(PRODUCTS[0]!.priceCents + EXPRESS_DELIVERY_CENTS + QSBS_ADDON_CENTS));
  });

  it('switches report type', async () => {
    const user = userEvent.setup();
    renderAt('/pricing');
    await user.selectOptions(screen.getByRole('combobox'), 'asc-718-valuation');
    const asc718 = PRODUCTS.find((p) => p.kind === '718')!;
    expect(screen.getByTestId('quote-total').textContent).toBe(formatUsd(asc718.priceCents));
  });

  it('stays flat as the capital-raised slider moves', async () => {
    renderAt('/pricing');
    const slider = screen.getByRole('slider', { name: /capital raised/i });
    expect(screen.getByTestId('quote-total').textContent).toBe(formatUsd(4_900));
    expect(screen.getByTestId('raise-band')).toHaveTextContent('Under $1M');

    fireEvent.change(slider, { target: { value: '4' } });
    expect(screen.getByTestId('quote-total').textContent).toBe(formatUsd(4_900));
    expect(screen.getByTestId('raise-band')).toHaveTextContent('$20M+');
  });

  it('names the band for a screen reader, not just the thumb position', () => {
    renderAt('/pricing');
    const slider = screen.getByRole('slider', { name: /capital raised/i });
    expect(slider).toHaveAttribute('aria-valuetext', 'Under $1M');
  });
});

describe('which-valuation quiz', () => {
  it('recommends the product for the picked scenario', async () => {
    const user = userEvent.setup();
    renderAt('/which-valuation');

    await user.click(
      screen.getByRole('button', {
        name: /giving employees stock options/,
      }),
    );

    const result = screen.getByTestId('quiz-result');
    expect(within(result).getByText('409A Valuation')).toBeInTheDocument();
    expect(within(result).getByRole('link', { name: 'Learn more →' })).toHaveAttribute(
      'href',
      '/products/409a-valuation',
    );
  });
});

describe('product + compare pages', () => {
  it('renders a product page from its slug', () => {
    renderAt('/products/asc-820-valuation');
    expect(screen.getByRole('heading', { level: 1, name: 'ASC 820 Valuation' })).toBeInTheDocument();
    // 8-section template (gap #17): Problem, Included, and FAQ headings.
    expect(screen.getByText('Everything in your ASC 820 report')).toBeInTheDocument();
    expect(screen.getByText('Common ASC 820 questions')).toBeInTheDocument();
  });

  it('renders a comparison table', () => {
    renderAt('/compare/carta');
    expect(screen.getByRole('heading', { level: 1, name: 'DoAide 409A vs Carta' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'DoAide 409A vs Carta' })).toBeInTheDocument();
  });

  it('redirects unknown slugs to the landing page', () => {
    renderAt('/products/not-a-product');
    expect(screen.getByText(/valuations/)).toBeInTheDocument();
  });
});

describe('product page content (gap #17)', () => {
  it('has 8-section long-form content for every product', () => {
    for (const p of PRODUCTS) {
      const content = PRODUCT_CONTENT[p.slug];
      expect(content, `content for ${p.slug}`).toBeDefined();
      expect(content!.solution.length).toBeGreaterThanOrEqual(4);
      expect(content!.included.length).toBeGreaterThanOrEqual(5);
      expect(content!.faq.length).toBeGreaterThanOrEqual(5);
      // The Problem section cross-links a real product.
      expect(PRODUCTS.some((q) => q.slug === content!.problem.relatedSlug)).toBe(true);
    }
  });

  it('shows the audit-defence rate on the 409A FAQ (gap #33)', () => {
    const faq = PRODUCT_CONTENT['409a-valuation']!.faq;
    expect(faq.some((f) => f.a.includes(`$${AUDIT_DEFENCE_RATE_USD}/hr`))).toBe(true);
  });
});

describe('compare provider hub (gap #30)', () => {
  it('renders the categories and founder questions', () => {
    renderAt('/compare/409a-valuation-providers');
    expect(
      screen.getByRole('heading', { level: 1, name: '409A valuation providers, compared' }),
    ).toBeInTheDocument();
    expect(screen.getByText('AI-native valuation platforms')).toBeInTheDocument();
    expect(screen.getByText('What founders should ask any 409A provider')).toBeInTheDocument();
    // Cross-links out to an individual comparison page (the footer also links
    // to Carta, so assert at least one hub link points at /compare/carta).
    const cartaLinks = screen.getAllByRole('link', { name: /DoAide 409A vs Carta/ });
    expect(cartaLinks.some((el) => el.getAttribute('href') === '/compare/carta')).toBe(true);
  });
});

describe('pricing page depth (gaps #31/#32/#33)', () => {
  it('has 15+ FAQ items including audit defence pricing', () => {
    expect(PRICING_FAQ.length).toBeGreaterThanOrEqual(15);
    expect(PRICING_FAQ.some((f) => f.a.includes(`$${AUDIT_DEFENCE_RATE_USD}/hr`))).toBe(true);
  });

  it('renders the FAQ, firms tier, and audit-defence comparison row', () => {
    renderAt('/pricing');
    expect(screen.getByText('Pricing & valuation questions')).toBeInTheDocument();
    expect(screen.getByText('Leverage our AI-powered valuation technology')).toBeInTheDocument();
    // With no partner address configured in this environment, the firms tier
    // CTA routes through the contact form rather than a mailto that bounces.
    // (MarketingExtras covers the configured branch.)
    const contactLinks = screen.getAllByRole('link', { name: 'Get in touch' });
    expect(contactLinks.length).toBeGreaterThan(0);
    expect(contactLinks.every((el) => el.getAttribute('href') === '/contact')).toBe(true);
    expect(screen.getByText(`From $${AUDIT_DEFENCE_RATE_USD}/hour`)).toBeInTheDocument();
  });
});
