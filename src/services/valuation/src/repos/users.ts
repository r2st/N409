import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { isSuspended } from '../auth/rbac.js';
import type { RoleKey } from '../domain/roles.js';
import { revokeInvitationsFrom } from './invitations.js';

export interface UserRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  phone: string | null;
  job_title: string | null;
  company_name: string | null;
  timezone: string | null;
  verified: boolean;
  sso_provider: 'google' | null;
  password_digest: string | null;
  partner_id: string | null;
  created_at: Date;
  /** Soft delete (M3 admin console): set = cannot authenticate. */
  deleted_at: Date | null;
  /** Bumped to invalidate every session JWT minted for this user so far. */
  session_epoch: number;
  /** AES-256-GCM-encrypted base32 TOTP secret (feature: MFA/2FA). */
  totp_secret: string | null;
  /** True once a TOTP enrolment has been confirmed with a valid code. */
  totp_enabled: boolean;
  totp_confirmed_at: Date | null;
  /** External-provisioning provenance (feature 9): 'saml' | 'scim' | null. */
  provisioned_by: string | null;
  scim_external_id: string | null;
}

export interface UserWithRoles extends UserRow {
  roles: RoleKey[];
}

/** Columns a user may edit on their own account. */
export interface OwnProfilePatch {
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  job_title?: string | null;
  company_name?: string | null;
  timezone?: string | null;
  email?: string;
}

export async function findUserByEmail(pool: pg.Pool, email: string): Promise<UserWithRoles | null> {
  const { rows } = await pool.query<UserWithRoles>(
    `SELECT u.*, coalesce(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE lower(u.email) = lower($1)
     GROUP BY u.id`,
    [email],
  );
  return rows[0] ?? null;
}

export async function findUserById(pool: pg.Pool, id: string): Promise<UserWithRoles | null> {
  const { rows } = await pool.query<UserWithRoles>(
    `SELECT u.*, coalesce(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.id = $1
     GROUP BY u.id`,
    [id],
  );
  return rows[0] ?? null;
}

/** The columns the `authenticate` preHandler actually reads. */
export interface AuthPrincipalRow {
  id: string;
  roles: RoleKey[];
  partner_id: string | null;
  deleted_at: Date | null;
  session_epoch: number;
}

/**
 * The narrow read behind bearer authentication.
 *
 * This runs on *every authenticated request* — it is the single most-executed
 * statement in the service — and it used to be `findUserById`, which is
 * `SELECT u.*`. The preHandler reads five fields; the other seventeen columns
 * were fetched, decoded and thrown away several times per page load, and among
 * them are `password_digest` and the encrypted `totp_secret`, which have no
 * business being materialised into the request path of a route that only wants
 * to know who is calling.
 *
 * Deliberately *not* cached. `plugins/auth.ts` documents why: roles and partner
 * are re-read per request so that a role change or a removal takes effect
 * immediately rather than at token expiry, and a TTL — however short — is
 * exactly the window in which a revoked operator keeps their access. Making
 * the read cheap is the alternative to making it rare.
 */
