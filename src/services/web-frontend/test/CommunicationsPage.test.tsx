import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CommunicationsPage } from '../src/pages/CommunicationsPage';
import type { AutoEmail, CommunicationTemplate, TemplateVariable } from '../src/lib/types';

/**
 * Communications admin — the templates a client's email is rendered from, and
 * the drip campaigns that send them.
 *
 * Everything on this page writes something a client eventually reads, and most
 * of it is destructive or close to it: a saved template changes the next
 * hundred emails, a deleted one silently falls the workflow back to built-in
 * content, and a campaign toggled on starts sending. So the assertions here are
 * mostly about *what request was made* rather than what the screen says — the
 * screen is downstream of the request, and it is the request that reaches a
 * mailbox.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const templates: CommunicationTemplate[] = [
  {
    id: '01N409CT000000000000000001',
    key: 'draft_ready',
    channel: 'email',
    category: 'open',
    description: 'Sent when a draft is ready.',
    subject: 'Your draft {{kind_label}} valuation is ready',
    body: 'A draft for {{company_name}} is ready.',
    enabled: true,
    updated_by: null,
    created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-01T10:00:00Z',
  },
  {
    id: '01N409CT000000000000000008',
    key: 'sms_payment_reminder',
    channel: 'sms',
    category: 'drafted',
    description: 'Payment reminder text.',
    subject: '',
    body: '{{company_name}}: payment pending.',
    enabled: false,
    updated_by: null,
    created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-01T10:00:00Z',
  },
];

const autoEmails: AutoEmail[] = [
  {
    id: '01N409AE000000000000000001',
    name: 'payment_reminder_1',
    channel: 'email',
    trigger_state: 'started',
    condition: 'unpaid',
    delay_hours: 72,
    repeat_hours: null,
    max_sends: 1,
    template_key: 'payment_reminder',
    enabled: true,
    // A payment nudge is about work the client asked for, not marketing.
    promotional: false,
    created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-01T10:00:00Z',
  },
];

const variables: TemplateVariable[] = [
  {
    name: 'company_name',
    scope: 'always',
    description: 'The client company',
    sample: 'Northwind Robotics, Inc.',
  },
  { name: 'kind_label', scope: 'valuation', description: 'The deliverable', sample: '409A' },
  { name: 'portal_link', scope: 'link', description: 'Client portal', sample: 'https://…' },
];

/** Every request the page made, in order, for asserting on writes. */
interface Call {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
}

interface ApiOptions {
  /** Per-route overrides, matched on `${method} ${path-fragment}`. */
  fail?: Record<string, { status: number; problem?: unknown }>;
  templates?: CommunicationTemplate[];
  autoEmails?: AutoEmail[];
  categories?: Array<{ key: CommunicationTemplate['category']; label: string; count: number }>;
  variables?: TemplateVariable[] | 'unavailable';
  /** Body for `POST /admin/auto-emails/run`; defaults to a plain two-queued pass. */
  scanResult?: Record<string, unknown>;
}

function mockApi(opts: ApiOptions = {}) {
  const calls: Call[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    calls.push({
      path,
      method,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });

    const failure = Object.entries(opts.fail ?? {}).find(
      ([key]) => key.startsWith(`${method} `) && path.includes(key.slice(method.length + 1)),
    );
    if (failure) {
      const [, { status, problem }] = failure;
      return jsonResponse(problem ?? { title: 'Failed', status }, status);
    }

    if (path.includes('/communication-templates/variables')) {
      if (opts.variables === 'unavailable') return jsonResponse({ title: 'Gone', status: 404 }, 404);
      return jsonResponse({ variables: opts.variables ?? variables });
    }
    if (path.includes('/preview')) {
      return jsonResponse({
        subject: 'Your draft 409A valuation is ready',
        body: 'A draft for Northwind Robotics, Inc. is ready.',
        unknown_variables: [],
      });
    }
    if (path.includes('/admin/communication-templates') && method === 'GET') {
      return jsonResponse({
        templates: opts.templates ?? templates,
        ...(opts.categories ? { categories: opts.categories } : {}),
      });
    }
    if (path.includes('/admin/auto-emails/run'))
      return jsonResponse(opts.scanResult ?? { queued: 2, skipped: 1 });
    if (path.includes('/admin/auto-emails') && method === 'GET') {
      return jsonResponse({ auto_emails: opts.autoEmails ?? autoEmails });
    }
    // Every write that has not been told to fail succeeds with no content, the
    // way the service answers a PATCH or a DELETE.
    if (method !== 'GET') return new Response(null, { status: 204 });
    throw new Error(`unexpected fetch ${method} ${path}`);
  });
  return { calls, spy };
}

/** `window.confirm`, answered. Typed here so the spy's type is not inferred loose. */
const confirming = (answer: boolean) => vi.spyOn(window, 'confirm').mockReturnValue(answer);

const wrote = (calls: Call[], method: string, fragment: string) =>
  calls.find((c) => c.method === method && c.path.includes(fragment));

function renderPage() {
  return render(
    <MemoryRouter>
      <CommunicationsPage />
    </MemoryRouter>,
  );
}

