import type pg from 'pg';
import { canReadValuation, type Principal } from '../auth/rbac.js';
import { findAuthPrincipal } from '../repos/users.js';
import { findApiTokenById } from '../repos/apiTokens.js';
import { findValuationById } from '../repos/valuations.js';

/**
 * Whether an open SSE stream is still allowed to be open.
 *
 * Every other route on this service re-answers that question per request: the
 * principal's roles and partner are read from the database inside
 * `app.authenticate`, so a role taken away, a partner moved, an account
 * deleted or a "sign out everywhere" takes effect on the very next call. A
 * stream is the one thing here that is authorized once and then served for as
 * long as a tab stays open — hours, days — with a heartbeat holding it up. So
 * the platform's one revocation mechanism reached everything except the
 * connection that outlives the revocation:
 *
 *   * "Sign out everywhere" and a password change bump `session_epoch`, which
 *     kills every JWT minted before it. The REST calls from that tab start
 *     401ing at once — and the stream beside them goes on pushing, which is
 *     the whole of what the button promised not to leave behind.
 *   * A revoked API token stops resolving on the next request and keeps its
 *     stream.
 *   * Losing read access to the valuation — moved to another firm, the
 *     engagement reassigned — leaves the stream carrying presence and comment
 *     pushes for an engagement the reader can no longer open. Their own name
 *     also stays in everyone else's presence badges, so the screen states that
 *     someone who was removed is reading along.
 *
 * The check is deliberately assembled from the same reads the connect path
 * uses, and both paths call *this* function rather than each keeping their own
 * copy. A revalidation stricter than the connect check would be worse than
 * none: the client reconnects three seconds after a close, so a predicate that
 * refuses what connect accepts is an infinite connect/close loop rather than a
 * revocation.
 */

/** How the stream authenticated, and therefore what can revoke it. */
export type StreamCredential =
  /** A session JWT. `epoch` is the `session_epoch` claim it carried. */
  | { kind: 'session'; epoch: number | null }
  /** An API token. Revocation and the org-membership rule both apply. */
  | { kind: 'api_token'; tokenId: string };

export type StreamAccess =
  | { ok: true; principal: Principal }
  /** The credential no longer identifies anyone — a 401 on the connect path. */
  | { ok: false; reason: 'unauthorized' }
  /** The valuation is gone, or this principal may no longer read it. */
  | { ok: false; reason: 'forbidden' };

export async function authorizeStream(
  pool: pg.Pool,
  input: { userId: string; valuationId: string; credential: StreamCredential },
): Promise<StreamAccess> {
  const user = await findAuthPrincipal(pool, input.userId);
  if (!user || user.deleted_at) return { ok: false, reason: 'unauthorized' };

  if (input.credential.kind === 'session') {
    // Mirrors `plugins/auth.ts`: a stream opened by an API token is deliberately
    // unaffected by the session epoch, because revoking browser sessions must
    // not break a partner's running integration.
    if (input.credential.epoch !== null && input.credential.epoch !== user.session_epoch) {
      return { ok: false, reason: 'unauthorized' };
    }
  } else {
    const token = await findApiTokenById(pool, input.credential.tokenId);
    if (!token || token.revoked_at) return { ok: false, reason: 'unauthorized' };
    // The org-token rule from `resolveApiToken`: an organisation token is only
    // good while the member who minted it is still in that organisation.
    if (token.partner_id && token.partner_id !== user.partner_id) {
      return { ok: false, reason: 'unauthorized' };
    }
  }

  const principal: Principal = { id: user.id, roles: user.roles, partnerId: user.partner_id };
  const valuation = await findValuationById(pool, input.valuationId);
  if (
    !valuation ||
    !canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })
  ) {
    return { ok: false, reason: 'forbidden' };
  }
  return { ok: true, principal };
}

/**
 * The periodic re-check, and the teardown it fires once.
 *
 * A transient failure fails *open*. The check is two queries against the same
 * pool every route uses, and treating a two-second database blip as a
 * revocation would close every open stream on the platform at once and hand
 * that same database a reconnect from every one of them a moment later. A
 * revocation that takes effect one tick late is the cheaper mistake by a wide
 * margin; the connect path behind the reconnect is authoritative either way.
 *
 * Ticks never overlap: a check still running when the next one is due skips
 * that beat rather than queueing a second query behind the first.
 */
export function startStreamRevalidation(opts: {
  intervalMs: number;
  check: () => Promise<StreamAccess>;
  /** Called once, with the reason, when the check says the stream must end. */
  onRevoked: (reason: 'unauthorized' | 'forbidden') => void;
  onError: (err: unknown) => void;
}): () => void {
  let running = false;
  let done = false;
  const timer = setInterval(() => {
    if (running || done) return;
    running = true;
    void opts
      .check()
      .then((access) => {
        if (done || access.ok) return;
        done = true;
        clearInterval(timer);
        opts.onRevoked(access.reason);
      })
      .catch(opts.onError)
      .finally(() => {
        running = false;
      });
  }, opts.intervalMs);
  // As with the heartbeat: a revocation check must not be what holds a
  // shutdown open on a connection nobody is waiting for.
  timer.unref?.();
  return () => {
    done = true;
    clearInterval(timer);
  };
}
