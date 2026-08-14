import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TasksPage } from '../src/pages/TasksPage';
import type { ReviewQueueItem } from '../src/lib/types';
import type { ReviewTask } from '../src/lib/pipeline';

/** P1 #6 — review queue + inline task actions. */

const OPS_ID = '01N409OPSUSER000000000000A';

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: {
      id: OPS_ID,
      email: 'ops@n409.example',
      first_name: 'Olive',
      last_name: 'Ops',
      verified: true,
      sso_provider: null,
      partner_id: null,
      roles: ['reviewer'],
    },
  }),
}));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const task: ReviewTask = {
  id: '01N409TASK000000000000000A',
  valuation_id: '01N409VAL00000000000000AAA',
  kind: 'draft_review',
  title: 'Check the draft report',
  description: null,
  status: 'open',
  assignee_id: null,
  created_by: null,
  sla_hours: 24,
  due_at: '2026-07-06T00:00:00Z',
  started_at: null,
  completed_at: null,
  created_at: '2026-07-01T00:00:00Z',
  overdue: true,
};

const review: ReviewQueueItem = {
  id: '01N409VAL00000000000000BBB',
  kind: '409a',
  state: 'review',
  company_name: 'Sendback Inc',
  service_name: null,
  user_id: '01N409CLIENT000000000000AA',
  partner_id: null,
  source: null,
  currency: 'USD',
  service_countries: [],
  waiting_on_client: false,
  assigned_reviewer_id: OPS_ID,
  due_date: null,
  delivery_days: null,
  paid_status: 'paid',
  qsbs_attestation: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
  signed_main: false,
  signed_second: false,
};

function mockApi() {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ url: path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.includes('/users/options')) {
      return jsonResponse({
        options: [
          { id: OPS_ID, email: 'ops@n409.example', first_name: 'Olive', last_name: 'Ops' },
          { id: '01N409OTHER0000000000000AA', email: 'r2@n409.example', first_name: 'Rae', last_name: 'Two' },
        ],
      });
    }
    if (path.includes('/review/decision'))
      return jsonResponse({ valuation: { ...review, state: 'reviewed' } });
    if (path.includes('/reviews')) return jsonResponse({ reviews: [review], total: 1 });
    if (method === 'PATCH' && path.includes('/tasks/')) return jsonResponse({ task });
    if (path.includes('/tasks')) return jsonResponse({ tasks: [task], total: 1 });
    return jsonResponse({});
  });
  return calls;
}

function renderPage() {
  return render(
    <MemoryRouter>
      <TasksPage />
    </MemoryRouter>,
  );
}

describe('TasksPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('lets a reviewer pick up an unassigned task from the queue', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Pick up' }));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(patch!.url).toContain(`/tasks/${task.id}`);
      expect(patch!.body).toEqual({ assignee_id: OPS_ID });
    });
  });

  it('reassigns a task inline via the assignee picker', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();

    const picker = await screen.findByLabelText(`Assignee of ${task.title}`);
    await user.selectOptions(picker, '01N409OTHER0000000000000AA');
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH');
      expect(patch!.body).toEqual({ assignee_id: '01N409OTHER0000000000000AA' });
    });
  });

  it('marks overdue tasks in the queue', async () => {
    mockApi();
    renderPage();
    const chip = await screen.findByText(/overdue by/);
    expect(chip.className).toContain('text-red-600');
  });

  it('approves a valuation from the review queue', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Review queue' }));
    expect(await screen.findByText('Sendback Inc')).toBeInTheDocument();
    expect(screen.getByText('Awaiting signature')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      const post = calls.find((c) => c.url.includes('/review/decision'));
      expect(post).toBeTruthy();
      expect(post!.url).toContain(`/valuations/${review.id}/review/decision`);
      expect(post!.body).toEqual({ decision: 'approve' });
    });
  });

  it('requests changes with a comment', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Review queue' }));
    await user.click(await screen.findByRole('button', { name: 'Request changes' }));
    await user.type(
      screen.getByLabelText(`Changes requested for ${review.company_name}`),
      'Fix the DLOM inputs.',
    );
    await user.click(screen.getByRole('button', { name: 'Send back' }));

    await waitFor(() => {
      const post = calls.find((c) => c.url.includes('/review/decision'));
      expect(post!.body).toEqual({ decision: 'request_changes', comment: 'Fix the DLOM inputs.' });
    });
  });

  /**
   * R31 — sending a valuation back is the one decision that carries an
   * instruction, and the box collecting it was optional. "Send back" on an
   * empty form returned the engagement to the analyst with the state changed
   * and nothing saying why. The API still accepts a bare `request_changes`
   * because approving needs no note, so the requirement belongs on the form
   * that asks the question.
   */
  it('will not send a valuation back with no explanation', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Review queue' }));
    await user.click(await screen.findByRole('button', { name: 'Request changes' }));
    await user.click(screen.getByRole('button', { name: 'Send back' }));

    expect(
      await screen.findByText('Say what needs to change — this is the note the analyst gets.'),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.url.includes('/review/decision'))).toBeUndefined();
  });

  /** Whitespace is not an explanation. */
  it('will not accept a blank-looking explanation', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Review queue' }));
    await user.click(await screen.findByRole('button', { name: 'Request changes' }));
    await user.type(screen.getByLabelText(`Changes requested for ${review.company_name}`), '   ');
    await user.click(screen.getByRole('button', { name: 'Send back' }));

    expect(
      await screen.findByText('Say what needs to change — this is the note the analyst gets.'),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.url.includes('/review/decision'))).toBeUndefined();
  });

  /** Approving still needs no note — the rule is on the send-back form only. */
  it('leaves approval free of the explanation rule', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Review queue' }));
    // Reveal the message on the send-back form first, then approve instead.
    await user.click(await screen.findByRole('button', { name: 'Request changes' }));
    await user.click(screen.getByRole('button', { name: 'Send back' }));
    await screen.findByText('Say what needs to change — this is the note the analyst gets.');

    await user.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      const post = calls.find((c) => c.url.includes('/review/decision'));
      expect(post).toBeTruthy();
      expect(post!.body).toEqual({ decision: 'approve' });
    });
  });

  /**
   * The panel is reused for whichever valuation is open, so a message revealed
   * on one must not greet the next with an error it has not earned.
   */
  it('clears the revealed message when the panel is reopened', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Review queue' }));
    await user.click(await screen.findByRole('button', { name: 'Request changes' }));
    await user.click(screen.getByRole('button', { name: 'Send back' }));
    await screen.findByText('Say what needs to change — this is the note the analyst gets.');

    // Close and reopen the panel.
    await user.click(screen.getByRole('button', { name: 'Request changes' }));
    await user.click(screen.getByRole('button', { name: 'Request changes' }));

    expect(
      screen.queryByText('Say what needs to change — this is the note the analyst gets.'),
    ).not.toBeInTheDocument();
  });
});
