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
});
