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

/** Every write the page made, in order — the engagement link is one. */
interface Sent {
  path: string;
  method: string;
  body: Record<string, unknown>;
}

function mockApi(
  instrument_type: string,
  over: { engagements?: { id: string; company_name: string }[]; valuation_id?: string | null } = {},
) {
  const sent: Sent[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({
        path,
        method,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      });
      return jsonResponse({});
    }
    if (path.includes('/valuations?')) return jsonResponse({ valuations: over.engagements ?? [] });
    if (/\/debt\/instruments\/[^/?]+$/.test(path)) {
      return jsonResponse({
        instrument: { ...instrument(instrument_type), valuation_id: over.valuation_id ?? null },
        credit_terms: null,
        valuations: [],
      });
    }
    return jsonResponse({ instruments: [instrument(instrument_type)] });
  });
  return sent;
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

  /**
   * R30 — the create form asked the browser to check `required` and nothing at
   * all to check the currency, which is posted upper-cased straight into the
   * instrument's currency column.
   */
  it('refuses a nameless instrument, and says which box', async () => {
    const sent = mockApi('bond');
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'New instrument' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
    expect(sent.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('refuses a currency that is not a three-letter code', async () => {
    const sent = mockApi('bond');
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'New instrument' }));
    await user.type(screen.getByLabelText('Name'), 'Note B');
    await user.clear(screen.getByLabelText('Currency'));
    await user.type(screen.getByLabelText('Currency'), 'Dollars');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(
      await screen.findByText('Currency must be a three-letter ISO 4217 code, like USD.'),
    ).toBeInTheDocument();
    expect(sent.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

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

  it('says the credit terms are saving and will not send them twice', async () => {
    // The save is a PUT followed by a reload of the instrument, and rendered
    // nothing in between — so the button read as dead and inviting a re-press,
    // which re-rates the instrument against whatever is in the form now.
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    let writes = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const path = String(url);
      if ((init?.method ?? 'GET') !== 'GET') {
        writes += 1;
        await held;
        return jsonResponse({});
      }
      // The card only exists on a credit_spread instrument.
      if (/\/debt\/instruments\/[^/]+$/.test(path)) {
        return jsonResponse({
          instrument: instrument('credit_spread'),
          credit_terms: null,
          valuations: [],
        });
      }
      return jsonResponse({ instruments: [instrument('credit_spread')] });
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Save credit terms' }));
    const saving = await screen.findByRole('button', { name: 'Saving…' });
    expect(saving).toBeDisabled();
    await user.click(saving);
    expect(writes).toBe(1);

    open();
    await screen.findByRole('button', { name: 'Save credit terms' });
  });

  /**
   * `PUT /debt/instruments/:id/valuation` is what lets `loadDebtReport` find
   * the instrument — it looks it up *by* `valuation_id` and returns null
   * otherwise, so the deliverable renders with no instrument pack in it. The
   * route has existed since 0109 and no client ever called it, so the link
   * could not be made from the product.
   */
  it('links the instrument to a debt engagement', async () => {
    const sent = mockApi('term_loan', { engagements: [{ id: 'V7', company_name: 'Acme Note' }] });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Note A/ }));
    const select = await screen.findByRole('combobox', { name: 'Linked engagement' });
    await user.selectOptions(select, 'V7');

    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('PUT');
    expect(sent[0]!.path).toContain('/debt/instruments/i1/valuation');
    expect(sent[0]!.body).toEqual({ valuation_id: 'V7' });
  });
});
