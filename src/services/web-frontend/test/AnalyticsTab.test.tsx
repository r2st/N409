import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { AnalyticsTab } from '../src/pages/valuation/AnalyticsTab';
import type { Valuation } from '../src/lib/types';

/**
 * Feature 5 — trends across a company's valuation history plus a comparable
 * benchmark. The numbers on this tab get quoted in board decks, so the tests
 * pin the formatting (dollars, percentages, multiples) and the percentile claim
 * as much as they pin the plumbing.
 */

const valuation = {
  id: '01N409VALANALYTICS000000AA',
  kind: '409a',
  state: 'completed',
  company_name: 'Acme Robotics',
} as unknown as Valuation;

const SERIES = [
  {
    as_of: '2025-01-15',
    valuation_number: 'V-1',
    fmv_per_share: 0.84,
    dlom: 0.31,
    volatility: 0.62,
    market_multiple: 4.2,
  },
  {
    as_of: '2026-01-15',
    valuation_number: null,
    fmv_per_share: 1.42,
    dlom: 0.255,
    volatility: null,
    market_multiple: 6.75,
  },
];

const BENCHMARK: {
  count: number;
  min: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  max: number | null;
  company_multiple: number | null;
  percentile: number | null;
} = {
  count: 8,
  min: 2.1,
  p25: 3.4,
  median: 5.5,
  p75: 7.2,
  max: 11.6,
  company_multiple: 6.75,
  percentile: 0.62,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Analytics {
  series: typeof SERIES;
  benchmark: typeof BENCHMARK;
  count: number;
}

function mockApi(analytics: Partial<Analytics> = {}) {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    urls.push(String(url));
    return jsonResponse({
      company_name: 'Acme Robotics',
      analytics: { series: SERIES, benchmark: BENCHMARK, count: SERIES.length, ...analytics },
    });
  });
  return urls;
}

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/analytics']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/analytics" element={<AnalyticsTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('AnalyticsTab', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('loads analytics for the valuation in the workspace', async () => {
    const urls = mockApi();
    renderTab();

    await screen.findByRole('heading', { name: 'Analytics' });
    expect(urls).toEqual([`/api/v1/valuations/${valuation.id}/analytics`]);
  });

  it('announces the load with a skeleton, not a bare spinner', () => {
    mockApi();
    renderTab();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading analytics…');
    expect(status).toHaveAttribute('aria-busy', 'true');
  });

  it('plots the four trends and labels the latest value in each unit', async () => {
    mockApi();
    renderTab();

    await screen.findByRole('heading', { name: 'Analytics' });
    // Each chart renders its title twice — once visibly, once as the caption of
    // the sr-only data table that carries the same series for screen readers.
    for (const title of ['FMV per share', 'DLOM', 'Volatility', 'Revenue multiple']) {
      expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText('$1.42').length).toBeGreaterThan(0);
    expect(screen.getAllByText('25.5%').length).toBeGreaterThan(0);
    // Volatility is null in the latest point, so the last *known* value shows.
    expect(screen.getAllByText('62.0%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('6.8×').length).toBeGreaterThan(0);
  });

  it('counts the valuations behind the trends', async () => {
    mockApi();
    renderTab();
    expect(await screen.findByText(/Trends across 2 valuations of Acme Robotics\./)).toBeInTheDocument();
  });

  it('singularises a company with one valuation', async () => {
    mockApi({ series: [SERIES[0]!], count: 1 });
    renderTab();
    expect(await screen.findByText(/Trends across 1 valuation of Acme Robotics\./)).toBeInTheDocument();
  });

  it('reports the comparable spread as multiples', async () => {
    mockApi();
    renderTab();

    await screen.findByText('Comparable-company benchmark');
    for (const cell of ['2.1×', '3.4×', '5.5×', '7.2×', '11.6×']) {
      expect(screen.getAllByText(cell).length).toBeGreaterThan(0);
    }
  });

  it('places the company against the comparables by percentile', async () => {
    mockApi();
    renderTab();

    const claim = await screen.findByTestId('benchmark-percentile');
    expect(claim).toHaveTextContent("This company's applied multiple of 6.8×");

    expect(claim).toHaveTextContent('sits at the 62nd percentile of the 8 comparables.');
  });

  it('states the multiple without a percentile claim it cannot support', async () => {
    mockApi({ benchmark: { ...BENCHMARK, percentile: null } });
    renderTab();

    const claim = await screen.findByTestId('benchmark-percentile');
    expect(claim).toHaveTextContent("This company's applied multiple of 6.8×");

    expect(claim).not.toHaveTextContent('percentile');
  });

  it('renders an em dash for a missing quartile rather than a zero', async () => {
    mockApi({ benchmark: { ...BENCHMARK, p25: null, p75: null } });
    renderTab();

    await screen.findByText('Comparable-company benchmark');
    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.queryByText('0.0×')).not.toBeInTheDocument();
  });

  it('says why the benchmark is empty instead of showing five dashes', async () => {
    mockApi({ benchmark: { ...BENCHMARK, count: 0 } });
    renderTab();

    expect(
      await screen.findByText(/No comparable multiples in the latest calculation/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('benchmark-percentile')).not.toBeInTheDocument();
  });

  it('explains an empty dashboard before any calculation has completed', async () => {
    mockApi({ series: [], count: 0 });
    renderTab();

    expect(await screen.findByText('No completed valuations yet')).toBeInTheDocument();
    expect(screen.queryByText('FMV per share')).not.toBeInTheDocument();
  });

  it('surfaces a load failure instead of leaving the skeleton up', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load analytics.');
    expect(screen.queryByText('Loading analytics…')).not.toBeInTheDocument();
  });
});
