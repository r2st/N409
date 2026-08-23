import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClientIntakePage } from '../src/pages/ClientIntakePage';
import { formatDate } from '../src/lib/format';

/**
 * The client intake form. Everything asserted here is something a prospect —
 * not signed in, sent a link by their valuation firm — would notice going
 * wrong: the token never leaving the fragment, typing being written back
 * without a Save button, submission being refused while required answers are
 * missing, and the page wearing the firm's brand rather than ours.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const FIRM = {
  tenant_id: '01N409FIRM0000000000000AA',
  name: 'Meridian Valuation',
  tagline: 'Independent valuations',
  accent: '#12936f',
  accent_dark: '#43cca0',
  accent_fg: '#ffffff',
  accent_dark_fg: '#08251c',
  logo_url: null,
  logo_dark_url: null,
  favicon_url: null,
  support_email: 'clients@meridian.test',
  white_label: true,
};

const SECTIONS = [
  {
    key: 'company',
    title: 'Company information',
    description: 'Tell us about the company being valued.',
    fields: [
      { key: 'legal_name', label: 'Legal company name', type: 'text', required: true },
      { key: 'employee_count', label: 'Number of employees', type: 'number', required: false },
      { key: 'business_description', label: 'Business description', type: 'textarea', required: true },
    ],
  },
  {
    key: 'legal',
    title: 'Legal & governance',
    description: 'Charter documents and anything affecting value.',
    fields: [
      { key: 'has_articles', label: 'Articles of incorporation available?', type: 'boolean', required: true },
    ],
  },
];

const completion = (answered: number, ready = false) => ({
  sections: [
    {
      key: 'company',
      title: 'Company information',
      requiredTotal: 2,
      requiredAnswered: Math.min(answered, 2),
      answeredTotal: answered,
      fieldTotal: 3,
      complete: answered >= 2,
    },
    {
      key: 'legal',
      title: 'Legal & governance',
      requiredTotal: 1,
      requiredAnswered: answered > 2 ? 1 : 0,
      answeredTotal: answered > 2 ? 1 : 0,
      fieldTotal: 1,
      complete: answered > 2,
    },
  ],
  requiredTotal: 3,
  requiredAnswered: answered,
  percentComplete: Math.round((answered / 3) * 100),
  ready,
});

interface PortalOverrides {
  sections?: unknown[];
  answers?: Record<string, unknown>;
  can_edit?: boolean;
  status?: string;
  submitted_at?: string | null;
  ready?: boolean;
  answered?: number;
  expires_at?: string;
}

function portalBody(o: PortalOverrides = {}) {
  return {
    firm: FIRM,
    client_name: 'Northwind Robotics',
    sections: o.sections ?? SECTIONS,
    answers: o.answers ?? {},
    completion: completion(o.answered ?? 0, o.ready ?? false),
    status: o.status ?? 'sent',
    can_edit: o.can_edit ?? true,
    submitted_at: o.submitted_at ?? null,
    expires_at: o.expires_at ?? '2026-09-01T00:00:00Z',
  };
}

interface Call {
  path: string;
  body: Record<string, unknown>;
}

/** Mocks the three portal endpoints and records every request body. */
function mockPortal(opts: { portal?: PortalOverrides; portalStatus?: number; submitStatus?: number } = {}) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path, body });

    if (path.endsWith('/intake/portal')) {
      return opts.portalStatus
        ? jsonResponse({ detail: 'This intake link is invalid, expired, or withdrawn' }, opts.portalStatus)
        : jsonResponse(portalBody(opts.portal));
    }
    if (path.endsWith('/portal/answers')) {
      const answers = body.answers as Record<string, unknown>;
      return jsonResponse({ answers, completion: completion(Object.keys(answers).length) });
    }
    if (path.endsWith('/portal/submit')) {
      return opts.submitStatus
        ? jsonResponse({ detail: 'Complete all required fields before submitting' }, opts.submitStatus)
        : jsonResponse({ submitted_at: '2026-08-01T10:00:00Z', completion: completion(3, true) });
    }
    throw new Error(`unexpected fetch ${path}`);
  });
  return calls;
}

