import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { SpecialtyTab } from '../src/pages/valuation/SpecialtyTab';
import type { Valuation } from '../src/lib/types';

const valuation = (kind: string) =>
  ({
    id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
    kind,
    state: 'review',
    company_name: 'Acme',
    user_id: 'u1',
    currency: 'USD',
  }) as unknown as Valuation;

const EMI_RESPONSE = {
  kind: 'emi',
  supported: true,
  engine: {
    kind: 'emi',
    label: 'EMI option valuation',
    path: '/engine/v1/emi-csop',
    produces: 'Actual and unrestricted market value per share.',
    runInputs: [],
    hmrcForm: 'VAL231',
  },
  calculation: { id: 'calc-1', created_at: '2026-07-01T00:00:00Z', engine_version: 'e-1' },
  result: { amv_per_share: 1.23, umv_per_share: 1.6, qualifies: true },
  history: [
    {
      id: 'calc-1',
      status: 'succeeded',
      engine_version: 'e-1',
      equity_value: '5000000',
      fmv_per_share: '1.23',
      error: null,
      created_at: '2026-07-01T00:00:00Z',
    },
    {
      id: 'calc-0',
      status: 'failed',
      engine_version: 'e-1',
      equity_value: null,
      fmv_per_share: null,
      error: 'gross_assets exceeds the EMI ceiling',
      created_at: '2026-06-30T00:00:00Z',
    },
  ],
};

const PPA_RESPONSE = {
  kind: 'ppa',
  supported: true,
  engine: {
    kind: 'ppa',
    label: 'Purchase price allocation',
    path: '/engine/v1/ppa',
    produces: 'The allocation of consideration.',
    runInputs: [
      {
        key: 'intangibles',
        label: 'Intangible asset schedule',
        hint: 'A list of { name, method, params } rows.',
      },
    ],
    hmrcForm: null,
  },
  calculation: null,
  result: null,
  history: [],
};

const UNSUPPORTED = { kind: '409a', supported: false, engine: null, calculation: null, result: null, history: [] };

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi(get: unknown, onPost?: (init: RequestInit) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if ((init?.method ?? 'GET') === 'POST' && onPost) return onPost(init!);
    return jsonResponse(get);
  });
}

function renderTab(kind = 'emi') {
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

describe('SpecialtyTab', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('names the engine the report type runs and what it produces', async () => {
    mockApi(EMI_RESPONSE);
    renderTab();
    expect(await screen.findByText('EMI option valuation')).toBeInTheDocument();
    expect(screen.getByText('/engine/v1/emi-csop')).toBeInTheDocument();
  });

  it('renders the result fields, booleans included', async () => {
    mockApi(EMI_RESPONSE);
    renderTab();
    expect(await screen.findByText('Amv per share')).toBeInTheDocument();
    // A qualification answer is a Yes/No, not a "true" — the deliverable says
    // whether the scheme qualifies.
    expect(screen.getByText('Yes')).toBeInTheDocument();
  });

  it('offers the HMRC pack only where a form applies', async () => {
    mockApi(EMI_RESPONSE);
    renderTab();
    expect(await screen.findByRole('button', { name: /VAL231/ })).toBeInTheDocument();
  });

  it('does not offer an HMRC pack for a kind with no form', async () => {
    mockApi(PPA_RESPONSE);
    renderTab('ppa');
    await screen.findByText('Purchase price allocation');
    expect(screen.queryByRole('button', { name: /VAL23/ })).not.toBeInTheDocument();
  });

  /**
   * A PPA's intangible schedule is analyst work product the questionnaire never
   * collects, and the assembler refuses without it. Saying so on the form is
   * what stops the operator meeting that refusal as a 422 after the fact.
   */
  it('asks for the run inputs the questionnaire cannot supply', async () => {
    mockApi(PPA_RESPONSE);
    renderTab('ppa');
    expect(await screen.findByText(/Intangible asset schedule/)).toBeInTheDocument();
    expect(screen.getByText(/analyst work product/)).toBeInTheDocument();
  });

  it('rejects malformed run inputs before sending them', async () => {
    const post = vi.fn(() => jsonResponse({}, 201));
    mockApi(PPA_RESPONSE, post);
    renderTab('ppa');
    await screen.findByText('Purchase price allocation');

    // fireEvent, not userEvent.type: `[` and `{` are userEvent key descriptors,
    // and JSON is made of them.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '[1,2,3]' } });
    await userEvent.click(screen.getByRole('button', { name: /run purchase price allocation/i }));

    // Caught here: a bad schedule would come back as a 422 about a missing key,
    // which reads like the questionnaire's fault.
    expect(await screen.findByText(/must be a JSON object/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('sends parsed run inputs on a valid run', async () => {
    let body: unknown;
    mockApi(PPA_RESPONSE, (init) => {
      body = JSON.parse(String(init.body));
      return jsonResponse({ calculation: {}, result: {} }, 201);
    });
    renderTab('ppa');
    await screen.findByText('Purchase price allocation');

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '{"intangibles":[{"name":"Tech","method":"relief_from_royalty"}]}' },
    });
    await userEvent.click(screen.getByRole('button', { name: /run purchase price allocation/i }));
    await waitFor(() =>
      expect(body).toMatchObject({ inputs: { intangibles: [{ name: 'Tech' }] } }),
    );
  });

  it('lists failed runs with the engine’s reason', async () => {
    // The analyst asking "why did nothing happen" is looking for exactly this.
    mockApi(EMI_RESPONSE);
    renderTab();
    expect(await screen.findByText('gross_assets exceeds the EMI ceiling')).toBeInTheDocument();
  });

  it('offers no Run button on a report type with no specialty engine', async () => {
    // A button that 422s teaches the operator the tab is unreliable rather than
    // that the report type is wrong.
    mockApi(UNSUPPORTED);
    renderTab('409a');
    expect(await screen.findByText(/No specialty engine for this report type/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Run/ })).not.toBeInTheDocument();
  });
});
