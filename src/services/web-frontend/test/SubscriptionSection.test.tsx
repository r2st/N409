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
    // The entry price, as migration 0100 corrected it: the cheapest amount the
    // one-time checkout can charge. It was seeded at 200000 against a $1,190
    // 409A charge, so this card overstated the flagship product by 68%.
    price_cents: 99000,
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

  /**
   * The per-valuation row is one catalogue entry standing for a price list that
   * differs by product ($990 SMB, $1,190 409A, $1,490 ASC 718/820). Quoting it
   * flat made this the last screen before Stripe to state a number the Stripe
   * page then contradicted — so it renders as a floor, and says so.
   */
  describe('the one-time tier quotes an entry price, not a flat one', () => {
    const noSubscription = () => mockApi({ subscription: null, plan: null, usage: null, invoices: [] });

    it('prefixes the one-time price with "From" and explains it', async () => {
      noSubscription();
      render(<SubscriptionSection />);
      const card = (await screen.findByText('Per valuation')).closest('div')!.parentElement!;
      expect(card).toHaveTextContent(/From\s*\$990\.00/);
      expect(screen.getByTestId('entry-price-note')).toHaveTextContent(
        /exact amount is shown before you pay/i,
      );
    });

    it('leaves a recurring price stated flat', async () => {
      noSubscription();
      render(<SubscriptionSection />);
      const card = (await screen.findByText('Annual retainer')).closest('div')!.parentElement!;
      expect(card).toHaveTextContent(/\$20,000\.00\/yr/);
      expect(card).not.toHaveTextContent(/From/);
      expect(screen.getAllByTestId('entry-price-note')).toHaveLength(1);
    });
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
