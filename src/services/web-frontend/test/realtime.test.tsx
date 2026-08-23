import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { parseSseBuffer, useValuationStream } from '../src/lib/realtime';
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

/**
 * The hook itself, which nothing exercised before: `parseSseBuffer` and
 * `PresenceBadges` are both pure, and every test above stops at one of them.
 * What sits between is a socket's lifecycle, and all three defects here live
 * in the transitions rather than in a frame.
 */
describe('useValuationStream', () => {
  /** An SSE response whose body this test pushes frames into and then ends. */
  function sseResponse() {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    return {
      res: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      push: (frame: string) => controller.enqueue(encoder.encode(frame)),
      end: () => controller.close(),
    };
  }

  const presence = (...names: string[]) =>
    `event: presence\ndata: ${JSON.stringify({
      viewers: names.map((name, i) => ({ user_id: `u${i + 1}`, name })),
    })}\n\n`;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('clears the presence list when the stream drops, and refills it on reconnect', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const first = sseResponse();
      const second = sseResponse();
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(first.res)
        .mockResolvedValueOnce(second.res);

      const { result } = renderHook(() => useValuationStream('v1'));
      await act(async () => first.push(presence('Ana', 'Bo')));
      await waitFor(() => expect(result.current.viewers).toHaveLength(2));

      // The server ends the stream — a restart, a dropped socket, a revoked
      // permission. Ana and Bo are no longer known to be there.
      await act(async () => first.end());
      await waitFor(() => expect(result.current.viewers).toEqual([]));

      // The reconnect's own join is what brings the room back.
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      await act(async () => second.push(presence('Ana')));
      await waitFor(() => expect(result.current.viewers).toEqual([{ user_id: 'u1', name: 'Ana' }]));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([401, 403, 404])('stops retrying on %i and leaves no presence behind', async (status) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const live = sseResponse();
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(live.res)
        .mockResolvedValue(new Response(null, { status }));

      const { result } = renderHook(() => useValuationStream('v1'));
      await act(async () => live.push(presence('Ana')));
      await waitFor(() => expect(result.current.viewers).toHaveLength(1));

      await act(async () => live.end());
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      // Nothing schedules a third attempt, and the badges stay gone.
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.current.viewers).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bumps the comment tick on a reconnect but not on the first connect', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const first = sseResponse();
      const second = sseResponse();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(first.res).mockResolvedValueOnce(second.res);

      const { result } = renderHook(() => useValuationStream('v1'));
      await act(async () => first.push(presence('Ana')));
      await waitFor(() => expect(result.current.viewers).toHaveLength(1));
      // The thread fetches itself on mount; a bump here would only duplicate it.
      expect(result.current.commentTick).toBe(0);

      // Comments posted during the gap were pushed to a socket nobody held.
      await act(async () => first.end());
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      await waitFor(() => expect(result.current.commentTick).toBe(1));

      // And a live push still counts once, on top of the reconnect's bump.
      await act(async () => second.push('event: comment\ndata: {"comment_id":"c9"}\n\n'));
      await waitFor(() => expect(result.current.commentTick).toBe(2));
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The server re-checks, on a timer, that an open stream is still allowed to be
   * open — a session signed out everywhere, a revoked token, a permission taken
   * away — and sends a `revoked` frame before it hangs up. Without reading the
   * frame the client cannot tell that close from a dropped socket, so it would
   * wait out its backoff and reconnect into a refusal it has already been told
   * about.
   */
  it('does not reconnect after the server says the stream was revoked', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const live = sseResponse();
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(live.res);

      const { result } = renderHook(() => useValuationStream('v1'));
      await act(async () => live.push(presence('Ana', 'Bo')));
      await waitFor(() => expect(result.current.viewers).toHaveLength(2));

      await act(async () => live.push('event: revoked\ndata: {"reason":"forbidden"}\n\n'));
      await act(async () => live.end());

      // The badges go, because presence is only ever true of an open socket.
      await waitFor(() => expect(result.current.viewers).toEqual([]));

      // And nothing comes back — well past the 3s the client waits after an
      // ordinary drop.
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens no stream at all without a valuation id', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    renderHook(() => useValuationStream(''));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
