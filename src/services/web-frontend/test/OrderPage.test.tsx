import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ status: 'authenticated', user: { id: 'u1', roles: ['valuation_user'] } }),
}));

import { OrderPage } from '../src/pages/OrderPage';
import { PRICING_TIERS } from '../src/lib/marketing';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderOrder(path = '/order') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/order" element={<OrderPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OrderPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows plan selector as the first step when no tier in query', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ orders: [] }));
    renderOrder();
    expect(screen.getByTestId('plan-selector')).toBeTruthy();
  });

  it('renders all three plan options', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ orders: [] }));
    renderOrder();
    for (const tier of PRICING_TIERS) {
      expect(screen.getByTestId(`select-${tier.tier}`)).toBeTruthy();
    }
  });

  it('skips to details step when tier is in query params', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ orders: [] }));
    renderOrder('/order?tier=growth');
    expect(screen.getByTestId('company-details')).toBeTruthy();
  });

  it('advances to details after selecting a plan', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ orders: [] }));
    renderOrder();
    await userEvent.click(screen.getByTestId('select-starter'));
    expect(screen.getByTestId('company-details')).toBeTruthy();
  });

  it('requires company name before continuing to confirm', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ orders: [] }));
    renderOrder('/order?tier=starter');
    const continueBtn = screen.getByTestId('continue-to-confirm');
    expect(continueBtn).toHaveProperty('disabled', true);

    await userEvent.type(screen.getByTestId('company-name-input'), 'Acme Corp');
    expect(continueBtn).toHaveProperty('disabled', false);
  });

  it('shows confirm step with plan details', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ orders: [] }));
    renderOrder('/order?tier=starter');
    await userEvent.type(screen.getByTestId('company-name-input'), 'Acme Corp');
    await userEvent.click(screen.getByTestId('continue-to-confirm'));
    expect(screen.getByTestId('order-confirm')).toBeTruthy();
    expect(screen.getByText('Per Report')).toBeTruthy();
    expect(screen.getByText('Acme Corp')).toBeTruthy();
  });

  it('shows step indicator', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ orders: [] }));
    renderOrder();
    expect(screen.getByTestId('order-steps')).toBeTruthy();
    expect(screen.getByText('Plan')).toBeTruthy();
    expect(screen.getByText('Details')).toBeTruthy();
    expect(screen.getByText('Payment')).toBeTruthy();
  });

  it('can navigate back from details to plan', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ orders: [] }));
    renderOrder('/order?tier=growth');
    expect(screen.getByTestId('company-details')).toBeTruthy();
    await userEvent.click(screen.getByText('Back'));
    expect(screen.getByTestId('plan-selector')).toBeTruthy();
  });

  it('calls checkout API and redirects on confirm', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const key = String(url);
      if (key.includes('/me/orders')) return jsonResponse({ orders: [] });
      if (key.includes('/orders/checkout')) {
        return jsonResponse({ checkout_url: 'https://checkout.stripe.com/test' });
      }
      throw new Error(`unexpected fetch: ${key}`);
    });
    const assignMock = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, assign: assignMock }, writable: true });

    renderOrder('/order?tier=starter');
    await userEvent.type(screen.getByTestId('company-name-input'), 'Acme Corp');
    await userEvent.click(screen.getByTestId('continue-to-confirm'));
    await userEvent.click(screen.getByTestId('proceed-to-payment'));

    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith('https://checkout.stripe.com/test');
    });

    const checkoutCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/orders/checkout'));
    expect(checkoutCall).toBeTruthy();
    const body = JSON.parse((checkoutCall![1] as RequestInit).body as string);
    expect(body.tier).toBe('starter');
    expect(body.company_name).toBe('Acme Corp');
  });

  it('shows error on checkout failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const key = String(url);
      if (key.includes('/me/orders')) return jsonResponse({ orders: [] });
      if (key.includes('/orders/checkout')) {
        return jsonResponse(
          { type: 'urn:n409:problem:billing-unavailable', detail: 'Billing not available' },
          503,
        );
      }
      throw new Error(`unexpected fetch: ${key}`);
    });

    renderOrder('/order?tier=starter');
    await userEvent.type(screen.getByTestId('company-name-input'), 'Acme Corp');
    await userEvent.click(screen.getByTestId('continue-to-confirm'));
    await userEvent.click(screen.getByTestId('proceed-to-payment'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });
  });

  it('shows error when order history fails to load (R382)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const key = String(url);
      if (key.includes('/me/orders')) {
        return jsonResponse(
          { type: 'urn:n409:problem:internal', detail: 'database connection lost' },
          500,
        );
      }
      throw new Error(`unexpected fetch: ${key}`);
    });

    renderOrder();
    await waitFor(() => {
      expect(screen.getByTestId('order-history')).toBeTruthy();
    });
    const history = screen.getByTestId('order-history');
    expect(within(history).getByRole('alert')).toBeTruthy();
  });

  it('preserves server detail in order-history error message (R382)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const key = String(url);
      if (key.includes('/me/orders')) {
        return jsonResponse(
          { type: 'urn:n409:problem:unavailable', detail: 'Service temporarily unavailable' },
          503,
        );
      }
      throw new Error(`unexpected fetch: ${key}`);
    });

    renderOrder();
    await waitFor(() => {
      expect(screen.getByTestId('order-history')).toBeTruthy();
    });
    const history = screen.getByTestId('order-history');
    const alert = within(history).getByRole('alert');
    expect(alert.textContent).toContain('Service temporarily unavailable');
  });

  it('shows order history when orders exist', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const key = String(url);
      if (key.includes('/me/orders')) {
        return jsonResponse({
          orders: [
            {
              id: 'o1',
              tier: 'starter',
              plan_name: 'Starter',
              amount_cents: 29900,
              currency: 'usd',
              status: 'completed',
              company_name: 'Acme Corp',
              created_at: '2026-09-15T10:00:00Z',
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${key}`);
    });

    renderOrder();
    await waitFor(() => {
      expect(screen.getByTestId('order-history')).toBeTruthy();
    });
    const history = screen.getByTestId('order-history');
    expect(within(history).getByText('Acme Corp')).toBeTruthy();
    expect(within(history).getByText('Starter')).toBeTruthy();
  });
});
