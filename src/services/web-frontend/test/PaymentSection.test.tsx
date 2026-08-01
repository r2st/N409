import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaymentHistory, PaymentSection } from '../src/components/PaymentSection';
import type { Valuation } from '../src/lib/types';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const VALUATION = {
  id: '01TESTVALUATION0000000000A',
  kind: '409a',
  company_name: 'Acme Robotics, Inc.',
  currency: 'USD',
  state: 'pending',
  paid_status: 'unpaid',
} as Valuation;

const QUOTE = { amount_cents: 119_000, currency: 'USD', kind: '409a', configured: true };

const PAYMENT = {
  id: '01TESTPAYMENT00000000000A',
  valuation_id: VALUATION.id,
  provider: 'stripe',
  session_id: 'cs_1',
  payment_intent_id: 'pi_1',
  amount_cents: 119_000,
  currency: 'USD',
  status: 'succeeded',
  checkout_url: null,
  charge_id: 'ch_1',
  receipt_url: 'https://pay.stripe.com/receipts/r1',
  created_by: null,
  created_at: '2026-07-01T12:00:00Z',
  updated_at: '2026-07-01T12:00:00Z',
};

describe('PaymentSection (price transparency before checkout)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows the exact quote amount before opening Stripe', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/payments/quote')) return jsonResponse({ quote: QUOTE });
      throw new Error(`unexpected fetch ${String(input)}`);
    });

    render(<PaymentSection valuation={VALUATION} />);
    await waitFor(() => expect(screen.getByTestId('payment-quote')).toHaveTextContent('$1,190.00'));
    expect(screen.getByRole('button', { name: /pay \$1,190\.00 now/i })).toBeInTheDocument();
  });

  it('degrades to invoice messaging when Stripe is unconfigured', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/payments/quote'))
        return jsonResponse({ quote: { ...QUOTE, configured: false } });
      throw new Error(`unexpected fetch ${String(input)}`);
    });

    render(<PaymentSection valuation={VALUATION} />);
    await waitFor(() => expect(screen.getByText(/we will invoice you instead/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /pay/i })).not.toBeInTheDocument();
  });

  it('starts checkout and surfaces a 503 as the invoice fallback', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/payments/quote')) return jsonResponse({ quote: QUOTE });
      if (url.includes('/payments/checkout') && init?.method === 'POST')
        return jsonResponse({ status: 503, detail: 'Payments are not configured' }, 503);
      throw new Error(`unexpected fetch ${url}`);
    });

    render(<PaymentSection valuation={VALUATION} />);
    await waitFor(() => expect(screen.getByTestId('payment-quote')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /pay/i }));
    await waitFor(() => expect(screen.getByText(/we will invoice you instead/i)).toBeInTheDocument());
  });

  it('renders nothing for paid valuations', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const { container } = render(<PaymentSection valuation={{ ...VALUATION, paid_status: 'paid' }} />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('PaymentHistory', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists past payments with amount, status, and receipt link', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/payments'))
        return jsonResponse({
          payments: [
            PAYMENT,
            { ...PAYMENT, id: 'p2', session_id: 'cs_2', status: 'expired', receipt_url: null },
          ],
        });
      throw new Error(`unexpected fetch ${String(input)}`);
    });

    render(<PaymentHistory valuation={{ ...VALUATION, paid_status: 'paid' }} />);
    await waitFor(() => expect(screen.getByText('Payment history')).toBeInTheDocument());
    expect(screen.getAllByText('$1,190.00')).toHaveLength(2);
    expect(screen.getByText('succeeded')).toBeInTheDocument();
    expect(screen.getByText('expired')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /view receipt/i });
    expect(link).toHaveAttribute('href', PAYMENT.receipt_url);
  });

  it('hides entirely when there are no payments', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ payments: [] }));
    const { container } = render(<PaymentHistory valuation={VALUATION} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