export async function findAuthPrincipal(pool: pg.Pool, id: string): Promise<AuthPrincipalRow | null> {
  const { rows } = await pool.query<AuthPrincipalRow>(
    `SELECT u.id, u.partner_id, u.deleted_at, u.session_epoch,
            coalesce(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.id = $1
     GROUP BY u.id`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Whether a user id names a row — for the reviewer and assignee checks.
 *
 * Four routes (workflow reassign, bulk assign_reviewer, the valuation patch and
 * task assignment) called `findUserById` and did nothing with the result but
 * test it for null. That is `SELECT u.*` plus a two-table join to build a role
 * array nobody reads.
 *
 * Soft-deleted accounts count as existing, which is what `findUserById`
 * returned and therefore what those routes already accepted. Whether a deleted
 * user should be assignable is a real question, but it is a behaviour change
 * and not this one's to make.
 */
export async function userExists(pool: pg.Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM users WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

/**
 * Several users by id, keyed by id — one query for a set the caller already
 * knows the whole of.
 *
 * The shape that wants this is a sweep holding a list of rows that each name a
 * user: the monitoring scan looking up an assigned reviewer per firing trigger,
 * re-reading the same reviewer for every trigger on the same engagement. Ids
 * are de-duplicated here so the caller does not have to.
 */
/**
 * Users by id, deactivated *and suspended* accounts excluded.
 *
 * Every caller uses the result to decide who to *write to* — the state-change
 * hook resolves the owner and reviewer of a transition, the monitoring sweep
 * resolves the reviewer to alert, the comment hook and the auditor-note
 * fan-out resolve who is told a message arrived — and none applied the soft
 * delete that `listUsers`, the firm roster, the reviewer picker, password reset
 * and email verification all apply. The drip-campaign candidate query grew its
 * own `u.deleted_at IS NULL` for exactly this reason; these are the rest of it.
 * A deactivated account kept receiving workflow email and in-app notifications,
 * which is the one thing deactivating it was supposed to stop.
 *
 * The suspension is the same sentence about the other half of this platform's
 * vocabulary for taking access away, and it was missed because `ignored` is
 * *additive*: the row keeps its `admin` or `valuation_user` grant, so nothing
 * that reads the id off an engagement can tell. `valuationScope` answers
 * `{ kind: 'none' }` for a suspended principal — they can open no engagement,
 * no report, no comment thread — and yet the push half went on addressing them
 * by name: a state-change email quoting the company and the engagement number,
 * an excerpt of a client's message, an auditor's finding. Read access was
 * revoked and delivery was not, so the content came to them instead.
 *
 * Nor is an unread notification the end of it. `GET /api/v1/notifications` is
 * authenticated and nothing more — "strictly per-user, so there is nothing to
 * authorize beyond authentication itself" — and a suspended account can still
 * sign in. Whatever was pushed after the suspension is waiting there to be
 * read.
 *
 * Filtered here rather than at the call sites so a fifth caller inherits the
 * rule instead of rediscovering it, and expressed with `isSuspended` rather
 * than a second spelling of `'ignored'` so the push half and the policy layer
 * cannot come to disagree about what a suspension is.
 */
export async function findUsersByIds(
  pool: pg.Pool,
  ids: readonly string[],
): Promise<Map<string, UserWithRoles>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { rows } = await pool.query<UserWithRoles>(
    `SELECT u.*, coalesce(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.id = ANY($1::ulid[]) AND u.deleted_at IS NULL
     GROUP BY u.id`,
    [unique],
  );
  return new Map(rows.filter((r) => !isSuspended(r)).map((r) => [r.id, r]));
}

export async function createUser(
  pool: pg.Pool,
  args: {
    email: string;
    passwordDigest?: string;
    ssoProvider?: 'google';
    firstName?: string;
    lastName?: string;
    partnerId?: string | null;
    verified?: boolean;
    roles: RoleKey[];
  },
): Promise<UserWithRoles> {
  return withTransaction(pool, async (client) => {
    const id = newUlid();
    const { rows } = await client.query<UserRow>(
      `INSERT INTO users (id, email, password_digest, sso_provider, first_name, last_name, partner_id, verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        args.email,
        args.passwordDigest ?? null,
        args.ssoProvider ?? null,
        args.firstName ?? null,
        args.lastName ?? null,
        args.partnerId ?? null,
        args.verified ?? false,
      ],
    );
    await assignRoles(client, id, args.roles);
    return { ...rows[0]!, roles: args.roles };
  });
}

/**
 * Create a user provisioned by an external identity source (SAML JIT / SCIM),
 * with no password and no Google link — the relaxed users_auth_method
 * constraint (migration 0082) accepts a `provisioned_by` account.
 */
export async function createProvisionedUser(
  pool: pg.Pool,
  args: {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    provisionedBy: 'saml' | 'scim';
    externalId?: string | null;
    roles: RoleKey[];
  },
): Promise<UserWithRoles> {
  return withTransaction(pool, async (client) => {
    const id = newUlid();
    const { rows } = await client.query<UserRow>(
      `INSERT INTO users (id, email, first_name, last_name, verified, provisioned_by, scim_external_id)
       VALUES ($1, $2, $3, $4, true, $5, $6)
       RETURNING *`,
      [
        id,
        args.email,
        args.firstName ?? null,
        args.lastName ?? null,
        args.provisionedBy,
        args.externalId ?? null,
      ],
    );
    await assignRoles(client, id, args.roles);
    return { ...rows[0]!, roles: args.roles };
  });
}

/**
 * Active users holding any of the given roles — the audience for a system
 * alert that has no single owner to send to.
 *
 * Soft-deleted accounts are excluded: a notification nobody can log in to read
 * is the same as no notification, and it is exactly the alert that must not go
 * missing. Capped because a billing alert fanned out across a large ops team is
 * noise, and the first few holders of an admin role are enough for someone to
 * act; callers that need everyone should page, not notify.
 *
 * Suspended accounts are excluded for both of those reasons at once. `ignored`
 * is additive, so a suspended administrator still holds the `admin` row this
 * query joins on — and `isOps` answers false for them, which means every one of
 * these fan-outs was addressing somebody the console will not let through the
 * door. That is a disclosure on the billing and client-message paths, whose
 * bodies carry an amount or an excerpt of what a client wrote; and on the job
 * alerts it is worse than nothing, because the cap is a real one and a
 * suspended admin sitting in the first 25 rows displaces a working one.
 *
 * Subtracted in SQL rather than after the fact for that same cap: filtering the
 * result would take the suspended rows out of the page instead of out of the
 * ordering, and the alert would reach fewer people the longer the suspension
 * list grew. `NOT EXISTS` rather than a second join for the reason
 * `isLastUserAdmin` records — the suspension is the absence of a row to join
 * to, and `r.key = ANY($1) AND r.key <> 'ignored'` would still match the
 * account through its other role.
 */
export async function listUserIdsWithRoles(
  pool: pg.Pool,
  roles: readonly RoleKey[],
  limit = 25,
): Promise<string[]> {
  if (roles.length === 0) return [];
  const { rows } = await pool.query<{ id: string }>(
    `SELECT DISTINCT u.id, u.created_at
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE r.key = ANY($1::text[]) AND u.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM user_roles sur
          JOIN roles sr ON sr.id = sur.role_id
          WHERE sur.user_id = u.id AND sr.key = 'ignored'
        )
      ORDER BY u.created_at ASC
      LIMIT $2`,
    [roles as readonly string[], limit],
  );
  return rows.map((r) => r.id);
}

/** Soft delete / reactivate for SCIM `active` toggling. */
/**
 * The directory's half of activation (SCIM deprovision / reactivate).
 *
 * Unlike `softDeleteUser` this deliberately keeps the account's roles: a SCIM
 * `active: false` is routinely followed by an `active: true` on the next
 * resync, and dropping the roles would hand the reactivated user an account
 * that can sign in and see nothing. But a deprovision is still the end of that
 * person's access, so the invitations they have outstanding go with it — the
 * same rule the console's own deactivation applies, for the same reason:
 * nothing else can revoke a link that is already in somebody's inbox.
 *
 * `COALESCE` on the way out, and it is the same rule `cancelSubscription`
 * carries for `canceled_at`: a transition into a state the row is already in
 * must not restate when it was reached. `now()` was assigned unconditionally,
 * and the `/Users/:id` PATCH beside this one already says why that is the
 * ordinary case rather than the exotic one — "an IdP resyncs its whole
 * directory on a schedule and re-asserts `active` for everybody each pass". So
 * a deprovisioned account's `deleted_at` moved forward every pass, forever.
 *
 * That column is the answer to "when did this person lose access". The admin
 * event beside it is guarded and stays put, but `deleted_at` is what
 * `personalDataExport` hands the subject themselves under Article 15, what
 * `analystAvailability` reads to call an assignment `closed`, and what the
 * console prints. All three were reporting the date of the last resync.
 */
export async function setUserActive(pool: pg.Pool, id: string, active: boolean): Promise<void> {
  if (active) {
    await pool.query('UPDATE users SET deleted_at = NULL WHERE id = $1', [id]);
    return;
  }
  await withTransaction(pool, async (client) => {
    await client.query('UPDATE users SET deleted_at = COALESCE(deleted_at, now()) WHERE id = $1', [id]);
    await revokeInvitationsFrom(client, id);
  });
}

/**
 * Grant a set of roles, in one statement rather than one per role.
 *
 * `key = ANY($2)` matches the whole set at once. A role key with no `roles` row
 * inserts nothing, which is what the per-role loop did too — the set is
 * validated where it is chosen, not here.
 */
export async function assignRoles(client: pg.PoolClient, userId: string, roles: RoleKey[]): Promise<void> {
  if (roles.length === 0) return;
  await client.query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, id FROM roles WHERE key = ANY($2::text[])
     ON CONFLICT DO NOTHING`,
    [userId, roles as readonly string[]],
  );
}

/**
 * First Google sign-in creates the account; later sign-ins link/refresh it.
 *
 * A closed account is returned untouched (round 272, methodology M3). `deleted_at`
 * is the terminal state of this row — the password door refuses it and the SAML
 * ACS refuses it — and the caller refuses it here too, so the link/refresh below
 * would be a write made on behalf of a sign-in that is about to be turned away.
 * It is not a harmless one: it moves `sso_provider` to 'google' and sets
 * `verified`, which is a closed account changing shape because somebody outside
 * the firm pressed a button, and it changes which door the account is described
 * as using after it is reopened.
 */
export async function upsertGoogleUser(
  pool: pg.Pool,
  identity: { email: string; givenName?: string; familyName?: string },
): Promise<UserWithRoles> {
  const existing = await findUserByEmail(pool, identity.email);
  if (existing) {
    if (existing.deleted_at) return existing;
    if (existing.sso_provider !== 'google') {
      await pool.query(`UPDATE users SET sso_provider = 'google', verified = true WHERE id = $1`, [
        existing.id,
      ]);
    }
    return { ...existing, sso_provider: 'google', verified: true };
  }
  return createUser(pool, {
    email: identity.email,
    ssoProvider: 'google',
    firstName: identity.givenName,
    lastName: identity.familyName,
    verified: true,
    roles: ['valuation_user'],
  });
}

/**
 * Self-service profile edit. The column allow-list is repeated here rather
 * than trusted from the caller's parsed body — this builds raw SQL identifiers,
 * so an unexpected key must be impossible, not merely unlikely.
 */
const OWN_PROFILE_COLUMNS: ReadonlySet<string> = new Set([
  'first_name',
  'last_name',
  'phone',
  'job_title',
  'company_name',
  'timezone',
  'email',
]);

export async function updateOwnProfile(pool: pg.Pool, id: string, patch: OwnProfilePatch): Promise<void> {
  const entries = Object.entries(patch).filter(([k, v]) => v !== undefined && OWN_PROFILE_COLUMNS.has(k));
  if (entries.length === 0) return;
  const sets = entries.map(([k], i) => `${k} = $${i + 1}`);
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${entries.length + 1}`, [
    ...entries.map(([, v]) => v),
    id,
  ]);
}

export async function setPasswordDigest(pool: pg.Pool, id: string, digest: string): Promise<void> {
  await pool.query('UPDATE users SET password_digest = $2 WHERE id = $1', [id, digest]);
}

/**
 * Invalidates every session JWT issued to this user so far, and returns the
 * new epoch so the caller can mint a replacement token for the session that
 * asked for the revocation.
 */
export async function bumpSessionEpoch(pool: pg.Pool, id: string): Promise<number> {
  const { rows } = await pool.query<{ session_epoch: number }>(
    'UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1 RETURNING session_epoch',
    [id],
  );
  const epoch = rows[0]?.session_epoch;
  if (epoch === undefined) throw new Error(`no such user: ${id}`);
  return epoch;
}

/**
 * The engagement owner's own name and stated company, for redaction.
 *
 * The AI pipelines send a client's cap table, their uploaded financials and
 * the free text they typed about themselves to an external model, and the
 * redactor strikes only the entities it is *told*. It is told the subject
 * company off the valuation row and nothing else, so the two most obvious
 * identifiers this platform holds about the person the engagement is for — the
 * name they signed up with and the employer they named — went out in the clear
 * on every run. `/ai/anonymize` has struck both since it was written, on the
 * reasoning that "they are known, they are on the sheet, and nothing about the
 * request would reveal that they had been missed"; that reasoning is about the
 * material, not about which route is carrying it.
 *
 * Three columns rather than `findUserById`'s `SELECT u.*`. This runs on every
 * AI pipeline run, and the wide read materialises `password_digest` and the
 * encrypted `totp_secret` — which `findAuthPrincipal` exists precisely to keep
 * out of a hot path — plus a two-table join for a role array nobody reads.
 *
 * Deleted and suspended accounts are *not* excluded, unlike `findUsersByIds`.
 * That query answers "who may we write to"; this one answers "whose name must
 * not leave the building", and an engagement whose owner has since been
 * deactivated is still that person's engagement. Excluding them would take the
 * redaction away at the moment the account is closed.
 */
export async function findRedactionIdentity(
  pool: pg.Pool,
  id: string,
): Promise<{ first_name: string | null; last_name: string | null; company_name: string | null } | null> {
  const { rows } = await pool.query<{
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
  }>('SELECT first_name, last_name, company_name FROM users WHERE id = $1', [id]);
  return rows[0] ?? null;
}
