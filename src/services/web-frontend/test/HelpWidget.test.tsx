import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { HelpWidget, HELP_TOPICS, filterTopics } from '../src/components/HelpWidget';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderWidget(path = '/valuations') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <HelpWidget />
    </MemoryRouter>,
  );
}

describe('filterTopics', () => {
  it('returns everything for an empty query', () => {
    expect(filterTopics(HELP_TOPICS, '')).toHaveLength(HELP_TOPICS.length);
  });

  it('matches title, keywords and body case-insensitively', () => {
    expect(filterTopics(HELP_TOPICS, 'DLOM').map((t) => t.id)).toContain('params');
    expect(filterTopics(HELP_TOPICS, 'upload').map((t) => t.id)).toContain('documents');
    expect(filterTopics(HELP_TOPICS, 'zzz-no-match')).toHaveLength(0);
  });
});

describe('HelpWidget', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('opens from the launcher, searches topics, expands one', async () => {
    const user = userEvent.setup();
    renderWidget();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Open help'));
    expect(screen.getByRole('dialog', { name: 'Help & support' })).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Search help topics…'), 'report');
    expect(screen.getByText('Reports and versions')).toBeInTheDocument();
    expect(screen.queryByText('Uploading documents')).not.toBeInTheDocument();

    await user.click(screen.getByText('Reports and versions'));
    expect(screen.getByText(/immutable version history/)).toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', async () => {
    const user = userEvent.setup();
    renderWidget();
    await user.click(screen.getByLabelText('Open help'));
    await user.type(screen.getByPlaceholderText('Search help topics…'), 'quaternions');
    expect(screen.getByText(/No topics match/)).toBeInTheDocument();
  });

  it('sends a support message with the current page path', async () => {
    const user = userEvent.setup();
    // Fresh Response per call — the widget also fetches /help/articles on
    // mount (P2 #10) and a Response body is single-read.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ message: { id: 'm1', status: 'open' } }, 201)),
      );
    renderWidget('/valuations/01ABC/documents');

    await user.click(screen.getByLabelText('Open help'));
    await user.click(screen.getByRole('button', { name: 'Contact support' }));

    const send = screen.getByRole('button', { name: 'Send to support' });
    expect(send).toBeDisabled(); // empty form can't submit

    await user.type(screen.getByPlaceholderText('What do you need help with?'), 'Upload fails');
    await user.type(screen.getByPlaceholderText(/Tell us what happened/), 'The cap table upload errors out.');
    await user.click(send);

    await waitFor(() => expect(screen.getByText("Thanks — we're on it.")).toBeInTheDocument());
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/support/messages',
      expect.objectContaining({ method: 'POST' }),
    );
    const postCall = fetchSpy.mock.calls.find(([url]) => url === '/api/v1/support/messages');
    const body = JSON.parse(String((postCall![1] as RequestInit).body));
    expect(body).toEqual({
      subject: 'Upload fails',
      body: 'The cap table upload errors out.',
      page_path: '/valuations/01ABC/documents',
    });
  });

  it('surfaces API failures in the form', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(jsonResponse({ title: 'Unprocessable', detail: 'Message too long' }, 422)),
    );
    renderWidget();

    await user.click(screen.getByLabelText('Open help'));
    await user.click(screen.getByRole('button', { name: 'Contact support' }));
    await user.type(screen.getByPlaceholderText('What do you need help with?'), 'Hi');
    await user.type(screen.getByPlaceholderText(/Tell us what happened/), 'Help me');
    await user.click(screen.getByRole('button', { name: 'Send to support' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Message too long');
  });
});
