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
  refunded_cents: 0,
  refunded_at: null,
  dispute_status: null,
  disputed_at: null,
  created_by: null,
  created_at: '2026-07-01T12:00:00Z',
  updated_at: '2026-07-01T12:00:00Z',
};

const listPayments = (payments: unknown[]) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input).endsWith('/payments')) return jsonResponse({ payments });
    throw new Error(`unexpected fetch ${String(input)}`);
  });

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

  /**
   * Money going back out is the customer's side of the refund/dispute work.
   * The API has returned `refunded_cents` / `dispute_status` since migration
   * 0099; this table ignored both and its status union never learned the
   * `refunded` label, so a refunded engagement rendered a colourless chip over
   * a row that otherwise still read like a completed payment.
   */
  describe('refunds and chargebacks', () => {
    const rowStyles = (label: string) => screen.getByText(label).className;

    it('styles a refunded payment instead of emitting an undefined class', async () => {
      listPayments([
        { ...PAYMENT, status: 'refunded', refunded_cents: 119_000, refunded_at: '2026-07-09T09:00:00Z' },
      ]);
      render(<PaymentHistory valuation={{ ...VALUATION, paid_status: 'unpaid' }} />);
      await waitFor(() => expect(screen.getByText('refunded')).toBeInTheDocument());
      expect(rowStyles('refunded')).not.toContain('undefined');
      expect(rowStyles('refunded')).toMatch(/bg-\S+/);
    });

    it('states the amount and date returned', async () => {
      listPayments([
        { ...PAYMENT, status: 'refunded', refunded_cents: 119_000, refunded_at: '2026-07-09T09:00:00Z' },
      ]);
      render(<PaymentHistory valuation={VALUATION} />);
      await waitFor(() => expect(screen.getByTestId('settlement-note')).toBeInTheDocument());
      expect(screen.getByTestId('settlement-note')).toHaveTextContent(/Refunded \$1,190\.00 on /);
    });

    it('distinguishes a partial refund, which leaves the status succeeded', async () => {
      listPayments([{ ...PAYMENT, refunded_cents: 20_000, refunded_at: '2026-07-09T09:00:00Z' }]);
      render(<PaymentHistory valuation={{ ...VALUATION, paid_status: 'paid' }} />);
      await waitFor(() => expect(screen.getByTestId('settlement-note')).toBeInTheDocument());
      expect(screen.getByTestId('settlement-note')).toHaveTextContent(/Partially refunded \$200\.00/);
      expect(screen.getByText('succeeded')).toBeInTheDocument();
    });

    it('surfaces an open chargeback, which is not a refund', async () => {
      listPayments([{ ...PAYMENT, dispute_status: 'open', disputed_at: '2026-07-11T09:00:00Z' }]);
      render(<PaymentHistory valuation={{ ...VALUATION, paid_status: 'paid' }} />);
      await waitFor(() => expect(screen.getByTestId('settlement-note')).toBeInTheDocument());
      const note = screen.getByTestId('settlement-note');
      expect(note).toHaveTextContent('Chargeback under review');
      expect(note).not.toHaveTextContent(/refunded/i);
    });

    it('reports both when a lost dispute became a refund', async () => {
      listPayments([
        {
          ...PAYMENT,
          status: 'refunded',
          refunded_cents: 119_000,
          refunded_at: '2026-07-12T09:00:00Z',
          dispute_status: 'lost',
          disputed_at: '2026-07-11T09:00:00Z',
        },
      ]);
      render(<PaymentHistory valuation={{ ...VALUATION, paid_status: 'unpaid' }} />);
      await waitFor(() => expect(screen.getByTestId('settlement-note')).toBeInTheDocument());
      expect(screen.getByTestId('settlement-note')).toHaveTextContent(
        /Refunded \$1,190\.00 on .* · Chargeback upheld/,
      );
    });

    it('says nothing extra about an ordinary settled payment', async () => {
      listPayments([PAYMENT]);
      render(<PaymentHistory valuation={{ ...VALUATION, paid_status: 'paid' }} />);
      await waitFor(() => expect(screen.getByText('succeeded')).toBeInTheDocument());
      expect(screen.queryByTestId('settlement-note')).not.toBeInTheDocument();
    });
  });
});
