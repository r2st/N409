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

  /**
   * A Stripe test key opens a real Checkout page on Stripe's own domain that
   * accepts `4242…` and declines every real card. The API only sends
   * `test_mode` to ops, and only ops are given the button at all while it is
   * set — so these two tests are the whole of what the browser has to get
   * right: warn the person who can click, and say nothing to the person who
   * cannot.
   */
  it('warns ops that a test-mode checkout moves no money', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/payments/quote'))
        return jsonResponse({ quote: { ...QUOTE, test_mode: true } });
      throw new Error(`unexpected fetch ${String(input)}`);
    });

    render(<PaymentSection valuation={VALUATION} />);
    await waitFor(() => expect(screen.getByTestId('stripe-test-mode')).toBeInTheDocument());
    expect(screen.getByTestId('stripe-test-mode')).toHaveTextContent(/no money moves/i);
    // Still clickable — exercising the pipeline end to end is what the key is
    // for, and the point of the warning is that the click is deliberate.
    expect(screen.getByRole('button', { name: /pay/i })).toBeInTheDocument();
  });

  it('shows a client the invoice fallback, with no mention of test mode', async () => {
    // What the API sends a client when the key is a test key: `configured`
    // false and no `test_mode` at all. Which Stripe account this deployment
    // holds is not a client's business, and the sentence they need is the one
    // an unconfigured deployment already gives them.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/payments/quote'))
        return jsonResponse({ quote: { ...QUOTE, configured: false } });
      throw new Error(`unexpected fetch ${String(input)}`);
    });

    render(<PaymentSection valuation={VALUATION} />);
    await waitFor(() => expect(screen.getByText(/we will invoice you instead/i)).toBeInTheDocument());
    expect(screen.queryByTestId('stripe-test-mode')).not.toBeInTheDocument();
    expect(screen.queryByText(/test mode/i)).not.toBeInTheDocument();
  });

  it('says nothing about test mode on an ordinary live quote', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/payments/quote')) return jsonResponse({ quote: QUOTE });
      throw new Error(`unexpected fetch ${String(input)}`);
    });
    render(<PaymentSection valuation={VALUATION} />);
    await waitFor(() => expect(screen.getByTestId('payment-quote')).toBeInTheDocument());
    expect(screen.queryByTestId('stripe-test-mode')).not.toBeInTheDocument();
  });

  it('renders nothing for paid valuations', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const { container } = render(<PaymentSection valuation={{ ...VALUATION, paid_status: 'paid' }} />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * The tiered quote. The panel never adds up the price itself — it sends the
 * flags and renders whatever the server quotes, because the server is what
 * Stripe is asked to charge.
 */
describe('PaymentSection add-ons and the itemised quote', () => {
  beforeEach(() => vi.restoreAllMocks());

  /** A server that prices the flags, the way domain/pricing.ts does. */
  const pricingServer = () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/payments/quote')) {
        calls.push(url);
        const q = new URL(url, 'https://x').searchParams;
        const express = q.get('express') === 'true';
        const qsbs = q.get('qsbs_letter') === 'true';
        const lines = [
          { key: 'base', label: '409A valuation', amount_cents: 119_000 },
          { key: 'band', label: '$5M – $10M raised', amount_cents: 110_000 },
          ...(express
            ? [{ key: 'express', label: 'Express delivery — 1 business day', amount_cents: 50_000 }]
            : []),
          ...(qsbs ? [{ key: 'qsbs_letter', label: 'QSBS attestation letter', amount_cents: 50_000 }] : []),
        ];
        return jsonResponse({
          quote: {
            ...QUOTE,
            amount_cents: lines.reduce((s, l) => s + l.amount_cents, 0),
            lines,
            delivery_days: express ? 1 : 7,
          },
        });
      }
      if (url.includes('/payments/checkout')) {
        calls.push(String(init?.body));
        return jsonResponse({ checkout_url: 'https://checkout.stripe.test/s' });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    return calls;
  };

  it('itemises the entry price and the capital-raised band', async () => {
    pricingServer();
    render(<PaymentSection valuation={VALUATION} />);
    await waitFor(() => expect(screen.getByTestId('payment-quote')).toHaveTextContent('$2,290.00'));
    const lines = screen.getByTestId('quote-lines');
    expect(lines).toHaveTextContent('409A valuation');
    expect(lines).toHaveTextContent('$5M – $10M raised');
  });

  it('re-quotes from the server when express is ticked, and moves the SLA', async () => {
    const user = userEvent.setup();
    pricingServer();
    render(<PaymentSection valuation={VALUATION} />);
    await waitFor(() => expect(screen.getByTestId('payment-quote')).toHaveTextContent('$2,290.00'));
    expect(screen.getByTestId('quote-lines')).toHaveTextContent('7 business days');

    await user.click(screen.getByTestId('addon-express'));
    await waitFor(() => expect(screen.getByTestId('payment-quote')).toHaveTextContent('$2,790.00'));
    expect(screen.getByTestId('quote-lines')).toHaveTextContent('1 business day');
  });

  it('posts the flags, never a total — the browser must not be able to set the price', async () => {
    const user = userEvent.setup();
    const calls = pricingServer();
    render(<PaymentSection valuation={VALUATION} />);
    await waitFor(() => expect(screen.getByTestId('payment-quote')).toBeInTheDocument());

    await user.click(screen.getByTestId('addon-express'));
    await waitFor(() => expect(screen.getByTestId('payment-quote')).toHaveTextContent('$2,790.00'));
    await user.click(screen.getByRole('button', { name: /pay/i }));

    const body = calls.find((c) => c.startsWith('{'))!;
    expect(JSON.parse(body)).toEqual({ express: true, qsbs_letter: false });
    expect(body).not.toContain('amount_cents');
  });

  it('hides the QSBS add-on on a QSBS engagement', async () => {
    // The attestation IS the deliverable; the server refuses to charge for it,
    // so offering a checkbox that does nothing would be worse than hiding it.
    pricingServer();
    render(<PaymentSection valuation={{ ...VALUATION, kind: 'qsbs' } as Valuation} />);
    await waitFor(() => expect(screen.getByTestId('addon-express')).toBeInTheDocument());
    expect(screen.queryByTestId('addon-qsbs')).not.toBeInTheDocument();
  });

  it('still shows the total when an older API omits the itemisation', async () => {
    // A rolling deploy can serve this page from a build newer than the API.
    // Blanking the panel a client is trying to pay from is the wrong failure.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/payments/quote')) return jsonResponse({ quote: QUOTE });
      throw new Error(`unexpected fetch ${String(input)}`);
    });
    render(<PaymentSection valuation={VALUATION} />);
    await waitFor(() => expect(screen.getByTestId('payment-quote')).toHaveTextContent('$1,190.00'));
    expect(screen.getByTestId('quote-lines')).not.toHaveTextContent('business day');
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
    // Two documents, not one: Stripe's proves the card was charged, ours is
    // the only one that says what the charge was made of.
    expect(screen.getByRole('link', { name: /stripe receipt/i })).toHaveAttribute(
      'href',
      PAYMENT.receipt_url,
    );
    const itemised = screen.getByRole('link', { name: /itemised pdf/i });
    expect(itemised).toHaveAttribute(
      'href',
      `/api/v1/valuations/${PAYMENT.valuation_id}/payments/${PAYMENT.id}/receipt.pdf`,
    );
    // The expired row settled nothing, so it offers no receipt of either kind.
    expect(screen.getAllByRole('link', { name: /itemised pdf/i })).toHaveLength(1);
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
