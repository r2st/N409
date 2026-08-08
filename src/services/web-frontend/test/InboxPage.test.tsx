import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { InboxPage } from '../src/pages/InboxPage';

const READER_ROLES = { current: ['reviewer'] as string[] };

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: {
      id: '01N409OPSUSER000000000000A',
      email: 'olive@n409.example',
      first_name: 'Olive',
      last_name: 'Ops',
      verified: true,
      sso_provider: null,
      partner_id: null,
      roles: READER_ROLES.current,
    },
  }),
}));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const item = (over: Record<string, unknown> = {}) => ({
  id: '01N409IC000000000000000001',
  valuation_id: '01N409VA000000000000000001',
  valuation_number: '1766',
  company_name: 'Acme Corp',
  valuation_kind: '409a',
  valuation_state: 'started',
  kind: 'chat',
  body: 'Where do I upload the cap table?',
  author_name: 'Dana Client',
  author_email: 'dana@acme.test',
  email_meta: null,
  pinned: false,
  created_at: '2026-08-07T09:00:00Z',
  unread: true,
  ...over,
});

function mockApi(overrides: { items?: unknown[]; unread_total?: number; commentStatus?: number } = {}) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    if (path.includes('/comments')) {
      const status = overrides.commentStatus ?? 201;
      return jsonResponse(
        status >= 400
          ? { title: 'Forbidden', status }
          : {
              comment: {
                id: '01N409ICREPLY0000000000001',
                created_at: '2026-08-08T10:00:00Z',
                author_name: null,
              },
            },
        status,
      );
    }
    if (path.includes('/inbox/read')) return jsonResponse({ marked: 1 });
    if (path.includes('/inbox')) {
      const items = overrides.items ?? [item()];
      return jsonResponse({
        items,
        total: items.length,
        unread_total: overrides.unread_total ?? items.filter((i) => (i as { unread: boolean }).unread).length,
        page: 1,
        per_page: 25,
      });
    }
    return jsonResponse({}, 404);
  });
  return { spy, calls, bodies };
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <InboxPage />
    </MemoryRouter>,
  );

