import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { problems } from '@n409/shared';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signOidcState, signSession, verifyOidcState, type JwtConfig } from '../auth/jwt.js';
import type { GoogleOidc } from '../auth/google.js';
import { createUser, findUserByEmail, upsertGoogleUser, type UserWithRoles } from '../repos/users.js';
import { requirePrincipal } from '../plugins/auth.js';
import { findUserById } from '../repos/users.js';
import { createPasswordResetToken, resetPasswordWithToken } from '../repos/passwordResets.js';
import { acceptInvitation, findPendingInvitationByToken } from '../repos/invitations.js';
import { passwordResetEmail } from '../domain/emailWorkflows.js';
import { sendTransactionalEmail } from '../email/transactional.js';
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
  },
): void {
  const issueToken = (u: UserWithRoles) =>
    signSession({ sub: u.id, roles: u.roles, partner_id: u.partner_id }, deps.jwt);
  const baseUrl = (deps.publicBaseUrl ?? 'http://localhost:3000').replace(/\/$/, '');
  const allow = slidingWindowLimiter();

  app.post('/api/v1/auth/register', async (req, reply) => {
    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success)
      throw problems.unprocessable('Invalid registration', { errors: parsed.error.issues });
    const { email, password, first_name, last_name } = parsed.data;

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
      const template = passwordResetEmail(`${baseUrl}/reset-password#token=${secret}`);
      // Deliberately not awaited: response latency must not reveal whether
      // an account exists. The outbox row tracks delivery either way.
      void sendTransactionalEmail(
        { pool: deps.pool, transport: deps.transport, log: req.log },
        { toUserId: user.id, toEmail: user.email, ...template },
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

    const digest = await hashPassword(parsed.data.password);
    const ok = await resetPasswordWithToken(deps.pool, parsed.data.token, digest);
    if (!ok) throw problems.badRequest('This reset link is invalid, expired, or already used');
    return { message: 'Password updated — you can now sign in.' };
  });

  app.post('/api/v1/auth/change-password', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = ChangePasswordBody.safeParse(req.body);
    if (!parsed.success)
      throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });

    const user = await findUserById(deps.pool, principal.id);
    if (!user) throw problems.unauthorized();
    if (!user.password_digest)
      throw problems.badRequest('This account signs in with Google SSO and has no password');
    if (!(await verifyPassword(parsed.data.current_password, user.password_digest)))
      throw problems.badRequest('Current password is incorrect');

    await deps.pool.query('UPDATE users SET password_digest = $2 WHERE id = $1', [
      user.id,
      await hashPassword(parsed.data.new_password),
    ]);
    return { message: 'Password updated.' };
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
