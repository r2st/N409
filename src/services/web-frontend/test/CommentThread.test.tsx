import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { CommentsSection } from '../src/components/CommentThread';
import type { Comment } from '../src/lib/types';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const chat: Comment = {
  id: '01HZXW5N8YBFJ4G2Q0TCVMKRAE',
  valuation_id: 'v1',
  kind: 'chat',
  author_id: 'u2',
  author_name: 'Grace Hopper',
  author_email: 'grace@acme.com',
  body: 'When is the draft due?',
  email_meta: null,
  pinned: false,
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-01T10:00:00Z',
};

function renderSection() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <CommentsSection valuationId="v1" />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('CommentsSection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  /**
   * The page the API returns is the newest end of the thread. Without saying
   * so, an older message that was sent and answered reads as one that was
   * never sent — on the record of what the client was told.
   */
  it('says when the thread is longer than the page it was handed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/comments')) return jsonResponse({ comments: [chat], truncated: true });
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    renderSection();
    expect(await screen.findByTestId('list-truncated')).toHaveTextContent(
      'Showing 1 messages. More exist than are listed',
    );
  });

  it('windows a long thread from its newest end', async () => {
    // `/comments` is capped at five thousand and hands them back oldest-first.
    // Windowing the head would show a reader the start of the conversation and
    // hide the reply they opened the panel for; the control offers the earlier
    // messages instead.
    const many: Comment[] = Array.from({ length: 150 }, (_, i) => ({
      ...chat,
      id: `c-${i}`,
      body: `message ${i}`,
      created_at: `2026-07-01T10:${String(i % 60).padStart(2, '0')}:00Z`,
    }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/comments')) return jsonResponse({ comments: many, truncated: false });
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    renderSection();

    expect(await screen.findByText('message 149')).toBeInTheDocument();
    expect(screen.getByText('message 50')).toBeInTheDocument();
    expect(screen.queryByText('message 49')).toBeNull();
    expect(screen.getByText('50 more messages not shown')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Show earlier messages' }));
    expect(screen.getByText('message 0')).toBeInTheDocument();
    expect(screen.getByText('message 149')).toBeInTheDocument();
    expect(screen.queryByTestId('show-more-rows')).toBeNull();
  });

  it('carries no window control on a thread that fits', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/comments')) return jsonResponse({ comments: [chat], truncated: false });
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    renderSection();
    await screen.findByText('When is the draft due?');
    expect(screen.queryByTestId('show-more-rows')).toBeNull();
  });

  it('says nothing when the whole thread came back', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/comments')) return jsonResponse({ comments: [chat], truncated: false });
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    renderSection();
    // Against the message actually rendering, so this cannot pass vacuously.
    expect(await screen.findByText('When is the draft due?')).toBeInTheDocument();
    expect(screen.queryByTestId('list-truncated')).not.toBeInTheDocument();
  });

  it('renders the conversation from the API', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/comments')) return jsonResponse({ comments: [chat] });
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    renderSection();
    expect(await screen.findByText('When is the draft due?')).toBeInTheDocument();
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    // sticky notes are ops-only; anonymous/client users never see the panel
    expect(screen.queryByText(/Sticky notes/)).not.toBeInTheDocument();
  });

  it('posts a chat message and reloads the thread', async () => {
    const posted: Comment = { ...chat, id: '01HZXW5N8YBFJ4G2Q0TCVMKRAF', body: 'Next Friday.' };
    let commentsCall = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('/comments') && init?.method === 'POST')
        return jsonResponse({ comment: posted }, 201);
      if (String(url).includes('/comments')) {
        commentsCall += 1;
        return jsonResponse({ comments: commentsCall > 1 ? [chat, posted] : [chat] });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });

    renderSection();
    await screen.findByText('When is the draft due?');
    await userEvent.type(screen.getByLabelText('Write a message'), 'Next Friday.');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByText('Next Friday.')).toBeInTheDocument());
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post![1]!.body))).toMatchObject({ kind: 'chat', body: 'Next Friday.' });
  });

  it('says the conversation could not be loaded instead of spinning', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ title: 'Down' }, 503));
    renderSection();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load the conversation/i);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  /**
   * R226. The banner was there and so was the sentence under it: "No messages
   * yet — start the conversation below." A reader was told, in the same
   * paragraph, that the thread could not be read and that it is empty; only
   * one of those can be true, and the false one is the one carrying the
   * invitation to write. On a valuation whose client is mid-conversation that
   * invitation is how a message gets sent twice.
   */
  it('does not invite a first message on a thread it could not read', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ title: 'Down' }, 503));
    renderSection();

    await screen.findByRole('alert');
    expect(screen.queryByText(/start the conversation below/i)).not.toBeInTheDocument();
  });

  it('goes back to the thread once a later load succeeds', async () => {
    let fail = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('/comments') && init?.method === 'POST') return jsonResponse({ id: 'x' }, 201);
      if (fail) {
        fail = false;
        return jsonResponse({ title: 'Down' }, 503);
      }
      return jsonResponse({ comments: [chat], truncated: false });
    });
    const user = userEvent.setup();
    renderSection();

    await screen.findByRole('alert');
    await user.type(screen.getByLabelText('Write a message'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('When is the draft due?')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('invites the first message rather than showing an empty list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ comments: [] }));
    renderSection();
    expect(await screen.findByText(/start the conversation below/i)).toBeInTheDocument();
  });

  it('reports a message the server would not accept, keeping the draft', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('/comments') && init?.method === 'POST')
        return jsonResponse({ title: 'Too long' }, 422);
      return jsonResponse({ comments: [chat] });
    });
    renderSection();

    await screen.findByText('When is the draft due?');
    await userEvent.type(screen.getByLabelText('Write a message'), 'Next Friday.');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not post/i);
    expect(screen.getByLabelText('Write a message')).toHaveValue('Next Friday.');
  });

  it('will not send whitespace', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ comments: [] }));
    renderSection();

    await screen.findByText(/start the conversation below/i);
    await userEvent.type(screen.getByLabelText('Write a message'), '   ');

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(fetchSpy.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(0);
  });

  it('labels threaded email with its sender and subject', async () => {
    const email: Comment = {
      ...chat,
      id: '01HZXW5N8YBFJ4G2Q0TCVMKRAG',
      kind: 'email',
      author_id: null,
      author_name: null,
      author_email: null,
      email_meta: { from: 'cfo@client.com', subject: 'Cap table attached' },
      body: 'Please find the cap table attached.',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/comments')) return jsonResponse({ comments: [email] });
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    renderSection();
    expect(await screen.findByText('cfo@client.com')).toBeInTheDocument();
    expect(screen.getByText(/Cap table attached/)).toBeInTheDocument();
  });

  describe('sticky notes (ops only)', () => {
    const note: Comment = {
      ...chat,
      id: '01HZXW5N8YBFJ4G2Q0TCVMKRBB',
      kind: 'note',
      author_id: 'op',
      author_name: 'Rae Okafor',
      author_email: 'rae@n409.ai',
      body: 'Client has not sent the 2025 audited accounts yet — chase before review.',
      pinned: false,
    };

    /**
     * The panel is gated on `isOps`, so the session has to be a real one: a
     * marker in storage plus an /auth/me the provider will accept.
     */
    function renderAsOps(handler: (url: string, init?: RequestInit) => Response) {
      localStorage.setItem('n409.token', '1');
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const u = String(url);
        if (u.endsWith('/auth/me'))
          return jsonResponse({
            user: { id: 'op', email: 'rae@n409.ai', roles: ['admin'], verified: true },
          });
        return handler(u, init as RequestInit | undefined);
      });
      return renderSection();
    }

    it('shows ops their internal notes, and clients nothing at all', async () => {
      renderAsOps(() => jsonResponse({ comments: [chat, note] }));

      expect(await screen.findByText(/Sticky notes/)).toBeInTheDocument();
      expect(screen.getByText(/chase before review/)).toBeInTheDocument();
      // A note is not a message — it must not appear in the client-visible thread.
      const conversation = screen.getByText('Conversation').closest('section')!;
      expect(conversation).not.toHaveTextContent(/chase before review/);
    });

    it('says so when there are no notes', async () => {
      renderAsOps(() => jsonResponse({ comments: [chat] }));
      expect(await screen.findByText('No notes yet.')).toBeInTheDocument();
    });

    /**
     * R226. One request carries the notes and the conversation, and its
     * failure was reported only in the conversation section — so the notes
     * panel, which is the internal record of what is outstanding on the
     * engagement, said "No notes yet." with nothing near it to disagree.
     */
    it('does not report an unread notes panel as an empty one', async () => {
      renderAsOps(() => jsonResponse({ title: 'Down' }, 503));

      expect(await screen.findByText(/Could not load the internal notes/i)).toBeInTheDocument();
      expect(screen.queryByText('No notes yet.')).not.toBeInTheDocument();
    });

    it('posts a note pinned, under the note kind', async () => {
      const posts: unknown[] = [];
      renderAsOps((url, init) => {
        if (url.includes('/comments') && init?.method === 'POST') {
          posts.push(JSON.parse(String(init.body)));
          return jsonResponse({ comment: note }, 201);
        }
        return jsonResponse({ comments: posts.length ? [note] : [] });
      });

      await screen.findByText('No notes yet.');
      await userEvent.type(screen.getByLabelText('Add an internal note'), '  Chase the accounts  ');
      await userEvent.click(screen.getByRole('button', { name: 'Add note' }));

      await waitFor(() => expect(posts).toHaveLength(1));
      expect(posts[0]).toEqual({ kind: 'note', body: 'Chase the accounts', pinned: true });
    });

    it('names each note control after the note it acts on', async () => {
      renderAsOps(() => jsonResponse({ comments: [note, { ...note, id: 'n2', body: 'Second note' }] }));

      await screen.findByText(/Sticky notes/);
      expect(
        screen.getByRole('button', { name: /Delete note — Rae Okafor: Client has not sent/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Delete note — Rae Okafor: Second note' }),
      ).toBeInTheDocument();
    });

    it('pins and unpins a note through the same control', async () => {
      const patches: Array<{ url: string; body: unknown }> = [];
      let pinned = false;
      renderAsOps((url, init) => {
        if (init?.method === 'PATCH') {
          patches.push({ url, body: JSON.parse(String(init.body)) });
          pinned = !pinned;
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ comments: [{ ...note, pinned }] });
      });

      await userEvent.click(await screen.findByRole('button', { name: /^Pin note —/ }));

      await waitFor(() => expect(patches).toHaveLength(1));
      expect(patches[0]!.body).toEqual({ pinned: true });
      await screen.findByRole('button', { name: /^Unpin note —/ });
    });

    it('deletes a note and reloads the panel', async () => {
      const deletes: string[] = [];
      renderAsOps((url, init) => {
        if (init?.method === 'DELETE') {
          deletes.push(url);
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ comments: deletes.length ? [] : [note] });
      });

      await userEvent.click(await screen.findByRole('button', { name: /^Delete note —/ }));

      await waitFor(() => expect(screen.getByText('No notes yet.')).toBeInTheDocument());
      expect(deletes[0]).toContain('/comments/01HZXW5N8YBFJ4G2Q0TCVMKRBB');
    });

    it('reports a delete the server refused', async () => {
      renderAsOps((_url, init) =>
        init?.method === 'DELETE'
          ? jsonResponse({ title: 'Forbidden' }, 403)
          : jsonResponse({ comments: [note] }),
      );

      await userEvent.click(await screen.findByRole('button', { name: /^Delete note —/ }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/Could not delete the comment/i);
    });

    it('reports a pin the server refused', async () => {
      renderAsOps((_url, init) =>
        init?.method === 'PATCH'
          ? jsonResponse({ title: 'Forbidden' }, 403)
          : jsonResponse({ comments: [note] }),
      );

      await userEvent.click(await screen.findByRole('button', { name: /^Pin note —/ }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/Could not update the note/i);
    });

    it('lets ops delete anyone else’s chat message', async () => {
      const deletes: string[] = [];
      renderAsOps((url, init) => {
        if (init?.method === 'DELETE') {
          deletes.push(url);
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ comments: deletes.length ? [] : [chat] });
      });

      await userEvent.click(await screen.findByRole('button', { name: /^Delete message — Grace Hopper/ }));
      await waitFor(() => expect(deletes).toHaveLength(1));
    });
  });

  it('offers no delete on a message that is not yours', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ comments: [chat] }));
    renderSection();

    await screen.findByText('When is the draft due?');
    expect(screen.queryByRole('button', { name: /^Delete message/ })).not.toBeInTheDocument();
  });
});

