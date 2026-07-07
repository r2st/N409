import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PaymentCancelPage, PaymentSuccessPage } from '../src/pages/PaymentRedirectPages';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const VID = '01TESTVALUATION0000000000A';

const valuation = (paid_status: string) => ({
  valuation: {
    id: VID,
    kind: '409a',
    company_name: 'Acme Robotics, Inc.',
    currency: 'USD',
    state: 'pending',
    paid_status,
  },
});

const RECEIPT = {
  id: 'p1',
  status: 'succeeded',
  amount_cents: 119_000,
  currency: 'USD',
  receipt_url: 'https://pay.stripe.com/receipts/r1',
};

function renderSuccess() {
  return render(
    <MemoryRouter initialEntries={[`/payment/success?valuation=${VID}`]}>
      <Routes>
        <Route path="/payment/success" element={<PaymentSuccessPage pollMs={5} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PaymentSuccessPage (Stripe redirect landing)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('polls past webhook lag, then confirms with amount and receipt link', async () => {
    let valuationCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith(`/valuations/${VID}`)) {
        valuationCalls += 1;
        // Unpaid on the first poll (webhook still in flight), paid after.
        return jsonResponse(valuation(valuationCalls < 3 ? 'unpaid' : 'paid'));
      }
      if (url.endsWith('/payments')) return jsonResponse({ payments: [RECEIPT] });
      throw new Error(`unexpected fetch ${url}`);
    });

    renderSuccess();
    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('Payment confirmed')).toBeInTheDocument());
    expect(valuationCalls).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/\$1,190\.00/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view stripe receipt/i })).toHaveAttribute(
      'href',
      RECEIPT.receipt_url,
    );
    expect(screen.getByRole('link', { name: /open my valuation/i })).toHaveAttribute(
      'href',
      `/valuations/${VID}`,
    );
  });

  it('reassures instead of erroring when confirmation outlasts the poll budget', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith(`/valuations/${VID}`)) return jsonResponse(valuation('unpaid'));
      throw new Error(`unexpected fetch ${String(input)}`);
    });

    renderSuccess();
    await waitFor(() => expect(screen.getByText('Payment processing')).toBeInTheDocument(), {
      timeout: 5000,
    });
    expect(screen.getByText(/update automatically/i)).toBeInTheDocument();
  });
});

describe('PaymentCancelPage', () => {
  it('shows a non-error notice and links back to the valuation', () => {
    render(
      <MemoryRouter initialEntries={[`/payment/cancel?valuation=${VID}`]}>
        <Routes>
          <Route path="/payment/cancel" element={<PaymentCancelPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Payment cancelled')).toBeInTheDocument();
    expect(screen.getByText(/no charge was made/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to my valuation/i })).toHaveAttribute(
      'href',
      `/valuations/${VID}`,
    );
  });
});
