import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { signSession, type JwtConfig } from '../auth/jwt.js';
import { setSessionCookie, type SessionCookieConfig } from '../auth/cookies.js';
import { verifyReauthPassword } from '../auth/reauth.js';
import { USER_ADMIN_ROLES } from '../domain/roles.js';
import {
  bumpSessionEpoch,
  findUserById,
  findUserByEmail,
  updateOwnProfile,
  type UserWithRoles,
} from '../repos/users.js';
import { softDeleteUser } from '../repos/adminUsers.js';
import { buildPersonalDataExport } from '../repos/dataExport.js';
import {
  API_TOKEN_PAGE_LIMIT,
  createApiToken,
  findApiTokenById,
  listPersonalApiTokens,
  revokeApiToken,
  revokeTokensOwnedBy,
} from '../repos/apiTokens.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { requirePrincipal } from '../plugins/auth.js';
import { createEmailVerificationToken } from '../repos/emailVerifications.js';
import { emailVerificationEmail } from '../domain/emailWorkflows.js';
import { NullablePhone } from '../domain/phone.js';
import { sendTransactionalEmail } from '../email/transactional.js';
import type { EmailTransport } from '../hooks/stateChange.js';
import type { SupportEmailSource } from '../hooks/autoEmails.js';
import { invalidBody } from '../domain/validationProblem.js';

/**
 * Self-service account management: the things a signed-in user does to their
 * own account without an administrator. Every route here is scoped to the
 * authenticated principal — there is no id in any path, so there is nothing to
 * authorize beyond authentication itself.
 *
 * Password change lives in routes/auth.ts alongside the reset flow it shares
 * hashing rules with.
 */

/** Trims, and turns a cleared field into NULL rather than an empty string. */
const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null));

const ProfileBody = z
  .object({
    first_name: OptionalText(100),
    last_name: OptionalText(100),
    phone: NullablePhone,
    job_title: OptionalText(150),
    company_name: OptionalText(200),
    // Validated against the runtime's own tz database rather than a hardcoded
    // list, so it stays correct as zones are added or renamed.
    timezone: OptionalText(100).refine(isKnownTimezone, 'Unknown time zone'),
    email: z.string().email().max(320),
    /** Required only when changing the email of a password account. */
    current_password: z.string().min(1),
  })
  .partial()
  .strict();

const CloseAccountBody = z.object({
  /** Required for password accounts; ignored for SSO-only accounts. */
  current_password: z.string().min(1).optional(),
});

const TokenBody = z.object({
  name: z.string().trim().min(1).max(200),
  /** Required for password accounts; ignored for SSO-only ones. See the mint route. */
  current_password: z.string().min(1).optional(),
});

