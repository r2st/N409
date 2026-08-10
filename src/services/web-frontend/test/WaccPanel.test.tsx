import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WaccPanel } from '../src/components/valuation/WaccPanel';

/**
 * The discount-rate build-up feeds the DCF and prints as Appendix I, and the
 * panel is the only way to enter it. It had no tests at all.
 *
 * The thing most worth pinning here is the unit boundary. Every premium and
 * rate is *typed* as a percentage and *stored* as a fraction, so the panel
 * divides by 100 on the way out and multiplies by 100 on the way back in. A
 * regression in either direction is silent — a discount rate 100× off still
 * renders as a plausible-looking number in a field, and the engine will
 * happily discount a forecast at 2,100%. Nothing else in the stack re-checks
 * it, so these tests are the check.
 *
 * The second is that preview reads the *stored* build-up rather than the form,
 * which the component documents as deliberate. A preview showing a rate the
 * next calculation would not reproduce is worse than no preview, so the
 * request body must stay empty even with a dirty form.
 */

const VALUATION_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A stored build-up exercising every field, including the optional ones. */
const STORED_INPUTS = {
  comparable_betas: [
    { ticker: 'AAA', beta: 1.2, debt_to_equity: 0.25 },
    // No ticker and no gearing: both are optional to the engine, so the row
    // must survive a round trip with those cells blank.
    { beta: 0.9 },
  ],
  unlevered_beta_input: 1.05,
  target_debt_to_equity: 0.3,
  market_cap: 50_000_000,
  tax_rate: 0.21,
  equity_risk_premium: 0.055,
  forecast_horizon_years: 5,
  risk_free_rate_override: 0.0425,
  company_specific_premium: 0.03,
  cost_of_debt: 0.08,
};

const RESULT = {
  wacc: 0.1834,
  cost_of_equity: 0.1955,
  cost_of_debt: 0.08,
  after_tax_cost_of_debt: 0.0632,
  capm: {
    risk_free_rate: 0.0425,
    beta_unlevered: 1.0512,
    beta_relevered: 1.2438,
    equity_risk_premium: 0.055,
    size_premium: 0.0673,
    size_tier: '10th decile',
    company_specific_premium: 0.03,
  },
  weights: { equity: 0.85, debt: 0.15 },
  tax_rate: 0.21,
  comparables: [],
};

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

/**
 * Records every request and answers the three endpoints the panel uses.
 * Handlers are per-endpoint overrides so a test states only what it varies;
 * anything else resolves with a benign default rather than rejecting.
 */
function mockApi(
  opts: {
    params?: () => Response;
    patch?: () => Response;
    preview?: () => Response;
  } = {},
): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({
        url,
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (/\/wacc\/preview$/.test(url)) {
        return opts.preview
          ? opts.preview()
          : json({ wacc: RESULT, applied_on_next_run: true });
      }
      if (/\/params$/.test(url) && method === 'PATCH') return opts.patch ? opts.patch() : json({});
      if (/\/params$/.test(url)) {
        return opts.params ? opts.params() : json({ params: { wacc_inputs: null, auto_wacc: false } });
      }
      return json({});
    },
  );
  return calls;
}

const stored = (wacc_inputs: unknown, auto_wacc = false) => () =>
  json({ params: { wacc_inputs, auto_wacc } });

const problem = (status: number, detail: string) => () =>
  json({ status, title: 'Error', detail }, status);

/** The body of the last PATCH, which is the build-up as it would be stored. */
function savedInputs(calls: Call[]): Record<string, unknown> | null {
  const patches = calls.filter((c) => c.method === 'PATCH');
  expect(patches.length).toBeGreaterThan(0);
  return patches[patches.length - 1]!.body!.wacc_inputs as Record<string, unknown> | null;
}

const renderPanel = (readOnly = false) =>
  render(<WaccPanel valuationId={VALUATION_ID} readOnly={readOnly} />);

/** Resolves once the load has replaced the spinner. */
const ready = () => screen.findByText('Discount rate build-up (WACC)');

const betaTable = () => screen.getByRole('table', { name: 'Guideline betas' });
const betaRows = () => within(betaTable()).getAllByRole('row').slice(1); // drop the header
const cells = (row: HTMLElement) => within(row).getAllByRole('textbox') as HTMLInputElement[];

const saveButton = () => screen.getByRole('button', { name: 'Save build-up' });

