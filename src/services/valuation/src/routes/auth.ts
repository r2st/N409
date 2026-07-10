import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { problems } from '@n409/shared';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signOidcState, signSession, verifyOidcState, type JwtConfig } from '../auth/jwt.js';
import type { GoogleOidc } from '../auth/google.js';
import {
  bumpSessionEpoch,
  createUser,
  findUserByEmail,
  setPasswordDigest,
  upsertGoogleUser,
  type UserWithRoles,
} from '../repos/users.js';
import { requirePrincipal } from '../plugins/auth.js';
import { findUserById } from '../repos/users.js';
import { createPasswordResetToken, resetPasswordWithToken } from '../repos/passwordResets.js';
import {
  createEmailVerificationToken,
  verifyEmailWithToken,
} from '../repos/emailVerifications.js';
import { acceptInvitation, findPendingInvitationByToken } from '../repos/invitations.js';
import { emailVerificationEmail, passwordResetEmail } from '../domain/emailWorkflows.js';
import { sendTransactionalEmail } from '../email/transactional.js';
import type { SystemSettingsStore } from '../repos/systemSettings.js';
import type { EmailTransport } from '../hooks/stateChange.js';

const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(10, 'password must be at least 10 characters'),
  first_name: z.string().min(1).max(100).optional(),
  last_name: z.string().min(1).max(100).optional(),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const ForgotPasswordBody = z.object({ email: z.string().email() });

const VerifyEmailBody = z.object({ token: z.string().min(1) });

const ResetPasswordBody = z.object({
  token: z.string().min(1),
  password: z.string().min(10, 'password must be at least 10 characters'),
});

const ChangePasswordBody = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(10, 'password must be at least 10 characters'),
});

const InviteTokenBody = z.object({ token: z.string().min(1) });

const AcceptInviteBody = z.object({
  token: z.string().min(1),
  password: z.string().min(10, 'password must be at least 10 characters'),
  first_name: z.string().min(1).max(100).optional(),
  last_name: z.string().min(1).max(100).optional(),
});

/**
 * In-memory sliding-window limiter for the forgot-password endpoint —
 * per-instance state is fine here: the worst case after a restart is a few
 * extra reset emails, and anything sturdier needs shared storage we don't
 * have a second use for.
 */
