import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SupportInboxPage, type SupportMessage } from '../src/pages/SupportInboxPage';

/** Ops triage for help-widget messages. */

const open: SupportMessage = {
  id: '01N409SUPPORT00000000000AA',
  user_id: '01N409USER0000000000000AAA',
  user_email: 'founder@acme.example',
  subject: 'Cap table import failed',
  body: 'The CSV upload spins forever.\nSecond line.',
  page_path: '/valuations/abc/cap-table',
  status: 'open',
  created_at: '2026-07-01T09:00:00Z',
  resolved_at: null,
};

const resolved: SupportMessage = {
  id: '01N409SUPPORT00000000000BB',
  user_id: '01N409USER0000000000000BBB',
  user_email: 'cfo@beta.example',
  subject: 'Invoice question',
  body: 'Answered by email.',
  page_path: null,
  status: 'resolved',
  created_at: '2026-06-28T09:00:00Z',
  resolved_at: '2026-06-29T09:00:00Z',
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ status, title: 'Error', detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function mockApi(
  opts: {
    list?: SupportMessage[];
    listFails?: Response;
    patchFails?: Response;
    truncated?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  let items = opts.list ?? [open];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: path, method, body });
    if (method === 'PATCH') {
      if (opts.patchFails) return opts.patchFails;
      const id = path.split('/').at(-1);
      items = items.map((m) =>
        m.id === id ? { ...m, status: (body as { status: SupportMessage['status'] }).status } : m,
      );
      return jsonResponse({ ok: true });
    }
    if (opts.listFails) return opts.listFails;
    const scope = new URL(path, 'http://x').searchParams.get('status');
    return jsonResponse({
      messages: scope ? items.filter((m) => m.status === scope) : items,
      truncated: opts.truncated ?? false,
    });
  });
  return calls;
}

describe('SupportInboxPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('opens on the open messages only', async () => {
    const calls = mockApi({ list: [open, resolved] });
    render(<SupportInboxPage />);

    expect(await screen.findByText(open.subject)).toBeInTheDocument();
    expect(screen.queryByText(resolved.subject)).not.toBeInTheDocument();
    expect(calls[0]!.url).toBe('/api/v1/support/messages?status=open');
  });

  it('shows who wrote in and from which page', async () => {
    mockApi();
    render(<SupportInboxPage />);

    await screen.findByText(open.subject);
    expect(screen.getByText(/founder@acme\.example/)).toBeInTheDocument();
    expect(screen.getByText(open.page_path!)).toBeInTheDocument();
    expect(screen.getByText(/The CSV upload spins forever/)).toBeInTheDocument();
  });

  it('omits the origin line for a message sent without one', async () => {
    mockApi({ list: [{ ...resolved, status: 'open' }] });
    render(<SupportInboxPage />);

    await screen.findByText(resolved.subject);
    expect(screen.queryByText(/· from/)).not.toBeInTheDocument();
  });

  it('refetches with the scope the operator picked', async () => {
    const calls = mockApi({ list: [open, resolved] });
    const user = userEvent.setup();
    render(<SupportInboxPage />);

    await screen.findByText(open.subject);
    await user.click(screen.getByRole('button', { name: 'Resolved' }));
    expect(await screen.findByText(resolved.subject)).toBeInTheDocument();
    expect(calls.at(-1)!.url).toBe('/api/v1/support/messages?status=resolved');

    await user.click(screen.getByRole('button', { name: 'All' }));
    await screen.findByText(open.subject);
    // "All" means no filter at all, not `?status=all`.
    expect(calls.at(-1)!.url).toBe('/api/v1/support/messages');
  });

  it('resolves a message and drops it out of the open scope', async () => {
    const calls = mockApi({ list: [open] });
    const user = userEvent.setup();
    render(<SupportInboxPage />);

    await user.click(await screen.findByRole('button', { name: 'Mark resolved' }));

    await waitFor(() => expect(screen.getByText('Inbox zero')).toBeInTheDocument());
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe(`/api/v1/support/messages/${open.id}`);
    expect(patch.body).toEqual({ status: 'resolved' });
  });

  it('reopens a resolved message', async () => {
    const calls = mockApi({ list: [resolved] });
    const user = userEvent.setup();
    render(<SupportInboxPage />);

    await user.click(await screen.findByRole('button', { name: 'Resolved' }));
    await user.click(await screen.findByRole('button', { name: 'Reopen' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ status: 'open' });
  });

  it('says something different when a filter simply matches nothing', async () => {
    mockApi({ list: [open] });
    const user = userEvent.setup();
    render(<SupportInboxPage />);

    await screen.findByText(open.subject);
    await user.click(screen.getByRole('button', { name: 'Resolved' }));

    expect(await screen.findByText('Nothing here')).toBeInTheDocument();
    expect(screen.queryByText('Inbox zero')).not.toBeInTheDocument();
  });

  it('names the reason a non-ops user sees nothing', async () => {
    mockApi({ listFails: problem(403, 'forbidden') });
    render(<SupportInboxPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The support inbox is operations-only.');
  });

  it('reports a generic load failure', async () => {
    mockApi({ listFails: problem(500, 'boom') });
    render(<SupportInboxPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load support messages.');
  });

  it('keeps the list visible and explains a failed status change', async () => {
    mockApi({ list: [open], patchFails: problem(409, 'Already resolved by another operator.') });
    const user = userEvent.setup();
    render(<SupportInboxPage />);

    await user.click(await screen.findByRole('button', { name: 'Mark resolved' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Already resolved by another operator.');
    expect(screen.getByText(open.subject)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark resolved' })).toBeEnabled();
  });
});

/**
 * R162 — the contact form's inbox, which had no page at all.
 *
 * `POST /api/v1/contact` has been writing rows since the marketing site
 * shipped, and the ops list and status PATCH beside it existed for as long with
 * nothing in the product calling either: every enquiry from the website landed
 * in a table only a `psql` session could read. It is the second queue on this
 * page now, because it is the same triage.
 */
const enquiry = {
  id: '01N409CONTACT0000000000AA',
  name: 'Dana Reed',
  email: 'dana@reedcapital.example',
  company: 'Reed Capital',
  phone: '+15550100',
  message: 'We need a 409A for our Series A.',
  status: 'new' as const,
  handled_at: null,
  created_at: '2026-07-02T09:00:00Z',
};

function mockContactApi(opts: { list?: Array<typeof enquiry>; truncated?: boolean } = {}) {
  const calls: Call[] = [];
  let items = opts.list ?? [enquiry];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: path, method, body });
    if (path.startsWith('/api/v1/support/messages')) return jsonResponse({ messages: [], truncated: false });
    if (method === 'PATCH') {
      const id = path.split('/').at(-1);
      items = items.map((c) =>
        c.id === id ? { ...c, status: (body as { status: typeof enquiry.status }).status } : c,
      );
      return jsonResponse({ submission: items.find((c) => c.id === id) });
    }
    const scope = new URL(path, 'http://x').searchParams.get('status');
    return jsonResponse({
      submissions: scope ? items.filter((c) => c.status === scope) : items,
      truncated: opts.truncated ?? false,
    });
  });
  return calls;
}

const openContactQueue = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Contact form' }));
};

