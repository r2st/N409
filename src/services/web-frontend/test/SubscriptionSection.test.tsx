import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ user: { roles: ['valuation_user'] } }) }));
// The ops flag is mutable so the admin dashboard — which only renders for ops —
// can be exercised without a second copy of the whole fixture set.
const flags = vi.hoisted(() => ({ ops: false }));
vi.mock('../src/lib/rbac', () => ({ isOps: () => flags.ops }));

import { monthDelta, monthLabel, SubscriptionSection } from '../src/components/SubscriptionSection';

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

  /**
   * A refund never moves a Stripe invoice's status, so a refunded invoice is
   * still `paid` and the amount column still reads the gross. Both facts come
   * back on `/me/subscription` and the PDF linked from the very same row has
   * stated them since migration 0169; the table said nothing, so a customer
   * reconciling against their card statement saw a charge they had been given
   * back.
   */
  it('states a full refund on the invoice row', async () => {
    mockApi(
      subscribed({
        invoices: [
          {
            id: 'in_1',
            number: 'INV-0001',
            status: 'paid',
            amount_cents: 119000,
            currency: 'usd',
            refunded_cents: 119000,
            refunded_at: '2026-08-14T10:00:00.000Z',
          },
        ],
      }),
    );
    render(<SubscriptionSection />);
    const note = await screen.findByTestId('invoice-refund-note');
    expect(note).toHaveTextContent('Refunded $1,190.00');
    expect(note).toHaveTextContent('net $0.00');
    expect(note).not.toHaveTextContent('Partially');
  });

  it('distinguishes a partial refund and shows what is left', async () => {
    mockApi(
      subscribed({
        invoices: [
          {
            id: 'in_1',
            number: 'INV-0001',
            status: 'paid',
            amount_cents: 119000,
            currency: 'usd',
            refunded_cents: 19000,
            refunded_at: null,
          },
        ],
      }),
    );
    render(<SubscriptionSection />);
    const note = await screen.findByTestId('invoice-refund-note');
    expect(note).toHaveTextContent('Partially refunded $190.00');
    expect(note).toHaveTextContent('net $1,000.00');
  });

  /**
   * Stripe's refund total is authoritative and this is a customer-facing
   * screen, not a reconciliation: a total above the invoice reads as a full
   * refund rather than a negative net.
   */
  it('bounds a refund that exceeds the invoice instead of printing a negative net', async () => {
    mockApi(
      subscribed({
        invoices: [
          {
            id: 'in_1',
            number: 'INV-0001',
            status: 'paid',
            amount_cents: 119000,
            currency: 'usd',
            refunded_cents: 200000,
            refunded_at: null,
          },
        ],
      }),
    );
    render(<SubscriptionSection />);
    const note = await screen.findByTestId('invoice-refund-note');
    expect(note).toHaveTextContent('Refunded $1,190.00');
    expect(note).toHaveTextContent('net $0.00');
    expect(note.textContent).not.toContain('-');
    expect(note.textContent).not.toContain('\u2212');
  });

  /** Rows that predate migration 0169 carry neither field. */
  it('says nothing about refunds on an invoice that has none', async () => {
    mockApi(
      subscribed({
        invoices: [
          { id: 'in_1', number: 'INV-0001', status: 'paid', amount_cents: 119000, currency: 'usd' },
          {
            id: 'in_2',
            number: 'INV-0002',
            status: 'paid',
            amount_cents: 99000,
            currency: 'usd',
            refunded_cents: 0,
            refunded_at: null,
          },
        ],
      }),
    );
    render(<SubscriptionSection />);
    expect(await screen.findByText('INV-0001')).toBeInTheDocument();
    expect(screen.queryByTestId('invoice-refund-note')).not.toBeInTheDocument();
  });

  it('omits the invoice table entirely when there is nothing billed yet', async () => {
    mockApi(subscribed());
    render(<SubscriptionSection />);
    await screen.findByTestId('usage');
    expect(screen.queryByText('Invoices')).not.toBeInTheDocument();
  });

  /**
   * The month label is parsed rather than passed through `new Date`. The server
   * states this boundary in UTC, and `new Date('2026-08-01')` formatted in a
   * local timezone prints July for every reader west of Greenwich — the
   * off-by-a-day this codebase has already fixed twice on date columns, arrived
   * at from the display side.
   */
  describe('month figures', () => {
    it('names the month from the string, without a timezone in the middle', () => {
      expect(monthLabel('2026-08-01')).toBe('August');
      expect(monthLabel('2026-01-01')).toBe('January');
      expect(monthLabel('2026-12-01')).toBe('December');
    });

    it('falls back rather than printing a wrong month for an unparseable value', () => {
      expect(monthLabel('')).toBe('this month');
      expect(monthLabel('August 2026')).toBe('this month');
      expect(monthLabel('2026-13-01')).toBe('this month');
    });

    it('reads the month against the one before it, in both directions', () => {
      expect(monthDelta(900000, 750000)).toBe('+20% vs last month');
      expect(monthDelta(600000, 750000)).toBe('-20% vs last month');
      // No sign on nothing: "+0%" reads as a rise that did not happen.
      expect(monthDelta(750000, 750000)).toBe('0% vs last month');
    });

    /** "Up ∞%" is not a fact, and a first month of trading has no comparison. */
    it('says nothing when there is nothing to compare against', () => {
      expect(monthDelta(900000, 0)).toBeNull();
      expect(monthDelta(0, 0)).toBeNull();
    });
  });

  describe('the ops billing dashboard', () => {
    const adminBilling = {
      summary: {
        active: 4,
        trialing: 1,
        past_due: 2,
        served: 7,
        mrr_cents: 500000,
        collected_cents: 12000000,
        // Distinct from MRR's $5,000.00: two metrics rendering the same string
        // make `getByText` ambiguous and the assertion meaningless.
        gross_cents: 12250000,
        refunded_cents: 250000,
        month_start: '2026-08-01',
        month_collected_cents: 900000,
        prev_month_collected_cents: 750000,
      },
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
      subscriptions_truncated: false,
      invoices_truncated: false,
      page_limit: 200,
      invoice_page_limit: 200,
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
      // The month, named rather than called "this month", and read against the
      // one before it — a revenue figure with no direction is one an operator
      // has to go and find last month's copy of before it says anything.
      expect(within(panel).getByText('Collected in August')).toBeInTheDocument();
      expect(within(panel).getByText('$9,000.00')).toBeInTheDocument();
      expect(within(panel).getByText('+20% vs last month')).toBeInTheDocument();
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
      // No figures, because none were read. Asserted on a label the panel does
      // render when it has figures — a negative assertion against a string that
      // no longer appears anywhere passes for the wrong reason.
      expect(within(panel).queryByText('Served')).not.toBeInTheDocument();
      expect(within(panel).queryByText('MRR (active + trialing)')).not.toBeInTheDocument();
    });

    /**
     * `/admin/billing` has shipped the invoice ledger since feature 7 and the
     * screen drew only the subscribers table, so the two all-time money
     * figures above it were the whole invoice view ops had. They can say
     * collected went down and never which invoice did it — which is the one
     * question the Refunded metric beside them exists to raise.
     */
    it('lists the invoice ledger behind the money figures', async () => {
      flags.ops = true;
      mockApi(subscribed(), undefined, {
        '/admin/billing': {
          body: {
            ...adminBilling,
            invoices: [
              {
                id: 'in_1',
                number: 'INV-0007',
                email: 'cfo@zorblatt.example',
                amount_cents: 2000000,
                currency: 'usd',
                status: 'paid',
                issued_at: '2026-08-02T00:00:00.000Z',
                refunded_cents: 250000,
                refunded_at: '2026-08-19T00:00:00.000Z',
              },
            ],
          },
        },
      });
      render(<SubscriptionSection />);

      const panel = await screen.findByTestId('admin-billing');
      // Scoped to the invoice's own row: the customer's address is also in the
      // subscribers table above, so a panel-wide match would not say which
      // table drew it.
      const row = within(panel).getByText('INV-0007').closest('tr') as HTMLElement;
      expect(within(row).getByText('cfo@zorblatt.example')).toBeInTheDocument();
      expect(within(row).getByText('$20,000.00')).toBeInTheDocument();
      // Which invoice the Refunded metric is made of, on the same row.
      expect(within(row).getByTestId('admin-invoice-refund-note')).toHaveTextContent(
        'Partially refunded $2,500.00',
      );
    });

    it('says the ledger is empty rather than drawing a headed table with no rows', async () => {
      flags.ops = true;
      mockApi(subscribed(), undefined, { '/admin/billing': { body: adminBilling } });
      render(<SubscriptionSection />);
      const panel = await screen.findByTestId('admin-billing');
      expect(within(panel).getByText('Nothing invoiced yet.')).toBeInTheDocument();
    });

    /**
     * Both lists are capped in SQL. `listAllInvoices` was rewritten to report
     * *when* the cap bit for exactly this reason: the summary counts in SQL
     * and the rows do not, so a capped table reads as a book that disagrees
     * with the totals above it. The flags reached the client and nothing drew
     * them, which is the silent truncation the cap was supposed to stop being.
     */
    it('says so when either table stopped short of the book', async () => {
      flags.ops = true;
      mockApi(subscribed(), undefined, {
        '/admin/billing': {
          body: { ...adminBilling, subscriptions_truncated: true, invoices_truncated: true },
        },
      });
      render(<SubscriptionSection />);

      const panel = await screen.findByTestId('admin-billing');
      const notes = within(panel).getAllByTestId('list-truncated');
      expect(notes).toHaveLength(2);
      expect(notes[0]).toHaveTextContent('Showing 2 subscribers. More exist than are listed');
      // The rows are a page and the metrics above are counted in SQL, so the
      // note has to say which of the two the reader is looking at.
      expect(notes[0]).toHaveTextContent('the figures above count them all');
      expect(notes[1]).toHaveTextContent('Showing 0 invoices. More exist than are listed');
    });

    it('says nothing about truncation when both tables are complete', async () => {
      flags.ops = true;
      mockApi(subscribed(), undefined, { '/admin/billing': { body: adminBilling } });
      render(<SubscriptionSection />);
      const panel = await screen.findByTestId('admin-billing');
      // Asserted against the subscribers table actually being drawn, so this
      // cannot pass by the whole panel having failed to render.
      expect(within(panel).getByText('cfo@zorblatt.example')).toBeInTheDocument();
      expect(within(panel).queryAllByTestId('list-truncated')).toHaveLength(0);
    });

    /**
     * The three figures used to be one count and one MRR that disagreed about
     * `trialing`, so an operator could not add up what they were shown. Broken
     * out, they have to reconcile.
     */
    it('states counts that add up to the served set', async () => {
      flags.ops = true;
      mockApi(subscribed(), undefined, { '/admin/billing': { body: adminBilling } });
      render(<SubscriptionSection />);

      const panel = await screen.findByTestId('admin-billing');
      for (const label of ['Active', 'Trialing', 'Past due', 'Served']) {
        expect(within(panel).getByText(label)).toBeInTheDocument();
      }
      // Past due is what dunning chases; it appeared in neither of the two
      // figures the panel used to show.
      expect(within(panel).getByText('2')).toBeInTheDocument();
      expect(within(panel).getByText('7')).toBeInTheDocument();
      // MRR names the set it covers, so it cannot be read against the wrong one.
      expect(within(panel).getByText('MRR (active + trialing)')).toBeInTheDocument();
    });
  });
});
