import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { PackageTab } from '../src/pages/valuation/PackageTab';
import type { Valuation } from '../src/lib/types';

const valuation = {
  id: '01JPACKAGE00000000000000001',
  kind: '409a',
  state: 'drafted',
  company_name: 'Acme Robotics',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const FULL = {
  valuation: { id: valuation.id },
  company_profile: { legal_name: 'Acme Robotics, Inc.', industry: 'B2B SaaS', employee_count: 42 },
  params: {
    valuation_id: valuation.id,
    updated_at: '2026-07-01T00:00:00Z',
    dlom_method: 'chaffee',
    volatility: null,
    discount_rate: '0.24',
  },
  documents: [
    {
      id: 'd1',
      kind: 'cap_table',
      filename: 'captable.xlsx',
      size_bytes: 20480,
      created_at: '2026-07-01T09:00:00Z',
    },
  ],
  ai_jobs: [
    {
      id: 'j1',
      pipeline: 'extract',
      status: 'succeeded',
      model: 'gpt-oss-120b',
      created_at: '2026-07-01T10:00:00Z',
    },
    {
      id: 'j2',
      pipeline: 'missing_data',
      status: 'failed',
      model: null,
      created_at: '2026-07-01T11:00:00Z',
    },
  ],
  calculations: [
    {
      id: 'c1',
      status: 'succeeded',
      engine_version: 'engine.v9',
      fmv_per_share: '1.2345',
      equity_value: '12000000',
      error: null,
      created_at: '2026-07-02T10:00:00Z',
    },
    {
      id: 'c2',
      status: 'failed',
      engine_version: 'engine.v9',
      fmv_per_share: null,
      equity_value: null,
      error: 'cap table does not balance',
      created_at: '2026-07-02T11:00:00Z',
    },
  ],
  overwrites: [{ id: 'o1', category: 'discounts', field_key: 'dlom', value: '0.22' }],
  report: {
    id: 'r1',
    status: 'draft',
    template_version: '409a.v54',
    current_version: 2,
    versions: [
      { version: 1, created_at: '2026-07-03T10:00:00Z', has_pdf: false },
      { version: 2, created_at: '2026-07-04T10:00:00Z', has_pdf: true },
    ],
  },
  tasks: [{ id: 't1', kind: 'final_review', title: 'Partner sign-off', status: 'open' }],
  funding_rounds: [
    { id: 'f1', name: 'Series A', closed_on: '2025-04-01', amount_raised_cents: 1_200_000_00 },
    { id: 'f2', name: 'Series B', closed_on: null, amount_raised_cents: null },
  ],
  transactions: [{ id: 'x1', kind: 'secondary_sale', occurred_on: '2026-01-15' }],
};

const EMPTY = {
  valuation: { id: valuation.id },
  company_profile: null,
  params: null,
  documents: [],
  ai_jobs: [],
  calculations: [],
  overwrites: [],
  report: null,
  tasks: [],
  funding_rounds: [],
  transactions: [],
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/package']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/package" element={<PackageTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/** The `<details>` block whose summary carries `label`. */
const section = (label: string) => screen.getByText(label).closest('details')!;

describe('PackageTab', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('requests the package for the workspace valuation', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ package: FULL }));
    renderTab();
    await screen.findByText('Company profile');
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(`/api/v1/valuations/${valuation.id}/package`);
  });

  it('reports a failed load instead of spinning forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    renderTab();
    await screen.findByText(/Could not load the valuation package/i);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('counts every section from the payload', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ package: FULL }));
    renderTab();
    await screen.findByText('Company profile');

    expect(section('Documents')).toHaveTextContent('1');
    expect(section('AI runs')).toHaveTextContent('2');
    expect(section('Calculations')).toHaveTextContent('2');
    expect(section('Overwrites')).toHaveTextContent('1');
    // The report count is its version history, not the report itself.
    expect(section('Report')).toHaveTextContent('2');
    expect(section('Review tasks')).toHaveTextContent('1');
    // Rounds and securities transactions share one count.
    expect(section('Funding rounds & transactions')).toHaveTextContent('3');
  });

  it('drops the params that are not methodology choices from the count', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ package: FULL }));
    renderTab();
    await screen.findByText('Company profile');

    // `valuation_id` and `updated_at` are bookkeeping and `volatility` is unset:
    // three of the five keys are not a methodology choice anybody made.
    const params = section('Methodology params');
    expect(within(params).getByText('2')).toBeInTheDocument();
    expect(within(params).getByText('dlom method')).toBeInTheDocument();
    expect(within(params).getByText('discount rate')).toBeInTheDocument();
    expect(within(params).queryByText('valuation id')).not.toBeInTheDocument();
    expect(within(params).queryByText('volatility')).not.toBeInTheDocument();
  });

  it('labels documents by kind with a human size', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ package: FULL }));
    renderTab();
    await screen.findByText('captable.xlsx');
    expect(section('Documents')).toHaveTextContent('Cap table');
    expect(section('Documents')).toHaveTextContent('20.0 KB');
  });

  it('names AI pipelines rather than showing their raw keys', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ package: FULL }));
    renderTab();
    await screen.findByText('Company profile');
    const ai = section('AI runs');
    expect(within(ai).getByText('Data extraction')).toBeInTheDocument();
    expect(within(ai).getByText('Missing data check')).toBeInTheDocument();
    // The model is shown where one was recorded and omitted where it was not.
    expect(ai).toHaveTextContent('gpt-oss-120b');
  });

  it('marks the newest successful calculation as the latest and shows the error on a failed one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ package: FULL }));
    renderTab();
    await screen.findByText('Company profile');

    const calcs = section('Calculations');
    expect(within(calcs).getByText('latest')).toBeInTheDocument();
    // The FMV row carries the badge; the failed row carries its reason instead
    // of a money figure that does not exist.
    const latestRow = within(calcs).getByText('latest').closest('li')!;
    expect(latestRow).toHaveTextContent('$1.2345');
    expect(within(calcs).getByText('cap table does not balance')).toBeInTheDocument();
  });

  it('renders the report template version and flags which versions have a PDF', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ package: FULL }));
    renderTab();
    await screen.findByText('Company profile');

    const report = section('Report');
    expect(report).toHaveTextContent('409a.v54');
    expect(report).toHaveTextContent('current v2');
    expect(within(report).getAllByText('PDF rendered')).toHaveLength(1);
  });

  it('converts the raised amount from cents and tolerates a round with neither figure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ package: FULL }));
    renderTab();
    await screen.findByText('Company profile');

    const rounds = section('Funding rounds & transactions');
    expect(within(rounds).getByText('$1,200,000 raised')).toBeInTheDocument();
    expect(within(rounds).getByText('not closed')).toBeInTheDocument();
    // The transaction kind is de-snaked for reading.
    expect(within(rounds).getByText('secondary sale')).toBeInTheDocument();
  });

  it('links each section to the tab that owns it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ package: FULL }));
    renderTab();
    await screen.findByText('Company profile');

    const base = `/valuations/${valuation.id}`;
    expect(within(section('Documents')).getByRole('link')).toHaveAttribute('href', `${base}/documents`);
    expect(within(section('Calculations')).getByRole('link')).toHaveAttribute('href', `${base}/calculations`);
    // Rounds and transactions have no single owning tab, so no link is offered.
    expect(within(section('Funding rounds & transactions')).queryByRole('link')).toBeNull();
  });

  it('opening a section link does not collapse the section it sits in', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ package: FULL }));
    renderTab();
    await screen.findByText('Company profile');

    // The link lives inside the `<summary>`; without stopPropagation the click
    // would toggle the disclosure on the way to navigating.
    const documents = section('Documents');
    expect(documents).toHaveAttribute('open');
    await userEvent.click(within(documents).getByRole('link'));
    expect(documents).toHaveAttribute('open');
  });

  it('falls back to the engagement company name when no structured profile exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ package: { ...FULL, company_profile: { ...FULL.company_profile, legal_name: null } } }),
    );
    renderTab();
    await screen.findByText('Acme Robotics');
  });

  it('says what is absent rather than showing empty sections', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ package: EMPTY }));
    renderTab();
    await screen.findByText(/No structured profile yet/);

    expect(screen.getByText('No documents uploaded.')).toBeInTheDocument();
    expect(screen.getByText('No params set.')).toBeInTheDocument();
    expect(screen.getByText('No AI pipeline runs.')).toBeInTheDocument();
    expect(screen.getByText('No engine runs.')).toBeInTheDocument();
    expect(screen.getByText('No analyst overrides.')).toBeInTheDocument();
    expect(screen.getByText('No report generated.')).toBeInTheDocument();
    expect(screen.getByText('No review tasks.')).toBeInTheDocument();
    expect(screen.getByText(/No rounds or securities transactions/)).toBeInTheDocument();
  });

  it('honours the engagement currency rather than assuming dollars', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ package: FULL }));
    render(
      <MemoryRouter initialEntries={['/package']}>
        <Routes>
          <Route
            element={
              <Outlet context={{ valuation: { ...valuation, currency: 'GBP' }, reload: async () => {} }} />
            }
          >
            <Route path="/package" element={<PackageTab />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Company profile');
    expect(section('Calculations')).toHaveTextContent('£1.2345');
  });
});
