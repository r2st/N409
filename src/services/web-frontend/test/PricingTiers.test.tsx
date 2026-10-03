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
    expect(screen.getByText('Starter')).toBeTruthy();
    expect(screen.getByText('Growth')).toBeTruthy();
    expect(screen.getByText('Enterprise')).toBeTruthy();
  });

  it('shows the correct price for each tier', () => {
    renderPricing();
    for (const tier of PRICING_TIERS) {
      const card = screen.getByTestId(`tier-${tier.tier}`);
      expect(within(card).getByText(formatUsd(tier.priceCents))).toBeTruthy();
    }
  });

  it('marks Growth as most popular', () => {
    renderPricing();
    expect(screen.getByText('Most popular')).toBeTruthy();
    const growthTier = PRICING_TIERS.find((t) => t.tier === 'growth')!;
    expect(growthTier.highlight).toBe(true);
  });

  it('shows CTA links pointing to /order with the tier', () => {
    renderPricing();
    for (const tier of PRICING_TIERS) {
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

    const growthCard = screen.getByTestId('tier-growth');
    expect(within(growthCard).getByText('/month')).toBeTruthy();

    const enterpriseCard = screen.getByTestId('tier-enterprise_monthly');
    expect(within(enterpriseCard).getByText('/month')).toBeTruthy();
  });

  it('still renders the per-report calculator', () => {
    renderPricing();
    expect(screen.getByTestId('quote-total')).toBeTruthy();
  });
});

describe('PRICING_TIERS data integrity', () => {
  it('has exactly three tiers', () => {
    expect(PRICING_TIERS).toHaveLength(3);
  });

  it('starter is one-time at $299', () => {
    const starter = PRICING_TIERS.find((t) => t.tier === 'starter')!;
    expect(starter.priceCents).toBe(29_900);
    expect(starter.interval).toBe('one_time');
    expect(starter.valuationLimit).toBe(1);
  });

  it('growth is monthly at $199', () => {
    const growth = PRICING_TIERS.find((t) => t.tier === 'growth')!;
    expect(growth.priceCents).toBe(19_900);
    expect(growth.interval).toBe('month');
    expect(growth.valuationLimit).toBe(3);
  });

  it('enterprise is monthly at $499', () => {
    const enterprise = PRICING_TIERS.find((t) => t.tier === 'enterprise_monthly')!;
    expect(enterprise.priceCents).toBe(49_900);
    expect(enterprise.interval).toBe('month');
    expect(enterprise.valuationLimit).toBeNull();
  });

  it('tier slugs match the migration', () => {
    const expected = ['starter', 'growth', 'enterprise_monthly'];
    expect(PRICING_TIERS.map((t) => t.tier)).toEqual(expected);
  });
});
