import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { isUniqueViolation } from '../db/pgError.js';
import { withTransaction } from '../db/pool.js';
import type { RoleKey } from '../domain/roles.js';
import { hashToken } from './apiTokens.js';
import { assignRoles, type UserRow, type UserWithRoles } from './users.js';

/**
 * User invitations (feature #9): an admin pre-assigns roles/partner, the
 * invitee follows the emailed link and sets their own password. Same token
 * hygiene as password resets — sha256 at rest, single-use, 7-day expiry.
 */

export const INVITE_TTL = '7 days';

export interface InvitationRow {
  id: string;
  email: string;
  roles: RoleKey[];
  partner_id: string | null;
  invited_by: string;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

export interface InvitationListRow extends InvitationRow {
  partner_name: string | null;
  invited_by_email: string | null;
}

const RETURNING = 'id, email, roles, partner_id, invited_by, expires_at, accepted_at, revoked_at, created_at';

/** Raised when a live pending invitation already holds the address. */
export class InvitationPendingError extends Error {}

/**
 * Mint an invitation, retiring whatever dead one was holding the address.
 *
 * `user_invitations_pending_email_key` (migration 0044) is a partial unique
 * index on `lower(email) WHERE accepted_at IS NULL AND revoked_at IS NULL`, and
 * that predicate says nothing about expiry — it cannot, because `now()` is not
 * immutable and Postgres will not index on it. So the slot is held by any
 * unaccepted, unrevoked invitation *forever*, while every reader of the table
 * — `hasPendingInvitation`, `findPendingInvitationByToken`, `acceptInvitation`
 * — additionally requires `expires_at > now()` and correctly considers the same
 * row dead.
 *
 * The two disagreed, and the route sat between them. An invitation that lapsed
 * unaccepted left `hasPendingInvitation` false, so the route's own guard waved
 * the admin through, and the INSERT then collided with the index and raised a
 * 23505 that nothing caught: a 500 on the invite form, for an address the
 * system had just said was free. The TTL is seven days, so this is not an edge
 * case — it is what happens to every invitation nobody accepts, and the only
 * way out was to notice that "revoke" works on a row the UI shows as expired.
 *
 * Retiring the lapsed row inside the same transaction as the INSERT is what
 * makes the index agree with every reader. `revoked_at` is the column for it:
 * the invitations that survive are the ones that can still be redeemed, and a
 * lapsed link cannot, so the row is recorded as what it is rather than deleted
 * — the audit trail keeps who invited whom, and the list keeps showing it.
 *
 * A collision that survives the retirement is a genuinely live invitation, and
 * that is the concurrent case: two admins inviting one address at the same
 * moment both pass `hasPendingInvitation` before either has inserted. The index
 * is the only thing that can settle that, and it now settles it as a 409 saying
 * what happened rather than as a 500.
 */
export async function createInvitation(
  pool: pg.Pool,
  args: { email: string; roles: RoleKey[]; partnerId?: string | null; invitedBy: string },
): Promise<{ invitation: InvitationRow; secret: string }> {
  const secret = randomBytes(32).toString('base64url');
  return withTransaction(pool, async (client) => {
    // Only the lapsed ones. A live pending invitation must still collide below
    // — superseding it here would let a second admin silently re-role an open
    // invitation and invalidate a link that is already in someone's inbox.
    await client.query(
      `UPDATE user_invitations SET revoked_at = now()
       WHERE lower(email) = lower($1)
         AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now()`,
      [args.email],
    );
    const { rows } = await client.query<InvitationRow>(
      `INSERT INTO user_invitations (id, email, roles, partner_id, invited_by, token_sha256, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '${INVITE_TTL}')
       RETURNING ${RETURNING}`,
      [newUlid(), args.email, args.roles, args.partnerId ?? null, args.invitedBy, hashToken(secret)],
    );
    return { invitation: rows[0]!, secret };
  }).catch((err: unknown) => {
    if (isUniqueViolation(err, 'user_invitations_pending_email_key')) throw new InvitationPendingError();
    throw err;
  });
}

/**
 * Ceiling on one page of the invitation ledger.
 *
 * The cap was already 200 and was already reachable — this table keeps every
 * invitation ever sent, accepted and revoked ones included, so a firm that has
 * onboarded two hundred people has an admin console reading only the newest
 * page. What it did not do was say so, and a pending invitation that falls off
 * the end reads as an address nobody has invited: the admin sends another one
 * and gets `InvitationPendingError` back for a row they cannot see.
 */
export const INVITATION_PAGE_LIMIT = 200;

export async function listInvitations(
  pool: pg.Pool,
  opts: { limit?: number } = {},
): Promise<{ invitations: InvitationListRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? INVITATION_PAGE_LIMIT, 1), INVITATION_PAGE_LIMIT);
  const { rows } = await pool.query<InvitationListRow>(
    `SELECT i.id, i.email, i.roles, i.partner_id, i.invited_by, i.expires_at,
            i.accepted_at, i.revoked_at, i.created_at,
            p.name AS partner_name, u.email AS invited_by_email
     FROM user_invitations i
     LEFT JOIN partners p ON p.id = i.partner_id
     LEFT JOIN users u ON u.id = i.invited_by
     ORDER BY i.created_at DESC
     LIMIT $1`,
    [limit + 1],
  );
  return { invitations: rows.slice(0, limit), truncated: rows.length > limit };
}

