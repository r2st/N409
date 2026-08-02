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
import {
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
import { sendTransactionalEmail } from '../email/transactional.js';
import type { EmailTransport } from '../hooks/stateChange.js';

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
    phone: OptionalText(50),
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

const TokenBody = z.object({ name: z.string().trim().min(1).max(200) });

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

  app.patch('/api/v1/me', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = ProfileBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid profile', { errors: parsed.error.issues });

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
            { pool: deps.pool, transport: deps.transport, log: req.log },
            { toUserId: user.id, toEmail: patch.email!, ...template, vars: { link } },
          );
        } catch (err) {
          req.log.warn({ err, userId: user.id }, 'failed to send verification email on email change');
        }
      })();
    }
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
    // Refresh this device's cookie to the new epoch so it isn't logged out.
    if (deps.cookie) setSessionCookie(reply, token, deps.cookie);
    return { token, message: 'Other sessions have been signed out.' };
  });

  // ── Personal API tokens ────────────────────────────────────────────────────

  app.get('/api/v1/me/tokens', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    return { tokens: await listPersonalApiTokens(deps.pool, principal.id) };
  });

  app.post('/api/v1/me/tokens', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const parsed = TokenBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid token', { errors: parsed.error.issues });

    const { token, secret } = await createApiToken(deps.pool, {
      partnerId: null,
      createdBy: principal.id,
      name: parsed.data.name,
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
    if (!parsed.success) throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });

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

/** True when no other live user holds a user-admin role. */
export async function isLastUserAdmin(pool: pg.Pool, userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) AS count
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE u.deleted_at IS NULL AND u.id <> $1 AND r.key = ANY($2)`,
    [userId, [...USER_ADMIN_ROLES]],
  );
  return Number(rows[0]?.count ?? 0) === 0;
}