function slidingWindowLimiter() {
  const hits = new Map<string, number[]>();
  return (key: string, limit: number, windowMs: number): boolean => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

const HOUR_MS = 60 * 60 * 1000;

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

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: {
    pool: pg.Pool;
    jwt: JwtConfig;
    google?: GoogleOidc;
    transport?: EmailTransport;
    publicBaseUrl?: string;
    settings?: SystemSettingsStore;
  },
): void {
  const issueToken = (u: UserWithRoles, sessionEpoch = u.session_epoch) =>
    signSession(
      { sub: u.id, roles: u.roles, partner_id: u.partner_id, session_epoch: sessionEpoch },
      deps.jwt,
    );
  const baseUrl = (deps.publicBaseUrl ?? 'http://localhost:3000').replace(/\/$/, '');
  const allow = slidingWindowLimiter();

  /**
   * Mints a verification token and emails the link (gap #26). Fire-and-forget
   * like the reset flow — the outbox row tracks delivery, and registration
   * latency must not hinge on the mail transport. Bound to the user's current
   * address so a later email change invalidates the link.
   */
  const sendVerificationEmail = (user: UserWithRoles, log: FastifyBaseLogger) => {
    void (async () => {
      try {
        const secret = await createEmailVerificationToken(deps.pool, user.id, user.email);
        // Fragment, not query string — the token never reaches server logs.
        const link = `${baseUrl}/verify-email#token=${secret}`;
        const template = emailVerificationEmail(link);
        await sendTransactionalEmail(
          { pool: deps.pool, transport: deps.transport, log },
          { toUserId: user.id, toEmail: user.email, ...template, vars: { link } },
        );
      } catch (err) {
        log.warn({ err, userId: user.id }, 'failed to send verification email');
      }
    })();
  };

  /**
   * The route schemas already enforce a 10-character floor; an administrator
   * can only tighten it. Checked at the point of use rather than baked into
   * the zod schema so a settings change takes effect without a restart.
   */
  const assertPasswordLongEnough = async (password: string) => {
    const min = (await deps.settings?.get('password_min_length')) ?? 10;
    if (password.length < min)
      throw problems.unprocessable(`Password must be at least ${min} characters`, {
        errors: [{ path: ['password'] }],
      });
  };

  app.post('/api/v1/auth/register', async (req, reply) => {
    if (deps.settings && !(await deps.settings.get('registration_enabled')))
      throw problems.forbidden('Self-service registration is currently closed');

    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success)
      throw problems.unprocessable('Invalid registration', { errors: parsed.error.issues });
    const { email, password, first_name, last_name } = parsed.data;
    await assertPasswordLongEnough(password);

    if (await findUserByEmail(deps.pool, email)) {
      throw problems.conflict('An account with this email already exists');
    }
    const user = await createUser(deps.pool, {
      email,
      passwordDigest: await hashPassword(password),
      firstName: first_name,
      lastName: last_name,
      roles: ['valuation_user'],
    });
    // Prove ownership of the address before the account is trusted (gap #26).
    sendVerificationEmail(user, req.log);
    return reply.status(201).send({ user: toPublicUser(user), token: await issueToken(user) });
  });

  app.post('/api/v1/auth/login', async (req) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid login', { errors: parsed.error.issues });
    const { email, password } = parsed.data;

    const user = await findUserByEmail(deps.pool, email);
    // Same error for unknown email, bad password, and deleted account —
    // no account enumeration.
    if (
      !user?.password_digest ||
      user.deleted_at ||
      !(await verifyPassword(password, user.password_digest))
    ) {
      throw problems.unauthorized('Invalid email or password');
    }
    return { user: toPublicUser(user), token: await issueToken(user) };
  });

  // Public: lets the SPA know which login methods to offer.
  app.get('/api/v1/auth/providers', async () => ({
    password: true,
    google: Boolean(deps.google),
  }));

  app.get('/api/v1/auth/google', async (_req, reply) => {
    if (!deps.google) throw problems.badRequest('Google SSO is not configured');
    const state = await signOidcState(deps.jwt);
    return reply.redirect(deps.google.authorizationUrl(state), 302);
  });

  app.get('/api/v1/auth/google/callback', async (req, reply) => {
    if (!deps.google) throw problems.badRequest('Google SSO is not configured');
    const query = z.object({ code: z.string().min(1), state: z.string().min(1) }).safeParse(req.query);
    if (!query.success) throw problems.badRequest('Missing code/state');

    try {
      await verifyOidcState(query.data.state, deps.jwt);
    } catch {
      throw problems.unauthorized('Invalid OIDC state');
    }
    const idToken = await deps.google.exchangeCode(query.data.code);
    const identity = await deps.google.verifyIdToken(idToken);
    if (!identity.emailVerified) throw problems.unauthorized('Google account email is not verified');

    const user = await upsertGoogleUser(deps.pool, identity);
    const token = await issueToken(user);
    // Browsers land here from Google's redirect — hand the token to the SPA.
    // API callers (no text/html Accept) keep the JSON contract.
    if (req.headers.accept?.includes('text/html')) {
      return reply.redirect(`/auth/google/complete#token=${encodeURIComponent(token)}`, 302);
    }
    return { user: toPublicUser(user), token };
  });

  app.get('/api/v1/auth/me', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const user = await findUserById(deps.pool, principal.id);
    if (!user) throw problems.unauthorized();
    return { user: toPublicUser(user) };
  });

  // ── Password reset (P0 #3) ─────────────────────────────────────────────────

  app.post('/api/v1/auth/forgot-password', async (req, reply) => {
    const parsed = ForgotPasswordBody.safeParse(req.body);
    if (!parsed.success)
      throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });
    const email = parsed.data.email;

    if (!allow(`email:${email.toLowerCase()}`, 3, HOUR_MS) || !allow(`ip:${req.ip}`, 30, HOUR_MS)) {
      throw problems.tooManyRequests('Too many reset requests — try again later');
    }

    const user = await findUserByEmail(deps.pool, email);
    // Only real password accounts get a link; SSO-only and deleted accounts
    // are silently skipped so the response never confirms an address.
    if (user?.password_digest && !user.deleted_at) {
      const secret = await createPasswordResetToken(deps.pool, user.id);
      // Fragment, not query string — the token never reaches server logs.
      const link = `${baseUrl}/reset-password#token=${secret}`;
      const template = passwordResetEmail(link);
      // Deliberately not awaited: response latency must not reveal whether
      // an account exists. The outbox row tracks delivery either way.
      void sendTransactionalEmail(
        { pool: deps.pool, transport: deps.transport, log: req.log },
        { toUserId: user.id, toEmail: user.email, ...template, vars: { link } },
      );
    }
    return reply
      .status(202)
      .send({ message: "If an account exists for this email, we've sent a reset link." });
  });

  app.post('/api/v1/auth/reset-password', async (req) => {
    const parsed = ResetPasswordBody.safeParse(req.body);
    if (!parsed.success)
      throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });
    await assertPasswordLongEnough(parsed.data.password);

    const digest = await hashPassword(parsed.data.password);
    const ok = await resetPasswordWithToken(deps.pool, parsed.data.token, digest);
    if (!ok) throw problems.badRequest('This reset link is invalid, expired, or already used');
    return { message: 'Password updated — you can now sign in.' };
  });

  // ── Email verification (gap #26) ───────────────────────────────────────────

  // Public: the link lands unauthenticated. POST so the token stays out of
  // URLs/server logs — the SPA reads it from the fragment and posts it here.
  app.post('/api/v1/auth/verify-email', async (req) => {
    const parsed = VerifyEmailBody.safeParse(req.body);
    if (!parsed.success)
      throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });

    const outcome = await verifyEmailWithToken(deps.pool, parsed.data.token);
    if (outcome === 'invalid')
      throw problems.badRequest('This verification link is invalid, expired, or already used');
    return {
      status: outcome,
      message:
        outcome === 'already_verified'
          ? 'Your email is already verified.'
          : 'Your email address has been verified.',
    };
  });

  // Authenticated: re-send the link to the signed-in user's own address.
  // Rate-limited per user and per IP so it can't be used to spam a mailbox.
  app.post('/api/v1/auth/resend-verification', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const user = await findUserById(deps.pool, principal.id);
    if (!user) throw problems.unauthorized();
    if (user.verified) return { message: 'Your email is already verified.' };

    if (!allow(`verify:${user.id}`, 3, HOUR_MS) || !allow(`verify-ip:${req.ip}`, 30, HOUR_MS)) {
      throw problems.tooManyRequests('Too many verification requests — try again later');
    }
    sendVerificationEmail(user, req.log);
    return { message: "We've sent a fresh verification link to your email." };
  });

  app.post('/api/v1/auth/change-password', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = ChangePasswordBody.safeParse(req.body);
    if (!parsed.success)
      throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });
    await assertPasswordLongEnough(parsed.data.new_password);

    const user = await findUserById(deps.pool, principal.id);
    if (!user) throw problems.unauthorized();
    if (!user.password_digest)
      throw problems.badRequest('This account signs in with Google SSO and has no password');
    if (!(await verifyPassword(parsed.data.current_password, user.password_digest)))
      throw problems.badRequest('Current password is incorrect');

    await setPasswordDigest(deps.pool, user.id, await hashPassword(parsed.data.new_password));
    // A password change signs out every other session — the whole point of
    // changing it may be that someone else holds a token. The caller gets a
    // replacement so they aren't logged out of the tab they're standing in.
    const epoch = await bumpSessionEpoch(deps.pool, user.id);
    return {
      message: 'Password updated. Other sessions have been signed out.',
      token: await issueToken(user, epoch),
    };
  });

  // ── Invitation acceptance (feature #9; public side) ────────────────────────

  // POST so the token stays out of URLs/server logs; the page reads it from
  // the link's fragment and posts it here to show who the invite is for.
  app.post('/api/v1/auth/invite-info', async (req) => {
    const parsed = InviteTokenBody.safeParse(req.body);
    if (!parsed.success)
      throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });
    const invitation = await findPendingInvitationByToken(deps.pool, parsed.data.token);
    if (!invitation)
      throw problems.badRequest('This invitation is invalid, expired, or has been revoked');
    return { email: invitation.email, expires_at: invitation.expires_at };
  });

  app.post('/api/v1/auth/accept-invite', async (req, reply) => {
    const parsed = AcceptInviteBody.safeParse(req.body);
    if (!parsed.success)
      throw problems.unprocessable('Invalid invitation', { errors: parsed.error.issues });
    const { token, password, first_name, last_name } = parsed.data;

    const result = await acceptInvitation(deps.pool, {
      rawToken: token,
      passwordDigest: await hashPassword(password),
      firstName: first_name,
      lastName: last_name,
    });
    if (result.status === 'invalid')
      throw problems.badRequest('This invitation is invalid, expired, or has been revoked');
    if (result.status === 'conflict')
      throw problems.conflict('An account with this email already exists');
    return reply
      .status(201)
      .send({ user: toPublicUser(result.user), token: await issueToken(result.user) });
  });
}
