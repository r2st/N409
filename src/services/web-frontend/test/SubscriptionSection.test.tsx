import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ user: { roles: ['valuation_user'] } }) }));
vi.mock('../src/lib/rbac', () => ({ isOps: () => false }));

import { SubscriptionSection } from '../src/components/SubscriptionSection';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const plans = [
  { tier: 'per_valuation', name: 'Per valuation', valuation_limit: 1, price_cents: 200000, currency: 'usd', interval: 'one_time' },
  { tier: 'annual_retainer', name: 'Annual retainer', valuation_limit: 12, price_cents: 2000000, currency: 'usd', interval: 'year' },
];

function mockApi(mySub: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const key = String(url).replace(/^.*\/api\/v1/, '');
    if (key === '/billing/plans') return jsonResponse({ plans });
    if (key === '/me/subscription') return jsonResponse(mySub);
    throw new Error(`unexpected fetch ${key}`);
  });
}

describe('SubscriptionSection (feature 7)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('offers subscribable plans when the user has no subscription', async () => {
    mockApi({ subscription: null, plan: null, usage: null, invoices: [] });
    render(<SubscriptionSection />);
    expect(await screen.findByText('Annual retainer')).toBeInTheDocument();
    // Per-valuation (one_time) has no Subscribe button; the retainer does.
    expect(screen.getAllByRole('button', { name: 'Subscribe' })).toHaveLength(1);
  });

  it('shows current usage when subscribed', async () => {
    mockApi({
      subscription: { id: 's1', plan_tier: 'annual_retainer', status: 'active', current_period_end: null },
      plan: plans[1],
      usage: { limit: 12, used: 5, remaining: 7, unlimited: false, exhausted: false },
      invoices: [],
    });
    render(<SubscriptionSection />);
    expect(await screen.findByTestId('usage')).toHaveTextContent('5 of 12 valuations used');
    expect(screen.getByText('7 remaining')).toBeInTheDocument();
  });
});
