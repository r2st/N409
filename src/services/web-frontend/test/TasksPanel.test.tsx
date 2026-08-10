import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { TaskStatusBadge, TasksPanel } from '../src/components/valuation/TasksPanel';
import type { ReviewTask } from '../src/lib/pipeline';
import type { User } from '../src/lib/types';

/**
 * The review-task panel — the analyst → reviewer → sign-off pipeline for one
 * valuation.
 *
 * What matters here is not that a list renders. It is that the panel does not
 * quietly lose work: a task created has to reach the server with the fields the
 * form showed, a status moved has to be persisted rather than only painted, and
 * a refusal from the server has to reach the analyst instead of leaving a form
 * that looks like it submitted. The overdue badge earns its own attention
 * because it is the one piece of state the panel computes a display for rather
 * than echoing — and an overdue task shown as merely "Open" is a missed
 * deadline nobody was told about.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ME: User = {
  id: 'user-analyst',
  email: 'avery@409.ai',
  first_name: 'Avery',
  last_name: 'Analyst',
  phone: null,
  job_title: null,
  company_name: null,
  timezone: null,
  verified: true,
  sso_provider: null,
  partner_id: null,
  roles: ['valuation_ops'],
};

const task = (over: Partial<ReviewTask> = {}): ReviewTask => ({
  id: 'task-1',
  valuation_id: 'val-1',
  kind: 'data_review',
  title: 'Tie out preferred share count',
  description: null,
  status: 'open',
  assignee_id: null,
  created_by: ME.id,
  sla_hours: 48,
  due_at: null,
  started_at: null,
  completed_at: null,
  created_at: '2026-08-01T00:00:00.000Z',
  overdue: false,
  ...over,
});

interface Call {
  path: string;
  method: string;
  body: unknown;
}

/**
 * GET returns whatever the list currently holds; writes are recorded and, by
 * default, accepted. `writeStatus` fails every write so the error path can be
 * driven without a second harness.
 */
function mockApi(tasks: ReviewTask[], opts: { writeStatus?: number; listStatus?: number } = {}) {
  const calls: Call[] = [];
  let list = tasks;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    if (path.endsWith('/auth/me')) return jsonResponse({ user: ME });
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (method === 'GET') {
      if (opts.listStatus) return jsonResponse({ status: opts.listStatus, detail: 'No' }, opts.listStatus);
      return jsonResponse({ tasks: list });
    }
    if (opts.writeStatus) {
      return jsonResponse({ status: opts.writeStatus, detail: 'Refused by the server.' }, opts.writeStatus);
    }
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { title: string; kind: ReviewTask['kind'] };
      list = [...list, task({ id: `task-${list.length + 1}`, title: body.title, kind: body.kind })];
      return jsonResponse({ task: list[list.length - 1] }, 201);
    }
    if (method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as { status: ReviewTask['status'] };
      const id = path.split('/tasks/')[1] ?? '';
      list = list.map((t) => (t.id === id ? { ...t, status: body.status } : t));
      return jsonResponse({ task: list.find((t) => t.id === id) });
    }
    throw new Error(`unexpected fetch ${method} ${path}`);
  });
  return { calls, current: () => list };
}

