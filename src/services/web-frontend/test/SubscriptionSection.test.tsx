import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ user: { roles: ['valuation_user'] } }) }));
vi.mock('../src/lib/rbac', () => ({ isOps: () => false }));

import { SubscriptionSection } from '../src/components/SubscriptionSection';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const plans = [
  {
    tier: 'per_valuation',
    name: 'Per valuation',
    valuation_limit: 1,
    price_cents: 200000,
    currency: 'usd',
    interval: 'one_time',
  },
  {
    tier: 'annual_retainer',
    name: 'Annual retainer',
    valuation_limit: 12,
    price_cents: 2000000,
    currency: 'usd',
    interval: 'year',
  },
];

function mockApi(mySub: unknown, portal?: { body: unknown; status?: number }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const key = String(url).replace(/^.*\/api\/v1/, '');
    if (key === '/billing/plans') return jsonResponse({ plans });
    if (key === '/me/subscription') return jsonResponse(mySub);
    if (key === '/billing/portal' && portal) return jsonResponse(portal.body, portal.status ?? 200);
    throw new Error(`unexpected fetch ${key}`);
  });
}

const subscribed = (over: Record<string, unknown> = {}) => ({
  plan: plans[1],
  usage: { limit: 12, used: 5, remaining: 7, unlimited: false, exhausted: false },
  invoices: [],
  portal_available: true,
  ...over,
  // After the spread, so a caller overriding one subscription field keeps
  // the rest rather than replacing the whole object.
  subscription: {
    id: 's1',
    plan_tier: 'annual_retainer',
    status: 'active',
    current_period_end: null,
    ...((over.subscription as Record<string, unknown>) ?? {}),
  },
});

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

  /**
   * Self-serve management. Before this control existed the only route to
   * cancelling was to email support, and a customer whose card expired had no
   * way to fix it — churn the product created for itself.
   */
  describe('manage subscription', () => {
    it('sends the subscriber to the Stripe portal', async () => {
      mockApi(subscribed(), { body: { portal_url: 'https://billing.stripe.com/session/xyz' } });
      // jsdom refuses a real navigation; the assertion is on what we set.
      const location = { href: '' } as Location;
      vi.spyOn(window, 'location', 'get').mockReturnValue(location);

      render(<SubscriptionSection />);
      await userEvent.click(await screen.findByRole('button', { name: 'Manage subscription' }));

      await waitFor(() => expect(location.href).toBe('https://billing.stripe.com/session/xyz'));
    });

    it('is hidden when there is no Stripe customer to manage', async () => {
      mockApi(subscribed({ portal_available: false }));
      render(<SubscriptionSection />);
      await screen.findByTestId('usage');
      expect(screen.queryByRole('button', { name: 'Manage subscription' })).not.toBeInTheDocument();
    });

    it('reports a portal failure instead of navigating nowhere', async () => {
      mockApi(subscribed(), {
        body: { title: 'Conflict', detail: 'There is no billing account to manage yet.' },
        status: 409,
      });
      render(<SubscriptionSection />);
      await userEvent.click(await screen.findByRole('button', { name: 'Manage subscription' }));
      expect(await screen.findByText(/no billing account to manage/)).toBeInTheDocument();
    });
  });

  it('tells a past-due subscriber their payment failed', async () => {
    mockApi(subscribed({ subscription: { status: 'past_due' } }));
    render(<SubscriptionSection />);
    expect(await screen.findByText(/Your last payment did not go through/)).toBeInTheDocument();
  });

  it('says nothing alarming while the subscription is healthy', async () => {
    mockApi(subscribed());
    render(<SubscriptionSection />);
    await screen.findByTestId('usage');
    expect(screen.queryByText(/did not go through/)).not.toBeInTheDocument();
  });
});
