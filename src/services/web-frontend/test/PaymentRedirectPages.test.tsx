import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PaymentCancelPage, PaymentSuccessPage } from '../src/pages/PaymentRedirectPages';
import { ONBOARDING_DRAFT_KEY } from '../src/lib/onboardingDraft';

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

/**
 * The return leg of the guided funnel, which nothing ever completed.
 *
 * `OnboardingPage.checkout` writes its draft parked on the *uploads* step
 * immediately before handing the browser to Stripe, and the comment on that
 * line states the intent: "Parked on the uploads step, which is where a client
 * who has just paid — or just cancelled — should land." Stripe returns to these
 * two pages, and both offered only the valuation page and the dashboard. So the
 * funnel ended at the payment step: its six-document checklist was never shown,
 * and the saved place was reachable only if the client happened to press the
 * browser's back button.
 */
function parkDraft(valuationId: string) {
  sessionStorage.setItem(
    ONBOARDING_DRAFT_KEY,
    JSON.stringify({
      version: 1,
      step: 2,
      valuation: { id: valuationId, company_name: 'Acme Robotics, Inc.', kind: '409a' },
      uploaded: {},
      paymentNote: null,
      savedAt: Date.now(),
    }),
  );
}

describe('the return leg of the onboarding funnel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('sends a paid client back into the funnel, on the step it parked itself on', async () => {
    parkDraft(VID);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).endsWith('/payments')
        ? jsonResponse({ payments: [RECEIPT] })
        : jsonResponse(valuation('paid')),
    );
    renderSuccess();

    await waitFor(() => expect(screen.getByText('Payment confirmed')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /upload your documents/i })).toHaveAttribute(
      'href',
      '/onboarding',
    );
    // The valuation is still one click away — continuing is the offer, not the
    // only exit.
    expect(screen.getByRole('link', { name: /skip for now/i })).toHaveAttribute('href', `/valuations/${VID}`);
  });

  it('leaves the ordinary pay-an-invoice landing alone', async () => {
    // No draft: this is somebody paying from the billing page, and dropping
    // them into a funnel they are not in would be the opposite mistake.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).endsWith('/payments')
        ? jsonResponse({ payments: [RECEIPT] })
        : jsonResponse(valuation('paid')),
    );
    renderSuccess();

    await waitFor(() => expect(screen.getByText('Payment confirmed')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /upload your documents/i })).toBeNull();
    expect(screen.getByRole('link', { name: /open my valuation/i })).toHaveAttribute(
      'href',
      `/valuations/${VID}`,
    );
  });

  it('does not divert a client whose draft is for a different company', async () => {
    // A funnel open for one company while an invoice is paid for another.
    // Matching on the draft merely existing would send them into the wrong
    // request, which is worse than the dead end this closes.
    parkDraft('01OTHERVALUATION000000000B');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).endsWith('/payments')
        ? jsonResponse({ payments: [RECEIPT] })
        : jsonResponse(valuation('paid')),
    );
    renderSuccess();

    await waitFor(() => expect(screen.getByText('Payment confirmed')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /upload your documents/i })).toBeNull();
  });

  it('still offers the funnel when the webhook confirmation is late', async () => {
    // The confirmation is late, not the request. Someone mid-funnel still has
    // documents to give us.
    parkDraft(VID);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(valuation('unpaid')));
    renderSuccess();

    await waitFor(() => expect(screen.getByText('Payment processing')).toBeInTheDocument(), {
      timeout: 4000,
    });
    expect(screen.getByRole('link', { name: /upload your documents/i })).toHaveAttribute(
      'href',
      '/onboarding',
    );
  });

  it('carries a cancelled payment back into the funnel too', () => {
    // Backing out of the card form is not abandoning the request — the funnel's
    // own payment step offers "Skip for now" as an ordinary choice. Cancelling
    // was the one action that dropped a client out of the funnel entirely.
    parkDraft(VID);
    render(
      <MemoryRouter initialEntries={[`/payment/cancel?valuation=${VID}`]}>
        <Routes>
          <Route path="/payment/cancel" element={<PaymentCancelPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /continue without paying now/i })).toHaveAttribute(
      'href',
      '/onboarding',
    );
    expect(screen.getByRole('link', { name: /back to my valuation/i })).toHaveAttribute(
      'href',
      `/valuations/${VID}`,
    );
  });

  it('leaves the ordinary cancel landing alone', () => {
    render(
      <MemoryRouter initialEntries={[`/payment/cancel?valuation=${VID}`]}>
        <Routes>
          <Route path="/payment/cancel" element={<PaymentCancelPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: /continue without paying/i })).toBeNull();
    expect(screen.getByRole('link', { name: /back to my valuation/i })).toBeInTheDocument();
  });
});
