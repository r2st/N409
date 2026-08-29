import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { EngagementTab } from '../src/pages/valuation/EngagementTab';
import type { Valuation } from '../src/lib/types';

const valuation = {
  id: '01JENGAGEMENT000000000001',
  kind: '409a',
  state: 'in_review',
  company_name: 'Acme Robotics',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const STAGES = [
  { key: 'intake', label: 'Intake', slaHours: 24 },
  { key: 'analysis', label: 'Analysis', slaHours: 72 },
  { key: 'review', label: 'Review', slaHours: 48 },
  { key: 'complete', label: 'Complete', slaHours: 0, terminal: true },
];

const VIEW = {
  engagement: {
    current_stage: 'review',
    assigned_analyst_id: 'u-analyst',
    stage_entered_at: '2026-06-29T10:00:00Z',
  },
  sla: {
    stage: 'review',
    label: 'Review',
    expectedHours: 48,
    elapsedHours: 30,
    dueAt: '2026-07-01T10:00:00Z',
    overdue: false,
    level: 'yellow' as const,
  },
  stages: STAGES,
  durations: [
    {
      stage: 'intake',
      label: 'Intake',
      enteredAt: '2026-06-20T10:00:00Z',
      exitedAt: '2026-06-21T04:00:00Z',
      actualHours: 18,
      expectedHours: 24,
      breachedSla: false,
    },
    {
      stage: 'analysis',
      label: 'Analysis',
      enteredAt: '2026-06-21T04:00:00Z',
      exitedAt: '2026-06-29T10:00:00Z',
      actualHours: 198,
      expectedHours: 72,
      breachedSla: true,
    },
    {
      stage: 'review',
      label: 'Review',
      enteredAt: '2026-06-29T10:00:00Z',
      exitedAt: null,
      actualHours: 30,
      expectedHours: 48,
      breachedSla: false,
    },
  ],
  activity: Array.from({ length: 20 }, (_, i) => ({
    id: `act-${i}`,
    type: `stage_advanced_${i}`,
    actor_type: 'user',
    occurred_at: '2026-06-29T10:00:00Z',
  })),
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ status, title: 'Error', detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

function mockApi(view: unknown = VIEW, onWrite?: (path: string, init: RequestInit) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if ((init?.method ?? 'GET') !== 'GET') {
      if (onWrite) return onWrite(String(url), init!);
      return jsonResponse({ ok: true });
    }
    return jsonResponse(view);
  });
}

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/engagement']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/engagement" element={<EngagementTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('EngagementTab', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('leads with the stage, its SLA state and the elapsed time against it', async () => {
    mockApi();
    renderTab();
    await screen.findByText('Stage: Review');
    expect(screen.getByText('Approaching SLA')).toBeInTheDocument();
    // The unit switches at two days, so a 48h SLA reads as "2d".
    expect(screen.getByText(/elapsed/)).toHaveTextContent('30h elapsed / 2d SLA');
  });

  it('says overdue where the SLA has already been missed', async () => {
    mockApi({ ...VIEW, sla: { ...VIEW.sla, overdue: true, level: 'red', elapsedHours: 96 } });
    renderTab();
    await screen.findByText('Overdue');
    // Past two days an hour count stops being readable.
    expect(screen.getByText(/elapsed/)).toHaveTextContent('4d elapsed / 2d SLA');
  });

  it('says on track where it is', async () => {
    mockApi({ ...VIEW, sla: { ...VIEW.sla, level: 'green' } });
    renderTab();
    await screen.findByText('On track');
  });

  it('walks the stepper through the working stages, omitting the terminal one', async () => {
    mockApi();
    renderTab();
    await screen.findByText('Stage: Review');

    const stepper = document.querySelector('ol')!;
    const steps = within(stepper).getAllByRole('listitem');
    expect(steps.map((s) => s.textContent)).toEqual(['Intake', 'Analysis', 'Review']);
    // Done, current, not-yet-reached read as three different things.
    expect(steps[0]!.className).toContain('bond-100');
    expect(steps[2]!.className).toContain('amber');
  });

  it('reports each stage as expected versus actual, calling out a breach', async () => {
    mockApi();
    renderTab();
    await screen.findByText('Stage timing (expected vs actual)');

    const timing = within(screen.getByRole('table'));
    const analysis = timing.getByText('Analysis').closest('tr')!;
    expect(analysis).toHaveTextContent('8d');
    expect(analysis).toHaveTextContent('3d');
    expect(analysis).toHaveTextContent('breached');

    const intake = timing.getByText('Intake').closest('tr')!;
    expect(intake).toHaveTextContent('on time');

    // The stage still running is neither — it has not been judged yet.
    const review = timing.getByText('Review').closest('tr')!;
    expect(review).toHaveTextContent('in progress');
  });

  it('renders a dash where a stage carries no SLA at all', async () => {
    mockApi({
      ...VIEW,
      durations: [{ ...VIEW.durations[0]!, expectedHours: 0, label: 'Triage', stage: 'triage' }],
    });
    renderTab();
    await screen.findByText('Stage timing (expected vs actual)');
    expect(screen.getByText('Triage').closest('tr')!).toHaveTextContent('—');
  });

  it('advances to the next stage without naming one', async () => {
    const writes: Array<{ path: string; body: unknown }> = [];
    mockApi(VIEW, (path, init) => {
      writes.push({ path, body: JSON.parse(String(init.body)) as unknown });
      return jsonResponse({ ok: true });
    });
    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: /Advance to next stage/i }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.path).toContain(`/valuations/${valuation.id}/engagement/advance`);
    // An empty body means "whatever comes next" — the server owns the order.
    expect(writes[0]!.body).toEqual({});
  });

  it('refuses to advance past the terminal stage', async () => {
    mockApi({
      ...VIEW,
      engagement: { ...VIEW.engagement, current_stage: 'complete' },
      sla: { ...VIEW.sla, stage: 'complete', label: 'Complete', level: 'green' },
    });
    renderTab();
    await screen.findByText('Stage: Complete');
    expect(screen.getByRole('button', { name: /Advance to next stage/i })).toBeDisabled();
  });

  it('jumps to a named stage and resets the picker', async () => {
    const writes: Array<{ body: unknown }> = [];
    mockApi(VIEW, (_path, init) => {
      writes.push({ body: JSON.parse(String(init.body)) as unknown });
      return jsonResponse({ ok: true });
    });
    renderTab();
    await screen.findByText('Stage: Review');

    const picker = screen.getByRole('combobox');
    // Nothing to go to until a stage is picked.
    expect(screen.getByRole('button', { name: 'Go' })).toBeDisabled();
    await userEvent.selectOptions(picker, 'intake');
    expect(screen.getByRole('button', { name: 'Go' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toEqual({ stage: 'intake' });
    await waitFor(() => expect(picker).toHaveValue(''));
  });

  it('offers the terminal stage as a jump target even though it cannot be stepped into', async () => {
    mockApi();
    renderTab();
    await screen.findByText('Stage: Review');
    const picker = screen.getByRole('combobox');
    expect(within(picker).getByRole('option', { name: 'Complete' })).toBeInTheDocument();
  });

  it('surfaces a refused advance and keeps the panel', async () => {
    mockApi(VIEW, () => problem(409, 'the QA gate has not been cleared'));
    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: /Advance to next stage/i }));

    await screen.findByText('the QA gate has not been cleared');
    expect(screen.getByText('Stage: Review')).toBeInTheDocument();
  });

  it('caps the activity feed at fifteen entries', async () => {
    mockApi();
    renderTab();
    await screen.findByText('Activity feed');
    // Twenty events arrived; a panel is a summary, not a log viewer.
    expect(screen.getAllByText(/stage advanced/)).toHaveLength(15);
    expect(screen.getByText('stage advanced 0')).toBeInTheDocument();
    expect(screen.queryByText('stage advanced 15')).not.toBeInTheDocument();
  });

  /**
   * The picker offers every stage from every stage, `complete` included, so
   * "back to kickoff" on a delivered engagement is one click away. The server
   * refuses that move unless the caller says it is a reopen; the panel is what
   * says so, and it asks first — reopening puts the engagement back on the
   * pipeline board and restarts the SLA clock.
   */
  describe('reopening a completed engagement', () => {
    const completed = {
      ...VIEW,
      engagement: { ...VIEW.engagement, current_stage: 'complete' },
      sla: { ...VIEW.sla, stage: 'complete', label: 'Complete', level: 'green' as const },
    };

    it('confirms, then names the move as a reopen', async () => {
      const writes: Array<{ body: unknown }> = [];
      mockApi(completed, (_path, init) => {
        writes.push({ body: JSON.parse(String(init.body)) as unknown });
        return jsonResponse({ ok: true });
      });
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      renderTab();
      await screen.findByText('Stage: Complete');

      await userEvent.selectOptions(screen.getByRole('combobox'), 'analysis');
      await userEvent.click(screen.getByRole('button', { name: 'Go' }));

      await waitFor(() => expect(writes).toHaveLength(1));
      expect(confirm).toHaveBeenCalledOnce();
      expect(writes[0]!.body).toEqual({ stage: 'analysis', reopen: true });
    });

    it('sends nothing when the confirmation is declined', async () => {
      const writes: unknown[] = [];
      mockApi(completed, (_path, init) => {
        writes.push(init);
        return jsonResponse({ ok: true });
      });
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      renderTab();
      await screen.findByText('Stage: Complete');

      await userEvent.selectOptions(screen.getByRole('combobox'), 'analysis');
      await userEvent.click(screen.getByRole('button', { name: 'Go' }));

      // Nothing asked for, so nothing sent — and the picker keeps the choice,
      // because the operator has not finished making it.
      await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('analysis'));
      expect(writes).toHaveLength(0);
    });

    it('does not ask, or claim a reopen, for an ordinary move between stages', async () => {
      const writes: Array<{ body: unknown }> = [];
      mockApi(VIEW, (_path, init) => {
        writes.push({ body: JSON.parse(String(init.body)) as unknown });
        return jsonResponse({ ok: true });
      });
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      renderTab();
      await screen.findByText('Stage: Review');

      await userEvent.selectOptions(screen.getByRole('combobox'), 'intake');
      await userEvent.click(screen.getByRole('button', { name: 'Go' }));

      await waitFor(() => expect(writes).toHaveLength(1));
      expect(confirm).not.toHaveBeenCalled();
      expect(writes[0]!.body).toEqual({ stage: 'intake' });
    });
  });

  /**
   * A retired valuation nobody ever opened the panel on has no engagement at
   * all. Opening the panel used to *create* one — the GET called
   * `ensureEngagement` — so this response could not previously arrive.
   */
  it('says so when the engagement was never started, rather than showing a stage', async () => {
    mockApi({ ...VIEW, engagement: null, sla: null, durations: [] });
    renderTab();
    await screen.findByText('No engagement was started');
    expect(screen.queryByText(/^Stage: /)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Advance to next stage/i })).not.toBeInTheDocument();
  });

  it('reports a failed load rather than spinning forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(problem(403, 'the engagement panel is operations-only'));
    renderTab();
    await screen.findByText('the engagement panel is operations-only');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
