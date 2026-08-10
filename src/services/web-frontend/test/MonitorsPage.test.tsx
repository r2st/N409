import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MonitorsPage } from '../src/pages/MonitorsPage';

/**
 * Feature 10 — the ops-wide monitoring dashboard. Its job is to make the
 * valuations that have drifted findable, so the tests are about the count that
 * says how many need attention and the triggers that say why.
 */

const green = {
  valuation_id: '01N409VAL00000000000000AAA',
  company_name: 'Steady State Inc',
  kind: '409a',
  last_checked_at: '2026-07-01T09:00:00Z',
  status: 'green' as const,
  triggers: [],
};

const red = {
  valuation_id: '01N409VAL00000000000000BBB',
  company_name: 'Drifted Labs',
  kind: 'fmv',
  last_checked_at: null,
  status: 'red' as const,
  triggers: [
    { type: 'funding_round', level: 'red' as const, message: 'A Series B closed on 2026-06-01.' },
    { type: 'revenue_change', level: 'yellow' as const, message: 'Revenue is up 125% on baseline.' },
    { type: 'time_elapsed', level: 'yellow' as const, message: 'The safe harbour lapses in 18 days.' },
    { type: 'headcount', level: 'yellow' as const, message: 'Headcount doubled since the baseline.' },
  ],
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const mockApi = (monitors: unknown[]) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ monitors }));

const renderPage = () =>
  render(
    <MemoryRouter>
      <MonitorsPage />
    </MemoryRouter>,
  );

describe('MonitorsPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('counts how many monitored valuations need attention', async () => {
    mockApi([green, red, { ...green, valuation_id: 'c', status: 'yellow' as const }]);
    renderPage();

    // Two of the three are off green — that number is the reason to open the page.
    expect(await screen.findByText('3 monitored · 2 need attention')).toBeInTheDocument();
  });

  it('links each row to that valuation’s monitoring tab', async () => {
    mockApi([green, red]);
    renderPage();

    const link = await screen.findByRole('link', { name: /Drifted Labs/ });
    expect(link).toHaveAttribute('href', `/valuations/${red.valuation_id}/monitoring`);
  });

  it('shows the trigger count and the first three messages', async () => {
    mockApi([red]);
    renderPage();

    expect(await screen.findByText('4 triggers')).toBeInTheDocument();
    expect(screen.getByText(`• ${red.triggers[0]!.message}`)).toBeInTheDocument();
    expect(screen.getByText(`• ${red.triggers[2]!.message}`)).toBeInTheDocument();
    // The list is capped at three so a noisy valuation can't push the rest off screen.
    expect(screen.queryByText(`• ${red.triggers[3]!.message}`)).not.toBeInTheDocument();
  });

  it('singularises a lone trigger', async () => {
    mockApi([{ ...red, triggers: [red.triggers[0]] }]);
    renderPage();
    expect(await screen.findByText('1 trigger')).toBeInTheDocument();
  });

  it('says nothing about triggers on a valuation that has none', async () => {
    mockApi([green]);
    renderPage();
    await screen.findByText('Steady State Inc');
    expect(screen.queryByText(/trigger/)).not.toBeInTheDocument();
  });

  it('reports the last check only when there has been one', async () => {
    mockApi([green, red]);
    renderPage();

    await screen.findByText('Drifted Labs');
    expect(screen.getAllByText(/^checked /)).toHaveLength(1);
  });

  it('explains how to populate an empty dashboard', async () => {
    mockApi([]);
    renderPage();

    expect(await screen.findByText('No valuations are being monitored')).toBeInTheDocument();
    expect(screen.getByText('0 monitored · 0 need attention')).toBeInTheDocument();
  });

  it('surfaces a load failure instead of spinning forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load monitored valuations.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