function isKnownTimezone(tz: string | null): boolean {
  if (tz === null) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function toPublicUser(u: UserWithRoles) {
  return {
    id: u.id,
    email: u.email,
    first_name: u.first_name,
    last_name: u.last_name,
    phone: u.phone,
    job_title: u.job_title,
    company_name: u.company_name,
    timezone: u.timezone,
    verified: u.verified,
    sso_provider: u.sso_provider,
    partner_id: u.partner_id,
    roles: u.roles,
  };
}

export function registerAccountRoutes(
  app: FastifyInstance,
  deps: {
    pool: pg.Pool;
    jwt: JwtConfig;
    transport?: EmailTransport;
    publicBaseUrl?: string;
    cookie?: SessionCookieConfig;
    /** Answers `{{support_email}}` in an ops-authored override of the copy below. */
    settings?: SupportEmailSource;
  },
): void {
  const baseUrl = (deps.publicBaseUrl ?? 'http://localhost:3000').replace(/\/$/, '');
  const loadSelf = async (id: string): Promise<UserWithRoles> => {
    const user = await findUserById(deps.pool, id);
    if (!user) throw problems.unauthorized();
    return user;
  };

  /** Mints a session token carrying the user's current epoch. */
  const issueToken = (u: UserWithRoles, sessionEpoch: number) =>
    signSession(
      { sub: u.id, roles: u.roles, partner_id: u.partner_id, session_epoch: sessionEpoch },
      deps.jwt,
    );

  // ── Profile ────────────────────────────────────────────────────────────────

  app.get('/api/v1/me', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    return { user: toPublicUser(await loadSelf(principal.id)) };
  });

  /**
   * A copy of everything held about the caller (GDPR Art. 15).
   *
   * The privacy page has said for a while that a user may "request a copy or
   * deletion of your personal data at any time". Deletion was self-serve —
   * `DELETE /api/v1/me`, just below — and the copy was a sentence with nothing
   * behind it: an access request arriving by email had to be answered by
   * somebody with a psql prompt, against a one-month statutory deadline, with
   * the answer being whichever tables that person happened to think of.
   *
   * Served as a download rather than a rendered page. What a subject-access
   * request produces is a file they keep, and a machine-readable one is what
   * Art. 20 asks for; there is nothing to gain by making them screenshot it.
   *
   * Scoped to the principal by construction — there is no id in the path, so
   * there is no cross-tenant question to get wrong. An administrator answering
   * a request on somebody's behalf has the admin route in adminUsers.ts.
   */
  app.get('/api/v1/me/data-export', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const bundle = await buildPersonalDataExport(deps.pool, principal.id);
    // The same event the admin route writes when it answers a request on
    // somebody's behalf (`adminUsers.ts`). Only that half was recorded, so a
    // trail asked "who has taken a copy of this person's data" answered with
    // the administrators and not with the account itself — which is the copy an
    // account takeover would take. `critical` in the catalog for that reason.
    await recordAdminEvent(deps.pool, {
      type: 'user_data_exported',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'user',
      subjectId: principal.id,
      payload: { self_service: true, sections: Object.keys(bundle).length },
    });
    const stamp = bundle.generated_at.slice(0, 10);
    return (
      reply
        .type('application/json')
        .header('content-disposition', `attachment; filename="n409-data-export-${stamp}.json"`)
        // A file of somebody's own personal data has no business in a shared
        // cache, and `no-store` is the one directive that also keeps it out of
        // the browser's disk cache on a machine they may not own.
        .header('cache-control', 'no-store')
        .send(bundle)
    );
  });

  app.patch('/api/v1/me', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = ProfileBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid profile', parsed.error);

    const user = await loadSelf(principal.id);
    const { current_password, ...patch } = parsed.data;
    const changingEmail = patch.email !== undefined && patch.email.toLowerCase() !== user.email.toLowerCase();

    if (changingEmail) {
      // Email is the login identifier and the password-reset destination, so
      // changing it is a credential change: re-authenticate first.
      if (user.password_digest) {
        if (!current_password)
          throw problems.unprocessable('Your current password is required to change your email', {
            errors: [{ path: ['current_password'] }],
          });
        if (!(await verifyReauthPassword(user.id, current_password, user.password_digest)))
          throw problems.badRequest('Current password is incorrect');
      } else {
        throw problems.badRequest('This account signs in with Google SSO — its email is managed by Google');
      }
      if (await findUserByEmail(deps.pool, patch.email!))
        throw problems.conflict('An account with this email already exists');
    } else {
      // A no-op email in the body shouldn't reset `verified` or demand a password.
      delete patch.email;
    }

    await updateOwnProfile(deps.pool, user.id, patch);
    if (changingEmail) {
      // The new address is unproven until it round-trips a message.
      await deps.pool.query('UPDATE users SET verified = false WHERE id = $1', [user.id]);
      // …so send the link that proves it (gap #26). Fire-and-forget: the outbox
      // row tracks delivery and the response shouldn't hinge on the transport.
      void (async () => {
        try {
          const secret = await createEmailVerificationToken(deps.pool, user.id, patch.email!);
          const link = `${baseUrl}/verify-email#token=${secret}`;
          const template = emailVerificationEmail(link);
          await sendTransactionalEmail(
            { pool: deps.pool, transport: deps.transport, log: req.log, settings: deps.settings },
            {
              toUserId: user.id,
              toEmail: patch.email!,
              ...template,
              recipientName: user.first_name,
              vars: { link },
            },
          );
        } catch (err) {
          req.log.warn({ err, userId: user.id }, 'failed to send verification email on email change');
        }
      })();
    }
    await recordAdminEvent(deps.pool, {
      type: 'user_updated',
      actor: { actorType: 'human', actorId: user.id },
      subjectType: 'user',
      subjectId: user.id,
      subjectLabel: user.email,
      // Field names, not values — this is a profile, and the values are the
      // personal data the trail exists beside rather than a copy of. The email
      // change is called out because it is a credential change: it moves where
      // a password reset is delivered.
      payload: { self_service: true, fields: Object.keys(patch), email_changed: changingEmail },
    });
    return { user: toPublicUser(await loadSelf(user.id)) };
  });

  // ── Sessions ───────────────────────────────────────────────────────────────

  /**
   * Sign out everywhere. Bumping the epoch kills every JWT already minted,
   * including the one that made this request — so a replacement is issued for
   * the caller, who stays signed in on this device.
   */
  app.post('/api/v1/me/sessions/revoke', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const epoch = await bumpSessionEpoch(deps.pool, principal.id);
    const user = await loadSelf(principal.id);
    const token = await issueToken(user, epoch);
    await recordAdminEvent(deps.pool, {
      type: 'user_sessions_revoked',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'user',
      subjectId: principal.id,
      subjectLabel: user.email,
      // See the admin deactivation route: the roles go with the account and
      // `restoreUser` brings it back with none, so this is the only record of
      // what it held.
      payload: { self_service: true, roles_removed: user.roles },
    });
    // Refresh this device's cookie to the new epoch so it isn't logged out.
    if (deps.cookie) setSessionCookie(reply, token, deps.cookie);
    return { token, message: 'Other sessions have been signed out.' };
  });

  // ── Personal API tokens ────────────────────────────────────────────────────

  app.get('/api/v1/me/tokens', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    return { ...(await listPersonalApiTokens(deps.pool, principal.id)), page_limit: API_TOKEN_PAGE_LIMIT };
  });

  /**
   * Mint a personal API token.
   *
   * Re-authenticated, which it was not. `auth/reauth.ts` lists the actions that
   * sit behind a password prompt on an already signed-in session — changing the
   * password or the login email, closing the account, disabling 2FA,
   * regenerating backup codes — and gives the reason: the session may not be
   * the owner's, so the password is the only thing still in the way. Minting a
   * credential belongs on that list and was the one credential-level action
   * missing from it, and it is the worst omission of the set, because the
   * others *change* an existing credential while this one **creates** a new one
   * that outlives everything meant to take access away. `bumpSessionEpoch` —
   * what a password change and "sign out everywhere" both do — deliberately
   * does not touch API tokens (plugins/auth.ts says why: revoking browser
   * sessions must not break a partner's running integration). So a borrowed
   * cookie bought permanent access: mint a token, and the owner changing their
   * password afterwards revokes the cookie and not the token.
   *
   * A token may not mint a token either, which the password check alone would
   * not settle: an SSO-only account has no digest to check, and the whole point
   * of `req.apiToken` here is that a stolen key must not be able to issue its
   * own successor and survive the revocation of the original. Refused as 403
   * rather than 401 — the credential is valid, it is this operation it may not
   * perform — and worded so an integration author knows to do it in the
   * console rather than retrying.
   */
  app.post('/api/v1/me/tokens', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    if (req.apiToken)
      throw problems.forbidden(
        'An API token cannot mint another API token — create it from the settings page while signed in',
      );
    const parsed = TokenBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid token', parsed.error);

    // Same shape as `DELETE /api/v1/me`: demanded when there is a password to
    // demand, skipped when the account signs in through Google or SAML and has
    // no digest at all — for those the `req.apiToken` refusal above is what
    // stops a token issuing its successor.
    const self = await loadSelf(principal.id);
    if (self.password_digest) {
      if (!parsed.data.current_password)
        throw problems.unprocessable('Your current password is required to create an API token', {
          errors: [{ path: ['current_password'] }],
        });
      if (!(await verifyReauthPassword(self.id, parsed.data.current_password, self.password_digest)))
        throw problems.badRequest('Current password is incorrect');
    }

    const { token, secret } = await createApiToken(deps.pool, {
      partnerId: null,
      createdBy: principal.id,
      name: parsed.data.name,
    });
    await recordAdminEvent(deps.pool, {
      type: 'api_token_created',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'api_token',
      subjectId: token.id,
      subjectLabel: parsed.data.name,
      payload: { personal: true },
    });
    // `secret` is shown once and never retrievable again.
    return reply.status(201).send({ token, secret });
  });

  app.delete('/api/v1/me/tokens/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const token = await findApiTokenById(deps.pool, id);
    // 404 rather than 403 for someone else's token — don't confirm it exists.
    if (!token || token.partner_id !== null || token.created_by !== principal.id) throw problems.notFound();
    await revokeApiToken(deps.pool, id);
    await recordAdminEvent(deps.pool, {
      type: 'api_token_revoked',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'api_token',
      subjectId: id,
      subjectLabel: token.name,
      payload: { personal: true },
    });
    return reply.status(204).send();
  });

  // ── Close account ──────────────────────────────────────────────────────────

  /**
   * Soft-deletes the caller's own account: they can no longer sign in, their
   * tokens stop working, and their valuations keep their audit trail. An
   * administrator can restore it.
   */
  app.delete('/api/v1/me', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const parsed = CloseAccountBody.safeParse(req.body ?? {});
    if (!parsed.success) throw invalidBody('Invalid request', parsed.error);

    const user = await loadSelf(principal.id);
    if (user.password_digest) {
      if (!parsed.data.current_password)
        throw problems.unprocessable('Your current password is required to close your account', {
          errors: [{ path: ['current_password'] }],
        });
      if (!(await verifyReauthPassword(user.id, parsed.data.current_password, user.password_digest)))
        throw problems.badRequest('Current password is incorrect');
    }

    // Losing the last administrator locks everyone out of the console with no
    // way back in. The same guard exists on the admin delete route.
    if (user.roles.some((r) => USER_ADMIN_ROLES.has(r)) && (await isLastUserAdmin(deps.pool, user.id)))
      throw problems.unprocessable(
        'You are the only administrator — grant another user admin access before closing your account',
      );

    await revokeTokensOwnedBy(deps.pool, user.id);
    await bumpSessionEpoch(deps.pool, user.id);
    const deleted = await softDeleteUser(deps.pool, user.id);
    if (!deleted) throw problems.conflict('This account is already closed');

    await recordAdminEvent(deps.pool, {
      type: 'account_closed',
      actor: { actorType: 'human', actorId: user.id },
      subjectType: 'user',
      subjectId: user.id,
      subjectLabel: user.email,
      payload: { self_service: true },
    });
    return reply.status(204).send();
  });
}

/**
 * True when no other live user holds a user-admin role.
 *
 * A suspended administrator is not a successor. `ignored` subtracts every
 * privilege the row otherwise carries (`auth/rbac.ts`, `isSuspended`), so an
 * `admin` + `ignored` account cannot open the console — and counting it here
 * is what lets the last working administrator close their own account and
 * leave the platform with nobody who can administer it and nobody who can be
 * granted the access to. The lockout this guard exists to prevent, arrived at
 * through the one account the guard cannot see is dead.
 *
 * `NOT EXISTS` rather than a second join, because the suspension is the
 * *absence* of a row to join to: `r.key = ANY($2) AND r.key <> 'ignored'`
 * would count a suspended admin twice over, once for each of their two rows.
 */
export async function isLastUserAdmin(pool: pg.Pool, userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) AS count
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE u.deleted_at IS NULL AND u.id <> $1 AND r.key = ANY($2)
       AND NOT EXISTS (
         SELECT 1 FROM user_roles sur
         JOIN roles sr ON sr.id = sur.role_id
         WHERE sur.user_id = u.id AND sr.key = 'ignored'
       )`,
    [userId, [...USER_ADMIN_ROLES]],
  );
  return Number(rows[0]?.count ?? 0) === 0;
}