describe('WaccPanel', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('loading', () => {
    it('shows the panel once the stored build-up arrives', async () => {
      mockApi({ params: stored(STORED_INPUTS) });
      renderPanel();
      expect(await ready()).toBeInTheDocument();
    });

    it('reports a failed load instead of an empty form', async () => {
      // An empty form here would be a lie an analyst could save over the top
      // of, silently discarding a build-up that is still on the engagement.
      mockApi({ params: problem(403, 'You cannot see this valuation.') });
      renderPanel();
      expect(await screen.findByRole('alert')).toHaveTextContent('You cannot see this valuation.');
      expect(screen.queryByRole('table', { name: 'Guideline betas' })).not.toBeInTheDocument();
    });

    it('falls back to its own message when the failure carries none', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
      renderPanel();
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not load the discount-rate build-up.',
      );
    });
  });

  describe('the stored build-up, shown in the form', () => {
    it('shows every rate as the percentage it was typed as, not the stored fraction', async () => {
      // The conversion this pins is the one that cannot be caught by eye: 0.21
      // and 21 are both plausible in a field labelled "Tax rate (%)".
      mockApi({ params: stored(STORED_INPUTS) });
      renderPanel();
      await ready();
      expect(screen.getByLabelText(/^Tax rate/)).toHaveValue('21');
      expect(screen.getByLabelText(/^Equity risk premium/)).toHaveValue('5.5');
      expect(screen.getByLabelText(/^Company-specific premium/)).toHaveValue('3');
      expect(screen.getByLabelText(/^Risk-free rate/)).toHaveValue('4.25');
      // 0.08 * 100 is 8.000000000000002 in binary floating point. The field
      // must show "8" — the rounding that achieves it is not incidental.
      expect(screen.getByLabelText(/^Cost of debt/)).toHaveValue('8');
    });

    it('shows the plain numbers unscaled', async () => {
      mockApi({ params: stored(STORED_INPUTS) });
      renderPanel();
      await ready();
      expect(screen.getByLabelText(/^Unlevered beta/)).toHaveValue('1.05');
      expect(screen.getByLabelText(/^Target debt \/ equity/)).toHaveValue('0.3');
      expect(screen.getByLabelText(/^Market capitalisation/)).toHaveValue('50000000');
      expect(screen.getByLabelText(/^Forecast horizon/)).toHaveValue('5');
    });

    it('lists each guideline beta, leaving the optional cells blank', async () => {
      mockApi({ params: stored(STORED_INPUTS) });
      renderPanel();
      await ready();
      const rows = betaRows();
      expect(rows).toHaveLength(2);
      expect(cells(rows[0]!).map((i) => i.value)).toEqual(['AAA', '1.2', '0.25']);
      expect(cells(rows[1]!).map((i) => i.value)).toEqual(['', '0.9', '']);
    });

    it('offers one blank row when nothing is stored', async () => {
      mockApi({ params: stored(null) });
      renderPanel();
      await ready();
      expect(betaRows()).toHaveLength(1);
      expect(cells(betaRows()[0]!).map((i) => i.value)).toEqual(['', '', '']);
    });

    it('reflects whether the build-up is switched on', async () => {
      mockApi({ params: stored(STORED_INPUTS, true) });
      renderPanel();
      await ready();
      expect(screen.getByTestId('auto-wacc')).toBeChecked();
    });
  });

  describe('editing the guideline set', () => {
    it('adds a row', async () => {
      const user = userEvent.setup();
      mockApi({ params: stored(null) });
      renderPanel();
      await ready();
      await user.click(screen.getByRole('button', { name: '+ Add guideline beta' }));
      expect(betaRows()).toHaveLength(2);
    });

    it('removes the named row rather than the last one', async () => {
      const user = userEvent.setup();
      mockApi({ params: stored(STORED_INPUTS) });
      renderPanel();
      await ready();
      await user.click(within(betaRows()[0]!).getByRole('button', { name: 'Remove' }));
      const rows = betaRows();
      expect(rows).toHaveLength(1);
      expect(cells(rows[0]!)[1]).toHaveValue('0.9');
    });

    it('leaves a blank row behind when the only row is removed', async () => {
      // Removing to zero rows would strand the analyst with no way to enter a
      // beta and no visible control to add one back except the add button.
      const user = userEvent.setup();
      mockApi({ params: stored({ comparable_betas: [{ ticker: 'AAA', beta: 1.2 }] }) });
      renderPanel();
      await ready();
      await user.click(within(betaRows()[0]!).getByRole('button', { name: 'Remove' }));
      expect(betaRows()).toHaveLength(1);
      expect(cells(betaRows()[0]!).map((i) => i.value)).toEqual(['', '', '']);
    });
  });

  describe('saving', () => {
    it('divides every percentage back down to a fraction', async () => {
      const user = userEvent.setup();
      const calls = mockApi({ params: stored(null) });
      renderPanel();
      await ready();
      await user.type(screen.getByLabelText(/^Tax rate/), '21');
      await user.type(screen.getByLabelText(/^Equity risk premium/), '5.5');
      await user.click(saveButton());
      await waitFor(() => expect(savedInputs(calls)).toMatchObject({ tax_rate: 0.21 }));
      expect(savedInputs(calls)).toMatchObject({ tax_rate: 0.21, equity_risk_premium: 0.055 });
    });

    it('omits a blank field rather than saving it as zero', async () => {
      // A zeroed equity risk premium is not the same as an unset one: unset
      // takes the engine's default, zero asserts that equities carry no risk
      // premium at all. The distinction has to survive the form.
      const user = userEvent.setup();
      const calls = mockApi({ params: stored(null) });
      renderPanel();
      await ready();
      await user.type(screen.getByLabelText(/^Tax rate/), '21');
      await user.click(saveButton());
      await waitFor(() => expect(savedInputs(calls)).not.toBeNull());
      const sent = savedInputs(calls)!;
      expect(sent).toHaveProperty('tax_rate');
      expect(sent).not.toHaveProperty('equity_risk_premium');
      expect(sent).not.toHaveProperty('market_cap');
      expect(sent).not.toHaveProperty('cost_of_debt');
    });

    it('drops a row with no beta and trims the ticker', async () => {
      const user = userEvent.setup();
      const calls = mockApi({ params: stored(null) });
      renderPanel();
      await ready();
      // Row 1: a real beta with a padded ticker and no gearing.
      const first = cells(betaRows()[0]!);
      await user.type(first[0]!, '  AAA  ');
      await user.type(first[1]!, '1.2');
      // Row 2: a ticker typed and then abandoned — a blank line, not an input.
      await user.click(screen.getByRole('button', { name: '+ Add guideline beta' }));
      await user.type(cells(betaRows()[1]!)[0]!, 'BBB');
      await user.click(saveButton());
      await waitFor(() => expect(savedInputs(calls)).not.toBeNull());
      expect(savedInputs(calls)!.comparable_betas).toEqual([{ ticker: 'AAA', beta: 1.2 }]);
    });

    it('keeps the gearing when it is given', async () => {
      const user = userEvent.setup();
      const calls = mockApi({ params: stored(null) });
      renderPanel();
      await ready();
      const first = cells(betaRows()[0]!);
      await user.type(first[1]!, '1.2');
      await user.type(first[2]!, '0.25');
      await user.click(saveButton());
      await waitFor(() => expect(savedInputs(calls)).not.toBeNull());
      expect(savedInputs(calls)!.comparable_betas).toEqual([{ beta: 1.2, debt_to_equity: 0.25 }]);
    });

    it('sends null when the whole form is empty', async () => {
      // Null is how the build-up is cleared. An empty object would leave a
      // build-up recorded on the engagement that has nothing in it.
      const user = userEvent.setup();
      const calls = mockApi({ params: stored(null) });
      renderPanel();
      await ready();
      await user.click(saveButton());
      await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
      expect(savedInputs(calls)).toBeNull();
    });

    it('sends the switch alongside the inputs', async () => {
      const user = userEvent.setup();
      const calls = mockApi({ params: stored(null) });
      renderPanel();
      await ready();
      await user.click(screen.getByTestId('auto-wacc'));
      await user.click(saveButton());
      await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
      expect(calls.filter((c) => c.method === 'PATCH').at(-1)!.body).toMatchObject({
        auto_wacc: true,
      });
    });

    it('says the build-up will drive the rate when it is switched on', async () => {
      const user = userEvent.setup();
      mockApi({ params: stored(STORED_INPUTS, true) });
      renderPanel();
      await ready();
      await user.click(saveButton());
      expect(await screen.findByText(/will use it as the DCF discount rate/)).toBeInTheDocument();
    });

    it('says it is only recorded when it is not', async () => {
      const user = userEvent.setup();
      mockApi({ params: stored(STORED_INPUTS, false) });
      renderPanel();
      await ready();
      await user.click(saveButton());
      expect(await screen.findByText(/recorded but not driving the discount rate/)).toBeInTheDocument();
    });

    it('re-reads the stored build-up after saving', async () => {
      // The server is free to normalise what it was sent, so the form should
      // show what was stored rather than what was typed.
      const user = userEvent.setup();
      const calls = mockApi({ params: stored(STORED_INPUTS) });
      renderPanel();
      await ready();
      await user.click(saveButton());
      await waitFor(() =>
        expect(calls.filter((c) => c.method === 'GET' && /\/params$/.test(c.url))).toHaveLength(2),
      );
    });

    it('reports a rejected save and shows no confirmation', async () => {
      const user = userEvent.setup();
      mockApi({
        params: stored(STORED_INPUTS),
        patch: problem(422, 'target_debt_to_equity must not be negative'),
      });
      renderPanel();
      await ready();
      await user.click(saveButton());
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'target_debt_to_equity must not be negative',
      );
      expect(screen.queryByText(/Build-up saved/)).not.toBeInTheDocument();
    });
  });

  describe('preview', () => {
    it('prints the build-up the engine returns', async () => {
      const user = userEvent.setup();
      mockApi({ params: stored(STORED_INPUTS, true) });
      renderPanel();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Preview rate' }));
      await screen.findByText('18.34%');
      const table = screen.getByRole('table', { name: 'Cost of capital build-up' });
      const line = (label: string | RegExp) =>
        within(table).getByText(label).closest('tr') as HTMLElement;
      expect(line('Risk-free rate')).toHaveTextContent('4.25%');
      expect(line('Unlevered beta')).toHaveTextContent('1.0512');
      expect(line('Relevered beta')).toHaveTextContent('1.2438');
      // The tier is named in the label because the premium is meaningless
      // without knowing which decile produced it.
      expect(line(/^Size premium/)).toHaveTextContent('6.73%');
      expect(line('Cost of equity')).toHaveTextContent('19.55%');
      expect(line('Cost of debt, after tax')).toHaveTextContent('6.32%');
      expect(line(/^Weights/)).toHaveTextContent('85.0% / 15.0%');
    });

    it('previews the stored build-up, not the form in front of the analyst', async () => {
      // Documented as deliberate: a preview of unsaved edits would show a rate
      // the next calculation could not reproduce. The request carries no form
      // state at all, so a dirty form cannot leak into it.
      const user = userEvent.setup();
      const calls = mockApi({ params: stored(STORED_INPUTS) });
      renderPanel();
      await ready();
      await user.clear(screen.getByLabelText(/^Tax rate/));
      await user.type(screen.getByLabelText(/^Tax rate/), '99');
      await user.click(screen.getByRole('button', { name: 'Preview rate' }));
      await waitFor(() => expect(calls.some((c) => /wacc\/preview/.test(c.url))).toBe(true));
      const call = calls.find((c) => /wacc\/preview/.test(c.url))!;
      expect(call.method).toBe('POST');
      expect(call.body).toEqual({});
    });

    it('warns that a previewed rate will not be used when the switch is off', async () => {
      const user = userEvent.setup();
      mockApi({
        params: stored(STORED_INPUTS),
        preview: () => json({ wacc: RESULT, applied_on_next_run: false }),
      });
      renderPanel();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Preview rate' }));
      expect(await screen.findByText(/will not reach the discount rate/)).toBeInTheDocument();
    });

    it('stays quiet about that when the build-up is switched on', async () => {
      const user = userEvent.setup();
      mockApi({ params: stored(STORED_INPUTS, true) });
      renderPanel();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Preview rate' }));
      await screen.findByText('18.34%');
      expect(screen.queryByText(/will not reach the discount rate/)).not.toBeInTheDocument();
    });

    it('reports a build that the engine refuses', async () => {
      const user = userEvent.setup();
      mockApi({
        params: stored(STORED_INPUTS),
        preview: problem(422, 'No guideline betas and no unlevered beta.'),
      });
      renderPanel();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Preview rate' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'No guideline betas and no unlevered beta.',
      );
      expect(
        screen.queryByRole('table', { name: 'Cost of capital build-up' }),
      ).not.toBeInTheDocument();
    });
  });

  describe('read-only', () => {
    it('offers nothing that writes', async () => {
      mockApi({ params: stored(STORED_INPUTS) });
      renderPanel(true);
      await ready();
      expect(screen.queryByRole('button', { name: 'Save build-up' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Preview rate' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '+ Add guideline beta' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('auto-wacc')).not.toBeInTheDocument();
    });

    it('still shows the build-up, disabled', async () => {
      // Read-only is a viewer, not a blank page — the reviewer needs to see
      // the inputs that produced the rate in the report.
      mockApi({ params: stored(STORED_INPUTS) });
      renderPanel(true);
      await ready();
      expect(screen.getByLabelText(/^Tax rate/)).toBeDisabled();
      expect(cells(betaRows()[0]!)[1]).toBeDisabled();
      expect(cells(betaRows()[0]!)[1]).toHaveValue('1.2');
    });
  });
});
