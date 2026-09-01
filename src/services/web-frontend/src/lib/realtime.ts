import { useEffect, useState } from 'react';
import { getToken } from './api';

/**
 * Improvement 4 — client side of the per-valuation SSE stream. A fetch-based
 * reader (not EventSource) so the normal bearer header authenticates the
 * stream — no token in the URL. Reconnects on a backoff that widens while the
 * server keeps refusing, and honours a `retry-after` when it sends one.
 */

/** First wait after a stream ends, and the step the backoff doubles from. */
const BASE_RETRY_MS = 3_000;
/** The widest the backoff opens. A tab is expected to come back on its own. */
const MAX_RETRY_MS = 30_000;
/** Ceiling on a server-supplied wait, so a bad header cannot park a tab. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;

/**
 * How long to wait after the `n`th consecutive failed attempt.
 *
 * Flat 3s was right for the case it was written for — a socket the server
 * restarted under, which comes back within one wait — and wrong for the case
 * below it: a refusal that will still be a refusal in three seconds.
 */
export function streamBackoffMs(consecutiveFailures: number): number {
  const n = Math.max(1, consecutiveFailures);
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** (n - 1));
}

/**
 * A `retry-after` in milliseconds, or null when there is nothing usable to read.
 *
 * Seconds only. The header's HTTP-date form is legal and this platform never
 * sends it — `problems.tooManyRequests` takes a number of seconds and the
 * helper writes exactly that — so parsing a date here would be answering a
 * question no server on the other end asks. Anything unusable falls back to the
 * backoff, which is the safe direction: too long a wait is a tab that reconnects
 * late, too short is the loop this exists to stop.
 */
export function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000));
}

export interface Viewer {
  user_id: string;
  name: string;
}

export interface StreamEvent {
  event: string;
  data: unknown;
}

/**
 * Incremental SSE parse: consumes complete `\n\n`-terminated blocks from the
 * buffer and returns the unterminated tail to prepend to the next chunk.
 * Comment/heartbeat lines (":" prefix) and non-JSON payloads are skipped.
 */
export function parseSseBuffer(buffer: string): { events: StreamEvent[]; rest: string } {
  const events: StreamEvent[] = [];
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    try {
      events.push({ event, data: JSON.parse(dataLines.join('\n')) });
    } catch {
      // malformed frame — drop it rather than kill the stream
    }
  }
  return { events, rest };
}

export interface ValuationStream {
  /** Everyone with the valuation open right now (including this session). */
  viewers: Viewer[];
  /** Bumps whenever a comment lands — consumers re-fetch their thread. */
  commentTick: number;
}

export function useValuationStream(valuationId: string): ValuationStream {
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const [commentTick, setCommentTick] = useState(0);

  useEffect(() => {
    if (!valuationId) return;
    let stopped = false;
    let controller: AbortController | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    /**
     * Whether a stream has ever carried presence for this valuation. It is what
     * separates the first connect from a reconnect, and the two owe the thread
     * different things — see the tick bump below.
     */
    let everConnected = false;
    /**
     * Attempts since the last stream that actually opened, for the backoff.
     *
     * Reset on a 200 rather than on a clean read: a socket the server restarted
     * under is the case the flat wait was written for and is not what the
     * widening is about.
     */
    let failures = 0;

    const connect = async () => {
      controller = new AbortController();
      /** A status that says not to come back, as opposed to a dropped socket. */
      let terminal = false;
      /** What the server asked us to wait, when it said anything about it. */
      let serverWaitMs: number | null = null;
      try {
        const headers = new Headers({ accept: 'text/event-stream' });
        const token = getToken();
        if (token) headers.set('authorization', `Bearer ${token}`);
        const res = await fetch(`/api/v1/valuations/${valuationId}/stream`, {
          headers,
          signal: controller.signal,
        });
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          terminal = true;
        } else {
          if (!res.ok || !res.body) {
            /*
             * A refusal, as opposed to a socket that went away.
             *
             * The hub refuses a caller with too many streams open with a 429
             * and `retry-after: 30`, which is the one condition where coming
             * back in three seconds makes things worse: every tab that caused
             * the saturation re-asks twenty times a minute, and each attempt
             * costs the authorization read and the user lookup that run before
             * the capacity check. The refusal says how long to wait, and it was
             * being thrown away with the rest of the response.
             */
            serverWaitMs = retryAfterMs(res.headers.get('retry-after'));
            throw new Error(`stream failed (${res.status})`);
          }
          failures = 0;

          // A reconnect means the gap it just closed swallowed every `comment`
          // push the server sent while the socket was down, and the hub replays
          // nothing on join — only presence. Bumping the tick makes consumers
          // re-fetch the thread once, which is the only way those comments are
          // ever seen again without a navigation. Not on the first connect:
          // there is no gap behind it, and the thread's own initial fetch
          // already covers that.
          if (everConnected) setCommentTick((t) => t + 1);
          everConnected = true;

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const { events, rest } = parseSseBuffer(buf);
            buf = rest;
            for (const ev of events) {
              if (ev.event === 'presence') {
                setViewers(((ev.data as { viewers?: Viewer[] }).viewers ?? []) as Viewer[]);
              } else if (ev.event === 'comment') {
                setCommentTick((t) => t + 1);
              } else if (ev.event === 'revoked') {
                // The server re-checks, on a timer, that this stream is still
                // allowed to be open — a signed-out session, a revoked token, a
                // permission taken away — and says so before it hangs up. The
                // reconnect behind a silent close would be refused anyway; the
                // frame is what makes that refusal immediate instead of a
                // three-second wait and a pointless request.
                terminal = true;
              }
            }
          }
        }
      } catch {
        // aborted on unmount, or a dropped connection — handled below
      }
      if (stopped) return;
      // Off the stream, for whatever reason. Presence is a fact only the open
      // socket knows: the hub broadcasts the room on every join and leave and
      // never replays, so a list held across a disconnect is the membership of
      // some earlier moment, shown as if it were now. A revoked permission or a
      // retired valuation ends the stream for good and nothing else would ever
      // clear those badges. Clearing costs at most a few seconds of an empty
      // list, because the reconnect's own join broadcasts the room back.
      setViewers([]);
      if (!terminal) {
        failures += 1;
        retry = setTimeout(() => void connect(), serverWaitMs ?? streamBackoffMs(failures));
      }
    };

    void connect();
    return () => {
      stopped = true;
      controller?.abort();
      if (retry) clearTimeout(retry);
      setViewers([]);
      setCommentTick(0);
    };
  }, [valuationId]);

  return { viewers, commentTick };
}
