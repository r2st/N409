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

function mount(billing: Record<string, unknown>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (String(url).includes('/me/billing')) return jsonResponse({ billing });
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  return render(
    <MemoryRouter>
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