/**
 * Rows whose author or email metadata is missing.
 *
 * `author_name` and `author_email` are both nullable and both genuinely null in
 * practice: a comment survives the deletion of the account that wrote it (the
 * thread is the record of a conversation, not of a user), and an inbound email
 * is attributed to a sender the platform has no account for at all. Rendering
 * `null` into an avatar or an aria-label is how a thread starts announcing
 * "Delete message — null".
 */
describe('CommentsSection — an author the row cannot name', () => {
  const anon: Comment = {
    ...chat,
    id: '01HZXW5N8YBFJ4G2Q0TCVMKRC1',
    author_id: 'u9',
    author_name: null,
    author_email: null,
    body: 'Left by an account that has since been deleted.',
  };

  const byEmailOnly: Comment = {
    ...chat,
    id: '01HZXW5N8YBFJ4G2Q0TCVMKRC2',
    author_name: null,
    author_email: 'grace@acme.com',
    body: 'Named by address alone.',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('falls back to the address, then to a placeholder, in the byline and the avatar', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ comments: [anon, byEmailOnly] }),
    );
    renderSection();

    expect(await screen.findByText('Left by an account that has since been deleted.')).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();
    expect(screen.getByText('?')).toBeInTheDocument(); // the avatar's two letters
    expect(screen.getByText('grace@acme.com')).toBeInTheDocument();
    expect(screen.getByText('GR')).toBeInTheDocument();
  });

  it('names an unattributable message in the delete control rather than saying "null"', async () => {
    localStorage.setItem('n409.token', '1');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/auth/me')
        ? jsonResponse({ user: { id: 'op', email: 'rae@n409.ai', roles: ['admin'], verified: true } })
        : jsonResponse({ comments: [anon] }),
    );
    renderSection();

    const remove = await screen.findByRole('button', { name: /Delete message/ });
    expect(remove).toHaveAccessibleName(expect.stringContaining('unknown'));
    expect(remove).not.toHaveAccessibleName(expect.stringContaining('null'));
  });

  it('names a note by its address, then by "ops", in the pin control', async () => {
    localStorage.setItem('n409.token', '1');
    const note: Comment = {
      ...chat,
      id: '01HZXW5N8YBFJ4G2Q0TCVMKRC3',
      kind: 'note',
      author_id: 'op',
      author_name: null,
      author_email: null,
      pinned: true,
      body: 'Chase the audited accounts.',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/auth/me')
        ? jsonResponse({ user: { id: 'op', email: 'rae@n409.ai', roles: ['admin'], verified: true } })
        : jsonResponse({ comments: [note] }),
    );
    renderSection();

    // Already pinned, so the control offers the other direction.
    const pin = await screen.findByRole('button', { name: /Unpin note/ });
    expect(pin).toHaveAccessibleName(expect.stringContaining('ops'));
    expect(pin).not.toHaveAccessibleName(expect.stringContaining('null'));
  });
});

