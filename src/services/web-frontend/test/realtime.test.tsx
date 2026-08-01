import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { parseSseBuffer } from '../src/lib/realtime';
import { PresenceBadges } from '../src/pages/valuation/ValuationWorkspace';
import { CommentsSection } from '../src/components/CommentThread';

describe('parseSseBuffer', () => {
  it('parses complete event blocks and returns the unterminated tail', () => {
    const { events, rest } = parseSseBuffer(
      'event: presence\ndata: {"viewers":[{"user_id":"u1","name":"Ana"}]}\n\n' +
        'event: comment\ndata: {"comment_id":"c1","kind":"chat"}\n\n' +
        'event: presence\ndata: {"vie',
    );
    expect(events).toEqual([
      { event: 'presence', data: { viewers: [{ user_id: 'u1', name: 'Ana' }] } },
      { event: 'comment', data: { comment_id: 'c1', kind: 'chat' } },
    ]);
    expect(rest).toBe('event: presence\ndata: {"vie');
  });

  it('skips heartbeats/comments and malformed frames', () => {
    const { events, rest } = parseSseBuffer(
      ': connected\n\n: ping\n\nevent: comment\ndata: not-json\n\n' +
        'event: comment\ndata: {"comment_id":"c2","kind":"note"}\n\n',
    );
    expect(events).toEqual([{ event: 'comment', data: { comment_id: 'c2', kind: 'note' } }]);
    expect(rest).toBe('');
  });

  it('defaults the event name to "message"', () => {
    const { events } = parseSseBuffer('data: {"x":1}\n\n');
    expect(events).toEqual([{ event: 'message', data: { x: 1 } }]);
  });
});

describe('PresenceBadges', () => {
  it('shows one "is viewing" chip per co-viewer and nothing when alone', () => {
    const { rerender } = render(
      <PresenceBadges
        viewers={[
          { user_id: 'u2', name: 'Bo Ops' },
          { user_id: 'u3', name: 'Cy Client' },
        ]}
      />,
    );
    expect(screen.getByText('Bo Ops is viewing')).toBeInTheDocument();
    expect(screen.getByText('Cy Client is viewing')).toBeInTheDocument();

    rerender(<PresenceBadges viewers={[]} />);
    expect(screen.queryByTestId('presence-badges')).not.toBeInTheDocument();
  });
});

describe('CommentsSection live refresh', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  const wrap = (node: React.ReactNode) => (
    <MemoryRouter>
      <AuthProvider>{node}</AuthProvider>
    </MemoryRouter>
  );

  it('re-fetches the thread when refreshKey bumps (SSE comment push)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ comments: [] }));
    const commentCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/valuations/v1/comments'));

    const { rerender } = render(wrap(<CommentsSection valuationId="v1" refreshKey={0} />));
    await waitFor(() => expect(commentCalls()).toHaveLength(1));

    rerender(wrap(<CommentsSection valuationId="v1" refreshKey={1} />));
    await waitFor(() => expect(commentCalls()).toHaveLength(2));
  });
});
