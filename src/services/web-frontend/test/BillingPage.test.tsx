import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ user: { roles: ['valuation_user'] } }) }));
vi.mock('../src/lib/rbac', () => ({ isOps: () => false, isPartner: () => false }));
// The subscription block has its own suite; stub it out so this one is about
// the payment history and the totals above it.
vi.mock('../src/components/SubscriptionSection', () => ({ SubscriptionSection: () => null }));

import { BillingPage } from '../src/pages/BillingPage';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const payment = (over: Record<string, unknown>) => ({
  id: 'p1',
  valuation_id: 'v1',
  valuation_number: '1042',
  company_name: 'Acme Robotics',
  kind: '409a',
  amount_cents: 119_000,
  currency: 'USD',
  status: 'succeeded',
  receipt_url: null,
  refunded_cents: 0,
  dispute_status: null,
  created_at: '2026-05-01T10:00:00Z',
  ...over,
});

function mount(billing: Record<string, unknown>, path = '/billing') {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (String(url).includes('/me/billing')) return jsonResponse({ billing });
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <BillingPage />
    </MemoryRouter>,
  );
}

/** A page whose only read fails, so the return note is the only thing on it. */
function mountWithFailedHistory(path: string) {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  return render(
    <MemoryRouter initialEntries={[path]}>
      <BillingPage />
    </MemoryRouter>,
  );
}

const totals = (over: Partial<Record<string, number>> = {}) => ({
  gross_cents: 119_000,
  refunded_cents: 0,
  paid_cents: 119_000,
  succeeded_count: 1,
  refunded_count: 0,
  payment_count: 1,
  ...over,
});

describe('BillingPage — refunds and chargebacks', () => {
  beforeEach(() => vi.restoreAllMocks());

  /**
   * What the cards above the table are denominated in.
   *
   * `gross_cents`, `refunded_cents` and `paid_cents` are sums of integer minor
   * units, and minor units only mean anything inside one currency: Stripe
   * reports ¥100,000 and $1,000.00 as the same `100000`. These cards were
   * rendered through `formatChargedCents` with no currency argument at all, so
   * they printed as dollars whatever they were made of — while every row in the
   * table beneath them was rendered in its own currency and visibly did not add
   * up to the card above. `valuations.currency` is chosen per engagement, so a
   * dollar engagement beside a euro one is an ordinary account.
   */
  describe('the currency the totals are in', () => {
    it('renders the cards in the currency the totals name', async () => {
      mount({
        payments: [payment({ currency: 'EUR' })],
        unpaid_valuations: [],
        totals: { ...totals(), currency: 'eur', mixed_currency: false },
      });
      // Not "$1,190.00" — the same minor units, correctly denominated.
      expect(await screen.findAllByText(/1,190\.00/)).toHaveLength(2);
      expect(screen.queryByText('$1,190.00')).not.toBeInTheDocument();
      expect(screen.queryByTestId('mixed-currency-note')).not.toBeInTheDocument();
    });

    it('says the totals are a mixed sum rather than one amount', async () => {
      mount({
        payments: [payment({}), payment({ id: 'p2', currency: 'JPY', amount_cents: 100_000 })],
        unpaid_valuations: [],
        totals: { ...totals({ paid_cents: 219_000 }), currency: 'usd', mixed_currency: true },
      });
      expect((await screen.findByTestId('mixed-currency-note')).textContent).toContain(
        'more than one currency',
      );
    });

    it('stays silent for a response written before the field existed', async () => {
      mount({ payments: [payment({})], unpaid_valuations: [], totals: totals() });
      expect(await screen.findAllByText('$1,190.00')).toHaveLength(2);
      expect(screen.queryByTestId('mixed-currency-note')).not.toBeInTheDocument();
    });
  });

  it('shows the net total and no refund card when nothing came back', async () => {
    mount({ payments: [payment({})], unpaid_valuations: [], totals: totals() });
    // Once in the "Total paid" card, once on the payment row.
    expect(await screen.findAllByText('$1,190.00')).toHaveLength(2);
    expect(screen.queryByText('Refunded')).not.toBeInTheDocument();
  });

  it('breaks out refunded money beside the net total', async () => {
    // Charged twice, one refunded in full: "Total paid" must be the $1,190 we
    // kept, not the $2,380 we charged — the client can check the second number
    // against their own card statement.
    mount({
      payments: [payment({}), payment({ id: 'p2', status: 'refunded', refunded_cents: 119_000 })],
      unpaid_valuations: [],
      totals: totals({ gross_cents: 238_000, refunded_cents: 119_000, refunded_count: 1, payment_count: 2 }),
    });
    expect(await screen.findByText('Refunded')).toBeInTheDocument();
    expect(screen.getByText('refunded')).toBeInTheDocument(); // the row's status badge
  });

  it('annotates a partially refunded row that is still succeeded', async () => {
    mount({
      payments: [payment({ refunded_cents: 20_000 })],
      unpaid_valuations: [],
      totals: totals({ refunded_cents: 20_000, paid_cents: 99_000 }),
    });
    expect(await screen.findByText('−$200.00 refunded')).toBeInTheDocument();
    // The row is still 'succeeded' — the annotation is the only signal.
    expect(screen.getByText('succeeded')).toBeInTheDocument();
  });

  it('flags an open chargeback on the row', async () => {
    mount({
      payments: [payment({ dispute_status: 'open' })],
      unpaid_valuations: [],
      totals: totals(),
    });
    expect(await screen.findByText('disputed')).toBeInTheDocument();
  });

  it('renders a status it has no tone for without crashing', async () => {
    // Forward-compatibility: a status added server-side must not blank the page.
    mount({
      payments: [payment({ status: 'something_new' })],
      unpaid_valuations: [],
      totals: totals(),
    });
    expect(await screen.findByText('something_new')).toBeInTheDocument();
  });

  it('offers a pay-now path for an engagement whose payment was reversed', async () => {
    mount({
      payments: [payment({ status: 'refunded', refunded_cents: 119_000 })],
      unpaid_valuations: [
        {
          id: 'v1',
          number: '1042',
          company_name: 'Acme Robotics',
          kind: '409a',
          currency: 'USD',
          amount_cents: 119_000,
        },
      ],
      totals: totals({ refunded_cents: 119_000, paid_cents: 0, succeeded_count: 0, refunded_count: 1 }),
    });
    // Once as the stat-card label, once as the section heading.
    expect(await screen.findAllByText('Unpaid engagements')).toHaveLength(2);
    expect(screen.getByRole('link', { name: /Pay now/ })).toHaveAttribute('href', '/valuations/v1');
  });
});

