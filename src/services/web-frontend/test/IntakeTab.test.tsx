import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { IntakeTab } from '../src/pages/valuation/IntakeTab';
import type { User, Valuation } from '../src/lib/types';

/**
 * The intake wizard is where a client's own answers enter the valuation, and
 * it is the surface with the most ways to record something the client did not
 * say.
 *
 * The one worth pinning hardest is the blank option on a yes/no question.
 * "—" has to save as `null`, not `false`: a client who leaves "Any pending
 * litigation?" unanswered must not be recorded as having denied it, and
 * because `false` counts as answered, a wrong reading also marks the field
 * complete and the tracker stops asking. `answerFromControl` owns that
 * conversion; these tests hold the wiring between it and the control.
 *
 * The second is that a section save sends the whole section — including its
 * unanswered fields as explicit nulls — because the server merges. A slice
 * that omitted them would make clearing an answer impossible.
 */

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  state: 'started',
  company_name: 'Acme',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

let mockUser: User;
vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

const opsUser = { id: 'u-ops', email: 'ops@example.com', roles: ['admin'] } as unknown as User;
const clientUser = { id: 'u-c', email: 'c@example.com', roles: ['client'] } as unknown as User;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const SECTIONS = [
  {
    key: 'company',
    title: 'Company information',
    description: 'Who you are.',
    fields: [
      { key: 'legal_name', label: 'Legal name', type: 'text' as const, required: true },
      {
        key: 'incorporated_on',
        label: 'Incorporation date',
        type: 'date' as const,
        required: true,
        rules: { notFuture: true },
      },
      {
        key: 'stage',
        label: 'Stage',
        type: 'select' as const,
        required: true,
        options: ['seed', 'series_a'],
      },
    ],
  },
  {
    key: 'financials',
    title: 'Financials',
    description: 'The numbers.',
    fields: [
      {
        key: 'revenue',
        label: 'Revenue',
        type: 'number' as const,
        required: true,
        rules: { min: 0 },
        hint: 'Trailing twelve months.',
      },
      { key: 'litigation', label: 'Any pending litigation?', type: 'boolean' as const, required: true },
      { key: 'notes', label: 'Anything else', type: 'textarea' as const, required: false },
    ],
  },
];

const CROSS_RULES = [
  {
    key: 'burn_vs_revenue',
    field: 'revenue',
    severity: 'warning' as const,
    left: 'revenue',
    op: 'lt' as const,
    right: 1,
    message: 'Revenue under $1 — is this in thousands?',
  },
];

const COMPLETION = {
  sections: [
    { key: 'company', title: 'Company information', requiredTotal: 3, requiredAnswered: 3, complete: true },
    { key: 'financials', title: 'Financials', requiredTotal: 2, requiredAnswered: 1, complete: false },
  ],
  requiredTotal: 5,
  requiredAnswered: 4,
  percentComplete: 80,
  ready: false,
};

const QUESTIONNAIRE = {
  answers: { legal_name: 'Acme, Inc.', incorporated_on: '2020-05-01', stage: 'series_a' },
  submitted_at: null as string | null,
  completion: COMPLETION,
  missing_documents: [{ kind: 'cap_table', label: 'Cap table export' }],
  can_edit: true,
};

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function mockApi(
  opts: {
    schema?: () => Response;
    questionnaire?: () => Response;
    save?: () => Response;
    submit?: () => Response;
    remind?: () => Response;
  } = {},
): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    if (/\/intake\/schema/.test(url)) {
      return opts.schema ? opts.schema() : json({ sections: SECTIONS, cross_rules: CROSS_RULES });
    }
    if (/\/questionnaire\/submit$/.test(url)) return opts.submit ? opts.submit() : json({});
    if (/\/remind-documents$/.test(url)) {
      return opts.remind ? opts.remind() : json({ reminded: 'client@example.com' });
    }
    if (/\/questionnaire$/.test(url) && method === 'PUT') {
      return opts.save
        ? opts.save()
        : json({ ...QUESTIONNAIRE, completion: { ...COMPLETION, percentComplete: 100 } });
    }
    if (/\/questionnaire$/.test(url)) {
      return opts.questionnaire ? opts.questionnaire() : json(QUESTIONNAIRE);
    }
    return json({});
  });
  return calls;
}