describe('InboxPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    READER_ROLES.current = ['reviewer'];
  });

  it('lists threads from across every engagement', async () => {
    mockApi({
      items: [
        item(),
        item({
          id: '01N409IC000000000000000002',
          valuation_id: '01N409VA000000000000000002',
          company_name: 'Beta Industries',
          body: 'Any update on this one?',
          unread: false,
        }),
      ],
    });
    renderPage();
    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Beta Industries')).toBeInTheDocument();
    expect(screen.getByText(/Where do I upload the cap table\?/)).toBeInTheDocument();
  });

  it('reports the unread count in words rather than only a badge', async () => {
    mockApi({ items: [item(), item({ id: 'x2', unread: true })], unread_total: 2 });
    renderPage();
    expect(await screen.findByText(/2 unread/)).toBeInTheDocument();
  });

  it('says so plainly when nothing is unread', async () => {
    mockApi({ items: [item({ unread: false })], unread_total: 0 });
    renderPage();
    expect(await screen.findByText(/Nothing unread/)).toBeInTheDocument();
  });

  it('names an inbound email by the address it came from', async () => {
    // An inbound email has no author row; the sending address is the only
    // thing we know about who sent it, and it is the useful thing.
    mockApi({
      items: [
        item({
          kind: 'email',
          author_name: null,
          author_email: null,
          email_meta: { from: 'cfo@acme.test', subject: 'Re: your 409A' },
        }),
      ],
    });
    renderPage();
    expect(await screen.findByText(/cfo@acme.test/)).toBeInTheDocument();
    expect(screen.getByText(/Re: your 409A/)).toBeInTheDocument();
  });

  it('marks the thread read when the engagement is opened', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi();
    renderPage();
    await user.click(await screen.findByText('Acme Corp'));
    await waitFor(() =>
      expect(calls.some((c) => c.startsWith('POST') && c.endsWith('/inbox/read'))).toBe(true),
    );
  });

  it('filters to unread only', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi();
    renderPage();
    await screen.findByText('Acme Corp');
    await user.click(screen.getByLabelText(/Unread only/i));
    await waitFor(() => expect(calls.some((c) => c.includes('unread=true'))).toBe(true));
  });

  it('filters by message kind', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi();
    renderPage();
    await screen.findByText('Acme Corp');
    await user.click(screen.getByRole('button', { name: 'Internal note' }));
    await waitFor(() => expect(calls.some((c) => c.includes('kind=note'))).toBe(true));
  });

  it('searches on submit rather than on every keystroke', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi();
    renderPage();
    await screen.findByText('Acme Corp');
    await user.type(screen.getByLabelText(/Search the inbox/i), 'cap table');
    // Typing alone must not fire a request per character.
    expect(calls.filter((c) => c.includes('q=')).length).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(calls.some((c) => c.includes('q=cap+table'))).toBe(true));
  });

  it('disables the clear-all action when nothing is unread', async () => {
    mockApi({ items: [item({ unread: false })], unread_total: 0 });
    renderPage();
    expect(await screen.findByRole('button', { name: 'Mark all read' })).toBeDisabled();
  });

  it('explains a forbidden inbox rather than showing an empty one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ title: 'Forbidden', status: 403 }, 403));
    renderPage();
    expect(await screen.findByText(/do not have access to the shared inbox/i)).toBeInTheDocument();
  });

  /**
   * The compose box (design §15.2). The point of the tests is less the box
   * than where it writes: an inbox-specific write endpoint would be a second
   * place for the kind rules, the mention parsing and the realtime broadcast
   * to live, so the assertion that matters is the URL it POSTs to.
   */
  describe('inline reply', () => {
    const openReply = async (user: ReturnType<typeof userEvent.setup>) => {
      renderPage();
      await screen.findByText('Acme Corp');
      await user.click(screen.getByRole('button', { name: 'Reply' }));
      return screen.getByLabelText(/Reply to Acme Corp/i);
    };

    it('posts through the engagement’s own comment endpoint, not an inbox one', async () => {
      const user = userEvent.setup();
      const { calls, bodies } = mockApi();
      const box = await openReply(user);
      await user.type(box, 'Uploading it now.');
      await user.click(screen.getByRole('button', { name: 'Send' }));

      await waitFor(() =>
        expect(
          calls.some(
            (c) =>
              c.startsWith('POST') && c.endsWith('/api/v1/valuations/01N409VA000000000000000001/comments'),
          ),
        ).toBe(true),
      );
      expect(bodies).toContainEqual({ kind: 'chat', body: 'Uploading it now.' });
      // The inbox is read-only by design; nothing may POST to it but the read marks.
      expect(calls.some((c) => c.startsWith('POST') && /\/inbox(\?|$)/.test(c))).toBe(false);
    });

    it('shows the sent reply in the list without waiting for a reload', async () => {
      const user = userEvent.setup();
      mockApi();
      const box = await openReply(user);
      await user.type(box, 'Uploading it now.');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      expect(await screen.findByText('Uploading it now.')).toBeInTheDocument();
      // The insert returns the row it wrote, which has no joined display name;
      // we are the author, so the name shown is ours rather than "Unknown".
      expect(screen.getAllByText('Olive Ops').length).toBeGreaterThan(0);
    });

    it('clears the thread’s unread state, because replying means you read it', async () => {
      const user = userEvent.setup();
      const { calls } = mockApi();
      const box = await openReply(user);
      await user.type(box, 'On it.');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() =>
        expect(calls.some((c) => c.startsWith('POST') && c.endsWith('/inbox/read'))).toBe(true),
      );
      expect(await screen.findByText(/Nothing unread/)).toBeInTheDocument();
    });

    it('answers an inbound email as client chat — email is inbound-only', async () => {
      const user = userEvent.setup();
      const { bodies } = mockApi({
        items: [
          item({
            kind: 'email',
            author_name: null,
            author_email: null,
            email_meta: { from: 'cfo@acme.test', subject: 'Re: your 409A' },
          }),
        ],
      });
      const box = await openReply(user);
      await user.type(box, 'Thanks — see the draft attached.');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() =>
        expect(bodies).toContainEqual({ kind: 'chat', body: 'Thanks — see the draft attached.' }),
      );
    });

    it('lets ops post an internal note instead of a client reply', async () => {
      const user = userEvent.setup();
      const { bodies } = mockApi();
      const box = await openReply(user);
      await user.click(screen.getByRole('button', { name: 'Post as note' }));
      await user.type(box, 'Chased the cap table twice now.');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() =>
        expect(bodies).toContainEqual({ kind: 'note', body: 'Chased the cap table twice now.' }),
      );
    });

    it('offers no note option to a firm reader — notes are ops tooling', async () => {
      READER_ROLES.current = ['partner'];
      const user = userEvent.setup();
      mockApi();
      await openReply(user);
      expect(screen.queryByRole('button', { name: 'Post as note' })).not.toBeInTheDocument();
    });

    it('keeps the draft on the screen when the post is refused', async () => {
      const user = userEvent.setup();
      mockApi({ commentStatus: 403 });
      const box = await openReply(user);
      await user.type(box, 'Draft worth keeping.');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      expect(await screen.findByText(/cannot post to this engagement/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Reply to Acme Corp/i)).toHaveValue('Draft worth keeping.');
    });

    it('will not send an empty reply', async () => {
      const user = userEvent.setup();
      mockApi();
      await openReply(user);
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    });
  });
});