/**
 * The half of Stripe's return leg that speaks.
 *
 * A subscription checkout returned to `/settings?billing=…`, which renders no
 * subscription card and reads no query parameter, so both outcomes a customer
 * cares about — the plan started, or it did not — arrived as silence on the
 * wrong page. The redirects now come here.
 */
describe('BillingPage — the subscription checkout return leg', () => {
  beforeEach(() => vi.restoreAllMocks());

  const empty = {
    payments: [],
    unpaid_valuations: [],
    totals: { ...totals({ paid_cents: 0, succeeded_count: 0, payment_count: 0 }), currency: 'usd' },
  };

  it('confirms a completed subscription checkout without promising the plan is live yet', async () => {
    mount(empty, '/billing?subscription=success');
    const note = await screen.findByTestId('subscription-return-note');
    expect(note.textContent).toMatch(/Payment accepted/i);
    // Stripe's redirect is not the event that starts the plan; the
    // subscription.created webhook is, and it can be seconds behind.
    expect(note.textContent).toMatch(/being set up/i);
  });

  it('says nothing was charged when the customer backed out', async () => {
    mount(empty, '/billing?subscription=canceled');
    const note = await screen.findByTestId('subscription-return-note');
    expect(note.textContent).toMatch(/not been charged/i);
    expect(note.textContent).not.toMatch(/Payment accepted/i);
  });

  it('leaves the page alone when the visit is not a return leg', async () => {
    mount(empty);
    await screen.findByRole('heading', { name: 'Billing' });
    expect(screen.queryByTestId('subscription-return-note')).toBeNull();
    // An unrecognised value is not an outcome either.
    vi.restoreAllMocks();
    mount(empty, '/billing?subscription=whatever');
    await screen.findByRole('heading', { name: 'Billing' });
    expect(screen.queryByTestId('subscription-return-note')).toBeNull();
  });

  it('still confirms the charge when the billing history fails to load', async () => {
    mountWithFailedHistory('/billing?subscription=success');
    // The read this page makes has nothing to do with the payment just taken,
    // and a bare load error is the worst moment to withhold the confirmation.
    const note = await screen.findByTestId('subscription-return-note');
    expect(note.textContent).toMatch(/Payment accepted/i);
  });
});