const problem = (status: number, detail: string) => () => json({ status, title: 'Error', detail }, status);

/**
 * A questionnaire whose required set is complete, on *both* endpoints.
 *
 * `saveSection` replaces `completion` from the PUT response, and stepping
 * forward saves — so overriding only the GET would hand the submit step a
 * `ready: false` completion and disable the button for a reason the test was
 * not about.
 */
const READY_COMPLETION = { ...COMPLETION, requiredAnswered: 5, percentComplete: 100, ready: true };
const readyOpts = {
  questionnaire: () => json({ ...QUESTIONNAIRE, completion: READY_COMPLETION }),
  save: () => json({ ...QUESTIONNAIRE, completion: READY_COMPLETION }),
};

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/intake']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/intake" element={<IntakeTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const ready = () => screen.findByRole('heading', { name: 'Company information' });
const next = () => screen.getByRole('button', { name: 'Next' });
const lastPut = (calls: Call[]) => calls.filter((c) => c.method === 'PUT').at(-1)!;

describe('IntakeTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUser = clientUser;
  });

  describe('loading', () => {
    it('waits for both the schema and the answers', async () => {
      mockApi();
      renderTab();
      expect(screen.getByRole('status')).toBeInTheDocument();
      await ready();
    });

    it('reports a failed load instead of spinning forever', async () => {
      // `load` records the failure but leaves `data` null, so a spinner-first
      // early return would hold the tab on a spinner with the explanation
      // already in hand.
      mockApi({ questionnaire: problem(403, 'This questionnaire is not shared with you.') });
      renderTab();
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'This questionnaire is not shared with you.',
      );
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('carries on with no schema rather than blocking the answers', async () => {
      // The schema fetch falls back to an empty list: the sidebar, the progress
      // and the document checklist are still worth showing.
      mockApi({ schema: problem(500, 'no schema') });
      renderTab();
      expect(await screen.findByText('Documents still needed')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Company information' })).not.toBeInTheDocument();
    });

    it('says why there are no sections, instead of inviting the client to fill in nothing', async () => {
      // The empty-list fallback is right; what was missing was the reason. The
      // tab rendered "Complete the sections below" above no sections at all,
      // and a client with nothing to fill in and no explanation has no way to
      // tell a broken form from a questionnaire that is already done.
      mockApi({ schema: problem(500, 'no schema') });
      renderTab();

      expect(await screen.findByText(/Could not load the questionnaire form/)).toBeInTheDocument();
      expect(screen.queryByText(/Complete the sections below/)).not.toBeInTheDocument();
      // The half that did load is still on screen and still true.
      expect(screen.getByText('Documents still needed')).toBeInTheDocument();
    });

    it('says nothing of the sort when the schema loads', async () => {
      mockApi();
      renderTab();
      await ready();
      expect(screen.getByText(/Complete the sections below/)).toBeInTheDocument();
      expect(screen.queryByText(/Could not load the questionnaire form/)).not.toBeInTheDocument();
    });
  });

  describe('the questionnaire', () => {
    it('numbers the step against the schema', async () => {
      mockApi();
      renderTab();
      await ready();
      expect(screen.getByText('Step 1 of 2')).toBeInTheDocument();
      expect(screen.getByText('Who you are.')).toBeInTheDocument();
    });

    it('shows the stored answers in their controls', async () => {
      mockApi();
      renderTab();
      await ready();
      expect(screen.getByLabelText(/^Legal name/)).toHaveValue('Acme, Inc.');
      expect(screen.getByLabelText(/^Incorporation date/)).toHaveValue('2020-05-01');
      expect(screen.getByLabelText(/^Stage/)).toHaveValue('series_a');
    });

    it('marks the required fields and carries the hint', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      expect(screen.getByLabelText(/Legal name \*/)).toBeInTheDocument();
      await user.click(next());
      await screen.findByRole('heading', { name: 'Financials' });
      expect(screen.getByText('Trailing twelve months.')).toBeInTheDocument();
    });

    it('renders a select option list with its underscores read as spaces', async () => {
      mockApi();
      renderTab();
      await ready();
      const stage = screen.getByLabelText(/^Stage/);
      expect(within(stage).getByRole('option', { name: 'series a' })).toBeInTheDocument();
      expect(within(stage).getByRole('option', { name: 'seed' })).toBeInTheDocument();
    });

    it('gives every field type a control', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await user.click(next());
      await screen.findByRole('heading', { name: 'Financials' });
      expect(screen.getByLabelText(/^Revenue/)).toHaveAttribute('type', 'number');
      expect(screen.getByLabelText(/^Any pending litigation/).tagName).toBe('SELECT');
      expect(screen.getByLabelText(/^Anything else/).tagName).toBe('TEXTAREA');
    });
  });

  describe('unanswered yes/no', () => {
    it('saves the blank option as no answer, not as a denial', async () => {
      // The whole point: `false` would record a denial the client never made,
      // and would also count as answered, so the tracker would stop asking.
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await user.click(next());
      await screen.findByRole('heading', { name: 'Financials' });
      await user.selectOptions(screen.getByLabelText(/^Any pending litigation/), 'no');
      await user.selectOptions(screen.getByLabelText(/^Any pending litigation/), '');
      await user.click(screen.getByRole('button', { name: 'Save section' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
      expect((lastPut(calls).body!.answers as Record<string, unknown>).litigation).toBeNull();
    });

    it('saves a real answer as a boolean', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await user.click(next());
      await screen.findByRole('heading', { name: 'Financials' });
      await user.selectOptions(screen.getByLabelText(/^Any pending litigation/), 'yes');
      await user.click(screen.getByRole('button', { name: 'Save section' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
      expect((lastPut(calls).body!.answers as Record<string, unknown>).litigation).toBe(true);
    });
  });

  describe('saving a section', () => {
    /*
     * The wizard is one section at a time behind Back/Next, so "Could not
     * save." left the reader with a failed write and no way to tell which of
     * the sections it was — including after stepping on, which is what the
     * Save-then-Next path does. The section is in hand at the call site.
     */
    it('names the section it could not save', async () => {
      const user = userEvent.setup();
      // No `detail`, which is when the operation half is what gets shown:
      // `describeActionFailure` prefers the server's own sentence.
      mockApi({ save: () => json({ status: 500, title: 'Internal Server Error' }, 500) });
      renderTab();
      await ready();
      await user.click(next());
      await screen.findByRole('heading', { name: 'Financials' });
      await user.click(screen.getByRole('button', { name: 'Save section' }));

      const message = await screen.findByText(/Could not save the “Financials” section\./);
      expect(message).not.toHaveTextContent('Internal Server Error');
    });

    it('sends the whole section, nulling what is unanswered', async () => {
      // The server merges, so an omitted key is "leave as it was". Sending the
      // explicit null is what makes clearing an answer possible at all.
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await user.click(next());
      await screen.findByRole('heading', { name: 'Financials' });
      await user.type(screen.getByLabelText(/^Revenue/), '1200');
      await user.click(screen.getByRole('button', { name: 'Save section' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
      expect(lastPut(calls).body!.answers).toEqual({
        revenue: 1200,
        litigation: null,
        notes: null,
      });
    });

    it('sends only the current section, not the whole form', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Save section' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
      expect(Object.keys(lastPut(calls).body!.answers as object).sort()).toEqual([
        'incorporated_on',
        'legal_name',
        'stage',
      ]);
    });

    it('reports a rejected save', async () => {
      const user = userEvent.setup();
      mockApi({ save: problem(422, 'Legal name is too long.') });
      renderTab();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Save section' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Legal name is too long.');
    });

    it('takes the refreshed completion from the save response', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Save section' }));
      expect(await screen.findByText('100%')).toBeInTheDocument();
    });
  });

  describe('moving between sections', () => {
    it('saves on the way forward', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await user.click(next());
      await screen.findByRole('heading', { name: 'Financials' });
      expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    });

    it('cannot go back from the first section', async () => {
      mockApi();
      renderTab();
      await ready();
      expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    });

    it('goes back without saving', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await user.click(next());
      await screen.findByRole('heading', { name: 'Financials' });
      const before = calls.filter((c) => c.method === 'PUT').length;
      await user.click(screen.getByRole('button', { name: 'Back' }));
      await screen.findByRole('heading', { name: 'Company information' });
      expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(before);
    });

    it('jumps straight to a section from the progress list', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Financials' }));
      expect(await screen.findByRole('heading', { name: 'Financials' })).toBeInTheDocument();
    });
  });

  describe('progress', () => {
    it('states how much of the required set is answered', async () => {
      mockApi();
      renderTab();
      await ready();
      expect(screen.getByText('80%')).toBeInTheDocument();
      expect(screen.getByText('4/5 required')).toBeInTheDocument();
    });

    it('lists every section, complete or not', async () => {
      mockApi();
      renderTab();
      await ready();
      expect(screen.getByRole('button', { name: 'Company information' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Financials' })).toBeInTheDocument();
    });
  });

  describe('validation', () => {
    it('shows the field error against the field that caused it', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await user.click(next());
      await screen.findByRole('heading', { name: 'Financials' });
      const revenue = screen.getByLabelText(/^Revenue/);
      await user.type(revenue, '-5');
      // Read it through the aria wiring rather than by text: the same sentence
      // also appears in the sidebar roll-up, and a by-text assertion could not
      // tell whether the field itself was flagged.
      await waitFor(() => expect(revenue).toHaveAttribute('aria-invalid', 'true'));
      const describedBy = revenue.getAttribute('aria-describedby')!;
      expect(document.getElementById(describedBy)).toHaveTextContent('Revenue cannot be negative.');
    });

    it('rolls every check up in the sidebar, including ones sections back', async () => {
      // Submit lives on the last step, but what blocks it may be three
      // sections earlier — so the roll-up is not merely a duplicate.
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await user.click(next());
      await screen.findByRole('heading', { name: 'Financials' });
      await user.type(screen.getByLabelText(/^Revenue/), '-5');
      await screen.findByText('Data checks');
      await user.click(screen.getByRole('button', { name: 'Back' }));
      await screen.findByRole('heading', { name: 'Company information' });
      expect(screen.getByText('Data checks')).toBeInTheDocument();
    });

    it('raises a cross-field warning without blocking', async () => {
      const user = userEvent.setup();
      mockApi(readyOpts);
      renderTab();
      await ready();
      await user.click(next());
      await screen.findByRole('heading', { name: 'Financials' });
      await user.type(screen.getByLabelText(/^Revenue/), '0');
      // Shown against the field and in the roll-up, hence getAllByText.
      await waitFor(() => expect(screen.getAllByText(/is this in thousands/).length).toBeGreaterThan(0));
      // A warning is advisory: it must not take the submit away.
      await waitFor(() => expect(screen.getByRole('button', { name: 'Submit questionnaire' })).toBeEnabled());
    });
  });

  describe('submitting', () => {
    const onLastStep = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(next());
      await screen.findByRole('heading', { name: 'Financials' });
    };

    it('is offered only on the last section', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      expect(screen.queryByRole('button', { name: 'Submit questionnaire' })).not.toBeInTheDocument();
      await onLastStep(user);
      expect(screen.getByRole('button', { name: 'Submit questionnaire' })).toBeInTheDocument();
    });

    it('stays disabled until the required set is complete', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await onLastStep(user);
      expect(screen.getByRole('button', { name: 'Submit questionnaire' })).toBeDisabled();
    });

    it('is blocked by a validation error, and says why', async () => {
      const user = userEvent.setup();
      mockApi(readyOpts);
      renderTab();
      await ready();
      await onLastStep(user);
      await user.type(screen.getByLabelText(/^Revenue/), '-5');
      const submit = screen.getByRole('button', { name: 'Submit questionnaire' });
      expect(submit).toBeDisabled();
      expect(submit).toHaveAttribute('title', 'Correct the highlighted answers first');
    });

    it('saves the last section before submitting it', async () => {
      // Submitting without the in-flight edits would file a questionnaire that
      // does not match what is on screen.
      const user = userEvent.setup();
      const calls = mockApi(readyOpts);
      renderTab();
      await ready();
      await onLastStep(user);
      // Stepping forward saves, and the button is disabled while that is in
      // flight — clicking through it would test nothing.
      await waitFor(() => expect(screen.getByRole('button', { name: 'Submit questionnaire' })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: 'Submit questionnaire' }));
      await waitFor(() => expect(calls.some((c) => /\/questionnaire\/submit$/.test(c.url))).toBe(true));
      const putAt = calls.findIndex((c) => c.method === 'PUT');
      const submitAt = calls.findIndex((c) => /\/questionnaire\/submit$/.test(c.url));
      expect(putAt).toBeLessThan(submitAt);
    });

    it('reports a refused submit', async () => {
      const user = userEvent.setup();
      mockApi({ ...readyOpts, submit: problem(422, 'Two required answers are still missing.') });
      renderTab();
      await ready();
      await onLastStep(user);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Submit questionnaire' })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: 'Submit questionnaire' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Two required answers are still missing.');
    });

    it('says the questionnaire is in, and that it can still be changed', async () => {
      mockApi({ questionnaire: () => json({ ...QUESTIONNAIRE, submitted_at: '2026-03-01T00:00:00Z' }) });
      renderTab();
      await ready();
      expect(screen.getByText(/Questionnaire submitted/)).toBeInTheDocument();
      expect(screen.getByText(/still update answers/)).toBeInTheDocument();
    });

    it('otherwise explains what the sections are for', async () => {
      mockApi();
      renderTab();
      await ready();
      expect(screen.getByText(/help us value Acme/)).toBeInTheDocument();
    });
  });

  describe('read-only', () => {
    it('disables the controls and offers no save or submit', async () => {
      mockApi({ questionnaire: () => json({ ...QUESTIONNAIRE, can_edit: false }) });
      renderTab();
      await ready();
      expect(screen.getByLabelText(/^Legal name/)).toBeDisabled();
      expect(screen.getByLabelText(/^Stage/)).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Save section' })).not.toBeInTheDocument();
    });

    it('still moves between sections without saving', async () => {
      const user = userEvent.setup();
      const calls = mockApi({ questionnaire: () => json({ ...QUESTIONNAIRE, can_edit: false }) });
      renderTab();
      await ready();
      await user.click(next());
      await screen.findByRole('heading', { name: 'Financials' });
      expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    });
  });

  describe('outstanding documents', () => {
    it('lists what is still missing', async () => {
      mockApi();
      renderTab();
      await ready();
      expect(screen.getByText('Cap table export')).toBeInTheDocument();
    });

    it('says so when nothing is', async () => {
      mockApi({ questionnaire: () => json({ ...QUESTIONNAIRE, missing_documents: [] }) });
      renderTab();
      await ready();
      expect(screen.getByText('All set')).toBeInTheDocument();
    });

    it('offers ops a reminder, and names who it went to', async () => {
      const user = userEvent.setup();
      mockUser = opsUser;
      mockApi();
      renderTab();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Send reminder to client' }));
      expect(await screen.findByText('Reminder sent to client@example.com.')).toBeInTheDocument();
    });

    it('reports a reminder that did not send', async () => {
      const user = userEvent.setup();
      mockUser = opsUser;
      mockApi({ remind: problem(429, 'A reminder was already sent today.') });
      renderTab();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Send reminder to client' }));
      expect(await screen.findByText('A reminder was already sent today.')).toBeInTheDocument();
    });

    it('offers no reminder to a client, or when nothing is missing', async () => {
      mockApi();
      renderTab();
      await ready();
      expect(screen.queryByRole('button', { name: 'Send reminder to client' })).not.toBeInTheDocument();
    });

    it('offers ops no reminder once every document is in', async () => {
      mockUser = opsUser;
      mockApi({ questionnaire: () => json({ ...QUESTIONNAIRE, missing_documents: [] }) });
      renderTab();
      await ready();
      expect(screen.queryByRole('button', { name: 'Send reminder to client' })).not.toBeInTheDocument();
    });
  });
});
