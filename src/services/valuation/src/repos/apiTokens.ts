import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { newUlid } from '@n409/shared';

/**
 * API tokens (M3 feature 14). The bearer secret (`n409_pat_…`) is returned
 * exactly once at creation; only its sha256 digest is stored.
 *
 * A token always acts as the user in `created_by`. With a `partner_id` it is a
 * partner token, usable against the programmatic partner API. With a NULL
 * `partner_id` it is a *personal* token: it carries only its owner's own scope,
 * which is what lets a client user script against their own valuations.
 */

export const TOKEN_SCHEME = 'n409_pat_';

export interface ApiTokenRow {
  id: string;
  partner_id: string | null;
  created_by: string;
  name: string;
  token_prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export function hashToken(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export async function createApiToken(
  pool: pg.Pool,
  args: { partnerId: string | null; createdBy: string; name: string },
): Promise<{ token: ApiTokenRow; secret: string }> {
  const secret = `${TOKEN_SCHEME}${randomBytes(32).toString('base64url')}`;
  const prefix = secret.slice(0, TOKEN_SCHEME.length + 6);
  const { rows } = await pool.query<ApiTokenRow>(
    `INSERT INTO api_tokens (id, partner_id, created_by, name, token_prefix, token_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, partner_id, created_by, name, token_prefix, created_at, last_used_at, revoked_at`,
    [newUlid(), args.partnerId, args.createdBy, args.name, prefix, hashToken(secret)],
  );
  return { token: rows[0]!, secret };
}

/**
 * Ceiling on one page of an issuer's tokens.
 *
 * Revoked rows are kept deliberately — a credential that existed is part of
 * the audit trail (see the admin listing below) — so this list is append-only
 * in practice and grows with every rotation.
 */
export const API_TOKEN_PAGE_LIMIT = 200;

export async function listApiTokens(
  pool: pg.Pool,
  partnerId: string,
): Promise<{ tokens: ApiTokenRow[]; truncated: boolean }> {
  const { rows } = await pool.query<ApiTokenRow>(
    `SELECT id, partner_id, created_by, name, token_prefix, created_at, last_used_at, revoked_at
     FROM api_tokens WHERE partner_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [partnerId, API_TOKEN_PAGE_LIMIT + 1],
  );
  return {
    tokens: rows.slice(0, API_TOKEN_PAGE_LIMIT),
    truncated: rows.length > API_TOKEN_PAGE_LIMIT,
  };
}

export interface AdminApiTokenRow extends ApiTokenRow {
  partner_name: string | null;
  partner_key: string | null;
  created_by_email: string | null;
  created_by_name: string | null;
}

/**
 * Every token on the platform, joined to its partner and issuing user
 * (design §14.1). `token_hash` is never selected — the plaintext secret is
 * shown once at creation and only its digest is stored, and a listing that
 * returns the digest hands an attacker an offline target for nothing.
 *
 * Live tokens sort first, then by recency, because the question this list is
 * read to answer — "who currently holds API credentials, and which of those
 * credentials is dormant" — is about the live ones. Revoked rows stay for the
 * audit trail rather than to be scrolled past.
 */
export async function listAllApiTokens(
  pool: pg.Pool,
  opts: { includeRevoked?: boolean; limit?: number } = {},
): Promise<{ tokens: AdminApiTokenRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? TOKEN_PAGE_LIMIT, 1), TOKEN_PAGE_LIMIT);
  const { rows } = await pool.query<AdminApiTokenRow>(
    `SELECT t.id, t.partner_id, t.created_by, t.name, t.token_prefix,
            t.created_at, t.last_used_at, t.revoked_at,
            p.name AS partner_name, p.key AS partner_key,
            u.email AS created_by_email,
            NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS created_by_name
       FROM api_tokens t
       LEFT JOIN partners p ON p.id = t.partner_id
       LEFT JOIN users u ON u.id = t.created_by
      WHERE ($1::boolean OR t.revoked_at IS NULL)
      ORDER BY (t.revoked_at IS NULL) DESC, t.created_at DESC
      LIMIT $2`,
    [opts.includeRevoked === true, limit + 1],
  );
  return { tokens: rows.slice(0, limit), truncated: rows.length > limit };
}

/** Ceiling on one page of the platform token listing. */
export const TOKEN_PAGE_LIMIT = 500;

export interface ApiTokenStats {
  total: number;
  live: number;
  dormant: number;
}

/**
 * The three figures the credential listing reports, counted in the database.
 *
 * They used to be `rows.length`, `rows.filter(...)` and so on over the whole
 * table, which is the reason the listing could not simply be capped: bounding
 * the read would have silently bounded the counts with it, and a security
 * listing that under-reports how many live credentials exist is worse than a
 * slow one. Counting here decouples the two, so the rows can be a page while
 * the figures stay platform-wide.
 *
 * `dormant` keeps the definition the route had. A token that has never been
 * used counts as dormant only once it is older than the window — a key minted
 * this morning has not had its chance yet — so the age is measured from
 * `last_used_at` when there is one and from `created_at` when there is not.
 */
export async function apiTokenStats(pool: pg.Pool, dormantAfterMs: number): Promise<ApiTokenStats> {
  const { rows } = await pool.query<{ total: string; live: string; dormant: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE revoked_at IS NULL)::text AS live,
            count(*) FILTER (
              WHERE revoked_at IS NULL
                AND coalesce(last_used_at, created_at) < now() - ($1::bigint * interval '1 millisecond')
            )::text AS dormant
       FROM api_tokens`,
    [Math.trunc(dormantAfterMs)],
  );
  const row = rows[0]!;
  return { total: Number(row.total), live: Number(row.live), dormant: Number(row.dormant) };
}

/** A user's personal tokens — partner tokens they minted for an org are excluded. */
export async function listPersonalApiTokens(
  pool: pg.Pool,
  userId: string,
): Promise<{ tokens: ApiTokenRow[]; truncated: boolean }> {
  const { rows } = await pool.query<ApiTokenRow>(
    `SELECT id, partner_id, created_by, name, token_prefix, created_at, last_used_at, revoked_at
     FROM api_tokens WHERE created_by = $1 AND partner_id IS NULL ORDER BY created_at DESC LIMIT $2`,
    [userId, API_TOKEN_PAGE_LIMIT + 1],
  );
  return {
    tokens: rows.slice(0, API_TOKEN_PAGE_LIMIT),
    truncated: rows.length > API_TOKEN_PAGE_LIMIT,
  };
}

/** Revokes every live token a user owns — used when closing an account. */
export async function revokeTokensOwnedBy(pool: pg.Pool, userId: string): Promise<number> {
  const { rowCount } = await pool.query(
    'UPDATE api_tokens SET revoked_at = now() WHERE created_by = $1 AND revoked_at IS NULL',
    [userId],
  );
  return rowCount ?? 0;
}

export async function findApiTokenById(pool: pg.Pool, id: string): Promise<ApiTokenRow | null> {
  const { rows } = await pool.query<ApiTokenRow>(
    `SELECT id, partner_id, created_by, name, token_prefix, created_at, last_used_at, revoked_at
     FROM api_tokens WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function revokeApiToken(pool: pg.Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Resolve a presented secret to the user it acts as. Touches last_used_at.
 * Returns null for unknown or revoked tokens, and for an organisation token
 * whose creator is no longer in that organisation.
 *
 * That last clause is the whole point of the join. A partner token is the only
 * credential on this platform that carries an authority the *token row* names
 * rather than one re-read from the presenter: `partnerApi.loadScoped` scopes
 * every request to `token.partner_id` and never consults the user behind it. So
 * when an admin moved a firm's org admin to another firm — or off the firm
 * entirely — the token they had minted went on reading, creating and uploading
 * against their old firm's engagements. One firm's client list, documents and
 * concluded 409As, reachable by someone who had left, with the only remedy
 * being that somebody at the old firm noticed a token in a settings page and
 * revoked it.
 *
 * The session path has always re-read roles and partner from the database on
 * every request, precisely so a change takes effect at once rather than at
 * token expiry. This is that same rule reaching the credential that had been
 * exempt from it.
 *
 * Refused rather than revoked: an admin who moves a user by mistake can move
 * them back and the integration resumes, where a revocation on a failed auth
 * would be permanent and would let a *stolen* token be used to kill a firm's
 * integration. The consequence — a firm's integration stops when the member who
 * minted its key leaves — is the correct one, and the same one every other
 * platform's org tokens have; the firm mints a new key under a current member.
 *
 * Personal tokens (partner_id NULL) are unaffected: they carry only their
 * owner's own scope, which is re-read per request already.
 */
/**
 * Why a presented secret was refused.
 *
 * Four conditions used to arrive as one `null`, and the partner API answered
 * all four with "Invalid or revoked API token". Three of them are things
 * somebody can go and fix, and each fix is different: mint a new key, un-revoke
 * or replace a revoked one, or move the member back / re-mint under a current
 * one. An integrator holding a key that stopped working overnight got no way to
 * tell which — and the `orphaned` case, which is the one this platform actually
 * causes, reads exactly like a typo.
 *
 * Telling the presenter is safe. Every one of these answers is given only to
 * somebody who has already produced the secret, so it discloses nothing to
 * anyone who did not already hold the credential; `unknown` — the one case
 * where the presenter has proved nothing — is the one that stays vague.
 */
export type ApiTokenRefusal =
  /** No live token has this digest. A typo, a key from another environment, or one that was deleted. */
  | 'unknown'
  /** The digest matches a token whose `revoked_at` is set. */
  | 'revoked'
  /**
   * The token is live, but the user in `created_by` is gone — the row deleted,
   * or the account closed (`deleted_at`).
   *
   * The closed-account half only became distinguishable this round. The
   * resolving UPDATE did not test `deleted_at`, so a token minted by somebody
   * whose account was later closed resolved, and `registerAuth` refused it one
   * line later with "Unknown user" — a message about *us* not finding a row,
   * handed to an integrator who has no user to go and look up. Excluding them
   * here is not a new refusal; it moves the same refusal to the layer that can
   * say what it means.
   */
  | 'no_owner'
  /**
   * The token is live and so is its owner, but they are no longer a member of
   * the organisation the token belongs to.
   *
   * The documented, deliberate consequence of scoping a partner token to
   * `token.partner_id` (see the note above): move the org admin who minted a
   * firm's key to another firm and that firm's integration stops. Refused
   * rather than revoked, so it resumes if the move was a mistake — which is
   * only a useful property if somebody is told what happened.
   */
  | 'orphaned'
  /**
   * The token, its owner and their membership are all fine, and the firm the
   * key acts for has been withdrawn from the platform (`partners.archived_at`).
   *
   * ARCHIVING A FIRM STOPPED EVERY DOOR A PERSON USES AND NONE OF THE MACHINE
   * ONES (round 342, methodology M3). `LIVE_LINK_SQL` in `repos/clientIntake.ts`
   * states what the flag means and it is not hedged: "the platform's soft delete
   * for a firm — an archived partner takes no new user assignments, cannot have
   * its branding edited, and is gone from the branding list", and it closed the
   * intake links for exactly that reason. The partner API key was the fourth
   * door onto the same authority and was never asked the question. So a firm the
   * platform has withdrawn kept a working credential against
   * `/api/partner/v1`: it could list its old clients, read their cap tables and
   * concluded 409As, create new engagements under the archived firm and upload
   * documents to them — unattended, on a schedule, with nothing in the product
   * showing the firm at all.
   *
   * The person-facing doors were closed one at a time as somebody noticed each;
   * this is the door with no person behind it to notice.
   *
   * Refused rather than revoked, the same choice `orphaned` makes and for a
   * stronger reason: archiving a partner is a boolean an administrator can set
   * back (`updatePartner`'s `archived: false` clears `archived_at`), so a firm
   * archived by mistake gets its integration back by being un-archived, where
   * revoking the keys would have made the mistake permanent.
   */
  | 'partner_retired';

/**
 * A refusal, and the row it is about.
 *
 * `unknown` is the one refusal that can arrive with no row — no live token has
 * that digest, so there is nothing to name. Every other branch has one, and the
 * log line in `observability/apiTokenAuth.ts` is the reason it is carried out:
 * `partner_retired` is remedied by un-archiving one partner, and a counter
 * labelled by outcome cannot say which.
 */
export interface RefusedApiToken {
  refusal: ApiTokenRefusal;
  tokenId: string | null;
  partnerId: string | null;
}

export interface ResolvedApiToken {
  tokenId: string;
  userId: string;
  partnerId: string | null;
}

/**
 * Resolve a presented secret to the user it acts as, with the reason when the
 * answer is no.
 *
 * One round trip on the hot path, not two: the UPDATE is attempted first and
 * the diagnostic SELECT runs only on the miss, so a working integration issues
 * exactly the query it always did and the extra read happens only on requests
 * that are about to be refused anyway.
 */
export async function resolveApiTokenWithReason(
  pool: pg.Pool,
  secret: string,
): Promise<{
  token: ResolvedApiToken | null;
  refusal: ApiTokenRefusal | null;
  /**
   * The refusal with the row it is about, for the log line the counter cannot
   * carry (R345, methodology M11). `observability/apiTokenAuth.ts` labels only
   * by outcome — a label per firm is a series per firm — so which key and which
   * partner has to travel here. Null on success, and both fields are null for
   * `unknown`, where there is no row to name.
   */
  refused: RefusedApiToken | null;
}> {
  const digest = hashToken(secret);
  const { rows } = await pool.query<{ id: string; created_by: string; partner_id: string | null }>(
    `UPDATE api_tokens t SET last_used_at = now()
       FROM users u
      WHERE t.token_hash = $1
        AND t.revoked_at IS NULL
        AND u.id = t.created_by
        AND u.deleted_at IS NULL
        AND (t.partner_id IS NULL OR u.partner_id = t.partner_id)
        -- The firm itself, not just the membership. See the partner_retired
        -- refusal: a withdrawn partner's key kept full authority over its old
        -- clients' files. An EXISTS rather than a second FROM entry, because a
        -- join condition in UPDATE ... FROM cannot reference the target table.
        AND (
          t.partner_id IS NULL
          OR EXISTS (SELECT 1 FROM partners p WHERE p.id = t.partner_id AND p.archived_at IS NULL)
        )
     RETURNING t.id, t.created_by, t.partner_id`,
    [digest],
  );
  const row = rows[0];
  if (row) {
    return {
      token: { tokenId: row.id, userId: row.created_by, partnerId: row.partner_id },
      refusal: null,
      refused: null,
    };
  }
  const refused = await refusalFor(pool, digest);
  return { token: null, refusal: refused.refusal, refused };
}

/**
 * Which of the UPDATE's four conditions failed.
 *
 * Deliberately not a join back onto `users`: `deleted_at` is what makes a user
 * gone here, and the membership test is against `partner_id`, so both are read
 * explicitly rather than inferred from a row's absence. A token whose owner is
 * both deleted and moved reports `no_owner`, the more fundamental of the two.
 *
 * `partner_retired` is ordered ahead of `orphaned` for that same reason. A firm
 * that has been withdrawn is the more fundamental fact of the pair, and it is
 * the one whose remedy comes first: re-minting the key under a current member
 * of an archived firm produces another key this same clause refuses.
 */
async function refusalFor(pool: pg.Pool, digest: string): Promise<RefusedApiToken> {
  const { rows } = await pool.query<{
    id: string;
    partner_id: string | null;
    revoked: boolean;
    owner_present: boolean;
    partner_live: boolean;
    owner_in_partner: boolean;
  }>(
    `SELECT t.id,
            t.partner_id,
            t.revoked_at IS NOT NULL AS revoked,
            (u.id IS NOT NULL AND u.deleted_at IS NULL) AS owner_present,
            (t.partner_id IS NULL OR (p.id IS NOT NULL AND p.archived_at IS NULL)) AS partner_live,
            (t.partner_id IS NULL OR u.partner_id = t.partner_id) AS owner_in_partner
       FROM api_tokens t
       LEFT JOIN users u ON u.id = t.created_by
       LEFT JOIN partners p ON p.id = t.partner_id
      WHERE t.token_hash = $1`,
    [digest],
  );
  const row = rows[0];
  if (!row) return { refusal: 'unknown', tokenId: null, partnerId: null };
  const named = (refusal: ApiTokenRefusal): RefusedApiToken => ({
    refusal,
    tokenId: row.id,
    partnerId: row.partner_id,
  });
  if (row.revoked) return named('revoked');
  if (!row.owner_present) return named('no_owner');
  if (!row.partner_live) return named('partner_retired');
  if (!row.owner_in_partner) return named('orphaned');
  // Every condition the UPDATE tests now reads as satisfied, so the row was
  // changed between the two statements. Nothing here is a fact any more; say
  // the least specific true thing rather than a stale one — and name the row
  // anyway, because there is one and the operator reading the line has as much
  // right to it here as in any other branch.
  return named('unknown');
}

/**
 * What the presenter of a refused token is told.
 *
 * One sentence each, naming the condition and the move that fixes it. Kept
 * beside the enum rather than in the auth plugin because the plugin is the only
 * caller today and will not be the only one for long — the docs endpoint
 * describes these statuses too, and two hand-written copies of a message is how
 * they drift.
 *
 * Four of them named one screen, Settings → API tokens, and that screen is
 * `POST /me/tokens` — it mints *personal* keys and nothing else. `orphaned` is
 * the one where that is unambiguously the wrong door: it can only fire on a
 * partner key (`owner_in_partner` is trivially true when `partner_id` is null),
 * so the holder of a firm's integration credential was told to replace it with
 * a credential that has no authority over the firm, and the partner API's own
 * 403 would then have sent them back to the same screen. The other three can be
 * about either kind of key and the sentence only knew about one, so all four
 * now name both doors. `partner_retired` is left alone — it is also partner-only
 * and it already says that minting anything is not the fix.
 */
export const API_TOKEN_REFUSAL_DETAIL: Record<ApiTokenRefusal, string> = {
  unknown:
    'That API token is not recognised. Check it was copied whole (tokens start `n409_pat_`) and that it belongs to this environment, or mint a new one — Settings → API tokens for a personal key, the API tokens panel on the partner portal for a partner key.',
  revoked:
    'That API token has been revoked and will not work again. Mint a replacement — Settings → API tokens for a personal key, the API tokens panel on the partner portal for a partner key — and update your integration.',
  no_owner:
    'The user account this API token was created under no longer exists, so the token has no authority to act with. Mint a replacement under a current user: Settings → API tokens for a personal key, the API tokens panel on the partner portal for a partner key.',
  orphaned:
    'The user who created this API token is no longer a member of the organization the token acts for, so it has been refused rather than revoked. Mint a replacement from the API tokens panel on the partner portal, under someone still with the organization — Settings → API tokens mints personal keys, which carry no authority over that organization. If the change of membership was a mistake, restoring it brings this token back.',
  partner_retired:
    'The organization this API token acts for has been archived on this platform, so every key belonging to it is refused rather than revoked, and minting a replacement will not help. Ask your administrator to restore the organization — doing so brings this token back on its own.',
};
