import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter } from 'react-router-dom';
import { ValuationCostPage, ValuationGuidePage, WhenDoYouNeedPage } from '../src/pages/marketing/GuidePages';
import {
  COST_DRIVERS,
  GUIDE_SECTIONS,
  MARKET_PRICE_BANDS,
  NONCOMPLIANCE_CONSEQUENCES,
  VALUATION_TRIGGERS,
  formatUsd,
  productBySlug,
} from '../src/lib/marketing';
import { pageMeta } from '../src/lib/pageMeta';
import { marketingRoutes } from '../src/lib/routes';

/**
 * The three educational pages.
 *
 * The failure these guard against is drift, not layout: the pages exist to be
 * indexed, so a route that renders but is missing from the sitemap or from
 * `pageMeta` is invisible and fails silently. The other half is the price — the
 * cost page must quote the 409A's own list price out of the product registry,
 * because a page that answers "how much does a 409A cost" with a stale or a
 * different product's number is wrong in the search result itself.
 */

const mount = (ui: React.ReactElement) =>
  render(
    <HelmetProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </HelmetProvider>,
  );

const GUIDE_PATHS = ['/409a-valuation-guide', '/when-do-you-need-a-409a', '/how-much-does-a-409a-cost'];

describe('guide pages: registration', () => {
  it.each(GUIDE_PATHS)('%s is in the sitemap', (path) => {
    expect(marketingRoutes().map((r) => r.path)).toContain(path);
  });

  it.each(GUIDE_PATHS)('%s has head metadata', (path) => {
    const meta = pageMeta(path);
    expect(meta).toBeDefined();
    expect(meta!.title).toBeTruthy();
    // Long enough to be a real meta description rather than a placeholder.
    expect(meta!.description.length).toBeGreaterThan(80);
  });

  it('the cost page description quotes the 409A price, not the catalogue minimum', () => {
    const price = formatUsd(productBySlug('409a-valuation')!.priceCents);
    expect(pageMeta('/how-much-does-a-409a-cost')!.description).toContain(price);
  });

  it('the timing page publishes its triggers as FAQ structured data', () => {
    const jsonLd = pageMeta('/when-do-you-need-a-409a')!.jsonLd;
    expect(JSON.stringify(jsonLd)).toContain(VALUATION_TRIGGERS[0]!.title);
  });
});

describe('ValuationGuidePage', () => {
  it('renders every section from the content registry', () => {
    mount(<ValuationGuidePage />);
    expect(screen.getAllByTestId('guide-section')).toHaveLength(GUIDE_SECTIONS.length);
    for (const section of GUIDE_SECTIONS) {
      expect(screen.getByRole('heading', { name: section.heading })).toBeInTheDocument();
    }
  });

  it('renders the bullets belonging to a section', () => {
    mount(<ValuationGuidePage />);
    const withBullets = GUIDE_SECTIONS.find((s) => s.bullets?.length);
    for (const bullet of withBullets!.bullets!) {
      expect(screen.getByText(bullet)).toBeInTheDocument();
    }
  });

  it('offers the sample report and the quiz rather than only checkout', () => {
    mount(<ValuationGuidePage />);
    expect(screen.getByRole('link', { name: /sample report/i })).toHaveAttribute('href', '/sample-report');
    expect(screen.getByRole('link', { name: /which valuation/i })).toHaveAttribute(
      'href',
      '/which-valuation',
    );
  });
});

describe('WhenDoYouNeedPage', () => {
  it('splits the triggers into required and recommended', () => {
    mount(<WhenDoYouNeedPage />);
    const required = VALUATION_TRIGGERS.filter((t) => t.urgency === 'required');
    const recommended = VALUATION_TRIGGERS.filter((t) => t.urgency === 'recommended');
    expect(screen.getAllByTestId('trigger-required')).toHaveLength(required.length);
    expect(screen.getAllByTestId('trigger-recommended')).toHaveLength(recommended.length);
  });

  it('places each trigger in the section its urgency says it belongs to', () => {
    mount(<WhenDoYouNeedPage />);
    for (const trigger of VALUATION_TRIGGERS) {
      const testId = trigger.urgency === 'required' ? 'trigger-required' : 'trigger-recommended';
      const cards = screen.getAllByTestId(testId);
      expect(cards.some((card) => within(card).queryByText(trigger.title))).toBe(true);
    }
  });

  it('states the consequences, which fall on the option holder', () => {
    mount(<WhenDoYouNeedPage />);
    for (const consequence of NONCOMPLIANCE_CONSEQUENCES) {
      expect(screen.getByText(consequence)).toBeInTheDocument();
    }
    expect(screen.getByText(/not tax advice/i)).toBeInTheDocument();
  });

  it('names the material-event rule, which is the one that creates exposure', () => {
    mount(<WhenDoYouNeedPage />);
    expect(screen.getAllByText(/material event/i).length).toBeGreaterThan(0);
  });
});

describe('ValuationCostPage', () => {
  it('renders every market band and cost driver', () => {
    mount(<ValuationCostPage />);
    expect(screen.getAllByTestId('price-band')).toHaveLength(MARKET_PRICE_BANDS.length);
    expect(screen.getAllByTestId('cost-driver')).toHaveLength(COST_DRIVERS.length);
  });

  it('quotes the 409A list price read from the product registry', () => {
    mount(<ValuationCostPage />);
    const product = productBySlug('409a-valuation')!;
    const ourPrice = screen.getByTestId('our-price');
    expect(within(ourPrice).getByText(formatUsd(product.priceCents))).toBeInTheDocument();
  });

  it('links to the pricing page for a real quote', () => {
    mount(<ValuationCostPage />);
    const ourPrice = screen.getByTestId('our-price');
    expect(within(ourPrice).getByRole('link', { name: /pricing page/i })).toHaveAttribute('href', '/pricing');
  });

  it('discloses the audit-support rate, which is the cost not on the quote', () => {
    mount(<ValuationCostPage />);
    expect(screen.getByText(/audit support is where a cheap valuation gets expensive/i)).toBeInTheDocument();
  });
});