describe('CommentsSection — an inbound email with no metadata', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('labels it as email without inventing a sender or a subject', async () => {
    const bare: Comment = {
      ...chat,
      id: '01HZXW5N8YBFJ4G2Q0TCVMKRD1',
      kind: 'email',
      author_name: null,
      author_email: null,
      email_meta: null,
      body: 'Forwarded from the shared inbox.',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ comments: [bare] }));
    renderSection();

    expect(await screen.findByText('Forwarded from the shared inbox.')).toBeInTheDocument();
    expect(screen.getByText('email')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument(); // the badge, with no subject appended
    // An email is never the reader's own message, so it carries no delete.
    expect(screen.queryByRole('button', { name: /Delete message/ })).not.toBeInTheDocument();
  });

  it('appends the subject to the badge when there is one', async () => {
    const withMeta: Comment = {
      ...chat,
      id: '01HZXW5N8YBFJ4G2Q0TCVMKRD2',
      kind: 'email',
      author_name: null,
      author_email: null,
      email_meta: { from: 'founder@northwind.test', subject: 'Audited accounts' },
      body: 'Attached.',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ comments: [withMeta] }));
    renderSection();

    expect(await screen.findByText('founder@northwind.test')).toBeInTheDocument();
    expect(screen.getByText('Email · Audited accounts')).toBeInTheDocument();
  });
});

describe('CommentsSection — a blank message', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('sends nothing for whitespace, rather than posting an empty comment', async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return jsonResponse({ comments: [chat] });
    });
    renderSection();

    const box = await screen.findByLabelText(/message/i);
    await userEvent.type(box, '   ');
    await userEvent.click(screen.getByRole('button', { name: /Send/i }));

    await waitFor(() => expect(calls.some((c) => c.startsWith('POST'))).toBe(false));
    expect(box).toHaveValue('   ');
  });
});