/** Opens the Auto emails tab and waits for it to have loaded. */
async function autoEmailsTab(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText('draft_ready');
  await user.click(screen.getByRole('button', { name: 'Auto emails' }));
  return screen.findByRole('button', { name: 'New campaign' });
}

describe('CommunicationsPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('lists templates with channel and enabled state', async () => {
    mockApi();
    renderPage();

    expect(await screen.findByText('draft_ready')).toBeInTheDocument();
    expect(screen.getByText('sms_payment_reminder')).toBeInTheDocument();
    expect(screen.getByText('SMS')).toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });

  it('marks the SMS channel as preview in the badge (P2-4)', async () => {
    mockApi();
    renderPage();
    await screen.findByText('sms_payment_reminder');
    // The SMS template's channel badge carries a "Preview" marker.
    expect(screen.getByText('Preview')).toBeInTheDocument();
  });

  it('warns that SMS is preview-only when composing an SMS template (P2-4)', async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();
    await screen.findByText('draft_ready');

    await user.click(screen.getByRole('button', { name: 'New template' }));
    // Email is the default channel — no preview warning yet.
    expect(screen.queryByText(/SMS is in preview/i)).not.toBeInTheDocument();

    // Named, not positional: the editor grew a Category select alongside the
    // Channel one, and `getByRole('combobox')` now finds both.
    await user.selectOptions(screen.getByRole('combobox', { name: /channel/i }), 'sms');
    expect(await screen.findByText(/SMS is in preview/i)).toBeInTheDocument();
  });

  it('shows auto email campaigns with schedule summary on the Auto emails tab', async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();
    await autoEmailsTab(user);

    expect(await screen.findByText('payment_reminder_1')).toBeInTheDocument();
    expect(screen.getByText('after 72h')).toBeInTheDocument();
    expect(screen.getByText('Unpaid')).toBeInTheDocument();
  });

  it('runs the drip scan on demand and reports the result', async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();
    await autoEmailsTab(user);
    await user.click(screen.getByRole('button', { name: 'Run scan now' }));

    expect(await screen.findByText('Scan complete — 2 queued, 1 skipped.')).toBeInTheDocument();
  });

  /*
   * R414 (M5). R340 gave the declined pass its own flag *for this button* —
   * "the operator who pressed the button is told 'nothing to send' rather than
   * 'your scan did not happen'" — and the button went on reading `queued` and
   * `skipped`, so a scan that never ran drew four zeros in the success colour.
   * `withSweepLock` can leave the key held by nobody, after which every pass
   * declines forever with only an `info` to say so.
   */
  it('does not report a declined scan as a scan with nothing to send', async () => {
    const user = userEvent.setup();
    mockApi({ scanResult: { queued: 0, skipped: 0, suppressed: 0, failed: 0, declined: true } });
    renderPage();
    await autoEmailsTab(user);
    await user.click(screen.getByRole('button', { name: 'Run scan now' }));

    const alert = await screen.findByText(/The scan did not run/);
    expect(alert).toHaveTextContent('holding the campaign scan lock');
    expect(screen.queryByText(/Scan complete/)).not.toBeInTheDocument();
  });

  it('names the candidates the scan threw on, and the ones it withheld', async () => {
    const user = userEvent.setup();
    mockApi({
      scanResult: { queued: 2, skipped: 1, suppressed: 3, failed: 2, declined: false },
    });
    renderPage();
    await autoEmailsTab(user);
    await user.click(screen.getByRole('button', { name: 'Run scan now' }));

    expect(
      await screen.findByText(
        'Scan complete \u2014 2 queued, 1 skipped, 3 withheld for want of marketing consent.',
      ),
    ).toBeInTheDocument();
    const alert = await screen.findByText(/2 candidates could not be processed/);
    expect(alert).toHaveTextContent('Check the service log');
  });

  it('shows an ops-only note on 403', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ title: 'Forbidden', status: 403 }, 403),
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Communication settings are operations-only.')).toBeInTheDocument();
    });
  });

  describe('the templates table', () => {
    it('reports a load failure that is not a permission problem', async () => {
      mockApi({ fail: { 'GET /admin/communication-templates': { status: 500 } } });
      renderPage();
      expect(await screen.findByText('Could not load templates.')).toBeInTheDocument();
    });

    it('offers an empty state rather than a bare table', async () => {
      mockApi({ templates: [] });
      renderPage();
      expect(await screen.findByText('No templates yet')).toBeInTheDocument();
    });

    it('names the placeholders nothing will supply at send time', async () => {
      // Computed by the server on every read, because the catalog moves under a
      // template that was correct when it was saved.
      mockApi({
        templates: [{ ...templates[0]!, unknown_variables: ['invoice_total', 'partner_name'] }],
      });
      renderPage();
      expect(
        await screen.findByText(/Unsupplied: \{\{invoice_total\}\}, \{\{partner_name\}\}/),
      ).toBeInTheDocument();
    });

    it('filters by category, asking the server rather than the browser', async () => {
      // The counts are over the whole table by design, so the strip does not
      // collapse to "the one I am looking at" once a filter is applied.
      const user = userEvent.setup();
      const { calls } = mockApi({
        categories: [
          { key: 'open', label: 'Open', count: 4 },
          { key: 'drafted', label: 'Drafted', count: 2 },
        ],
      });
      renderPage();
      await screen.findByText('draft_ready');
      expect(screen.getByText('4')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /^Drafted/ }));
      await waitFor(() => {
        expect(wrote(calls, 'GET', 'communication-templates?category=drafted')).toBeDefined();
      });
      // Still showing the whole-table counts after the filter.
      expect(screen.getByText('4')).toBeInTheDocument();
    });
  });

  describe('editing a template', () => {
    it('creates one from the editor', async () => {
      const user = userEvent.setup();
      const { calls } = mockApi();
      renderPage();
      await screen.findByText('draft_ready');

      await user.click(screen.getByRole('button', { name: 'New template' }));
      await user.type(screen.getByRole('textbox', { name: /key/i }), 'invoice_due');
      await user.type(screen.getByRole('textbox', { name: /subject/i }), 'Invoice due');
      await user.type(screen.getByRole('textbox', { name: /body/i }), 'Your invoice is due.');
      await user.click(screen.getByRole('button', { name: 'Create template' }));

      await waitFor(() => {
        const post = wrote(calls, 'POST', '/admin/communication-templates');
        expect(post?.body).toMatchObject({
          key: 'invoice_due',
          channel: 'email',
          category: 'account',
          subject: 'Invoice due',
          body: 'Your invoice is due.',
          enabled: true,
        });
      });
      // The editor closes and the table is re-read, so the new row appears.
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Create template' })).not.toBeInTheDocument();
      });
    });

    it('patches an existing one, and does not offer to rename its key', async () => {
      // The key is what a workflow looks a template up by; changing it in place
      // would silently detach the override from the workflow that used it.
      const user = userEvent.setup();
      const { calls } = mockApi();
      renderPage();
      await screen.findByText('draft_ready');

      await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
      expect(screen.getByRole('textbox', { name: /key/i })).toBeDisabled();
      expect(screen.getByRole('combobox', { name: /channel/i })).toBeDisabled();

      await user.clear(screen.getByRole('textbox', { name: /description/i }));
      await user.type(screen.getByRole('textbox', { name: /description/i }), 'Draft is ready to review.');
      await user.click(screen.getByRole('button', { name: 'Save template' }));

      await waitFor(() => {
        const patch = wrote(calls, 'PATCH', '/admin/communication-templates/01N409CT000000000000000001');
        expect(patch?.body).toMatchObject({ description: 'Draft is ready to review.', category: 'open' });
        // Not in the payload at all — the server would reject it and the UI
        // should not be asking.
        expect(patch?.body).not.toHaveProperty('key');
      });
    });

    it('surfaces a rejected save without closing the editor', async () => {
      const user = userEvent.setup();
      mockApi({
        fail: {
          'POST /admin/communication-templates': {
            status: 409,
            problem: { title: 'Conflict', detail: 'A template with that key exists.', status: 409 },
          },
        },
      });
      renderPage();
      await screen.findByText('draft_ready');

      await user.click(screen.getByRole('button', { name: 'New template' }));
      await user.type(screen.getByRole('textbox', { name: /key/i }), 'draft_ready');
      await user.type(screen.getByRole('textbox', { name: /subject/i }), 'Ready');
      await user.type(screen.getByRole('textbox', { name: /body/i }), 'Ready.');
      await user.click(screen.getByRole('button', { name: 'Create template' }));

      expect(await screen.findByText('A template with that key exists.')).toBeInTheDocument();
      // Still open, with the operator's text in it.
      expect(screen.getByRole('button', { name: 'Create template' })).toBeInTheDocument();
    });

    it('drops the subject field for an SMS template, which has none', async () => {
      const user = userEvent.setup();
      mockApi();
      renderPage();
      await screen.findByText('draft_ready');

      await user.click(screen.getByRole('button', { name: 'New template' }));
      expect(screen.getByRole('textbox', { name: /subject/i })).toBeInTheDocument();
      await user.selectOptions(screen.getByRole('combobox', { name: /channel/i }), 'sms');
      expect(screen.queryByRole('textbox', { name: /subject/i })).not.toBeInTheDocument();
    });

    it('closes without writing anything when cancelled', async () => {
      const user = userEvent.setup();
      const { calls } = mockApi();
      renderPage();
      await screen.findByText('draft_ready');

      await user.click(screen.getByRole('button', { name: 'New template' }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('button', { name: 'Create template' })).not.toBeInTheDocument();
      expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    });
  });

  describe('the variable palette', () => {
    it('inserts a variable at the cursor of the field last focused', async () => {
      // The alternative is an operator typing `{{valuation_date}}` by hand, and
      // a typo there is an email a client reads with braces in it.
      const user = userEvent.setup();
      mockApi();
      renderPage();
      await screen.findByText('draft_ready');
      await user.click(screen.getByRole('button', { name: 'New template' }));

      const body = screen.getByRole('textbox', { name: /body/i });
      await user.click(body);
      await user.click(screen.getByRole('button', { name: 'company_name' }));
      expect(body).toHaveValue('{{company_name}}');
      // The subject is untouched — focus decided where it went, not order.
      expect(screen.getByRole('textbox', { name: /subject/i })).toHaveValue('');
    });

    it('inserts into the subject when that is the field being edited', async () => {
      const user = userEvent.setup();
      mockApi();
      renderPage();
      await screen.findByText('draft_ready');
      await user.click(screen.getByRole('button', { name: 'New template' }));

      const subject = screen.getByRole('textbox', { name: /subject/i });
      await user.click(subject);
      await user.click(screen.getByRole('button', { name: 'kind_label' }));
      expect(subject).toHaveValue('{{kind_label}}');
    });

    it('groups the palette by where a variable comes from', async () => {
      const user = userEvent.setup();
      mockApi();
      renderPage();
      await screen.findByText('draft_ready');
      await user.click(screen.getByRole('button', { name: 'New template' }));

      expect(screen.getByText('Always available')).toBeInTheDocument();
      expect(screen.getByText('Engagement')).toBeInTheDocument();
      expect(screen.getByText('Links')).toBeInTheDocument();
    });

    it('leaves a scope out entirely when nothing is in it', async () => {
      const user = userEvent.setup();
      mockApi({ variables: [variables[0]!] });
      renderPage();
      await screen.findByText('draft_ready');
      await user.click(screen.getByRole('button', { name: 'New template' }));

      expect(screen.getByText('Always available')).toBeInTheDocument();
      expect(screen.queryByText('Links')).not.toBeInTheDocument();
    });

    it('still opens the editor when the catalog could not be fetched', async () => {
      // A missing palette degrades to typing variables by hand, which is what
      // this page did before it existed. It must not cost the editor.
      const user = userEvent.setup();
      mockApi({ variables: 'unavailable' });
      renderPage();
      await screen.findByText('draft_ready');
      await user.click(screen.getByRole('button', { name: 'New template' }));

      expect(screen.getByRole('button', { name: 'Create template' })).toBeInTheDocument();
      expect(screen.queryByText('Always available')).not.toBeInTheDocument();
    });

    it('warns about a placeholder no variable supplies, and still allows the save', async () => {
      // The catalog grows; a variable somebody is expecting may simply not
      // exist yet, and refusing the save would be the wrong call on a guess.
      const user = userEvent.setup();
      const { calls } = mockApi();
      renderPage();
      await screen.findByText('draft_ready');

      await user.click(screen.getByRole('button', { name: 'New template' }));
      await user.type(screen.getByRole('textbox', { name: /key/i }), 'nudge');
      // `{{` is userEvent's escape for a literal `{`, so a placeholder has to
      // be typed with the braces doubled or the field ends up holding
      // `{invoice_total}}` and the warning correctly does not fire.
      await user.type(screen.getByRole('textbox', { name: /subject/i }), 'Hi {{{{company_name}}');
      await user.type(screen.getByRole('textbox', { name: /body/i }), 'Due {{{{invoice_total}} soon.');
      expect(screen.getByRole('textbox', { name: /body/i })).toHaveValue('Due {{invoice_total}} soon.');

      // The warning interpolates the list, so the sentence is split across text
      // nodes — matched on the rendered text of the element that carries it.
      const [warning] = await screen.findAllByText((_, el) =>
        (el?.textContent ?? '').startsWith('Nothing supplies {{invoice_total}}.'),
      );
      expect(warning).toBeDefined();
      // The one that *is* declared is not named in the warning.
      expect(warning!.textContent).not.toContain('company_name');

      await user.click(screen.getByRole('button', { name: 'Create template' }));
      await waitFor(() => expect(wrote(calls, 'POST', '/admin/communication-templates')).toBeDefined());
    });
  });

  describe('previewing a template', () => {
    it('renders what is on screen against sample data', async () => {
      // The editor's content is usually not the table's yet, so the preview has
      // to be of the unsaved text.
      const user = userEvent.setup();
      const { calls } = mockApi();
      renderPage();
      await screen.findByText('draft_ready');

      await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
      await user.click(screen.getByRole('button', { name: 'Preview' }));

      expect(await screen.findByText('Preview (sample data)')).toBeInTheDocument();
      expect(screen.getByText('A draft for Northwind Robotics, Inc. is ready.')).toBeInTheDocument();
      const post = wrote(calls, 'POST', '/preview');
      expect(post?.body).toMatchObject({ subject: templates[0]!.subject, body: templates[0]!.body });
      expect(post?.body).not.toHaveProperty('valuation_id');
    });

    it('renders against a named engagement when one is given', async () => {
      // A template reads fine against "Acme Corp" and falls apart against a
      // company whose legal name runs to sixty characters.
      const user = userEvent.setup();
      const { calls } = mockApi();
      renderPage();
      await screen.findByText('draft_ready');

      await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
      await user.type(screen.getByRole('textbox', { name: /preview against/i }), '  01JQREAL  ');
      await user.click(screen.getByRole('button', { name: 'Preview' }));

      expect(await screen.findByText('Preview (this engagement)')).toBeInTheDocument();
      expect(wrote(calls, 'POST', '/preview')?.body).toMatchObject({ valuation_id: '01JQREAL' });
    });

    it('says which engagement id was wrong rather than "preview failed"', async () => {
      const user = userEvent.setup();
      mockApi({ fail: { 'POST /preview': { status: 404 } } });
      renderPage();
      await screen.findByText('draft_ready');

      await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
      await user.type(screen.getByRole('textbox', { name: /preview against/i }), '01JQMISSING');
      await user.click(screen.getByRole('button', { name: 'Preview' }));

      expect(await screen.findByText('No engagement with that id.')).toBeInTheDocument();
    });

    it('reports any other preview failure plainly', async () => {
      const user = userEvent.setup();
      mockApi({ fail: { 'POST /preview': { status: 500 } } });
      renderPage();
      await screen.findByText('draft_ready');

      await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
      await user.click(screen.getByRole('button', { name: 'Preview' }));

      expect(await screen.findByText('Preview failed.')).toBeInTheDocument();
    });

    it('does not offer a preview for a template that does not exist yet', async () => {
      // There is nothing on the server to render against.
      const user = userEvent.setup();
      mockApi();
      renderPage();
      await screen.findByText('draft_ready');

      await user.click(screen.getByRole('button', { name: 'New template' }));
      expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
    });
  });

  describe('deleting a template', () => {
    let confirmSpy: ReturnType<typeof confirming> | undefined;

    afterEach(() => confirmSpy?.mockRestore());

    it('asks first, and names the template it is about to remove', async () => {
      const user = userEvent.setup();
      const { calls } = mockApi();
      confirmSpy = confirming(true);
      renderPage();
      await screen.findByText('draft_ready');

      await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
      expect(confirmSpy).toHaveBeenCalledWith('Delete template "draft_ready"?');
      await waitFor(() => {
        expect(wrote(calls, 'DELETE', '/01N409CT000000000000000001')).toBeDefined();
      });
    });

    it('does nothing at all when the operator says no', async () => {
      const user = userEvent.setup();
      const { calls } = mockApi();
      confirmSpy = confirming(false);
      renderPage();
      await screen.findByText('draft_ready');

      await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    });

    it('keeps the table on screen when the delete is refused', async () => {
      const user = userEvent.setup();
      mockApi({
        fail: {
          'DELETE /admin/communication-templates': {
            status: 409,
            problem: { detail: 'A campaign still references it.', status: 409 },
          },
        },
      });
      confirmSpy = confirming(true);
      renderPage();
      await screen.findByText('draft_ready');

      await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
      expect(await screen.findByText('A campaign still references it.')).toBeInTheDocument();
      expect(screen.getByText('draft_ready')).toBeInTheDocument();
    });
  });

  describe('drip campaigns', () => {
    it('reports a load failure that is not a permission problem', async () => {
      const user = userEvent.setup();
      mockApi({ fail: { 'GET /admin/auto-emails': { status: 500 } } });
      renderPage();
      await screen.findByText('draft_ready');
      await user.click(screen.getByRole('button', { name: 'Auto emails' }));

      expect(await screen.findByText('Could not load auto emails.')).toBeInTheDocument();
    });

    it('offers an empty state when no campaign has been set up', async () => {
      const user = userEvent.setup();
      mockApi({ autoEmails: [] });
      renderPage();
      await autoEmailsTab(user);

      expect(await screen.findByText('No auto email campaigns')).toBeInTheDocument();
    });

    it('separates a marketing campaign from a transactional one', async () => {
      // The CAN-SPAM/GDPR distinction: one is gated on consent and carries an
      // unsubscribe footer, the other must never be silenced by an opt-out.
      const user = userEvent.setup();
      mockApi({
        autoEmails: [
          autoEmails[0]!,
          {
            ...autoEmails[0]!,
            id: '01N409AE000000000000000002',
            name: 'quarterly_digest',
            promotional: true,
            enabled: false,
            repeat_hours: 24,
            max_sends: 3,
          },
        ],
      });
      renderPage();
      await autoEmailsTab(user);

      expect(await screen.findByText('transactional')).toBeInTheDocument();
      expect(screen.getByText('promotional')).toBeInTheDocument();
      // The repeat and cap are spelled out in the schedule cell.
      expect(screen.getByText('after 72h, every 24h, max 3')).toBeInTheDocument();
    });

    it('creates a campaign from the editor', async () => {
      const user = userEvent.setup();
      const { calls } = mockApi();
      renderPage();
      await autoEmailsTab(user);

      await user.click(screen.getByRole('button', { name: 'New campaign' }));
      await user.type(screen.getByRole('textbox', { name: /name/i }), 'nudge_1');
      await user.selectOptions(screen.getByRole('combobox', { name: /template/i }), 'draft_ready');
      await user.selectOptions(screen.getByRole('combobox', { name: /condition/i }), 'no_documents');
      await user.clear(screen.getByRole('spinbutton', { name: /delay/i }));
      await user.type(screen.getByRole('spinbutton', { name: /delay/i }), '48');
      await user.type(screen.getByRole('spinbutton', { name: /repeat/i }), '12');
      await user.click(screen.getByLabelText(/^Promotional/));
      await user.click(screen.getByRole('button', { name: 'Create campaign' }));

      await waitFor(() => {
        expect(wrote(calls, 'POST', '/admin/auto-emails')?.body).toMatchObject({
          name: 'nudge_1',
          channel: 'email',
          condition: 'no_documents',
          delay_hours: 48,
          repeat_hours: 12,
          template_key: 'draft_ready',
          promotional: true,
        });
      });
    });

    it('sends a blank repeat as null rather than as an empty string', async () => {
      // "Blank = send once" is the hint on the field, and `''` is not what the
      // column means by once.
      const user = userEvent.setup();
      const { calls } = mockApi();
      renderPage();
      await autoEmailsTab(user);

      await user.click(screen.getByRole('button', { name: 'New campaign' }));
      await user.type(screen.getByRole('textbox', { name: /name/i }), 'once_only');
      await user.selectOptions(screen.getByRole('combobox', { name: /template/i }), 'draft_ready');
      await user.click(screen.getByRole('button', { name: 'Create campaign' }));

      await waitFor(() => {
        expect(wrote(calls, 'POST', '/admin/auto-emails')?.body).toMatchObject({ repeat_hours: null });
      });
    });

    it('re-offers the templates of whichever channel is chosen', async () => {
      // A campaign pointing at a template of the other channel is a send that
      // fails at delivery time; the selection is cleared rather than carried.
      const user = userEvent.setup();
      mockApi();
      renderPage();
      await autoEmailsTab(user);

      await user.click(screen.getByRole('button', { name: 'New campaign' }));
      const template = screen.getByRole('combobox', { name: /template/i });
      await user.selectOptions(template, 'draft_ready');
      expect(template).toHaveValue('draft_ready');

      await user.selectOptions(screen.getByRole('combobox', { name: /channel/i }), 'sms');
      expect(template).toHaveValue('');
      expect(within(template).getByRole('option', { name: 'sms_payment_reminder' })).toBeInTheDocument();
      expect(within(template).queryByRole('option', { name: 'draft_ready' })).not.toBeInTheDocument();
      expect(screen.getByText(/SMS is in preview/i)).toBeInTheDocument();
    });

    it('patches an existing campaign without renaming it', async () => {
      const user = userEvent.setup();
      // Pointed at a template the list actually holds: the Template select is
      // required, and a campaign whose stored key is not among the current
      // channel's templates renders it empty, which blocks the submit.
      const { calls } = mockApi({
        autoEmails: [{ ...autoEmails[0]!, template_key: 'draft_ready' }],
      });
      renderPage();
      await autoEmailsTab(user);

      await user.click(screen.getByRole('button', { name: 'Edit' }));
      expect(screen.getByRole('textbox', { name: /name/i })).toBeDisabled();
      await user.clear(screen.getByRole('spinbutton', { name: /max sends/i }));
      await user.type(screen.getByRole('spinbutton', { name: /max sends/i }), '3');
      await user.click(screen.getByRole('button', { name: 'Save campaign' }));

      await waitFor(() => {
        const patch = wrote(calls, 'PATCH', '/admin/auto-emails/01N409AE000000000000000001');
        expect(patch?.body).toMatchObject({ max_sends: 3, condition: 'unpaid' });
        expect(patch?.body).not.toHaveProperty('name');
      });
    });

    it('surfaces a rejected campaign save', async () => {
      const user = userEvent.setup();
      mockApi({
        fail: {
          'POST /admin/auto-emails': {
            status: 422,
            problem: { detail: 'No template with that key.', status: 422 },
          },
        },
      });
      renderPage();
      await autoEmailsTab(user);

      await user.click(screen.getByRole('button', { name: 'New campaign' }));
      await user.type(screen.getByRole('textbox', { name: /name/i }), 'broken');
      await user.selectOptions(screen.getByRole('combobox', { name: /template/i }), 'draft_ready');
      await user.click(screen.getByRole('button', { name: 'Create campaign' }));

      expect(await screen.findByText('No template with that key.')).toBeInTheDocument();
    });

    it('closes the campaign editor without writing when cancelled', async () => {
      const user = userEvent.setup();
      const { calls } = mockApi();
      renderPage();
      await autoEmailsTab(user);

      await user.click(screen.getByRole('button', { name: 'New campaign' }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('button', { name: 'Create campaign' })).not.toBeInTheDocument();
      expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    });

    it('stops a running campaign from the row', async () => {
      const user = userEvent.setup();
      const { calls } = mockApi();
      renderPage();
      await autoEmailsTab(user);

      await user.click(screen.getByRole('button', { name: 'Disable' }));
      await waitFor(() => {
        expect(wrote(calls, 'PATCH', '/admin/auto-emails/01N409AE000000000000000001')?.body).toEqual({
          enabled: false,
        });
      });
    });

    it('reports a toggle that did not take', async () => {
      const user = userEvent.setup();
      // The server's reason reaches the reader. These three handlers were bare
      // `catch` blocks with no binding, so a refusal that explained itself read
      // identically to one that did not (R350).
      mockApi({
        fail: {
          'PATCH /admin/auto-emails': {
            status: 409,
            problem: { detail: 'This campaign is mid-send; pause it before changing it.', status: 409 },
          },
        },
      });
      renderPage();
      await autoEmailsTab(user);

      await user.click(screen.getByRole('button', { name: 'Disable' }));
      expect(
        await screen.findByText('This campaign is mid-send; pause it before changing it.'),
      ).toBeInTheDocument();
    });

    it('asks before deleting a campaign, and names it', async () => {
      const user = userEvent.setup();
      const { calls } = mockApi();
      const confirmSpy = confirming(true);
      renderPage();
      await autoEmailsTab(user);

      await user.click(screen.getByRole('button', { name: 'Delete' }));
      expect(confirmSpy).toHaveBeenCalledWith('Delete campaign "payment_reminder_1"?');
      await waitFor(() => {
        expect(wrote(calls, 'DELETE', '/admin/auto-emails/01N409AE000000000000000001')).toBeDefined();
      });
      confirmSpy.mockRestore();
    });

    it('does nothing when the delete is declined', async () => {
      const user = userEvent.setup();
      const { calls } = mockApi();
      const confirmSpy = confirming(false);
      renderPage();
      await autoEmailsTab(user);

      await user.click(screen.getByRole('button', { name: 'Delete' }));
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
      confirmSpy.mockRestore();
    });

    it('reports a delete the server refused', async () => {
      const user = userEvent.setup();
      mockApi({
        fail: {
          'DELETE /admin/auto-emails': {
            status: 409,
            problem: { detail: 'Messages from this campaign are still queued.', status: 409 },
          },
        },
      });
      const confirmSpy = confirming(true);
      renderPage();
      await autoEmailsTab(user);

      await user.click(screen.getByRole('button', { name: 'Delete' }));
      expect(await screen.findByText('Messages from this campaign are still queued.')).toBeInTheDocument();
      confirmSpy.mockRestore();
    });

    it('reports a scan that failed', async () => {
      const user = userEvent.setup();
      // No `detail` on this one, which is the other half: the operation still
      // has to be named, and "Scan failed." was a fragment rather than a
      // sentence the status prose could follow.
      mockApi({ fail: { 'POST /admin/auto-emails/run': { status: 500 } } });
      renderPage();
      await autoEmailsTab(user);

      await user.click(screen.getByRole('button', { name: 'Run scan now' }));
      const alert = await screen.findByText(/The campaign scan did not run\./);
      expect(alert).toHaveTextContent('500');
      expect(alert).not.toHaveTextContent('Failed');
    });
  });

  /**
   * R29 — both editors carried `required` and `pattern` and left the checking
   * to the browser. Everything asserted here is a constraint one of the
   * controls still declares as an attribute; the point is that the page now
   * refuses it itself, and names the box rather than showing a tooltip.
   */
  describe('editor validation', () => {
    it('refuses a template key that is not a slug', async () => {
      const user = userEvent.setup();
      const { calls } = mockApi();
      renderPage();
      await screen.findByText('draft_ready');

      await user.click(screen.getByRole('button', { name: 'New template' }));
      await user.type(screen.getByRole('textbox', { name: /key/i }), 'Payment Reminder!');
      await user.type(screen.getByRole('textbox', { name: /subject/i }), 'Due');
      await user.type(screen.getByRole('textbox', { name: /body/i }), 'Text.');
      await user.click(screen.getByRole('button', { name: 'Create template' }));

      expect(
        await screen.findByText('Use lower-case letters, digits and underscores only.'),
      ).toBeInTheDocument();
      expect(wrote(calls, 'POST', '/admin/communication-templates')).toBeUndefined();
    });

    it('will not create a template with an empty body', async () => {
      const user = userEvent.setup();
      const { calls } = mockApi();
      renderPage();
      await screen.findByText('draft_ready');

      await user.click(screen.getByRole('button', { name: 'New template' }));
      await user.type(screen.getByRole('textbox', { name: /key/i }), 'invoice_due');
      await user.type(screen.getByRole('textbox', { name: /subject/i }), 'Invoice due');
      await user.click(screen.getByRole('button', { name: 'Create template' }));

      expect(await screen.findByText('Body is required.')).toBeInTheDocument();
      expect(wrote(calls, 'POST', '/admin/communication-templates')).toBeUndefined();
    });

    it('does not demand a subject for an SMS template, which has no subject box', async () => {
      // The subject field is not rendered on the SMS channel, so a rule that
      // ignored the channel would fail the form on a box nobody can see.
      const user = userEvent.setup();
      const { calls } = mockApi();
      renderPage();
      await screen.findByText('draft_ready');

      await user.click(screen.getByRole('button', { name: 'New template' }));
      await user.type(screen.getByRole('textbox', { name: /key/i }), 'sms_due');
      await user.selectOptions(screen.getByRole('combobox', { name: /channel/i }), 'sms');
      await user.type(screen.getByRole('textbox', { name: /body/i }), 'Payment pending.');
      await user.click(screen.getByRole('button', { name: 'Create template' }));

      await waitFor(() =>
        expect(wrote(calls, 'POST', '/admin/communication-templates')?.body).toMatchObject({
          key: 'sms_due',
          channel: 'sms',
          body: 'Payment pending.',
        }),
      );
    });

    it('still saves a template that is complete', async () => {
      const user = userEvent.setup();
      const { calls } = mockApi();
      renderPage();
      await screen.findByText('draft_ready');

      await user.click(screen.getByRole('button', { name: 'New template' }));
      await user.type(screen.getByRole('textbox', { name: /key/i }), 'invoice_due');
      await user.type(screen.getByRole('textbox', { name: /subject/i }), 'Invoice due');
      await user.type(screen.getByRole('textbox', { name: /body/i }), 'Your invoice is due.');
      await user.click(screen.getByRole('button', { name: 'Create template' }));

      await waitFor(() =>
        expect(wrote(calls, 'POST', '/admin/communication-templates')?.body).toMatchObject({
          key: 'invoice_due',
        }),
      );
    });

    it('will not create a campaign with no template chosen', async () => {
      const user = userEvent.setup();
      const { calls } = mockApi();
      renderPage();
      await autoEmailsTab(user);

      await user.click(screen.getByRole('button', { name: 'New campaign' }));
      await user.type(screen.getByRole('textbox', { name: /name/i }), 'invoice_nudge');
      await user.click(screen.getByRole('button', { name: 'Create campaign' }));

      expect(await screen.findByText('Template is required.')).toBeInTheDocument();
      expect(wrote(calls, 'POST', '/admin/auto-emails')).toBeUndefined();
    });

    it('refuses an emptied max-sends box rather than saving a campaign that never sends', async () => {
      // The box is `number` state fed by `Number(e.target.value)`, so clearing
      // it lands 0 — a campaign with max_sends 0 sends nothing and says
      // nothing about why.
      const user = userEvent.setup();
      const { calls } = mockApi();
      renderPage();
      await autoEmailsTab(user);

      await user.click(screen.getByRole('button', { name: 'New campaign' }));
      await user.type(screen.getByRole('textbox', { name: /name/i }), 'invoice_nudge');
      await user.selectOptions(screen.getByRole('combobox', { name: /template/i }), 'draft_ready');
      await user.clear(screen.getByRole('spinbutton', { name: /max sends/i }));
      await user.click(screen.getByRole('button', { name: 'Create campaign' }));

      expect(await screen.findByText('Max sends must be at least 1.')).toBeInTheDocument();
      expect(wrote(calls, 'POST', '/admin/auto-emails')).toBeUndefined();
    });

    it('caps max sends at the ten the control declares', async () => {
      const user = userEvent.setup();
      const { calls } = mockApi();
      renderPage();
      await autoEmailsTab(user);

      await user.click(screen.getByRole('button', { name: 'New campaign' }));
      await user.type(screen.getByRole('textbox', { name: /name/i }), 'invoice_nudge');
      await user.selectOptions(screen.getByRole('combobox', { name: /template/i }), 'draft_ready');
      await user.clear(screen.getByRole('spinbutton', { name: /max sends/i }));
      await user.type(screen.getByRole('spinbutton', { name: /max sends/i }), '50');
      await user.click(screen.getByRole('button', { name: 'Create campaign' }));

      expect(await screen.findByText('Max sends must be at most 10.')).toBeInTheDocument();
      expect(wrote(calls, 'POST', '/admin/auto-emails')).toBeUndefined();
    });

    it('leaves the repeat box optional, but floors it once it is filled', async () => {
      const user = userEvent.setup();
      const { calls } = mockApi();
      renderPage();
      await autoEmailsTab(user);

      await user.click(screen.getByRole('button', { name: 'New campaign' }));
      await user.type(screen.getByRole('textbox', { name: /name/i }), 'invoice_nudge');
      await user.selectOptions(screen.getByRole('combobox', { name: /template/i }), 'draft_ready');
      await user.type(screen.getByRole('spinbutton', { name: /repeat every/i }), '0');
      await user.click(screen.getByRole('button', { name: 'Create campaign' }));

      expect(await screen.findByText('Repeat must be at least 1.')).toBeInTheDocument();
      expect(wrote(calls, 'POST', '/admin/auto-emails')).toBeUndefined();
    });

    it('creates the campaign when the repeat box is left blank', async () => {
      const user = userEvent.setup();
      const { calls } = mockApi();
      renderPage();
      await autoEmailsTab(user);

      await user.click(screen.getByRole('button', { name: 'New campaign' }));
      await user.type(screen.getByRole('textbox', { name: /name/i }), 'invoice_nudge');
      await user.selectOptions(screen.getByRole('combobox', { name: /template/i }), 'draft_ready');
      await user.click(screen.getByRole('button', { name: 'Create campaign' }));

      await waitFor(() =>
        expect(wrote(calls, 'POST', '/admin/auto-emails')?.body).toMatchObject({
          name: 'invoice_nudge',
          template_key: 'draft_ready',
          repeat_hours: null,
        }),
      );
    });
  });
});