beforeEach(() => {
  window.location.hash = '#token=intake-token-abc';
  // jsdom has no layout, so its scrollTo logs a "not implemented" error on
  // every step change. The page only uses it to return to the top of the form.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('ClientIntakePage', () => {
  it('opens the form with the firm’s brand and the client’s name', async () => {
    mockPortal();
    render(<ClientIntakePage />);

    expect(await screen.findByText('Welcome, Northwind Robotics')).toBeInTheDocument();
    // The firm's identity, not ours — this page is the firm's front door.
    expect(screen.getAllByText('Meridian Valuation').length).toBeGreaterThan(0);
    expect(screen.getByText('Independent valuations')).toBeInTheDocument();
    expect(screen.queryByText('N409')).not.toBeInTheDocument();
  });

  it('reopens on the section the client still owes an answer for', async () => {
    // Company answered, Legal not. Before this the form always reopened on
    // step 1 — the section already showing a tick — and getting back to the
    // unanswered one was a manual walk the client often did not make.
    mockPortal({ portal: { answered: 2, answers: { legal_name: 'Northwind Robotics, Inc.' } } });
    render(<ClientIntakePage />);

    expect(await screen.findByRole('heading', { name: 'Legal & governance' })).toBeInTheDocument();
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument();
    // The finished section's questions are behind us, not on screen.
    expect(screen.queryByLabelText(/Legal company name/)).not.toBeInTheDocument();
  });

  it('opens a form nobody has touched at the first section', async () => {
    mockPortal();
    render(<ClientIntakePage />);

    expect(await screen.findByRole('heading', { name: 'Company information' })).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
  });

  it('sends the token in the body, never in the URL', async () => {
    const calls = mockPortal();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    const open = calls[0]!;
    // A token in the query string lands in access logs and the Referer header.
    expect(open.path).toBe('/api/v1/intake/portal');
    expect(open.path).not.toContain('intake-token-abc');
    expect(open.body.token).toBe('intake-token-abc');
  });

  it('refuses to start when the link carries no token', async () => {
    window.location.hash = '';
    const calls = mockPortal();
    render(<ClientIntakePage />);

    expect(await screen.findByText('This link isn’t available')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('explains a dead link without naming the firm behind it', async () => {
    mockPortal({ portalStatus: 401 });
    render(<ClientIntakePage />);

    expect(await screen.findByText('This link isn’t available')).toBeInTheDocument();
    expect(screen.getByText(/invalid, expired, or withdrawn/)).toBeInTheDocument();
    // A token that doesn't resolve tells us nothing about who issued it, and
    // guessing would let anyone probe which firm a stolen link belonged to.
    expect(screen.queryByText('Meridian Valuation')).not.toBeInTheDocument();
  });

  it('writes answers back without a save button, sending only what changed', async () => {
    const calls = mockPortal();
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    await user.type(screen.getByLabelText('Legal company name *'), 'Northwind Robotics, Inc.');

    const save = await waitFor(
      () => {
        const found = calls.find((c) => c.path.endsWith('/portal/answers'));
        expect(found).toBeTruthy();
        return found!;
      },
      { timeout: 3000 },
    );
    // Only the touched key: a save must not re-post — or resurrect — fields the
    // client never opened.
    expect(save.body.answers).toEqual({ legal_name: 'Northwind Robotics, Inc.' });
    expect(save.body.token).toBe('intake-token-abc');
    expect(await screen.findByText('All answers saved')).toBeInTheDocument();
  });

  it('flushes pending answers before moving on rather than after a pause', async () => {
    const calls = mockPortal();
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    await user.type(screen.getByLabelText('Number of employees'), '42');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/portal/answers'))).toBe(true));
    const save = calls.find((c) => c.path.endsWith('/portal/answers'))!;
    expect(save.body.answers).toEqual({ employee_count: 42 });
    expect(await screen.findByRole('heading', { name: 'Legal & governance' })).toBeInTheDocument();
  });

  it('keeps the client’s typing when a save fails', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const path = String(url);
      if (path.endsWith('/intake/portal')) return jsonResponse(portalBody());
      if (path.endsWith('/portal/answers')) {
        attempts += 1;
        if (attempts === 1) return jsonResponse({ detail: 'Network hiccup' }, 503);
        const answers = (JSON.parse(String(init!.body)) as { answers: Record<string, unknown> }).answers;
        return jsonResponse({ answers, completion: completion(1) });
      }
      throw new Error(`unexpected fetch ${path}`);
    });

    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');
    const input = screen.getByLabelText('Legal company name *');
    await user.type(input, 'Halcyon');

    expect(await screen.findByText('Network hiccup')).toBeInTheDocument();
    // The value stays on screen and the key stays queued, so the next edit
    // retries it instead of silently dropping what they typed.
    expect(input).toHaveValue('Halcyon');
    await user.type(input, ' Bio');
    await waitFor(() => expect(screen.getByText('All answers saved')).toBeInTheDocument(), { timeout: 3000 });
  });

  it('blocks submission while required answers are missing, and says how many', async () => {
    mockPortal({ portal: { answered: 1 } });
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    await user.click(screen.getByRole('button', { name: 'Review & submit' }));

    expect(screen.getByRole('button', { name: /Submit to Meridian Valuation/ })).toBeDisabled();
    expect(screen.getByText(/2 required answers still needed/)).toBeInTheDocument();
  });

  it('shows a review of every answer before submitting, and marks the gaps', async () => {
    mockPortal({
      portal: { answers: { legal_name: 'Northwind Robotics, Inc.', has_articles: true }, answered: 2 },
    });
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    await user.click(screen.getByRole('button', { name: 'Review & submit' }));

    expect(screen.getByText('Northwind Robotics, Inc.')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    // A required blank has to look different from an optional one.
    const description = screen.getByText('Business description').closest('div')!;
    expect(within(description).getByText('required')).toBeInTheDocument();
    expect(within(description).getByText('Not answered')).toBeInTheDocument();
  });

  it('confirms a completed submission and stops accepting changes', async () => {
    const calls = mockPortal({ portal: { answered: 3, ready: true } });
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    await user.click(screen.getByRole('button', { name: 'Review & submit' }));
    await user.click(screen.getByRole('button', { name: /Submit to Meridian Valuation/ }));

    expect(await screen.findByText('Thank you — that’s everything')).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/portal/submit'))).toBe(true);
    expect(screen.queryByRole('button', { name: /Submit to/ })).not.toBeInTheDocument();
  });

  it('reopens a submitted link read-only rather than as an empty form', async () => {
    mockPortal({
      portal: {
        status: 'submitted',
        can_edit: false,
        submitted_at: '2026-07-20T09:00:00Z',
        answers: { legal_name: 'Northwind Robotics, Inc.' },
        answered: 3,
        ready: true,
      },
    });
    render(<ClientIntakePage />);

    expect(await screen.findByText('Thank you — that’s everything')).toBeInTheDocument();
    expect(screen.getByText('Northwind Robotics, Inc.')).toBeInTheDocument();
  });

  it('disables the fields on a link that lapsed mid-form', async () => {
    mockPortal({ portal: { status: 'expired', can_edit: false } });
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    expect(screen.getByText(/no longer accepting changes/)).toBeInTheDocument();
    expect(screen.getByLabelText('Legal company name *')).toBeDisabled();
  });

  it('surfaces a rejected submission instead of appearing to succeed', async () => {
    mockPortal({ portal: { answered: 3, ready: true }, submitStatus: 422 });
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    await user.click(screen.getByRole('button', { name: 'Review & submit' }));
    await user.click(screen.getByRole('button', { name: /Submit to Meridian Valuation/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Complete all required fields');
    expect(screen.queryByText('Thank you — that’s everything')).not.toBeInTheDocument();
  });

  /**
   * The autosave, the step change and Submit all write back, and they can all
   * be triggered within a second of each other. Overlapping writes were ordered
   * by the network rather than by when the client typed, and the server merges
   * per key on arrival — so an older value could land second, and Submit could
   * outrun the answers it was submitting.
   */
  describe('overlapping writes', () => {
    /**
     * Mocks the portal with a delay on each answers write, and records how many
     * writes were open at the same time — the invariant under test, rather than
     * a timing the test would have to guess at.
     */
    function mockSlowPortal(delaysMs: number | number[], portal: PortalOverrides = {}) {
      const calls: Call[] = [];
      const settled: string[] = [];
      const delayFor = (i: number) =>
        typeof delaysMs === 'number' ? delaysMs : (delaysMs[i] ?? delaysMs[delaysMs.length - 1] ?? 0);
      let started = 0;
      let open = 0;
      let maxOpen = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const path = String(url);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ path, body });
        if (path.endsWith('/intake/portal')) return jsonResponse(portalBody(portal));
        if (path.endsWith('/portal/answers')) {
          const delay = delayFor(started++);
          open += 1;
          maxOpen = Math.max(maxOpen, open);
          try {
            await new Promise((r) => setTimeout(r, delay));
            const answers = body.answers as Record<string, unknown>;
            settled.push(JSON.stringify(answers));
            return jsonResponse({ answers, completion: completion(Object.keys(answers).length) });
          } finally {
            open -= 1;
          }
        }
        if (path.endsWith('/portal/submit')) {
          settled.push('SUBMIT');
          return jsonResponse({ submitted_at: '2026-08-01T10:00:00Z', completion: completion(3, true) });
        }
        throw new Error(`unexpected fetch ${path}`);
      });
      return { calls, settled, maxOpen: () => maxOpen };
    }

    it('never lets an older value for a field land after a newer one', async () => {
      // The first write is slow and every later one is instant — the ordinary
      // shape of a flaky connection. Unserialized, the correction overtakes the
      // value it corrects, the server applies them in arrival order, and the
      // field ends up holding what the client typed *first*.
      const { settled, maxOpen } = mockSlowPortal([800, 0]);
      const user = userEvent.setup();
      render(<ClientIntakePage />);
      await screen.findByText('Welcome, Northwind Robotics');

      await user.type(screen.getByLabelText('Legal company name *'), 'Halcyon');
      // Wait for the slow write to be open before typing the correction.
      await waitFor(() => expect(maxOpen()).toBe(1), { timeout: 3000 });
      await user.type(screen.getByLabelText('Legal company name *'), ' Bio');
      await user.click(screen.getByRole('button', { name: 'Continue' }));

      await waitFor(() => expect(settled).toHaveLength(2), { timeout: 4000 });
      // Never two open at once, and the last thing the server saw is the last
      // thing the client typed.
      expect(maxOpen()).toBe(1);
      expect(settled[settled.length - 1]).toContain('Halcyon Bio');
    });

    it('does not submit ahead of the answers it is submitting', async () => {
      // A pending write already in flight used to make `flush` resolve
      // instantly — it found the pending set empty because the open write had
      // taken it — so /submit reached the server first and was judged against
      // answers that had not arrived.
      // answered: 0 keeps the form on its first section, where the field typed
      // below lives — `answered` now also decides which step a returning client
      // reopens on, and this test is about write ordering, not resumption.
      const { settled } = mockSlowPortal(400, { answered: 0, ready: true });
      const user = userEvent.setup();
      render(<ClientIntakePage />);
      await screen.findByText('Welcome, Northwind Robotics');

      await user.type(screen.getByLabelText('Legal company name *'), 'Halcyon');
      await user.click(screen.getByRole('button', { name: 'Review & submit' }));
      await user.click(screen.getByRole('button', { name: /Submit to Meridian Valuation/ }));

      expect(await screen.findByText('Thank you — that’s everything')).toBeInTheDocument();
      expect(settled[settled.length - 1]).toBe('SUBMIT');
      expect(settled.filter((s) => s.includes('Halcyon'))).not.toHaveLength(0);
    });

    it('refuses to submit when the answers could not be saved', async () => {
      const user = userEvent.setup();
      let submits = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const path = String(url);
        // answered: 0 so the form opens on the section holding the field below.
        if (path.endsWith('/intake/portal')) return jsonResponse(portalBody({ answered: 0, ready: true }));
        if (path.endsWith('/portal/answers')) return jsonResponse({ detail: 'Network hiccup' }, 503);
        if (path.endsWith('/portal/submit')) {
          submits += 1;
          return jsonResponse({ submitted_at: '2026-08-01T10:00:00Z', completion: completion(3, true) });
        }
        throw new Error(`unexpected fetch ${path}`);
      });

      render(<ClientIntakePage />);
      await screen.findByText('Welcome, Northwind Robotics');
      await user.type(screen.getByLabelText('Legal company name *'), 'Halcyon');
      await user.click(screen.getByRole('button', { name: 'Review & submit' }));
      await user.click(screen.getByRole('button', { name: /Submit to Meridian Valuation/ }));

      // The client is told what actually went wrong — a save that did not
      // land — rather than the server's "you left fields blank".
      expect(await screen.findByText(/could not be saved/)).toBeInTheDocument();
      expect(submits).toBe(0);
      expect(screen.queryByText('Thank you — that’s everything')).not.toBeInTheDocument();
    });
  });

  it('reports progress to assistive technology, not just visually', async () => {
    mockPortal({ portal: { answered: 2 } });
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    const bar = screen.getByRole('progressbar', { name: 'Intake completion' });
    expect(bar).toHaveAttribute('aria-valuenow', '67');
  });
});

