import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { OnboardingPage } from '../src/pages/OnboardingPage';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const VALUATION = {
  id: '01TESTVALUATION0000000000A',
  kind: '409a',
  company_name: 'Acme Robotics, Inc.',
  currency: 'USD',
  state: 'pending',
  paid_status: 'unpaid',
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/onboarding']}>
      <Routes>
        <Route path="/onboarding" element={<OnboardingPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OnboardingPage (guided client funnel)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('walks company → payment → uploads → done, skipping payment when Stripe is unconfigured', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/valuations') && init?.method === 'POST') {
        return jsonResponse({ valuation: VALUATION }, 201);
      }
      if (url.includes('/payments/quote')) {
        return jsonResponse({
          quote: { amount_cents: 119_000, currency: 'USD', kind: '409a', configured: false },
        });
      }
      if (url.includes('/payments/checkout')) {
        return jsonResponse({ status: 503, detail: 'Payments are not configured' }, 503);
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    renderPage();

    // Step 1 — company details
    expect(screen.getByText("Let's get your valuation started")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Acme Robotics, Inc.'), 'Acme Robotics, Inc.');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Step 2 — payment, with the exact list price shown before checkout
    await waitFor(() => expect(screen.getByRole('button', { name: /with card/i })).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/valuations'),
      expect.objectContaining({ method: 'POST' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-quote')).toHaveTextContent('$1,190.00'),
    );

    // Stripe unconfigured → 503 → invoice fallback advances to uploads
    await user.click(screen.getByRole('button', { name: /with card/i }));
    await waitFor(() =>
      expect(screen.getByText(/online payment is not available yet/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/upload what you have/i)).toBeInTheDocument();

    // Step 3 → skip uploads → done
    await user.click(screen.getByRole('button', { name: /skip uploads for now/i }));
    expect(screen.getByText(/your request is in/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open my valuation/i })).toBeInTheDocument();
  });

  it('lets the client skip payment explicitly', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/valuations') && init?.method === 'POST') {
        return jsonResponse({ valuation: VALUATION }, 201);
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    renderPage();
    await user.type(screen.getByPlaceholderText('Acme Robotics, Inc.'), 'Acme');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => screen.getByRole('button', { name: /skip for now/i }));
    await user.click(screen.getByRole('button', { name: /skip for now/i }));
    expect(screen.getByText(/upload what you have/i)).toBeInTheDocument();
    // The engagement checklist is shown (kinds also appear in the type picker).
    expect(screen.getAllByText(/articles of incorporation/i).length).toBeGreaterThan(0);
  });

  it('surfaces creation errors instead of advancing', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ detail: 'Not allowed to create valuations' }, 403),
    );

    renderPage();
    await user.type(screen.getByPlaceholderText('Acme Robotics, Inc.'), 'Acme');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() =>
      expect(screen.getByText(/not allowed to create valuations/i)).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /pay now/i })).not.toBeInTheDocument();
  });
});
