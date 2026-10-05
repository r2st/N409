import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FundingHistory } from '../src/components/FundingHistory';
import type { FundingRound, ValuationTransaction } from '../src/lib/types';

/**
 * Funding rounds and share transactions for one valuation.
 *
 * This is the evidence a 409A's backsolve rests on: the price of the last round
 * and the prices at which shares have actually changed hands. So what the tests
 * hold the panel to is the arithmetic at the boundary and the honesty of an
 * unrecorded field:
 *
 *   * dollars typed become integer cents — a rounding slip here is a mispriced
 *     round, and floating-point cents are how that happens;
 *   * a field left blank is sent as null, never as zero. "Raised $0" and "we
 *     did not record what was raised" are different claims about a company;
 *   * a read-only viewer is offered no way to change any of it.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const round = (over: Partial<FundingRound> = {}): FundingRound => ({
  id: 'round-1',
  name: 'Series A',
  security_type: 'Series A Preferred',
  closed_on: '2025-03-14',
  amount_raised_cents: '1200000000',
  pre_money_cents: '3000000000',
  post_money_cents: '4200000000',
  shares_issued: '4000000',
  notes: null,
  ...over,
});

const txn = (over: Partial<ValuationTransaction> = {}): ValuationTransaction => ({
  id: 'txn-1',
  kind: 'secondary_sale',
  occurred_on: '2026-01-20',
  shares: '25000',
  price_per_share_cents: '274',
  counterparty: 'Founder to Fund II',
  notes: null,
  ...over,
});

interface Call {
  path: string;
  method: string;
  body: unknown;
}

function mockApi(
  state: { rounds?: FundingRound[]; transactions?: ValuationTransaction[] },
  opts: { loadStatus?: number; loadDetail?: string; writeStatus?: number; writeDetailless?: boolean } = {},
) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (method === 'GET') {
      if (opts.loadStatus) {
        const body = opts.loadDetail !== undefined
          ? { status: opts.loadStatus, detail: opts.loadDetail }
          : { status: opts.loadStatus, title: 'Internal Server Error' };
        return jsonResponse(body, opts.loadStatus);
      }
      if (path.endsWith('/rounds')) return jsonResponse({ rounds: state.rounds ?? [] });
      return jsonResponse({ transactions: state.transactions ?? [] });
    }
    if (opts.writeStatus) {
      // A body with no `detail` is the case the operation half exists for:
      // `describeActionFailure` prefers the server's own sentence wherever
      // there is one, and this is what `registerProblemHandler` sends when a
      // route threw — a reason phrase and nothing about the request.
      if (opts.writeDetailless) {
        return jsonResponse({ status: opts.writeStatus, title: 'Internal Server Error' }, opts.writeStatus);
      }
      return jsonResponse({ status: opts.writeStatus, detail: 'Refused by the server.' }, opts.writeStatus);
    }
    return jsonResponse({ ok: true }, method === 'POST' ? 201 : 200);
  });
  return calls;
}

const renderHistory = (canEdit = true) =>
  render(<FundingHistory valuationId="val-1" currency="USD" canEdit={canEdit} />);

const bodyOf = (calls: Call[], suffix: string) =>
  calls.find((c) => c.method === 'POST' && c.path.endsWith(suffix))?.body as Record<string, unknown>;

describe('FundingHistory', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('says the history is empty rather than showing bare headings', async () => {
    mockApi({});
    renderHistory();

    await screen.findByText('No funding rounds recorded.');
    expect(screen.getByText('No transactions recorded.')).toBeInTheDocument();
  });

  it('reports a load failure instead of an empty history that looks recorded', async () => {
    // An empty table and a table that failed to load look identical, and one of
    // them means the backsolve has no evidence behind it.
    mockApi({}, { loadStatus: 500 });
    renderHistory();

    await screen.findByText(/Could not load funding history/);
    expect(screen.queryByText('No funding rounds recorded.')).not.toBeInTheDocument();
  });

  it('surfaces the server detail on a load failure instead of the generic fallback', async () => {
    mockApi({}, { loadStatus: 403, loadDetail: 'You do not have access to this valuation.' });
    renderHistory();

    await screen.findByText('You do not have access to this valuation.');
  });

  it('lists a round with its money formatted in the valuation’s currency', async () => {
    mockApi({ rounds: [round()] });
    renderHistory();

    const row = (await screen.findByText('Series A')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Series A Preferred')).toBeInTheDocument();
    expect(within(row).getByText('$12,000,000.00')).toBeInTheDocument();
    expect(within(row).getByText('$30,000,000.00')).toBeInTheDocument();
    expect(within(row).getByText('$42,000,000.00')).toBeInTheDocument();
  });

  it('converts dollars to whole cents when a round is added', async () => {
    const calls = mockApi({});
    renderHistory();
    await screen.findByText('No funding rounds recorded.');

    await userEvent.click(screen.getByRole('button', { name: '+ Add round' }));
    await userEvent.type(screen.getByLabelText('Round name'), 'Series B');
    await userEvent.type(screen.getByLabelText('Security type'), 'Preferred');
    await userEvent.type(screen.getByLabelText('Amount raised ($)'), '1234567.89');
    await userEvent.type(screen.getByLabelText('Pre-money ($)'), '0.07');
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    await waitFor(() => expect(bodyOf(calls, '/rounds')).toBeDefined());
    // 1234567.89 * 100 in binary floating point is 123456788.99999999.
    // Truncating would lose a cent on every round entered.
    expect(bodyOf(calls, '/rounds')).toEqual({
      name: 'Series B',
      security_type: 'Preferred',
      closed_on: null,
      amount_raised_cents: 123456789,
      pre_money_cents: 7,
      post_money_cents: null,
    });
  });

  it('sends null, not zero, for the amounts nobody recorded', async () => {
    const calls = mockApi({});
    renderHistory();
    await screen.findByText('No funding rounds recorded.');

    await userEvent.click(screen.getByRole('button', { name: '+ Add round' }));
    await userEvent.type(screen.getByLabelText('Round name'), '  Seed  ');
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    await waitFor(() => expect(bodyOf(calls, '/rounds')).toBeDefined());
    expect(bodyOf(calls, '/rounds')).toEqual({
      name: 'Seed',
      security_type: null,
      closed_on: null,
      amount_raised_cents: null,
      pre_money_cents: null,
      post_money_cents: null,
    });
  });

  it('closes and clears the round form after a save', async () => {
    mockApi({});
    renderHistory();
    await screen.findByText('No funding rounds recorded.');

    await userEvent.click(screen.getByRole('button', { name: '+ Add round' }));
    await userEvent.type(screen.getByLabelText('Round name'), 'Series C');
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    await waitFor(() => expect(screen.queryByLabelText('Round name')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: '+ Add round' }));
    expect(screen.getByLabelText('Round name')).toHaveValue('');
  });

  it('keeps the round form open, with its values, when the save is refused', async () => {
    mockApi({}, { writeStatus: 422 });
    renderHistory();
    await screen.findByText('No funding rounds recorded.');

    await userEvent.click(screen.getByRole('button', { name: '+ Add round' }));
    await userEvent.type(screen.getByLabelText('Round name'), 'Series D');
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    await screen.findByText('Refused by the server.');
    expect(screen.getByLabelText('Round name')).toHaveValue('Series D');
  });

  it('will not submit a round with no name, and says which box is empty', async () => {
    // R29 — the button used to be disabled until a name was typed, which
    // refused the submit without ever saying why. It is now live, and the
    // refusal comes with a message attached to the box it is about.
    const calls = mockApi({});
    renderHistory();
    await screen.findByText('No funding rounds recorded.');

    await userEvent.click(screen.getByRole('button', { name: '+ Add round' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    expect(await screen.findByText('Round name is required.')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('treats a whitespace-only round name as no name at all', async () => {
    const calls = mockApi({});
    renderHistory();
    await screen.findByText('No funding rounds recorded.');

    await userEvent.click(screen.getByRole('button', { name: '+ Add round' }));
    await userEvent.type(screen.getByLabelText('Round name'), '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    expect(await screen.findByText('Round name is required.')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('refuses a negative amount rather than storing negative cents', async () => {
    // `toCents` has no floor of its own — it would turn "-5" into -500 and the
    // API would take it. The min="0" on the control was the only guard, and
    // that stopped applying when the form took validation over.
    const calls = mockApi({});
    renderHistory();
    await screen.findByText('No funding rounds recorded.');

    await userEvent.click(screen.getByRole('button', { name: '+ Add round' }));
    await userEvent.type(screen.getByLabelText('Round name'), 'Series D');
    await userEvent.type(screen.getByLabelText('Amount raised ($)'), '-5');
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    expect(await screen.findByText('Amount raised must be at least 0.')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('leaves the optional money boxes alone when they are blank', async () => {
    // The floor applies only to a box that has something in it — otherwise
    // "optional" would have quietly become "required at zero".
    const calls = mockApi({});
    renderHistory();
    await screen.findByText('No funding rounds recorded.');

    await userEvent.click(screen.getByRole('button', { name: '+ Add round' }));
    await userEvent.type(screen.getByLabelText('Round name'), 'Series D');
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      name: 'Series D',
      amount_raised_cents: null,
      pre_money_cents: null,
      post_money_cents: null,
    });
  });

  it('abandons the round form on cancel', async () => {
    mockApi({});
    renderHistory();
    await screen.findByText('No funding rounds recorded.');

    await userEvent.click(screen.getByRole('button', { name: '+ Add round' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Round name')).not.toBeInTheDocument();
  });

  it('removes a round', async () => {
    const calls = mockApi({ rounds: [round()] });
    renderHistory();

    const row = (await screen.findByText('Series A')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/rounds/round-1'))).toBe(true),
    );
  });

  it('reports a removal the server refused', async () => {
    mockApi({ rounds: [round()] }, { writeStatus: 409 });
    renderHistory();

    const row = (await screen.findByText('Series A')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }));

    await screen.findByText('Refused by the server.');
  });

  it('lists a transaction with its kind spelled out and its price per share', async () => {
    mockApi({ transactions: [txn()] });
    renderHistory();

    const row = (await screen.findByText('Secondary sale')).closest('tr') as HTMLElement;
    expect(within(row).getByText('25,000')).toBeInTheDocument();
    expect(within(row).getByText('$2.74')).toBeInTheDocument();
    expect(within(row).getByText('Founder to Fund II')).toBeInTheDocument();
  });

  it('shows a dash for a transaction with no counterparty on record', async () => {
    mockApi({ transactions: [txn({ counterparty: null, kind: 'conversion' })] });
    renderHistory();

    const row = (await screen.findByText('Conversion')).closest('tr') as HTMLElement;
    expect(within(row).getByText('—')).toBeInTheDocument();
  });

  it('sends a whole share count and a price rounded to the cent', async () => {
    const calls = mockApi({});
    renderHistory();
    await screen.findByText('No transactions recorded.');

    await userEvent.click(screen.getByRole('button', { name: '+ Add transaction' }));
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'repurchase');
    await userEvent.type(screen.getByLabelText('Date'), '2026-02-01');
    await userEvent.type(screen.getByLabelText('Shares'), '1001');
    // A half-cent price is legitimate — sub-cent per-share prices are common on
    // early common — and it must not silently truncate downward.
    await userEvent.type(screen.getByLabelText('Price / share ($)'), '2.745');
    await userEvent.type(screen.getByLabelText('Counterparty'), '  Acme Inc.  ');
    await userEvent.click(screen.getByRole('button', { name: 'Add transaction' }));

    await waitFor(() => expect(bodyOf(calls, '/transactions')).toBeDefined());
    expect(bodyOf(calls, '/transactions')).toEqual({
      kind: 'repurchase',
      occurred_on: '2026-02-01',
      shares: 1001,
      price_per_share_cents: 275,
      counterparty: 'Acme Inc.',
    });
  });

  it('refuses a fractional share count at the field, before it can be rounded away', async () => {
    // Shares are integers; the input's step is what stops 1000.6 becoming a
    // silently-rounded 1001 in the transaction record.
    const calls = mockApi({});
    renderHistory();
    await screen.findByText('No transactions recorded.');

    await userEvent.click(screen.getByRole('button', { name: '+ Add transaction' }));
    await userEvent.type(screen.getByLabelText('Date'), '2026-02-01');
    await userEvent.type(screen.getByLabelText('Shares'), '1000.6');
    await userEvent.click(screen.getByRole('button', { name: 'Add transaction' }));

    expect(screen.getByLabelText('Shares')).toBeInvalid();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('sends null for a transaction’s unrecorded share count, price and counterparty', async () => {
    const calls = mockApi({});
    renderHistory();
    await screen.findByText('No transactions recorded.');

    await userEvent.click(screen.getByRole('button', { name: '+ Add transaction' }));
    await userEvent.type(screen.getByLabelText('Date'), '2026-03-01');
    await userEvent.click(screen.getByRole('button', { name: 'Add transaction' }));

    await waitFor(() => expect(bodyOf(calls, '/transactions')).toBeDefined());
    expect(bodyOf(calls, '/transactions')).toEqual({
      kind: 'issuance',
      occurred_on: '2026-03-01',
      shares: null,
      price_per_share_cents: null,
      counterparty: null,
    });
  });

  it('will not submit a transaction with no date', async () => {
    // Without a date a transaction cannot be placed relative to the valuation
    // date, which is the only thing that makes it evidence.
    const calls = mockApi({});
    renderHistory();
    await screen.findByText('No transactions recorded.');

    await userEvent.click(screen.getByRole('button', { name: '+ Add transaction' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add transaction' }));

    expect(await screen.findByText('Date is required.')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('refuses a fractional share count on a transaction', async () => {
    // step="1" said so, and `Math.round` in the submit body would otherwise
    // have silently rounded 25000.5 shares to 25001 without telling anyone.
    const calls = mockApi({});
    renderHistory();
    await screen.findByText('No transactions recorded.');

    await userEvent.click(screen.getByRole('button', { name: '+ Add transaction' }));
    await userEvent.type(screen.getByLabelText('Date'), '2026-01-20');
    await userEvent.type(screen.getByLabelText('Shares'), '25000.5');
    await userEvent.click(screen.getByRole('button', { name: 'Add transaction' }));

    expect(await screen.findByText('Shares must be a whole number.')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('offers every transaction kind the API accepts', async () => {
    mockApi({});
    renderHistory();
    await screen.findByText('No transactions recorded.');

    await userEvent.click(screen.getByRole('button', { name: '+ Add transaction' }));
    expect(
      within(screen.getByLabelText('Type'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Issuance', 'Secondary sale', 'Repurchase', 'Conversion', 'Transfer', 'Other']);
  });

  it('removes a transaction', async () => {
    const calls = mockApi({ transactions: [txn()] });
    renderHistory();

    const row = (await screen.findByText('Secondary sale')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/transactions/txn-1'))).toBe(true),
    );
  });

  /*
   * The four writes on this panel shared one wrapper and one message, "Could
   * not save." — vague for the two adds and wrong for the two removes: nothing
   * was being saved, and a reader told a save failed goes back to the form
   * they had just filled in rather than to the row that is still there.
   */
  it('says a failed removal was a removal, not a failed save', async () => {
    mockApi({ rounds: [round()] }, { writeStatus: 500, writeDetailless: true });
    renderHistory();

    const row = (await screen.findByText('Series A')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }));

    const message = await screen.findByText(/Could not remove that funding round\./);
    // The second half is still `describeRequestFailure` — the operation names
    // what was asked, not what went wrong.
    expect(message).toHaveTextContent('500');
    expect(message).not.toHaveTextContent(/Could not save/);
  });

  it('names the transaction it could not remove', async () => {
    mockApi({ transactions: [txn()] }, { writeStatus: 500, writeDetailless: true });
    renderHistory();

    const row = (await screen.findByText('Secondary sale')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }));

    await screen.findByText(/Could not remove that secondary transaction\./);
  });

  it('shows a read-only viewer the history and no way to change it', async () => {
    mockApi({ rounds: [round()], transactions: [txn()] });
    renderHistory(false);

    await screen.findByText('Series A');
    expect(screen.getByText('Secondary sale')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add round' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add transaction' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });
});