/**
 * Moving around a questionnaire the client cannot finish in one sitting.
 *
 * The form is a wizard with three ways backwards — the Back button on a
 * section, the Back button on the review screen, and the numbered sidebar —
 * plus an Edit link per section on the review. Each runs its own handler, and
 * every one of them calls `goTo`, which flushes whatever the client had just
 * typed before it changes step. A back route that skipped that flush would
 * discard the answer the client typed last, which is the answer they were
 * still thinking about.
 */
describe('ClientIntakePage — moving between sections', () => {
  const heading = (title: string) => screen.findByRole('heading', { name: title, level: 2 });
  const step = (name: string) => screen.getByRole('button', { name: new RegExp(name) });

  it('goes back to the previous section without losing the answer just typed', async () => {
    const calls = mockPortal();
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await heading('Company information');

    await user.type(screen.getByLabelText(/Legal company name/), 'Northwind Robotics Ltd');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await heading('Legal & governance');

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await heading('Company information');
    expect(screen.getByLabelText(/Legal company name/)).toHaveValue('Northwind Robotics Ltd');
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/portal/answers'))).toBe(true));
  });

  it('cannot go back past the first section', async () => {
    mockPortal();
    render(<ClientIntakePage />);
    await heading('Company information');

    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  });

  it('jumps straight to a section from the sidebar', async () => {
    mockPortal();
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await heading('Company information');

    await user.click(step('Legal & governance'));
    await heading('Legal & governance');

    await user.click(step('Company information'));
    await heading('Company information');
  });

  it('opens the review from the sidebar and comes back out of it', async () => {
    mockPortal();
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await heading('Company information');

    await user.click(step('Review & submit'));
    await screen.findByRole('button', { name: /Submit/ });

    // Back from the review lands on the last section, not the first.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await heading('Legal & governance');
  });

  /** The point of the review: spot a gap, and go straight to the section with it. */
  it('sends the client to the section they chose to edit', async () => {
    mockPortal();
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await heading('Company information');

    await user.click(step('Review & submit'));
    const review = (await screen.findAllByRole('heading', { name: 'Company information', level: 2 }))[0]!;
    await user.click(within(review.closest('section')!).getByRole('button', { name: 'Edit' }));

    // Back on the form, on the section that was chosen, with its fields live.
    expect(await screen.findByLabelText(/Legal company name/)).toBeEnabled();
  });

  /** A submitted form shows the same review with nothing to edit. */
  it('offers no Edit links once the form has been submitted', async () => {
    mockPortal({ portal: { status: 'submitted', can_edit: false, submitted_at: '2026-08-01T10:00:00Z' } });
    render(<ClientIntakePage />);
    await screen.findByText(/that’s everything/);

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
});

describe('ClientIntakePage — the field types', () => {
  const answersFor = (calls: Call[]) =>
    calls.filter((c) => c.path.endsWith('/portal/answers')).map((c) => c.body.answers);

  it('records a long-form answer from the textarea', async () => {
    const calls = mockPortal();
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByLabelText(/Business description/);

    await user.type(screen.getByLabelText(/Business description/), 'Autonomous warehouse robots.');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(answersFor(calls).length).toBeGreaterThan(0));
    expect(answersFor(calls).at(-1)).toMatchObject({
      business_description: 'Autonomous warehouse robots.',
    });
  });

  /** The picker offers words; what is stored is a boolean, not the word. */
  it('records a yes/no answer as a boolean', async () => {
    const calls = mockPortal();
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByLabelText(/Legal company name/);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByLabelText(/Articles of incorporation available/);
    await user.selectOptions(screen.getByLabelText(/Articles of incorporation available/), 'yes');
    await user.click(screen.getByRole('button', { name: 'Review answers' }));

    await waitFor(() => expect(answersFor(calls).length).toBeGreaterThan(0));
    expect(answersFor(calls).at(-1)).toMatchObject({ has_articles: true });
  });

  /**
   * A `select` field renders its options from the questionnaire definition,
   * underscores turned back into spaces for the client to read — while the
   * value that goes back is the key the engine expects.
   */
  it('records a chosen option, showing it in the client’s words', async () => {
    const calls = mockPortal({
      portal: {
        sections: [
          {
            key: 'company',
            title: 'Company information',
            description: 'Tell us about the company being valued.',
            fields: [
              {
                key: 'entity_type',
                label: 'Entity type',
                type: 'select',
                required: true,
                options: ['c_corp', 'llc'],
              },
            ],
          },
        ],
      },
    });
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    const picker = await screen.findByLabelText(/Entity type/);

    expect(within(picker).getByRole('option', { name: 'c corp' })).toHaveValue('c_corp');
    await user.selectOptions(picker, 'c_corp');
    await user.click(screen.getByRole('button', { name: 'Review answers' }));

    await waitFor(() => expect(answersFor(calls).length).toBeGreaterThan(0));
    expect(answersFor(calls).at(-1)).toMatchObject({ entity_type: 'c_corp' });
  });
});

/**
 * Leaving the page mid-answer.
 *
 * The form tells the client, in as many words, that their answers save
 * automatically and they can close the page — and between the last keystroke
 * and the 900ms autosave there was nothing on the server. Closing the tab there
 * threw the answer away, reliably the last one, since that is when a form gets
 * abandoned.
 */
describe('ClientIntakePage — leaving before the autosave fires', () => {
  interface Sent {
    path: string;
    body: { token?: string; answers?: Record<string, unknown> };
    keepalive: boolean | undefined;
  }

  /** Same three endpoints, but recording the transport as well as the body. */
  function mockWithTransport(o: PortalOverrides = {}) {
    const sent: Sent[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const path = String(url);
      sent.push({
        path,
        body: init?.body ? (JSON.parse(String(init.body)) as Sent['body']) : {},
        keepalive: init?.keepalive,
      });
      if (path.endsWith('/intake/portal')) return jsonResponse(portalBody(o));
      if (path.endsWith('/portal/answers')) {
        const answers = (JSON.parse(String(init!.body)) as { answers: Record<string, unknown> }).answers;
        return jsonResponse({ answers, completion: completion(Object.keys(answers).length) });
      }
      throw new Error(`unexpected fetch ${path}`);
    });
    return sent;
  }

  const saves = (sent: Sent[]) => sent.filter((s) => s.path.endsWith('/portal/answers'));

  /** jsdom's visibilityState is a read-only getter; this is the only way in. */
  const setVisibility = (value: DocumentVisibilityState) =>
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });

  const hide = () => {
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
  };
  const show = () => {
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
  };

  afterEach(() => setVisibility('visible'));

  it('writes the answer back when the tab is hidden inside the debounce window', async () => {
    const sent = mockWithTransport();
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    await user.type(screen.getByLabelText('Legal company name *'), 'Halcyon Bio');
    // Nothing has been written yet — the debounce has not elapsed.
    expect(saves(sent)).toHaveLength(0);

    hide();

    // Asserted without waiting: a save that exists *now* cannot be the timer's.
    const beacon = saves(sent);
    expect(beacon).toHaveLength(1);
    expect(beacon[0]!.body.answers).toEqual({ legal_name: 'Halcyon Bio' });
    expect(beacon[0]!.body.token).toBe('intake-token-abc');
    // An ordinary fetch issued as the document tears down is cancelled.
    expect(beacon[0]!.keepalive).toBe(true);
  });

  it('sends nothing when there is nothing pending', async () => {
    const sent = mockWithTransport();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    hide();

    expect(saves(sent)).toHaveLength(0);
  });

  it('sends one request per departure, not one per event', async () => {
    const sent = mockWithTransport();
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    await user.type(screen.getByLabelText('Number of employees'), '42');
    // Closing a tab fires both, and the page has nothing new to say the second
    // time.
    hide();
    window.dispatchEvent(new Event('pagehide'));

    expect(saves(sent)).toHaveLength(1);
  });

  it('beacons again after the client comes back and leaves once more', async () => {
    const sent = mockWithTransport();
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    await user.type(screen.getByLabelText('Number of employees'), '42');
    hide();
    expect(saves(sent)).toHaveLength(1);

    show();
    hide();

    // The send is unobservable by construction, so a second departure with the
    // same answers still owes a second attempt — the first may never have
    // arrived.
    expect(saves(sent)).toHaveLength(2);
    expect(saves(sent)[1]!.body.answers).toEqual({ employee_count: 42 });
  });

  /**
   * The keepalive body quota is 64 KiB and a body over it makes `fetch` reject
   * rather than send. An intake answer may be 10,000 characters and several may
   * be pending, so the slice really can exceed it — and rejecting would turn a
   * save that would otherwise have worked into silence.
   */
  it('sends an over-quota body without keepalive rather than not at all', async () => {
    const sent = mockWithTransport();
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    // Pasted rather than typed: 70,000 characters is not a keystroke sequence.
    const long = 'x'.repeat(70_000);
    const box = screen.getByLabelText(/Business description/);
    await user.click(box);
    await user.paste(long);
    expect(saves(sent)).toHaveLength(0);

    hide();

    const beacon = saves(sent);
    expect(beacon).toHaveLength(1);
    expect((beacon[0]!.body.answers as Record<string, string>).business_description).toHaveLength(70_000);
    expect(beacon[0]!.keepalive).toBe(false);
  });

  /**
   * Measured in bytes rather than characters. A form filled in in a non-Latin
   * script is up to four bytes a character, and it is bytes the quota counts —
   * 40,000 characters of it is 120,000 bytes, well over.
   */
  it('counts the quota in bytes, not characters', async () => {
    const sent = mockWithTransport();
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    const box = screen.getByLabelText(/Business description/);
    await user.click(box);
    await user.paste('計'.repeat(40_000));

    hide();

    expect(saves(sent)[0]!.keepalive).toBe(false);
  });
});

