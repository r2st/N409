import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProductPage } from '../src/pages/marketing/ProductPage';
import { WhichValuationPage } from '../src/pages/marketing/WhichValuationPage';
import { PRODUCTS, productBySlug } from '../src/lib/marketing';
import { QUIZ_OPTIONS } from '../src/lib/marketingContent';
import { productContent } from '../src/lib/productContent';
import { anyPageMeta } from '../src/lib/pageMetaRoutes';
import { marketingRoutes } from '../src/lib/routes';

/**
 * The Portfolio (fund) valuation product.
 *
 * The `fund` kind has been a complete product for a while — position marks
 * classified in the ASC 820 hierarchy, Level 3 calibration to the last round,
 * roll-forward, NAV, and an LP waterfall with clawback — with a workspace, a
 * REST surface and an engine module behind it. None of that was on the public
 * catalogue, so the site advertised thirteen report types while the platform
 * shipped fourteen: a customer comparing providers could only conclude we did
 * not do it.
 *
 * The general assertion here is the one that keeps it from happening again: a
 * product in the catalogue must have long-form content, a route, and metadata.
 */

const mountProduct = (slug: string) =>
  render(
    <HelmetProvider>
      <MemoryRouter initialEntries={[`/products/${slug}`]}>
        <Routes>
          <Route path="/products/:slug" element={<ProductPage />} />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );

describe('every catalogued product is a complete page', () => {
  it.each(PRODUCTS.map((p) => p.slug))('%s has long-form content', (slug) => {
    const content = productContent(slug);
    expect(content, `${slug} has no PRODUCT_CONTENT entry`).toBeDefined();
    expect(content!.faq.length).toBeGreaterThan(2);
    expect(content!.included.length).toBeGreaterThan(2);
    // The Problem section cross-links a sibling; a dangling slug renders a
    // section with no link out of it.
    expect(productBySlug(content!.problem.relatedSlug), `${slug} → related`).toBeDefined();
    expect(content!.problem.relatedSlug).not.toBe(slug);
  });

  it.each(PRODUCTS.map((p) => p.slug))('%s is routed and described', (slug) => {
    expect(marketingRoutes().map((r) => r.path)).toContain(`/products/${slug}`);
    expect(anyPageMeta(`/products/${slug}`)).toBeDefined();
  });
});

describe('portfolio valuation', () => {
  const product = productBySlug('portfolio-valuation')!;

  it('is catalogued against the fund kind', () => {
    expect(product.kind).toBe('fund');
  });

  it('quotes the price the checkout actually charges for a fund engagement', () => {
    // `fund` has no entry in the valuation service's DEFAULT_PRICE_CENTS, so
    // `priceForKind` returns FALLBACK_PRICE_CENTS — 2_900.
    expect(product.priceCents).toBe(2_900);
  });

  it('renders the fund-level capabilities rather than a generic ASC 820 page', () => {
    mountProduct('portfolio-valuation');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Portfolio Valuation');
    for (const phrase of [/NAV/i, /waterfall/i, /roll-forward/i, /calibrat/i]) {
      expect(screen.getAllByText(phrase).length, String(phrase)).toBeGreaterThan(0);
    }
  });

  it('distinguishes itself from the single-instrument ASC 820 product', () => {
    // The two are adjacent enough that a reader lands on one meaning the
    // other; the FAQ has to say which is which.
    const faq = productContent('portfolio-valuation')!.faq;
    expect(faq.some((item) => /ASC 820/.test(item.q))).toBe(true);
  });

  it('is reachable from the "which valuation?" quiz', () => {
    expect(QUIZ_OPTIONS.map((o) => o.productSlug)).toContain('portfolio-valuation');
    render(
      <HelmetProvider>
        <MemoryRouter>
          <WhichValuationPage />
        </MemoryRouter>
      </HelmetProvider>,
    );
    expect(
      screen.getByText('I need to mark a whole fund portfolio and report NAV to my LPs'),
    ).toBeInTheDocument();
  });
});
