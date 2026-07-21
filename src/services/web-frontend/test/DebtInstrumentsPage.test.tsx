import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { DebtInstrumentsPage } from '../src/pages/DebtInstrumentsPage';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function instrument(instrument_type: string) {
  return { id: 'i1', name: 'Note A', instrument_type, currency: 'USD', params: {} };
}

function mockApi(instrument_type: string) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    if (/\/debt\/instruments\/[^/]+$/.test(path)) {
      return jsonResponse({ instrument: instrument(instrument_type), credit_terms: null, valuations: [] });
    }
    return jsonResponse({ instruments: [instrument(instrument_type)] });
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <DebtInstrumentsPage />
    </MemoryRouter>,
  );
}

describe('DebtInstrumentsPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders a contextual HelpIcon that opens the debt-valuation article', async () => {
    mockApi('bond');
    const user = userEvent.setup();
    renderPage();

    const help = await screen.findByRole('button', { name: /Help: Debt valuation engine/ });
    await user.click(help);
    await screen.findByRole('dialog', { name: /Debt valuation engine/ });
    expect(screen.getByRole('link', { name: /Open in Help Center/ })).toHaveAttribute(
      'href',
      '/help/debt-valuation-overview',
    );
  });

  it('explains yield to maturity on a bond', async () => {
    mockApi('bond');
    const user = userEvent.setup();
    renderPage();
    const tip = await screen.findByRole('button', { name: 'About Market yield' });
    await user.hover(tip);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/Yield to maturity/);
  });

  it('explains the conversion ratio and credit spread on a convertible', async () => {
    mockApi('convertible');
    renderPage();
    expect(await screen.findByRole('button', { name: 'About Conversion ratio' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About Credit spread' })).toBeInTheDocument();
  });

  it('explains the cap amount and discount rate on a SAFE', async () => {
    mockApi('safe');
    const user = userEvent.setup();
    renderPage();

    const cap = await screen.findByRole('button', { name: 'About Valuation cap' });
    await user.hover(cap);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/cap amount/);
    expect(screen.getByRole('button', { name: 'About Discount' })).toBeInTheDocument();
  });
});
