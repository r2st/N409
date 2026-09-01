import type pg from 'pg';
import { canReadValuation } from '../auth/rbac.js';
import { findAuthPrincipal } from '../repos/users.js';

/**
 * Whether the person who started an OAuth hop may still finish it.
 *
 * THE OTHER HALF OF THE QUESTION R334 ASKED (round 336, methodology M3). The
 * three integration callbacks — accounting, cap-table sync, HRIS — re-ask
 * whether the *engagement* is still live before they spend the code, because
 * the signed state lives thirty minutes and what it has to survive is a person
 * reading a provider's consent screen. Nothing re-asked whether the *actor* is
 * still somebody this platform would let do it.
 *
 * A callback carries no session. Its whole authority is a JWT minted by
 * `/connect` and handed to the browser, and a JWT cannot be withdrawn: no
 * `session_epoch`, no revocation list, thirty minutes of validity. So every way
 * an operator's access can end between Connect and Allow left the connection
 * completing anyway — the account closed, the account suspended, the ops role
 * taken away, the partner scope changed so the engagement is no longer theirs.
 *
 * That is the same hole `revokeInvitationsFrom` was written for. Deactivation
 * is this platform's "their access ends now" — sessions 401 on the next
 * request, API tokens stop resolving because the owner is closed, and pending
 * invitations are retired. This state token was the remaining thing that
 * outlived it, and it is the one that grants a *third party* standing access:
 * `upsertConnection` stores the provider's access and refresh tokens, records a
 * `connected` event naming the closed account as who connected it, and arms a
 * schedule that begins pulling the client's data on the next sweep.
 *
 * Asked before the token exchange, for the reason the retirement check gives
 * next to it: spending the code mints a refresh token that then has to be
 * disposed of, and it tells the provider we are acting for somebody whose
 * access ended. Nothing is connected and nothing is granted.
 *
 * The same predicate `/connect` applied, re-read rather than re-derived from
 * the token: `findAuthPrincipal` is deliberately uncached so that a role change
 * or a removal takes effect immediately, and `canReadValuation` subtracts
 * `ignored` through `valuationScope`, so a suspension answers `none` here
 * without this file having to know what a suspension is.
 *
 * Not `findValuationById`: that reader is a five-second read-through cache and
 * the whole question is whether the answer is current — the same note
 * `isRetiredNow` carries beside it. A valuation that has gone counts as no
 * longer connectable, which is what the retirement check would have said about
 * it anyway.
 */
export async function integrationActorStillAuthorized(
  pool: pg.Pool,
  userId: string,
  valuationId: string,
): Promise<boolean> {
  const principal = await findAuthPrincipal(pool, userId);
  if (!principal || principal.deleted_at !== null) return false;
  const { rows } = await pool.query<{ user_id: string; partner_id: string | null }>(
    'SELECT user_id, partner_id FROM valuations WHERE id = $1',
    [valuationId],
  );
  const valuation = rows[0];
  if (!valuation) return false;
  return canReadValuation(
    { id: principal.id, roles: principal.roles, partnerId: principal.partner_id },
    { userId: valuation.user_id, partnerId: valuation.partner_id },
  );
}