function renderPanel() {
  localStorage.setItem('n409.token', 'header.payload.sig');
  return render(
    <MemoryRouter>
      <AuthProvider>
        <TasksPanel valuationId="val-1" />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('TasksPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('shows a skeleton until the tasks arrive', async () => {
    mockApi([task()]);
    renderPanel();

    expect(screen.getByText('Loading review tasks…')).toBeInTheDocument();
    await screen.findByText('Tie out preferred share count');
    expect(screen.queryByText('Loading review tasks…')).not.toBeInTheDocument();
  });

  it('invites the first task rather than showing an empty list', async () => {
    mockApi([]);
    renderPanel();

    await screen.findByText('No review tasks yet');
    expect(screen.getByRole('button', { name: 'Add task' })).toBeDisabled();
  });

  it('sends the title, kind, SLA and assignee the form was showing', async () => {
    const { calls } = mockApi([]);
    renderPanel();
    await screen.findByText('No review tasks yet');

    await userEvent.type(screen.getByLabelText('Title'), 'Confirm the option pool');
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'cap_table');
    await userEvent.clear(screen.getByLabelText('SLA (hours)'));
    await userEvent.type(screen.getByLabelText('SLA (hours)'), '24');
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));

    await screen.findByText('Confirm the option pool');
    const post = calls.find((c) => c.method === 'POST');
    // Every field, not just the title: a task created with the default kind or
    // no deadline is a task the pipeline will not chase.
    expect(post?.body).toEqual({
      kind: 'cap_table',
      title: 'Confirm the option pool',
      sla_hours: 24,
      assignee_id: ME.id,
    });
  });

  it('clears the title after a create, so the next task is not a duplicate', async () => {
    mockApi([]);
    renderPanel();
    await screen.findByText('No review tasks yet');

    await userEvent.type(screen.getByLabelText('Title'), 'Tie out cash');
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));

    await screen.findByText('Tie out cash');
    expect(screen.getByLabelText('Title')).toHaveValue('');
  });

  it('leaves the assignee unset when the task is not for me', async () => {
    const { calls } = mockApi([]);
    renderPanel();
    await screen.findByText('No review tasks yet');

    await userEvent.type(screen.getByLabelText('Title'), 'Client to send the cap table');
    await userEvent.click(screen.getByLabelText('Assign to me'));
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));

    await screen.findByText('Client to send the cap table');
    expect((calls.find((c) => c.method === 'POST')?.body as { assignee_id: unknown }).assignee_id).toBeNull();
  });

  it('sends no SLA when the field is emptied, rather than an hour of zero', async () => {
    const { calls } = mockApi([]);
    renderPanel();
    await screen.findByText('No review tasks yet');

    await userEvent.type(screen.getByLabelText('Title'), 'Open-ended follow-up');
    await userEvent.clear(screen.getByLabelText('SLA (hours)'));
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));

    await screen.findByText('Open-ended follow-up');
    expect((calls.find((c) => c.method === 'POST')?.body as { sla_hours: unknown }).sla_hours).toBeNull();
  });

  it('trims the title, so leading whitespace is not part of the task', async () => {
    const { calls } = mockApi([]);
    renderPanel();
    await screen.findByText('No review tasks yet');

    await userEvent.type(screen.getByLabelText('Title'), '   Reconcile the 83(b)   ');
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect((calls.find((c) => c.method === 'POST')?.body as { title: string }).title).toBe(
      'Reconcile the 83(b)',
    );
  });

  it('surfaces the server’s refusal instead of pretending the task was created', async () => {
    mockApi([], { writeStatus: 422 });
    renderPanel();
    await screen.findByText('No review tasks yet');

    await userEvent.type(screen.getByLabelText('Title'), 'Something the server rejects');
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));

    await screen.findByText('Refused by the server.');
    // The typed title survives the failure — retyping it is the analyst paying
    // for the server's error.
    expect(screen.getByLabelText('Title')).toHaveValue('Something the server rejects');
    expect(screen.getByRole('button', { name: 'Add task' })).toBeEnabled();
  });

  it('persists a status move rather than only painting it', async () => {
    const { calls, current } = mockApi([task()]);
    renderPanel();
    await screen.findByText('Tie out preferred share count');

    await userEvent.selectOptions(
      screen.getByLabelText('Status of Tie out preferred share count'),
      'in_progress',
    );

    await waitFor(() => expect(current()[0]?.status).toBe('in_progress'));
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.path).toContain('/tasks/task-1');
    expect(patch?.body).toEqual({ status: 'in_progress' });
    // Re-read after the write: the panel shows server state, not local state.
    expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(1);
  });

  it('reports a status move the server refused', async () => {
    mockApi([task()], { writeStatus: 409 });
    renderPanel();
    await screen.findByText('Tie out preferred share count');

    await userEvent.selectOptions(screen.getByLabelText('Status of Tie out preferred share count'), 'done');

    await screen.findByText('Refused by the server.');
  });

  it('says so when the list cannot be loaded at all', async () => {
    mockApi([], { listStatus: 500 });
    renderPanel();

    await screen.findByText('Could not load tasks.');
    expect(screen.queryByText('Loading review tasks…')).not.toBeInTheDocument();
  });

  it('marks a task as assigned to the signed-in analyst', async () => {
    mockApi([task({ assignee_id: ME.id }), task({ id: 'task-2', title: 'Someone else', assignee_id: 'x' })]);
    renderPanel();

    const mine = (await screen.findByText('Tie out preferred share count')).closest('li') as HTMLElement;
    expect(within(mine).getByText(/assigned to you/)).toBeInTheDocument();
    const theirs = screen.getByText('Someone else').closest('li') as HTMLElement;
    expect(within(theirs).queryByText(/assigned to you/)).not.toBeInTheDocument();
  });

  it('shows how long is left on a task with a deadline', async () => {
    const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString();
    mockApi([task({ due_at: inTwoDays })]);
    renderPanel();

    const row = (await screen.findByText('Tie out preferred share count')).closest('li') as HTMLElement;
    expect(within(row).getByText(/due in 2d/)).toBeInTheDocument();
  });
});

describe('TaskStatusBadge', () => {
  it('reads "Overdue" for a live task past its deadline, whatever its status', () => {
    render(
      <>
        <TaskStatusBadge task={{ status: 'open', overdue: true }} />
        <TaskStatusBadge task={{ status: 'in_progress', overdue: true }} />
        <TaskStatusBadge task={{ status: 'blocked', overdue: true }} />
      </>,
    );
    expect(screen.getAllByText('Overdue')).toHaveLength(3);
  });

  it('does not call a finished task overdue', () => {
    // A task closed after its SLA is still closed; nagging about it buries the
    // deadlines that are actually still open.
    render(
      <>
        <TaskStatusBadge task={{ status: 'done', overdue: true }} />
        <TaskStatusBadge task={{ status: 'cancelled', overdue: true }} />
      </>,
    );
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });

  it('labels each on-time status', () => {
    render(
      <>
        <TaskStatusBadge task={{ status: 'open', overdue: false }} />
        <TaskStatusBadge task={{ status: 'in_progress', overdue: false }} />
        <TaskStatusBadge task={{ status: 'blocked', overdue: false }} />
      </>,
    );
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
  });
});
