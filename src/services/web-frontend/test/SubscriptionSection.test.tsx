import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ user: { roles: ['valuation_user'] } }) }));
// The ops flag is mutable so the admin dashboard — which only renders for ops —
// can be exercised without a second copy of the whole fixture set.
const flags = vi.hoisted(() => ({ ops: false }));
vi.mock('../src/lib/rbac', () => ({ isOps: () => flags.ops }));

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

function mockApi(
  mySub: unknown,
  portal?: { body: unknown; status?: number },
  extra?: Record<string, { body: unknown; status?: number }>,
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const key = String(url).replace(/^.*\/api\/v1/, '');
    if (key === '/billing/plans') return jsonResponse({ plans });
    if (key === '/me/subscription') return jsonResponse(mySub);
    if (key === '/billing/portal' && portal) return jsonResponse(portal.body, portal.status ?? 200);
    const hit = extra?.[key];
    if (hit) return jsonResponse(hit.body, hit.status ?? 200);
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
  beforeEach(() => {
    vi.restoreAllMocks();
    flags.ops = false;
  });

  it('says so when the plan catalogue is empty, rather than rendering a bare heading', async () => {
    // An unconfigured Stripe catalogue is a real deployment state, and it used
    // to render the "Choose a plan" heading over an empty grid.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const key = String(url).replace(/^.*\/api\/v1/, '');
      if (key === '/billing/plans') return jsonResponse({ plans: [] });
      if (key === '/me/subscription') {
        return jsonResponse({ subscription: null, plan: null, usage: null, invoices: [] });
      }
      throw new Error(`unexpected fetch ${key}`);
    });
    render(<SubscriptionSection />);

    expect(await screen.findByText('No plans available right now')).toBeInTheDocument();
    expect(screen.getByText(/Contact us and we’ll set your account up directly/)).toBeInTheDocument();
  });

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

  /**
   * The billing section set an error on a failed load and then returned a
   * spinner, so the ErrorNote it had written was inside markup that never
   * rendered: a customer whose billing state would not load watched a
   * spinner instead of being told.
   */
  it('reports a failed load instead of spinning forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    render(<SubscriptionSection />);
    expect(await screen.findByText('Could not load subscription details.')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: /loading/i })).not.toBeInTheDocument();
  });

  describe('subscribing', () => {
    const noSubscription = (over?: Parameters<typeof mockApi>[2]) =>
      mockApi({ subscription: null, plan: null, usage: null, invoices: [] }, undefined, over);

    it('sends the buyer to Stripe checkout for the chosen tier', async () => {
      noSubscription({
        '/billing/subscribe': { body: { checkout_url: 'https://checkout.stripe.com/c/abc' } },
      });
      const location = { href: '' } as Location;
      vi.spyOn(window, 'location', 'get').mockReturnValue(location);

      render(<SubscriptionSection />);
      await userEvent.click(await screen.findByRole('button', { name: 'Subscribe' }));
      await waitFor(() => expect(location.href).toBe('https://checkout.stripe.com/c/abc'));
    });

    it('reports a refused checkout and re-enables the button', async () => {
      noSubscription({
        '/billing/subscribe': {
          body: { title: 'Conflict', detail: 'Billing is not configured on this deployment.' },
          status: 503,
        },
      });
      render(<SubscriptionSection />);
      await userEvent.click(await screen.findByRole('button', { name: 'Subscribe' }));

      expect(await screen.findByText(/Billing is not configured/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Subscribe' })).toBeEnabled();
    });
  });

  it('counts usage without a ceiling on an unlimited plan', async () => {
    mockApi(
      subscribed({
        usage: { limit: null, used: 31, remaining: null, unlimited: true, exhausted: false },
      }),
    );
    render(<SubscriptionSection />);
    expect(await screen.findByTestId('usage')).toHaveTextContent(
      'Unlimited valuations · 31 used this period',
    );
  });

  /** An exhausted allowance is the one number worth colouring. */
  it('marks the remaining count when the allowance is spent', async () => {
    mockApi(
      subscribed({
        usage: { limit: 12, used: 12, remaining: 0, unlimited: false, exhausted: true },
      }),
    );
    render(<SubscriptionSection />);
    const usage = await screen.findByTestId('usage');
    expect(usage).toHaveTextContent('12 of 12 valuations used');
    expect(within(usage).getByText('0 remaining')).toHaveClass('text-red-600');
  });

  it('falls back to the raw tier when the plan behind a subscription is gone', async () => {
    mockApi(subscribed({ plan: null }));
    render(<SubscriptionSection />);
    expect(await screen.findByText('annual_retainer')).toBeInTheDocument();
  });

  it('lists invoices with a PDF link per row', async () => {
    mockApi(
      subscribed({
        invoices: [
          { id: 'in_1', number: 'INV-0001', status: 'paid', amount_cents: 119000, currency: 'usd' },
          { id: 'in_2', number: 'INV-0002', status: 'open', amount_cents: 99000, currency: 'usd' },
        ],
      }),
    );
    render(<SubscriptionSection />);
    expect(await screen.findByText('INV-0001')).toBeInTheDocument();
    expect(screen.getByText('$1,190.00')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'PDF' })[0]).toHaveAttribute(
      'href',
      '/api/v1/billing/invoices/in_1/pdf',
    );
  });

  it('omits the invoice table entirely when there is nothing billed yet', async () => {
    mockApi(subscribed());
    render(<SubscriptionSection />);
    await screen.findByTestId('usage');
    expect(screen.queryByText('Invoices')).not.toBeInTheDocument();
  });

  describe('the ops billing dashboard', () => {
    const adminBilling = {
      summary: { active: 4, mrr_cents: 500000, collected_cents: 12000000 },
      subscriptions: [
        {
          id: 'sub_1',
          email: 'cfo@zorblatt.example',
          plan_name: 'Annual retainer',
          status: 'active',
          valuations_used: 5,
          valuation_limit: 12,
        },
        {
          id: 'sub_2',
          email: 'ops@globex.example',
          plan_name: 'Enterprise',
          status: 'active',
          valuations_used: 40,
          valuation_limit: null,
        },
      ],
      invoices: [],
    };

    it('is not fetched at all for a non-ops reader', async () => {
      mockApi(subscribed());
      render(<SubscriptionSection />);
      await screen.findByTestId('usage');
      expect(screen.queryByTestId('admin-billing')).not.toBeInTheDocument();
    });

    it('summarises the book and states an unlimited plan without a ceiling', async () => {
      flags.ops = true;
      mockApi(subscribed(), undefined, { '/admin/billing': { body: adminBilling } });
      render(<SubscriptionSection />);

      const panel = await screen.findByTestId('admin-billing');
      expect(within(panel).getByText('$5,000.00')).toBeInTheDocument();
      expect(within(panel).getByText('$120,000.00')).toBeInTheDocument();
      expect(within(panel).getByText('5 / 12')).toBeInTheDocument();
      // A null limit is unlimited — "40 / null" would be worse than nothing.
      expect(within(panel).getByText('40')).toBeInTheDocument();
    });

    /**
     * `isOps` reads the token on the client, so a 403 means the server has
     * decided this reader is not ops after all — the section belongs to
     * someone else and removing it silently is right.
     */
    it('stays out of the way when the reader turns out not to be ops', async () => {
      flags.ops = true;
      mockApi(subscribed(), undefined, {
        '/admin/billing': { body: { title: 'Forbidden' }, status: 403 },
      });
      render(<SubscriptionSection />);
      await screen.findByTestId('usage');
      await waitFor(() => expect(screen.queryByTestId('admin-billing')).not.toBeInTheDocument());
    });

    /**
     * Every other failure is the opposite case: the reader is entitled to the
     * dashboard and it is missing. Vanishing then reads as "ops has no billing
     * view", which is a claim about the product rather than about the request.
     */
    it('says so when the reader is entitled to the figures and they did not come back', async () => {
      flags.ops = true;
      mockApi(subscribed(), undefined, {
        '/admin/billing': {
          body: { title: 'Service Unavailable', detail: 'Billing is resyncing.' },
          status: 503,
        },
      });
      render(<SubscriptionSection />);

      const panel = await screen.findByTestId('admin-billing');
      expect(within(panel).getByText('Billing dashboard (ops)')).toBeInTheDocument();
      expect(within(panel).getByText('Billing is resyncing.')).toBeInTheDocument();
      // No figures, because none were read.
      expect(within(panel).queryByText('Active subscriptions')).not.toBeInTheDocument();
    });
  });
});
