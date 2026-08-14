import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TasksPage } from '../src/pages/TasksPage';
import type { ReviewQueueItem } from '../src/lib/types';
import type { ReviewTask } from '../src/lib/pipeline';

/**
 * The other half of `TasksPage.test.tsx`: the refusal, the filters that build
 * the query, the two empty states, both loads failing, and the rows whose
 * fields are not the ones the happy path renders.
 *
 * The picker case is the one that found a bug — see "a task assigned to
 * somebody the roster does not list".
 */

const OPS_ID = '01N409OPSUSER000000000000A';
const OTHER_ID = '01N409OTHER0000000000000AA';
const GONE_ID = '01N409GONEUSER0000000000A';

let roles: string[] = ['reviewer'];

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
      roles,
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
  due_at: null,
  started_at: null,
  completed_at: null,
  created_at: '2026-07-01T00:00:00Z',
  overdue: false,
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

interface Options {
  tasks?: ReviewTask[];
  reviews?: ReviewQueueItem[];
  truncated?: boolean;
  /** Paths (substring match) that should answer 500 instead of a body. */
  fail?: string[];
}

function mockApi(opts: Options = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ url: path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if ((opts.fail ?? []).some((f) => path.includes(f))) return jsonResponse({ title: 'nope' }, 500);
    if (path.includes('/users/options')) {
      return jsonResponse({
        options: [
          { id: OPS_ID, email: 'ops@n409.example', first_name: 'Olive', last_name: 'Ops' },
          { id: OTHER_ID, email: 'r2@n409.example', first_name: 'Rae', last_name: 'Two' },
        ],
        truncated: opts.truncated ?? false,
      });
    }
    if (path.includes('/review/decision')) return jsonResponse({ valuation: review });
    if (path.includes('/reviews'))
      return jsonResponse({ reviews: opts.reviews ?? [review], total: (opts.reviews ?? [review]).length });
    if (method === 'PATCH' && path.includes('/tasks/')) return jsonResponse({ task });
    const tasks = opts.tasks ?? [task];
    if (path.includes('/tasks')) return jsonResponse({ tasks, total: tasks.length });
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

describe('TasksPage — refusals and edges', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    roles = ['reviewer'];
  });

  it('is closed to a client account, before any request is made', async () => {
    roles = ['client'];
    const calls = mockApi();
    renderPage();

    expect(screen.getByText('Review tasks are available to operations roles only.')).toBeInTheDocument();
    // The page must not render either queue behind the refusal.
    expect(screen.queryByRole('heading', { name: 'Review tasks' })).not.toBeInTheDocument();
    expect(calls.filter((c) => c.url.includes('/tasks'))).toHaveLength(0);
  });

  describe('the task filters', () => {
    it('asks for the overdue set, and says so when it is empty', async () => {
      const calls = mockApi({ tasks: [] });
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'Overdue' }));

      await waitFor(() => {
        expect(calls.some((c) => c.url.includes('overdue=true'))).toBe(true);
      });
      expect(await screen.findByText('No overdue tasks — the SLA board is clean.')).toBeInTheDocument();
      // `assignee=me` belongs to the "Assigned to me" scope only.
      const overdueCall = calls.filter((c) => c.url.includes('overdue=true')).at(-1)!;
      expect(overdueCall.url).not.toContain('assignee=me');
    });

    it('drops the scope filter entirely for "All tasks"', async () => {
      const calls = mockApi({ tasks: [] });
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'All tasks' }));

      await waitFor(() => {
        const last = calls.filter((c) => c.url.includes('/tasks?')).at(-1)!;
        expect(last.url).not.toContain('assignee=me');
        expect(last.url).not.toContain('overdue=true');
      });
      // The generic empty line, not the SLA one.
      expect(await screen.findByText('No tasks match this filter.')).toBeInTheDocument();
    });

    it('adds the status filter to the query, and keeps the scope alongside it', async () => {
      const calls = mockApi();
      const user = userEvent.setup();
      renderPage();

      await user.selectOptions(await screen.findByLabelText('Filter by status'), 'blocked');

      await waitFor(() => {
        const last = calls.filter((c) => c.url.includes('/tasks?')).at(-1)!;
        expect(last.url).toContain('status=blocked');
        expect(last.url).toContain('assignee=me');
      });
    });
  });

  describe('a task whose fields are not the happy path', () => {
    it('names the kind the server sent when it is one this build has no label for', async () => {
      mockApi({
        // A kind added server-side ahead of the frontend. The row must still
        // say what it is rather than render blank.
        tasks: [{ ...task, kind: 'valuation_sanity_check' as ReviewTask['kind'] }],
      });
      renderPage();

      expect(await screen.findByText(/valuation_sanity_check/)).toBeInTheDocument();
    });

    it('marks the one assigned to you, and offers no "Pick up" for it', async () => {
      mockApi({ tasks: [{ ...task, assignee_id: OPS_ID }] });
      renderPage();

      expect(await screen.findByText(/assigned to you/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Pick up' })).not.toBeInTheDocument();
    });

    it.each([
      ['done', 'done'],
      ['cancelled', 'cancelled'],
    ] as const)('offers no "Pick up" on a task already %s', async (_label, status) => {
      mockApi({ tasks: [{ ...task, status }] });
      renderPage();

      await screen.findByText(task.title);
      expect(screen.queryByRole('button', { name: 'Pick up' })).not.toBeInTheDocument();
    });

    it('shows a due date that has not passed in the quiet colour', async () => {
      mockApi({
        tasks: [{ ...task, due_at: new Date(Date.now() + 3 * 86_400_000).toISOString(), overdue: false }],
      });
      renderPage();

      const chip = await screen.findByText(/due in/);
      expect(chip.className).toContain('text-ink-400');
      expect(chip.className).not.toContain('text-red-600');
    });

    it('unassigns through the picker by sending null rather than an empty string', async () => {
      const calls = mockApi({ tasks: [{ ...task, assignee_id: OTHER_ID }] });
      const user = userEvent.setup();
      renderPage();

      await user.selectOptions(await screen.findByLabelText(`Assignee of ${task.title}`), '');
      await waitFor(() => {
        const patch = calls.find((c) => c.method === 'PATCH');
        // `assignee_id: ''` is not a null id — the API takes a ULID or null.
        expect(patch!.body).toEqual({ assignee_id: null });
      });
    });

    /**
     * `/users/options` lists neither everybody nor forever: it drops deleted
     * accounts and caps at PICKER_LIMIT, while `assignee_id` is whoever held
     * the task whenever it was assigned. A controlled `<select>` whose value
     * matches no option selects nothing, so the task read as *Unassigned* —
     * next to a "Pick up" button offering to fix exactly that. Reassigning it
     * was then a decision taken against a state that was not true.
     */
    it('keeps a task assigned to somebody the roster does not list out of "Unassigned"', async () => {
      mockApi({ tasks: [{ ...task, assignee_id: GONE_ID }] });
      renderPage();

      const picker = (await screen.findByLabelText(`Assignee of ${task.title}`)) as HTMLSelectElement;
      expect(picker.value).toBe(GONE_ID);
      expect(picker.value).not.toBe('');
      // And the row says who, as far as it can — the id, exactly as the review
      // tab falls back to when a reviewer is off the roster.
      expect(within(picker).getByText(`${GONE_ID} (not in list)`)).toBeInTheDocument();
    });

    it('carries no extra option when the assignee is on the roster', async () => {
      mockApi({ tasks: [{ ...task, assignee_id: OTHER_ID }] });
      renderPage();

      const picker = (await screen.findByLabelText(`Assignee of ${task.title}`)) as HTMLSelectElement;
      expect(picker.value).toBe(OTHER_ID);
      expect(within(picker).queryByText(/not in list/)).not.toBeInTheDocument();
    });

    it('warns that the roster is cut short when the server says it is', async () => {
      mockApi({ truncated: true });
      renderPage();

      const picker = await screen.findByLabelText(`Assignee of ${task.title}`);
      expect(
        within(picker).getByText('— more exist than are listed; filter to narrow the list —'),
      ).toBeInTheDocument();
    });
  });

  describe('when the server will not answer', () => {
    it('says the task list could not be loaded, and drops the skeleton', async () => {
      mockApi({ fail: ['/tasks'] });
      renderPage();

      expect(await screen.findByText('Could not load tasks.')).toBeInTheDocument();
      expect(screen.queryByLabelText('Loading tasks…')).not.toBeInTheDocument();
    });

    it('says an inline task edit did not land', async () => {
      const user = userEvent.setup();
      mockApi({ fail: ['PATCH-marker'] });
      // Fail only the PATCH: the listing has to succeed for a row to click.
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const path = String(url);
        if ((init?.method ?? 'GET') === 'PATCH') return jsonResponse({ title: 'nope' }, 500);
        if (path.includes('/users/options')) return jsonResponse({ options: [], truncated: false });
        if (path.includes('/reviews')) return jsonResponse({ reviews: [], total: 0 });
        if (path.includes('/tasks')) return jsonResponse({ tasks: [task], total: 1 });
        return jsonResponse({});
      });
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'Pick up' }));
      expect(await screen.findByText('Could not update the task.')).toBeInTheDocument();
    });

    it('says the review queue could not be loaded', async () => {
      mockApi({ fail: ['/reviews'] });
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'Review queue' }));
      expect(await screen.findByText('Could not load the review queue.')).toBeInTheDocument();
      expect(screen.queryByLabelText('Loading review queue…')).not.toBeInTheDocument();
    });

    it("repeats the API's own refusal when a decision is rejected", async () => {
      const user = userEvent.setup();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const path = String(url);
        if (path.includes('/review/decision'))
          return new Response(JSON.stringify({ title: 'A main signature is required before approval' }), {
            status: 409,
            headers: { 'content-type': 'application/problem+json' },
          });
        if (path.includes('/users/options')) return jsonResponse({ options: [], truncated: false });
        if (path.includes('/reviews')) return jsonResponse({ reviews: [review], total: 1 });
        return jsonResponse({ tasks: [], total: 0 });
      });
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'Review queue' }));
      await user.click(await screen.findByRole('button', { name: 'Approve' }));

      expect(await screen.findByText('A main signature is required before approval')).toBeInTheDocument();
      // And the button is usable again — the failure is not a dead end.
      await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).not.toBeDisabled());
    });
  });

  describe('the review queue', () => {
    it('says nothing is assigned to you, then nothing at all, per scope', async () => {
      mockApi({ reviews: [] });
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'Review queue' }));
      expect(await screen.findByText('Nothing in review is assigned to you.')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'All in review' }));
      expect(await screen.findByText('No valuations are waiting on a review decision.')).toBeInTheDocument();
    });

    it('drops assignee=me when the scope widens', async () => {
      const calls = mockApi({ reviews: [] });
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'Review queue' }));
      await user.click(await screen.findByRole('button', { name: 'All in review' }));

      await waitFor(() => {
        const last = calls.filter((c) => c.url.includes('/reviews?')).at(-1)!;
        expect(last.url).not.toContain('assignee=me');
      });
    });

    it('shows a signed valuation as signed, names its reviewer and its due date', async () => {
      mockApi({
        reviews: [
          {
            ...review,
            signed_main: true,
            assigned_reviewer_id: OTHER_ID,
            due_date: '2026-08-20',
          },
        ],
      });
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'Review queue' }));
      expect(await screen.findByText('Signed')).toBeInTheDocument();
      expect(screen.queryByText('Awaiting signature')).not.toBeInTheDocument();
      expect(screen.getByText(/Rae Two/)).toBeInTheDocument();
      expect(screen.getByText(/due /)).toBeInTheDocument();
    });

    it('falls back to the raw id for a reviewer the roster does not list', async () => {
      mockApi({ reviews: [{ ...review, assigned_reviewer_id: GONE_ID }] });
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'Review queue' }));
      expect(await screen.findByText(new RegExp(GONE_ID))).toBeInTheDocument();
    });

    it('says "Unassigned" when nobody holds the review', async () => {
      mockApi({ reviews: [{ ...review, assigned_reviewer_id: null }] });
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'Review queue' }));
      expect(await screen.findByText(/Unassigned/)).toBeInTheDocument();
    });

    /**
     * The button's tooltip names where approving lands, and that is not one
     * state: a valuation in `review` advances to `reviewed`, anything else to
     * `drafted`.
     */
    it('names the state approval advances to, per starting state', async () => {
      mockApi({ reviews: [{ ...review, state: 'reviewed' }] });
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'Review queue' }));
      const approve = await screen.findByRole('button', { name: 'Approve' });
      expect(approve.getAttribute('title')).toContain('Draft');
    });

    it('closes the send-back form on Cancel without deciding anything', async () => {
      const calls = mockApi();
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'Review queue' }));
      await user.click(await screen.findByRole('button', { name: 'Request changes' }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByLabelText(`Changes requested for ${review.company_name}`)).not.toBeInTheDocument();
      expect(calls.find((c) => c.url.includes('/review/decision'))).toBeUndefined();
    });
  });
});
