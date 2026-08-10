import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EngagementsPage } from '../src/pages/EngagementsPage';

/**
 * Feature 8 — the engagement pipeline as a light kanban. It exists so ops can
 * see where work is piling up, so the tests are about which column an
 * engagement lands in and whether it reads as past SLA.
 */

const STAGES = [
  { key: 'intake', label: 'Intake' },
  { key: 'analysis', label: 'Analysis' },
  { key: 'review', label: 'Review' },
  { key: 'delivered', label: 'Delivered', terminal: true },
];

const onTrack = {
  valuation_id: '01N409VAL00000000000000AAA',
  company_name: 'Acme Robotics',
  kind: '409a',
  valuation_state: 'started',
  current_stage: 'intake',
  analyst_email: 'ana@n409.example',
  stage_entered_at: '2026-07-01T09:00:00Z',
  sla: {
    label: 'Intake',
    elapsedHours: 6,
    expectedHours: 24,
    overdue: false,
    level: 'green' as const,
  },
};

const late = {
  valuation_id: '01N409VAL00000000000000BBB',
  company_name: 'Behind Industries',
  kind: 'fmv',
  valuation_state: 'started',
  current_stage: 'analysis',
  analyst_email: null,
  stage_entered_at: '2026-06-20T09:00:00Z',
  sla: {
    label: 'Analysis',
    elapsedHours: 200,
    expectedHours: 72,
    overdue: true,
    level: 'red' as const,
  },
};

const stale = {
  ...onTrack,
  valuation_id: '01N409VAL00000000000000CCC',
  company_name: 'Slow Motion Co',
  sla: { ...onTrack.sla, elapsedHours: 72, level: 'yellow' as const },
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const mockApi = (engagements: unknown[], stages = STAGES) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ engagements, stages }));

const renderPage = () =>
  render(
    <MemoryRouter>
      <EngagementsPage />
    </MemoryRouter>,
  );

/** The kanban column with the given heading, including its card list. */
const column = (label: string) => screen.getByRole('heading', { name: label, level: 2 }).closest('div')!
  .parentElement!;

describe('EngagementsPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('counts the active engagements and how many are past SLA', async () => {
    mockApi([onTrack, late, stale]);
    renderPage();
    expect(await screen.findByText('3 active · 1 past SLA')).toBeInTheDocument();
  });

  it('files each engagement under its current stage', async () => {
    mockApi([onTrack, late]);
    renderPage();

    await screen.findByText('Acme Robotics');
    expect(within(column('Intake')).getByText('Acme Robotics')).toBeInTheDocument();
    expect(within(column('Analysis')).getByText('Behind Industries')).toBeInTheDocument();
    expect(within(column('Intake')).queryByText('Behind Industries')).not.toBeInTheDocument();
  });

  it('drops terminal stages — the pipeline is about work still in flight', async () => {
    mockApi([onTrack]);
    renderPage();

    await screen.findByText('Acme Robotics');
    expect(screen.getByRole('heading', { name: 'Intake', level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Delivered', level: 2 })).not.toBeInTheDocument();
  });

  it('shows a per-column count, including zero', async () => {
    mockApi([onTrack, stale]);
    renderPage();

    await screen.findByText('Acme Robotics');
    expect(within(column('Intake')).getByText('2')).toBeInTheDocument();
    expect(within(column('Review')).getByText('0')).toBeInTheDocument();
    expect(within(column('Review')).getByText('—')).toBeInTheDocument();
  });

  it('replaces the elapsed time with "Overdue" once the SLA is blown', async () => {
    mockApi([onTrack, late]);
    renderPage();

    await screen.findByText('Behind Industries');
    expect(within(column('Analysis')).getByText('Overdue')).toBeInTheDocument();
    // On track, the badge reports how long it has been sitting there instead.
    expect(within(column('Intake')).getByText('6h')).toBeInTheDocument();
  });

  it('switches from hours to days once a stage has run for two days', async () => {
    mockApi([stale]);
    renderPage();
    // 72 elapsed hours reads as 3d, not 72h.
    expect(await screen.findByText('3d')).toBeInTheDocument();
  });

  it('names the analyst, or says the engagement has none', async () => {
    mockApi([onTrack, late]);
    renderPage();

    expect(await screen.findByText('ana@n409.example')).toBeInTheDocument();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
  });

  it('links each card to that valuation’s engagement tab', async () => {
    mockApi([onTrack]);
    renderPage();

    const link = await screen.findByRole('link', { name: /Acme Robotics/ });
    expect(link).toHaveAttribute('href', `/valuations/${onTrack.valuation_id}/engagement`);
  });

  it('shows the empty state rather than a row of empty columns', async () => {
    mockApi([]);
    renderPage();

    expect(await screen.findByText('No active engagements')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Intake', level: 2 })).not.toBeInTheDocument();
  });

  it('surfaces a load failure instead of spinning forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the engagement pipeline.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
