import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ParamsPanel } from '../src/components/valuation/ParamsPanel';

/**
 * The methodology panel's refusals, its two failure paths, and the values it
 * reads back that no happy-path test writes.
 *
 * The DLOM form toggle is the one that found a bug — see "a blend switched back
 * to a single method".
 */

const PARAMS = {
  valuation_id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  rolling_forward: false,
  inception_date: null,
  fiscal_year_end: null,
  weight_asset: null,
  weight_opm: null,
  weight_income: null,
  weight_market: null,
  dloc: null,
  dloc_method: null,
  control_premium: null,
  dloc_synergy_share: null,
  dloc_statistic: null,
  dlom: null,
  dlom_method: null,
  dlom_methods: null,
  dlom_qualitative: null,
  dlom_statistic: null,
  revenue_status: null,
  development_stage: null,
  exit_timeline: null,
  last_round_date: null,
  last_year_revenue_cents: null,
  ytd_revenue_cents: null,
  runway_months: null,
  market_method: null,
  market_horizon: null,
  asset_method: null,
  allocation_method: 'opm',
  business_overview: null,
  updated_at: '2026-07-01T00:00:00Z',
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Setup {
  params?: Record<string, unknown>;
  engineInputs?: unknown;
  /** Make every PATCH fail: 'problem' carries a title, 'network' carries none. */
  patchFails?: 'problem' | 'network';
}

function mockApi(opts: Setup = {}) {
  const row = { ...PARAMS, ...opts.params };
  const patched: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (init?.method === 'PATCH') {
      patched.push({ url: path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      if (opts.patchFails === 'network') throw new TypeError('Failed to fetch');
      if (opts.patchFails === 'problem')
        return new Response(
          JSON.stringify({
            title: 'Unprocessable Content',
            status: 422,
            detail: 'weight_opm must be at most 1',
          }),
          {
            status: 422,
            headers: { 'content-type': 'application/problem+json' },
          },
        );
      return jsonResponse({ params: row });
    }
    if (path.includes('/engine-inputs')) return jsonResponse({ engine_inputs: opts.engineInputs ?? {} });
    return jsonResponse({ params: row });
  });
  return patched;
}

const renderPanel = (opts: Setup = {}) => {
  const patched = mockApi(opts);
  render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
  return patched;
};

const saveButton = () => screen.getByRole('button', { name: /save methodology/i });
const only = (patched: Array<{ body: Record<string, unknown> }>) => {
  expect(patched).toHaveLength(1);
  return patched[0]!.body;
};

describe('ParamsPanel — edges', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('the DLOM form toggle', () => {
    /**
     * Entering the blend clears `dlom_method` so the two forms stay mutually
     * exclusive (the row's `valuation_params_one_dlom_form` CHECK). Coming back
     * out put nothing back: the single form reappeared empty, nothing blocks a
     * save on an empty method, and the request then carried `dlom_method: null`
     * alongside `dlom_methods: null` — an engagement with no DLOM methodology
     * at all, from a round trip that looks like a no-op.
     */
    it('keeps the method when a blend is switched back to a single method', async () => {
      const patched = renderPanel({ params: { dlom_method: 'longstaff' } });
      await screen.findByTestId('dlom-method');

      await userEvent.click(screen.getByTestId('dlom-form-blend'));
      await userEvent.click(screen.getByTestId('dlom-form-single'));

      expect((screen.getByTestId('dlom-method') as HTMLSelectElement).value).toBe('longstaff');

      await userEvent.click(saveButton());
      await waitFor(() => expect(patched).toHaveLength(1));
      expect(only(patched).dlom_method).toBe('longstaff');
      expect(only(patched).dlom_methods).toBeNull();
    });

    it('leaves a method typed into the single form alone on the way back', async () => {
      renderPanel({ params: { dlom_method: 'longstaff' } });
      await screen.findByTestId('dlom-method');

      await userEvent.click(screen.getByTestId('dlom-form-blend'));
      await userEvent.click(screen.getByTestId('dlom-form-single'));
      await userEvent.selectOptions(screen.getByTestId('dlom-method'), 'ghaidarov');
      await userEvent.click(screen.getByTestId('dlom-form-blend'));
      await userEvent.click(screen.getByTestId('dlom-form-single'));

      expect((screen.getByTestId('dlom-method') as HTMLSelectElement).value).toBe('ghaidarov');
    });

    /** The seed pair must be two distinct methods whichever one is concluded. */
    it('seeds the second leg away from the first when Finnerty is the concluded method', async () => {
      renderPanel({ params: { dlom_method: 'finnerty' } });
      await screen.findByTestId('dlom-method');
      await userEvent.click(screen.getByTestId('dlom-form-blend'));

      const methods = screen.getAllByLabelText(/^Method \d$/) as HTMLSelectElement[];
      expect(methods.map((m) => m.value)).toEqual(['finnerty', 'chaffee']);
    });
  });

  describe('the blend’s own refusals', () => {
    const openBlend = async () => {
      await screen.findByTestId('dlom-method');
      await userEvent.click(screen.getByTestId('dlom-form-blend'));
      await screen.findByTestId('dlom-blend');
    };

    it('refuses a blend of one — that is a single method, not a weighting', async () => {
      const patched = renderPanel();
      await openBlend();
      await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);

      expect(screen.getByText(/A blend needs at least two methods/)).toBeInTheDocument();
      await userEvent.click(saveButton());
      expect(patched).toHaveLength(0);
    });

    it('refuses a leg with no method chosen', async () => {
      const patched = renderPanel();
      await openBlend();
      await userEvent.click(screen.getByTestId('add-dlom-leg'));

      expect(screen.getByText('Every leg needs a method.')).toBeInTheDocument();
      await userEvent.click(saveButton());
      expect(patched).toHaveLength(0);
    });

    /**
     * Checked before the sum, because legs of −0.5 and 1.5 add to exactly one.
     */
    it('refuses a leg weighted outside 0…1 even when the legs sum to one', async () => {
      const patched = renderPanel();
      await openBlend();
      const weights = screen.getAllByLabelText('Weight') as HTMLInputElement[];
      await userEvent.clear(weights[0]!);
      await userEvent.type(weights[0]!, '-0.5');
      await userEvent.clear(weights[1]!);
      await userEvent.type(weights[1]!, '1.5');

      expect(screen.getByText('Every leg needs a weight between 0 and 1.')).toBeInTheDocument();
      await userEvent.click(saveButton());
      expect(patched).toHaveLength(0);
    });

    it('refuses a leg with no weight at all', async () => {
      renderPanel();
      await openBlend();
      const weights = screen.getAllByLabelText('Weight') as HTMLInputElement[];
      await userEvent.clear(weights[0]!);

      expect(screen.getByText('Weight is required.')).toBeInTheDocument();
    });
  });

  describe('when the save will not land', () => {
    it("repeats the API's own refusal", async () => {
      renderPanel({ patchFails: 'problem' });
      await screen.findByTestId('dlom-method');
      await userEvent.click(saveButton());

      expect(await screen.findByText('weight_opm must be at most 1')).toBeInTheDocument();
      expect(screen.queryByText('Methodology saved.')).not.toBeInTheDocument();
    });

    it('falls back to its own words when the failure carries none', async () => {
      renderPanel({ patchFails: 'network' });
      await screen.findByTestId('dlom-method');
      await userEvent.click(saveButton());

      expect(await screen.findByText(/Could not save params\./)).toBeInTheDocument();
      // And the button comes back — a failed save is not a dead end.
      await waitFor(() => expect(saveButton()).not.toBeDisabled());
    });

    /**
     * The cross-field checks have their own always-visible messages and their
     * own disabled button, but the submit handler has to refuse too: a form
     * whose every *field* is individually valid still must not save when the
     * approach weights do not sum to one.
     */
    it('refuses the submit on a cross-field problem, not only the button', async () => {
      const patched = renderPanel({ params: { weight_opm: '0.5' } });
      await screen.findByTestId('dlom-method');

      expect(screen.getByTestId('save-blocked')).toBeInTheDocument();
      await userEvent.click(saveButton());
      expect(patched).toHaveLength(0);
    });
  });

  describe('what it reads back', () => {
    it('treats a row with no allocation method as an OPM, and saves it as one', async () => {
      const patched = renderPanel({ params: { allocation_method: null } });
      await screen.findByTestId('dlom-method');

      await userEvent.click(saveButton());
      await waitFor(() => expect(patched).toHaveLength(1));
      // Not null: the column is what every downstream exhibit reads to know
      // which allocation the report describes.
      expect(only(patched).allocation_method).toBe('opm');
    });

    it('shows nothing for a revenue figure the row cannot express as a number', async () => {
      renderPanel({ params: { last_year_revenue_cents: 'not-a-number', ytd_revenue_cents: null } });
      const field = (await screen.findByTestId('last-year-revenue')) as HTMLInputElement;
      expect(field.value).toBe('');
    });

    it('divides a stored cent figure back into currency units', async () => {
      renderPanel({ params: { last_year_revenue_cents: 123_456 } });
      const field = (await screen.findByTestId('last-year-revenue')) as HTMLInputElement;
      expect(field.value).toBe('1234.56');
    });
  });

  describe('the PWERM scenarios it loads', () => {
    const pwerm = (scenarios: unknown[], hybrid?: unknown) => ({
      params: { allocation_method: 'pwerm' },
      engineInputs: { pwerm: { scenarios }, ...(hybrid ? { hybrid } : {}) },
    });

    it('reads an older scenario stored as an enterprise value', async () => {
      renderPanel(
        pwerm([{ name: 'IPO', probability: 1, enterprise_value: 90_000_000, time_to_exit_years: 3 }]),
      );
      const exit = (await screen.findByLabelText('Scenario 1 exit value')) as HTMLInputElement;
      expect(exit.value).toBe('90000000');
    });

    it('leaves every field of a scenario stored empty empty, rather than showing zeros', async () => {
      renderPanel(pwerm([{}]));
      await screen.findByTestId('pwerm-scenarios');
      for (const label of [
        'Scenario 1 name',
        'Scenario 1 exit value',
        'Scenario 1 probability',
        'Scenario 1 years',
        'Scenario 1 discount rate',
      ]) {
        expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('');
      }
      // A blank probability is not a probability of zero on the page either —
      // the Σ reads 0 and the row is refused for it.
      expect(screen.getByTestId('pwerm-probability-total')).toHaveTextContent('Σp 0.0000');
    });

    /**
     * The grid has no room for a message under each cell, so the row is named
     * in one line beneath it. A stored value that is not a number at all has to
     * reach that line rather than be sent on as a NaN.
     */
    it('names the row and the field when a stored figure is not a number', async () => {
      renderPanel(
        pwerm([{ name: 'IPO', probability: 1, equity_value: 'to be confirmed', time_to_exit_years: 3 }]),
      );
      expect(await screen.findByTestId('scenario-issue')).toHaveTextContent(
        'Scenario 1: exit value must be a number.',
      );
    });

    it('names the bound a stored probability breaks', async () => {
      renderPanel(pwerm([{ name: 'IPO', probability: 1.4, equity_value: 1, time_to_exit_years: 1 }]));
      expect(await screen.findByTestId('scenario-issue')).toHaveTextContent(
        'Scenario 1: probability must be at most 1.',
      );
    });

    it('sends a blank discount rate as null so the engagement default applies', async () => {
      const patched = renderPanel(
        pwerm([{ name: 'IPO', probability: 1, equity_value: 5, time_to_exit_years: 2 }]),
      );
      await screen.findByTestId('pwerm-scenarios');
      await userEvent.click(screen.getByRole('button', { name: /save scenarios/i }));

      await waitFor(() => expect(patched).toHaveLength(1));
      const body = patched[0]!.body as { pwerm: { scenarios: Array<Record<string, unknown>> } };
      expect(body.pwerm.scenarios[0]!.discount_rate).toBeNull();
      expect(patched[0]!.url).toContain('/engine-inputs');
    });

    it('says so when the scenarios cannot be saved', async () => {
      renderPanel({
        ...pwerm([{ name: 'IPO', probability: 1, equity_value: 5, time_to_exit_years: 2 }]),
        patchFails: 'network',
      });
      await screen.findByTestId('pwerm-scenarios');
      await userEvent.click(screen.getByRole('button', { name: /save scenarios/i }));

      expect(await screen.findByText(/Could not save PWERM scenarios\./)).toBeInTheDocument();
    });
  });

  describe('the hybrid weights', () => {
    const hybridSetup = (hybrid: unknown): Setup => ({
      params: { allocation_method: 'hybrid' },
      engineInputs: {
        pwerm: { scenarios: [{ name: 'IPO', probability: 1, equity_value: 5, time_to_exit_years: 2 }] },
        hybrid,
      },
    });

    it('keeps its own defaults when the stored hybrid carries no weights', async () => {
      renderPanel(hybridSetup({ opm_weight: null, pwerm_weight: null }));
      await screen.findByTestId('hybrid-weights');
      const opm = screen.getByLabelText(/OPM weight/i) as HTMLInputElement;
      // Not blanked: a hybrid allocation with a missing weight is not an
      // allocation, and blank would be refused at the field.
      expect(opm.value).not.toBe('');
    });

    it('refuses a hybrid weight outside 0…1, and does not send the scenarios either', async () => {
      const patched = renderPanel(hybridSetup({ opm_weight: 0.4, pwerm_weight: 0.6 }));
      await screen.findByTestId('hybrid-weights');
      const opm = screen.getByLabelText(/OPM weight/i) as HTMLInputElement;
      await userEvent.clear(opm);
      await userEvent.type(opm, '1.4');

      await userEvent.click(screen.getByRole('button', { name: /save scenarios/i }));
      expect(patched).toHaveLength(0);
    });

    /**
     * The message was drawn and the button was not disabled.
     *
     * `hybrid.valid` is the field half — each weight inside [0, 1] — and it was
     * the whole of the gate, so 0.6 and 0.6 are two valid fields and a blend
     * that double-counts a fifth of the equity. `resolve_hybrid_weights`
     * refuses the sum in the engine, so the document stored, the engagement
     * read as configured, and the refusal landed on whoever next pressed
     * Calculate — naming `hybrid.opm_weight` at the far end of a run they did
     * not set up. The two sums either side of this one (approach weights, DLOM
     * legs) have always blocked their own saves.
     */
    it('will not save a blend whose weights do not sum to one', async () => {
      const patched = renderPanel(hybridSetup({ opm_weight: 0.4, pwerm_weight: 0.6 }));
      await screen.findByTestId('hybrid-weights');
      const opm = screen.getByLabelText(/OPM weight/i) as HTMLInputElement;
      await userEvent.clear(opm);
      await userEvent.type(opm, '0.6');

      // Both weights are inside 0…1, so the field-level rules are all happy.
      expect(await screen.findByTestId('hybrid-weight-warning')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /save scenarios/i }));
      expect(patched).toHaveLength(0);
    });

    it('carries both weights alongside the scenarios in one request', async () => {
      const patched = renderPanel(hybridSetup({ opm_weight: 0.4, pwerm_weight: 0.6 }));
      await screen.findByTestId('hybrid-weights');
      await userEvent.click(screen.getByRole('button', { name: /save scenarios/i }));

      await waitFor(() => expect(patched).toHaveLength(1));
      expect(patched[0]!.body.hybrid).toEqual({ opm_weight: 0.4, pwerm_weight: 0.6 });
    });
  });
});