/**
 * The sidebar reads "Not saved — retrying" on a failed write. Nothing retried:
 * the keys went back into `pending` and waited for another keystroke, a step
 * change or Submit, so a client whose connection blipped on their last answer
 * was shown a promise the page had no way of keeping.
 */
describe('ClientIntakePage — the retry the sidebar promises', () => {
  it('re-attempts a failed write without the client typing again', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const path = String(url);
      if (path.endsWith('/intake/portal')) return jsonResponse(portalBody());
      if (path.endsWith('/portal/answers')) {
        attempts += 1;
        if (attempts === 1) return jsonResponse({ detail: 'Network hiccup' }, 503);
        const answers = (JSON.parse(String(init!.body)) as { answers: Record<string, unknown> }).answers;
        return jsonResponse({ answers, completion: completion(1) });
      }
      throw new Error(`unexpected fetch ${path}`);
    });

    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');
    await user.type(screen.getByLabelText('Legal company name *'), 'Halcyon');

    expect(await screen.findByText('Network hiccup')).toBeInTheDocument();
    expect(screen.getByText('Not saved — retrying')).toBeInTheDocument();

    // No further typing, no step change, no Submit. The retry is the page's.
    await waitFor(() => expect(screen.getByText('All answers saved')).toBeInTheDocument(), {
      timeout: 6000,
    });
    expect(attempts).toBe(2);
  });

  it('keeps the answer the client typed through the retry', async () => {
    const user = userEvent.setup();
    const bodies: Array<Record<string, unknown>> = [];
    let attempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const path = String(url);
      if (path.endsWith('/intake/portal')) return jsonResponse(portalBody());
      if (path.endsWith('/portal/answers')) {
        attempts += 1;
        const answers = (JSON.parse(String(init!.body)) as { answers: Record<string, unknown> }).answers;
        bodies.push(answers);
        if (attempts <= 2) return jsonResponse({ detail: 'Network hiccup' }, 503);
        return jsonResponse({ answers, completion: completion(1) });
      }
      throw new Error(`unexpected fetch ${path}`);
    });

    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');
    await user.type(screen.getByLabelText('Legal company name *'), 'Halcyon');

    await waitFor(() => expect(screen.getByText('All answers saved')).toBeInTheDocument(), {
      timeout: 10_000,
    });
    // Every attempt carries the same answer, read fresh each time rather than
    // captured at the first failure.
    expect(bodies).toEqual([{ legal_name: 'Halcyon' }, { legal_name: 'Halcyon' }, { legal_name: 'Halcyon' }]);
  });
});