/** Pending (unaccepted, unrevoked, unexpired) invitation for a presented token. */
export async function findPendingInvitationByToken(
  pool: pg.Pool,
  rawToken: string,
): Promise<InvitationRow | null> {
  const { rows } = await pool.query<InvitationRow>(
    `SELECT ${RETURNING} FROM user_invitations
     WHERE token_sha256 = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
    [hashToken(rawToken)],
  );
  return rows[0] ?? null;
}

/** True while an unaccepted, unrevoked, unexpired invitation exists for the address. */
export async function hasPendingInvitation(pool: pg.Pool, email: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM user_invitations
     WHERE lower(email) = lower($1) AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
    [email],
  );
  return rows.length > 0;
}

/** Resend: mint a new token + expiry, invalidating the previous link. */
export async function refreshInvitation(
  pool: pg.Pool,
  id: string,
): Promise<{ invitation: InvitationRow; secret: string } | null> {
  const secret = randomBytes(32).toString('base64url');
  const { rows } = await pool.query<InvitationRow>(
    `UPDATE user_invitations
     SET token_sha256 = $2, expires_at = now() + interval '${INVITE_TTL}'
     WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
     RETURNING ${RETURNING}`,
    [id, hashToken(secret)],
  );
  return rows[0] ? { invitation: rows[0], secret } : null;
}

export async function revokeInvitation(pool: pg.Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE user_invitations SET revoked_at = now()
     WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export type AcceptResult =
  { status: 'invalid' } | { status: 'conflict' } | { status: 'ok'; user: UserWithRoles };

/**
 * Claims the token and creates the account in one transaction, so a raced
 * double-accept can only ever create one user.
 */
export async function acceptInvitation(
  pool: pg.Pool,
  args: { rawToken: string; passwordDigest: string; firstName?: string; lastName?: string },
): Promise<AcceptResult> {
  return withTransaction(pool, async (client): Promise<AcceptResult> => {
    const { rows } = await client.query<InvitationRow>(
      `UPDATE user_invitations SET accepted_at = now()
       WHERE token_sha256 = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
       RETURNING ${RETURNING}`,
      [hashToken(args.rawToken)],
    );
    const invitation = rows[0];
    if (!invitation) return { status: 'invalid' };

    const existing = await client.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [
      invitation.email,
    ]);
    if (existing.rows.length > 0) {
      // The address was registered after the invite went out — roll back the
      // claim so the admin sees the invitation still pending and can revoke.
      throw new InviteConflictError();
    }

    const { rows: userRows } = await client.query<UserRow>(
      `INSERT INTO users (id, email, password_digest, first_name, last_name, partner_id, verified)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING *`,
      [
        newUlid(),
        invitation.email,
        args.passwordDigest,
        args.firstName ?? null,
        args.lastName ?? null,
        invitation.partner_id,
      ],
    );
    await assignRoles(client, userRows[0]!.id, invitation.roles);
    return { status: 'ok', user: { ...userRows[0]!, roles: invitation.roles } };
  }).catch((err) => {
    if (err instanceof InviteConflictError) return { status: 'conflict' } as const;
    throw err;
  });
}

class InviteConflictError extends Error {}
