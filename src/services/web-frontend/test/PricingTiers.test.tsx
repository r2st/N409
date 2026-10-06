import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PricingPage } from '../src/pages/marketing/PricingPage';
import { MarketingLayout } from '../src/components/MarketingLayout';
import { PRICING_TIERS, formatUsd } from '../src/lib/marketing';

function renderPricing() {
  return render(
    <MemoryRouter initialEntries={['/pricing']}>
      <Routes>
        <Route element={<MarketingLayout />}>
          <Route path="/pricing" element={<PricingPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('PricingPage tier cards', () => {
  it('renders all three tiers', () => {
    renderPricing();
    for (const tier of PRICING_TIERS) {
      expect(screen.getByTestId(`tier-${tier.tier}`)).toBeTruthy();
    }
  });

  it('displays tier names', () => {
    renderPricing();
    expect(screen.getByText('Free')).toBeTruthy();
    expect(screen.getByText('Per Report')).toBeTruthy();
    expect(screen.getByText('Annual')).toBeTruthy();
  });

  it('shows the correct price for each tier', () => {
    renderPricing();
    for (const tier of PRICING_TIERS) {
      const card = screen.getByTestId(`tier-${tier.tier}`);
      expect(within(card).getByText(formatUsd(tier.priceCents))).toBeTruthy();
    }
  });

  it('marks Per Report as most popular', () => {
    renderPricing();
    expect(screen.getByText('Most popular')).toBeTruthy();
    const starter = PRICING_TIERS.find((t) => t.tier === 'starter')!;
    expect(starter.highlight).toBe(true);
  });

  it('free tier CTA links to /register, paid tiers to /order', () => {
    renderPricing();
    const freeTier = PRICING_TIERS.find((t) => t.priceCents === 0)!;
    expect(screen.getByTestId(`cta-${freeTier.tier}`).getAttribute('href')).toBe('/register');

    for (const tier of PRICING_TIERS.filter((t) => t.priceCents > 0)) {
      const link = screen.getByTestId(`cta-${tier.tier}`);
      expect(link.getAttribute('href')).toBe(`/order?tier=${tier.tier}`);
    }
  });

  it('shows feature lists for each tier', () => {
    renderPricing();
    for (const tier of PRICING_TIERS) {
      const card = screen.getByTestId(`tier-${tier.tier}`);
      for (const feature of tier.features) {
        const matches = within(card).getAllByText(feature);
        expect(matches.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('shows interval labels correctly', () => {
    renderPricing();
    const starterCard = screen.getByTestId('tier-starter');
    expect(within(starterCard).getByText('/valuation')).toBeTruthy();

    const annualCard = screen.getByTestId('tier-annual');
    expect(within(annualCard).getByText('/year')).toBeTruthy();
  });

  it('still renders the per-report calculator', () => {
    renderPricing();
    expect(screen.getByTestId('quote-total')).toBeTruthy();
  });

  it('renders the "Why we charge" section', () => {
    renderPricing();
    expect(screen.getByTestId('why-we-charge')).toBeTruthy();
  });
});

describe('PRICING_TIERS data integrity', () => {
  it('has exactly three tiers', () => {
    expect(PRICING_TIERS).toHaveLength(3);
  });

  it('free tier at $0', () => {
    const free = PRICING_TIERS.find((t) => t.tier === 'free')!;
    expect(free.priceCents).toBe(0);
    expect(free.interval).toBe('one_time');
    expect(free.valuationLimit).toBe(1);
  });

  it('starter is one-time at $49', () => {
    const starter = PRICING_TIERS.find((t) => t.tier === 'starter')!;
    expect(starter.priceCents).toBe(4_900);
    expect(starter.interval).toBe('one_time');
    expect(starter.valuationLimit).toBe(1);
  });

  it('annual is yearly at $99', () => {
    const annual = PRICING_TIERS.find((t) => t.tier === 'annual')!;
    expect(annual.priceCents).toBe(9_900);
    expect(annual.interval).toBe('year');
    expect(annual.valuationLimit).toBeNull();
  });

  it('tier slugs match the new plan structure', () => {
    const expected = ['free', 'starter', 'annual'];
    expect(PRICING_TIERS.map((t) => t.tier)).toEqual(expected);
  });
});