/**
 * When the link stops working.
 *
 * A firm sets the window per link — a day to a month — and the form's standing
 * promise is that the client can close the page and pick it up from the same
 * link. That promise has an end date, and the page had it on the wire
 * (`expires_at`, fetched and never read) without ever saying it. A prospect who
 * left a half-finished form for a fortnight came back to "This link isn't
 * available" and no warning they had ever been given.
 */
describe('ClientIntakePage — the link’s own deadline', () => {
  /**
   * Only `Date` is faked: the page's autosave and this file's `waitFor`s both
   * run on real timers, and faking those would stall them.
   */
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).toISOString();

  /**
   * The date as this host will render it. Asserting the literal `Sep 22, 2026`
   * would be an assertion about the machine's locale rather than about the
   * page — the same test reads `22. Sep. 2026` under a German one. What is
   * being pinned is *which day* is named, so the expectation is built the way
   * the page builds it, with a guard against the placeholder `formatDate`
   * returns for an unreadable date so the check cannot pass vacuously.
   */
  const shown = (isoDate: string) => {
    const text = formatDate(isoDate);
    expect(text).not.toBe('—');
    return text;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Local components on both sides, so the calendar-day arithmetic below
    // holds in whatever zone the suite runs in.
    vi.setSystemTime(new Date(2026, 7, 23, 9));
  });
  afterEach(() => vi.useRealTimers());

  it('names the date the link stops working, in the standing promise', async () => {
    mockPortal({ portal: { expires_at: at(2026, 8, 22) } });
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    const expiry = shown(at(2026, 8, 22));
    expect(
      screen.getByText(`pick it up from the same link until ${expiry}.`, { exact: false }),
    ).toBeInTheDocument();
    // A month out is a footnote, not a warning.
    expect(screen.queryByText(/you’ll need a fresh link/)).not.toBeInTheDocument();
  });

  it('says so plainly once the deadline is inside a week', async () => {
    mockPortal({ portal: { expires_at: at(2026, 7, 26) } });
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    expect(
      screen.getByText(`This link expires in 3 days (${shown(at(2026, 7, 26))}).`, { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByText(/you’ll need a fresh link/)).toBeInTheDocument();
    // The footnote gives way to the notice rather than doubling it.
    expect(screen.queryByText(/pick it up from the same link until/)).not.toBeInTheDocument();
  });

  /** "Expires in 0 days" is not something anyone says, and it is the day that matters. */
  it('calls the last day today, without a date in brackets', async () => {
    mockPortal({ portal: { expires_at: at(2026, 7, 23, 23) } });
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    const notice = screen.getByText(/This link expires today/);
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).not.toMatch(/\(/);
  });

  it('calls the next day tomorrow', async () => {
    mockPortal({ portal: { expires_at: at(2026, 7, 24) } });
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    expect(
      screen.getByText(`This link expires tomorrow (${shown(at(2026, 7, 24))}).`, { exact: false }),
    ).toBeInTheDocument();
  });

  /**
   * A converted or submitted link is the firm's business now. Telling the
   * client a deadline for a form they can no longer change is noise.
   */
  it('says nothing about a deadline on a form that is closed to changes', async () => {
    mockPortal({ portal: { can_edit: false, status: 'converted', expires_at: at(2026, 7, 24) } });
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    expect(screen.getByText(/no longer accepting changes/)).toBeInTheDocument();
    expect(screen.queryByText(/expires/)).not.toBeInTheDocument();
    expect(screen.queryByText(/pick it up from the same link until/)).not.toBeInTheDocument();
  });
});
