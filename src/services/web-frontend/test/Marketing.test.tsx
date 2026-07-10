import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { MarketingLayout } from '../src/components/MarketingLayout';
import { LandingPage } from '../src/pages/marketing/LandingPage';
import { PricingPage } from '../src/pages/marketing/PricingPage';
import { ProductPage } from '../src/pages/marketing/ProductPage';
import { WhichValuationPage } from '../src/pages/marketing/WhichValuationPage';
import { ComparePage } from '../src/pages/marketing/ComparePage';
import { CompareHubPage } from '../src/pages/marketing/CompareHubPage';
import {
  AUDIT_DEFENCE_RATE_USD,
  COMPARISONS,
  PRICING_FAQ,
  PRODUCTS,
  PRODUCT_CONTENT,
  formatUsd,
  quote,
} from '../src/lib/marketing';

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
      totalCents: 119_000,
      deliveryDays: 7,
    });
    expect(quote(p409a, { express: true, qsbsLetter: true })).toEqual({
      totalCents: 219_000,
      deliveryDays: 1,
    });
  });

  it('never double-charges the QSBS add-on on the QSBS product', () => {
    const qsbs = PRODUCTS.find((p) => p.kind === 'qsbs')!;
    expect(quote(qsbs, { express: false, qsbsLetter: true }).totalCents).toBe(qsbs.priceCents);
  });

  it('has a product page for every valuation kind and 7 comparisons', () => {
    expect(new Set(PRODUCTS.map((p) => p.kind)).size).toBe(13);
    expect(COMPARISONS).toHaveLength(7);
  });
});

describe('landing page', () => {
  it('renders hero, CTA, and the product grid', () => {
    renderAt('/');
    expect(screen.getByRole('link', { name: 'Start my valuation' })).toHaveAttribute('href', '/register');
    expect(screen.getByText('Thirteen report types, one platform')).toBeInTheDocument();
    expect(screen.getAllByText('409A Valuation').length).toBeGreaterThan(0);
    // Accounting integrations strip (§23) + the partner-logo trust badges
    // (gap #21) both surface these names, so there may be more than one.
    expect(screen.getAllByText('Xero').length).toBeGreaterThan(0);
    expect(screen.getAllByText('QuickBooks').length).toBeGreaterThan(0);
  });
});

describe('pricing calculator', () => {
  it('updates the quote when add-ons are toggled', async () => {
    const user = userEvent.setup();
    renderAt('/pricing');

    const total = () => screen.getByTestId('quote-total').textContent;
    expect(total()).toBe(formatUsd(PRODUCTS[0]!.priceCents));

    await user.click(screen.getByRole('checkbox', { name: /Express delivery/ }));
    expect(total()).toBe(formatUsd(PRODUCTS[0]!.priceCents + 50_000));

    await user.click(screen.getByRole('checkbox', { name: /QSBS attestation letter/ }));
    expect(total()).toBe(formatUsd(PRODUCTS[0]!.priceCents + 100_000));
  });

  it('switches report type', async () => {
    const user = userEvent.setup();
    renderAt('/pricing');
    await user.selectOptions(screen.getByRole('combobox'), 'asc-718-valuation');
    expect(screen.getByTestId('quote-total').textContent).toBe(formatUsd(149_000));
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
    expect(screen.getByRole('heading', { level: 1, name: 'N409 vs Carta' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'N409 vs Carta' })).toBeInTheDocument();
  });

  it('redirects unknown slugs to the landing page', () => {
    renderAt('/products/not-a-product');
    expect(screen.getByText('Thirteen report types, one platform')).toBeInTheDocument();
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
    const cartaLinks = screen.getAllByRole('link', { name: /N409 vs Carta/ });
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
    // The firms tier CTA is a mailto (a second "Get in touch" links to /contact).
    const contactLinks = screen.getAllByRole('link', { name: 'Get in touch' });
    expect(contactLinks.some((el) => el.getAttribute('href')?.startsWith('mailto:'))).toBe(true);
    expect(screen.getByText(`$${AUDIT_DEFENCE_RATE_USD}/hour`)).toBeInTheDocument();
  });
});
