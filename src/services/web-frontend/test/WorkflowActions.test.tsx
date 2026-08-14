import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkflowActions } from '../src/components/WorkflowActions';
import type { Valuation, ValuationState } from '../src/lib/types';

/**
 * The ops-only workflow controls on the valuation detail page. The button must
 * name the state the *server* will move to — the client mirror of nextState()
 * is the whole point of the component.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const OPTIONS = {
  options: [
    { id: 'r1', email: 'rae@n409.ai', first_name: 'Rae', last_name: 'Okafor' },
    { id: 'r2', email: 'sam@n409.ai', first_name: null, last_name: null },
  ],
};

function valuation(over: Partial<Valuation> = {}): Valuation {
  return {
    id: '01JVAL000000000000000000',
    kind: '409a',
    state: 'review' as ValuationState,
    company_name: 'Acme',
    service_name: null,
    user_id: 'u1',
    partner_id: null,
    source: null,
    currency: 'USD',
    service_countries: null,
    waiting_on_client: false,
    assigned_reviewer_id: null,
    due_date: null,
    delivery_days: null,
    paid_status: 'unpaid',
    qsbs_attestation: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  } as Valuation;
}

interface Call {
  url: string;
  body: unknown;
}

function mockApi(
  calls: Call[],
  opts: { options?: () => Response; workflow?: () => Response } = {},
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.includes('/users/options')) return (opts.options ?? (() => jsonResponse(OPTIONS)))();
    if (u.includes('/workflow/')) {
      calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return (opts.workflow ?? (() => jsonResponse({ ok: true })))();
    }
    throw new Error(`unexpected fetch ${u}`);
  });
}

describe('WorkflowActions', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('names the state the server will actually advance to', async () => {
    mockApi([]);
    render(<WorkflowActions valuation={valuation({ state: 'drafted' })} onChanged={vi.fn()} />);
    expect(
      await screen.findByRole('button', { name: /Advance → Draft accepted/i }),
    ).toBeInTheDocument();
  });

  it('promises "paid", not "review", on a completed valuation that has been paid for', async () => {
    mockApi([]);
    render(
      <WorkflowActions
        valuation={valuation({ state: 'completed', paid_status: 'paid_by_partner' })}
        onChanged={vi.fn()}
      />,
    );
    expect(await screen.findByRole('button', { name: /Advance → Paid/i })).toBeInTheDocument();
  });

  it('still promises "review" on a completed valuation nobody has paid for', async () => {
    mockApi([]);
    render(
      <WorkflowActions
        valuation={valuation({ state: 'completed', paid_status: 'unpaid' })}
        onChanged={vi.fn()}
      />,
    );
    expect(await screen.findByRole('button', { name: /Advance → In review/i })).toBeInTheDocument();
  });

  it('offers no next step from the terminal state', async () => {
    mockApi([]);
    render(<WorkflowActions valuation={valuation({ state: 'published' })} onChanged={vi.fn()} />);
    const advance = await screen.findByRole('button', { name: 'No next step' });
    expect(advance).toBeDisabled();
  });

  it('advances and reloads the valuation it changed', async () => {
    const calls: Call[] = [];
    mockApi(calls);
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowActions valuation={valuation()} onChanged={onChanged} />);

    await userEvent.click(await screen.findByRole('button', { name: /Advance →/i }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls[0]!.url).toContain('/workflow/advance');
  });

  it('restarts anywhere but the published and started ends of the workflow', async () => {
    const calls: Call[] = [];
    mockApi(calls);
    const { rerender } = render(
      <WorkflowActions valuation={valuation({ state: 'started' })} onChanged={vi.fn()} />,
    );
    expect(await screen.findByRole('button', { name: 'Restart' })).toBeDisabled();

    rerender(<WorkflowActions valuation={valuation({ state: 'published' })} onChanged={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Restart' })).toBeDisabled();

    rerender(<WorkflowActions valuation={valuation({ state: 'review' })} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(calls[0]!.url).toContain('/workflow/restart'));
  });

  it('surfaces a refused transition instead of pretending it landed', async () => {
    const onChanged = vi.fn();
    mockApi([], {
      workflow: () =>
        jsonResponse({ title: 'Conflict', detail: 'This valuation has no report yet.' }, 409),
    });
    render(<WorkflowActions valuation={valuation()} onChanged={onChanged} />);

    await userEvent.click(await screen.findByRole('button', { name: /Advance →/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This valuation has no report yet.');
    expect(onChanged).not.toHaveBeenCalled();
  });

  describe('reassignment', () => {
    it('labels the reviewer picker so clicking the label focuses it', async () => {
      mockApi([]);
      render(<WorkflowActions valuation={valuation()} onChanged={vi.fn()} />);
      expect(await screen.findByLabelText('Assigned reviewer')).toBeInTheDocument();
    });

    it('lists reviewers by name, falling back to email when they have none', async () => {
      mockApi([]);
      render(<WorkflowActions valuation={valuation()} onChanged={vi.fn()} />);

      await screen.findByRole('option', { name: 'Rae Okafor' });
      expect(screen.getByRole('option', { name: 'sam@n409.ai' })).toBeInTheDocument();
    });

    it('will not post a reassignment that changes nothing', async () => {
      mockApi([]);
      render(
        <WorkflowActions valuation={valuation({ assigned_reviewer_id: 'r1' })} onChanged={vi.fn()} />,
      );
      expect(await screen.findByRole('button', { name: 'Reassign' })).toBeDisabled();
    });

    it('sends the chosen reviewer, and null for unassigned', async () => {
      const calls: Call[] = [];
      mockApi(calls);
      const { rerender } = render(
        <WorkflowActions valuation={valuation()} onChanged={vi.fn()} />,
      );

      await userEvent.selectOptions(await screen.findByLabelText('Assigned reviewer'), 'r1');
      await userEvent.click(screen.getByRole('button', { name: 'Reassign' }));
      await waitFor(() => expect(calls[0]!.body).toEqual({ reviewer_id: 'r1' }));

      rerender(
        <WorkflowActions valuation={valuation({ assigned_reviewer_id: 'r2' })} onChanged={vi.fn()} />,
      );
      await userEvent.selectOptions(screen.getByLabelText('Assigned reviewer'), '');
      await userEvent.click(screen.getByRole('button', { name: 'Reassign' }));
      await waitFor(() => expect(calls[1]!.body).toEqual({ reviewer_id: null }));
    });

    it('says the reviewer list failed rather than showing an empty picker', async () => {
      mockApi([], { options: () => jsonResponse({ title: 'Forbidden' }, 403) });
      render(<WorkflowActions valuation={valuation()} onChanged={vi.fn()} />);

      expect(await screen.findByText(/Reviewers could not be loaded/i)).toBeInTheDocument();
      expect(screen.getByLabelText('Assigned reviewer')).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Reassign' })).toBeDisabled();
    });
  });
});
