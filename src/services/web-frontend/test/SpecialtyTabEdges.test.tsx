import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { SpecialtyTab } from '../src/pages/valuation/SpecialtyTab';
import type { Valuation } from '../src/lib/types';

/**
 * The result shapes an engine actually returns, and the two ways the tab can
 * fail. `SpecialtyTab.test.tsx` runs the EMI happy path, whose result is three
 * numbers and a `true`; every other type an engine emits — a string, a
 * schedule, a null, a `false` — went through `ResultValue` untested, as did
 * both catch arms.
 */

const valuation = (kind: string) =>
  ({
    id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
    kind,
    state: 'review',
    company_name: 'Acme',
    user_id: 'u1',
    currency: 'USD',
  }) as unknown as Valuation;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (title: string, status = 422) =>
  new Response(JSON.stringify({ title, status }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

/** An 820 measurement: one of everything `ResultValue` can be handed. */
const FAIR_VALUE = {
  kind: 'fair_value_820',
  supported: true,
  engine: {
    kind: 'fair_value_820',
    label: 'ASC 820 fair value',
    path: '/engine/v1/fair-value-820',
    produces: 'A fair value measurement and its level.',
    runInputs: [],
    hmrcForm: null,
  },
  calculation: { id: 'calc-9', created_at: '2026-07-02T00:00:00Z', engine_version: 'e-2' },
  result: {
    hierarchy_level: 'Level 3',
    concluded_value: 4_250_000,
    is_observable: false,
    unobservable_inputs: { discount_rate: 0.18, exit_multiple: 4.5 },
    comparable_tickers: ['ACME', 'BETA'],
    prior_measurement: null,
  },
  history: [],
};

/** Two run inputs — the plural half of the sentence under the JSON box. */
const PORTFOLIO = {
  kind: 'fund_portfolio',
  supported: true,
  engine: {
    kind: 'fund_portfolio',
    label: 'Fund portfolio valuation',
    path: '/engine/v1/fund-valuation',
    produces: 'NAV and per-position marks.',
    runInputs: [
      { key: 'positions', label: 'Position schedule', hint: 'A list of { name, cost } rows.' },
      { key: 'marks', label: 'Manager marks', hint: 'A list of { name, mark } rows.' },
    ],
    hmrcForm: null,
  },
  calculation: null,
  result: null,
  history: [],
};

function renderTab(kind: string) {
  return render(
    <MemoryRouter initialEntries={['/specialty']}>
      <Routes>
        <Route element={<Outlet context={{ valuation: valuation(kind), reload: async () => {} }} />}>
          <Route path="/specialty" element={<SpecialtyTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('SpecialtyTab — result shapes and failures', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('the result table', () => {
    beforeEach(() => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(FAIR_VALUE));
    });

    it('prints a string field as itself', async () => {
      renderTab('fair_value_820');
      expect(await screen.findByText('Level 3')).toBeInTheDocument();
    });

    it('prints a false as No, in the colour that reads as no', async () => {
      renderTab('fair_value_820');
      const no = await screen.findByText('No');
      expect(no.className).toContain('text-red-700');
    });

    it('lays a nested object out as JSON rather than [object Object]', async () => {
      renderTab('fair_value_820');
      await screen.findByText('Unobservable inputs');
      expect(screen.getByText(/"discount_rate": 0.18/)).toBeInTheDocument();
      expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
    });

    it('lays a list out the same way', async () => {
      renderTab('fair_value_820');
      await screen.findByText('Comparable tickers');
      expect(screen.getByText(/"ACME"/)).toBeInTheDocument();
    });

    it('shows an em dash for a field the engine left null', async () => {
      renderTab('fair_value_820');
      await screen.findByText('Prior measurement');
      expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    });

    it('names the calculation the result came from', async () => {
      renderTab('fair_value_820');
      expect(await screen.findByText(/engine e-2/)).toBeInTheDocument();
    });
  });

  it('says so when the engine returns an empty object rather than showing a blank table', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ ...FAIR_VALUE, result: {} }));
    renderTab('fair_value_820');
    expect(await screen.findByText('The engine returned nothing.')).toBeInTheDocument();
  });

  it('offers the run, and no history section, before anything has been run', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(PORTFOLIO));
    renderTab('fund_portfolio');
    expect(await screen.findByText('No result yet')).toBeInTheDocument();
    expect(screen.queryByText('Run history')).not.toBeInTheDocument();
  });

  /**
   * The sentence under the JSON box is built from the input list, and a
   * two-input engine must not read "Position schedule and Manager marks is
   * analyst work product".
   */
  it('agrees with itself in number when an engine takes two inputs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(PORTFOLIO));
    renderTab('fund_portfolio');
    expect(
      await screen.findByText(/Position schedule and Manager marks are analyst work product/),
    ).toBeInTheDocument();
    expect(screen.getByText(/does not collect them/)).toBeInTheDocument();
    expect(screen.getByText(/refuses without them/)).toBeInTheDocument();
  });

  describe('when the server will not answer', () => {
    it("repeats the API's own words when the tab cannot load", async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        problem('This valuation is not yours to read', 403),
      );
      renderTab('emi');
      expect(await screen.findByText('This valuation is not yours to read')).toBeInTheDocument();
      // The skeleton must not be left running underneath the message.
      expect(screen.queryByLabelText('Loading specialty engine…')).not.toBeInTheDocument();
    });

    it('falls back to its own words when the failure carries none', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        throw new TypeError('Failed to fetch');
      });
      renderTab('emi');
      expect(await screen.findByText('Could not load the specialty engine.')).toBeInTheDocument();
    });

    /**
     * A run that fails leaves the loaded tab in place — the reason belongs
     * beside the button that produced it, not in place of the whole tab, and
     * the button has to come back.
     */
    it('shows a failed run beside the button, with the engine’s reason', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
        (init?.method ?? 'GET') === 'POST'
          ? problem('positions[0].cost must be a positive number')
          : jsonResponse(PORTFOLIO),
      );
      renderTab('fund_portfolio');
      await screen.findByText('Fund portfolio valuation');

      fireEvent.change(screen.getByRole('textbox'), {
        target: { value: '{"positions":[{"name":"A","cost":-1}],"marks":[]}' },
      });
      await userEvent.click(screen.getByRole('button', { name: /run fund portfolio valuation/i }));

      expect(await screen.findByText('positions[0].cost must be a positive number')).toBeInTheDocument();
      expect(screen.getByText('Fund portfolio valuation')).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /run fund portfolio valuation/i })).not.toBeDisabled(),
      );
    });

    it('falls back to its own words when a run fails without a message', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        if ((init?.method ?? 'GET') === 'POST') throw new TypeError('Failed to fetch');
        return jsonResponse(PORTFOLIO);
      });
      renderTab('fund_portfolio');
      await screen.findByText('Fund portfolio valuation');

      await userEvent.click(screen.getByRole('button', { name: /run fund portfolio valuation/i }));
      expect(await screen.findByText('The engine run failed.')).toBeInTheDocument();
    });

    it('clears a rejected-input message once the input is fixed and sent', async () => {
      const bodies: unknown[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        if ((init?.method ?? 'GET') === 'POST') {
          bodies.push(JSON.parse(String(init!.body)));
          return jsonResponse({ calculation: {}, result: {} }, 201);
        }
        return jsonResponse(PORTFOLIO);
      });
      renderTab('fund_portfolio');
      await screen.findByText('Fund portfolio valuation');

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'not json' } });
      await userEvent.click(screen.getByRole('button', { name: /run fund portfolio valuation/i }));
      expect(await screen.findByText(/must be a JSON object/i)).toBeInTheDocument();

      fireEvent.change(screen.getByRole('textbox'), { target: { value: '{"positions":[]}' } });
      await userEvent.click(screen.getByRole('button', { name: /run fund portfolio valuation/i }));

      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(screen.queryByText(/must be a JSON object/i)).not.toBeInTheDocument();
    });

    it('sends an empty inputs object when the box is left blank', async () => {
      const bodies: unknown[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        if ((init?.method ?? 'GET') === 'POST') {
          bodies.push(JSON.parse(String(init!.body)));
          return jsonResponse({ calculation: {}, result: {} }, 201);
        }
        return jsonResponse(PORTFOLIO);
      });
      renderTab('fund_portfolio');
      await screen.findByText('Fund portfolio valuation');

      fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
      await userEvent.click(screen.getByRole('button', { name: /run fund portfolio valuation/i }));

      // Whitespace is not a document: the engine's own defaults apply.
      await waitFor(() => expect(bodies).toEqual([{ inputs: {} }]));
    });
  });
});