describe('the contact-form queue', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('is not loaded until its tab is chosen, then reads the new queue', async () => {
    const calls = mockContactApi();
    const user = userEvent.setup();
    render(<SupportInboxPage />);

    // The support queue is what the page opens on; switching is what fetches.
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/v1/support'))).toBe(true));
    expect(calls.some((c) => c.url.startsWith('/api/v1/contact'))).toBe(false);

    await openContactQueue(user);
    expect(await screen.findByText(enquiry.name)).toBeInTheDocument();
    expect(calls.at(-1)!.url).toBe('/api/v1/contact/submissions?status=new');
  });

  it('shows the details an enquiry from a stranger carries', async () => {
    mockContactApi();
    const user = userEvent.setup();
    render(<SupportInboxPage />);
    await openContactQueue(user);

    expect(await screen.findByText(enquiry.message)).toBeInTheDocument();
    // The sender has no account, so the address is the whole of the reply path
    // — a mailto rather than plain text.
    const mail = screen.getByRole('link', { name: enquiry.email });
    expect(mail).toHaveAttribute('href', `mailto:${enquiry.email}`);
  });

  it('marks an enquiry handled and drops it out of the new queue', async () => {
    const calls = mockContactApi();
    const user = userEvent.setup();
    render(<SupportInboxPage />);
    await openContactQueue(user);

    await user.click(await screen.findByRole('button', { name: 'Mark handled' }));

    await waitFor(() => expect(screen.queryByText(enquiry.name)).not.toBeInTheDocument());
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toBe(`/api/v1/contact/submissions/${enquiry.id}`);
    expect(patch?.body).toEqual({ status: 'handled' });
  });

  /**
   * Ordered by status before date, so the row that falls off this cap is the
   * oldest enquiry of the lowest-priority status — the one an operator would
   * assume had been dealt with.
   */
  it('says so when the queue was capped', async () => {
    mockContactApi({ truncated: true });
    const user = userEvent.setup();
    render(<SupportInboxPage />);
    await openContactQueue(user);

    const note = await screen.findByTestId('list-truncated');
    expect(note).toHaveTextContent(/Showing 1 enquiries/);
    expect(note).toHaveTextContent(/status filter/);
  });

  it('draws no notice when the queue is complete', async () => {
    mockContactApi();
    const user = userEvent.setup();
    render(<SupportInboxPage />);
    await openContactQueue(user);

    expect(await screen.findByText(enquiry.name)).toBeInTheDocument();
    expect(screen.queryByTestId('list-truncated')).not.toBeInTheDocument();
  });
});
