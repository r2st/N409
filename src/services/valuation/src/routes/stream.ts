import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { isUlid, problems } from '@n409/shared';
import type { Principal } from '../auth/rbac.js';
import { findUserById } from '../repos/users.js';
import { requirePrincipal } from '../plugins/auth.js';
import { HubCapacityError, type ValuationHub } from '../realtime/hub.js';
import { authorizeStream, startStreamRevalidation, type StreamCredential } from '../realtime/streamAccess.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The realtime hub these routes fan out through, for the saturation gauge. */
    realtimeHub: ValuationHub;
  }
}

/**
 * Improvement 4 — per-valuation SSE stream. One long-lived GET per open
 * detail page; the hub pushes `presence` (who is viewing) and `comment`
 * (live thread updates) events. The client authenticates with the normal
 * bearer header (fetch-based reader, not EventSource, so no token-in-URL).
 */
export function registerStreamRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; hub: ValuationHub; heartbeatMs?: number; revalidateMs?: number },
): void {
  const heartbeatMs = deps.heartbeatMs ?? 25_000;
  // Slower than the heartbeat on purpose. The heartbeat is a socket write; this
  // is two queries per open stream, so it is paced by what the database should
  // be asked to carry for a connection that is idle by definition. A minute is
  // the window a revocation may lag by, against sessions that otherwise lasted
  // as long as the tab.
  const revalidateMs = deps.revalidateMs ?? 60_000;
  app.decorate('realtimeHub', deps.hub);

  app.get('/api/v1/valuations/:id/stream', { preHandler: app.authenticate }, async (req, reply) => {
    const principal: Principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();

    // The credential, kept for as long as the stream is: it is what the
    // periodic re-check re-answers against. A session carries the epoch the JWT
    // was minted under; an API token carries its row id, since the secret
    // itself is never held past `resolveApiToken`.
    const credential: StreamCredential = req.apiToken
      ? { kind: 'api_token', tokenId: req.apiToken.tokenId }
      : { kind: 'session', epoch: req.sessionEpoch };

    const check = () => authorizeStream(deps.pool, { userId: principal.id, valuationId: id, credential });
    const access = await check();
    // Both failures are a 404 here, which is what this route already answered
    // for an unreadable valuation: an authenticated caller has just cleared
    // `app.authenticate`, so 'unauthorized' at this point means the account was
    // deleted between the two reads and is not worth a different status.
    if (!access.ok) throw problems.notFound();

    const user = await findUserById(deps.pool, principal.id);
    const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.email || 'Someone';

    // Refuse before hijacking: once the event-stream headers are on the wire
    // there is no status left to answer with. `capacityFor` and the `join`
    // below are one synchronous run, so no second request can slip between.
    if (deps.hub.capacityFor(id, principal.id)) {
      throw problems.tooManyRequests('Too many open realtime streams — close a tab and retry', 30);
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // disable proxy buffering (nginx) so events flush
    });
    reply.raw.write(': connected\n\n');

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // The heartbeat's teardown is also what closes this stream at shutdown, and
    // it cannot exist yet: the hub has to register the connection before
    // `startHeartbeat` can be handed the leave fn it tears down with. So the
    // teardown is passed by reference and filled in below. A shutdown landing
    // in the microseconds between registers as a stream with nothing to stop,
    // which ends the response and leaves the heartbeat to the timer's own
    // failed-write teardown.
    const heartbeat: { stop?: () => void } = {};
    let leave: () => void;
    try {
      leave = deps.hub.join(id, {
        userId: principal.id,
        name,
        send,
        close: () => {
          heartbeat.stop?.();
          reply.raw.end();
        },
      });
    } catch (err) {
      // Unreachable behind the check above, but a throw after `hijack()` has no
      // reply to land on — end the stream rather than leak the socket.
      if (!(err instanceof HubCapacityError)) req.log.error({ err, valuationId: id }, 'realtime join failed');
      reply.raw.end();
      return;
    }

    const stop = startHeartbeat({
      intervalMs: heartbeatMs,
      write: () => reply.raw.write(': ping\n\n'),
      onDead: (err) => req.log.debug({ err }, 'realtime heartbeat write failed; closing stream'),
      leave: () => leave(),
    });
    heartbeat.stop = stop;

    // Revocation. Told before it is closed: the client's reader sees a socket
    // that ended and cannot tell a revoked stream from a dropped one, so
    // without the frame it waits out its backoff and reconnects into a refusal.
    const stopRevalidation = startStreamRevalidation({
      intervalMs: revalidateMs,
      check,
      onRevoked: (reason) => {
        req.log.info({ valuationId: id, userId: principal.id, reason }, 'realtime stream revoked');
        try {
          send('revoked', { reason });
        } catch {
          // The socket is already gone; the teardown below is what matters.
        }
        stop();
        reply.raw.end();
      },
      onError: (err) =>
        req.log.warn({ err, valuationId: id }, 'realtime revocation check failed; stream kept'),
    });

    req.raw.on('close', () => {
      stopRevalidation();
      stop();
    });
  });
}

/**
 * The keep-alive ping, and the teardown it shares with the client disconnect.
 *
 * `write` is guarded because the `close` handler is not guaranteed to have run
 * before the next tick: a write to a socket that has already gone away emits
 * `error` on the response, and an `error` with no listener is thrown — from a
 * timer callback, so it lands as an uncaughtException and `installCrashHandlers`
 * takes the whole service down with it. `ValuationHub.broadcast` already wraps
 * exactly this call for exactly this reason; the heartbeat was the one writer
 * that did not.
 *
 * Tearing down on the first failed ping, rather than pinging on into a dead
 * socket, also releases the room entry — which is what the presence badges and
 * the per-user stream cap are counted from.
 *
 * The returned stop is idempotent, so the close handler and a failed ping can
 * both run without double-counting the departure: `clearInterval` on a cleared
 * timer is a no-op, and `leave` returns early on a second call (see hub.join).
 */
export function startHeartbeat(opts: {
  intervalMs: number;
  write: () => void;
  onDead: (err: unknown) => void;
  leave: () => void;
}): () => void {
  const stop = () => {
    clearInterval(timer);
    opts.leave();
  };
  const timer = setInterval(() => {
    try {
      opts.write();
    } catch (err) {
      opts.onDead(err);
      stop();
    }
  }, opts.intervalMs);
  // Node keeps the process alive for a pending timer; a keep-alive ping on a
  // connection nobody is waiting for should not be what holds a shutdown open.
  timer.unref?.();
  return stop;
}
