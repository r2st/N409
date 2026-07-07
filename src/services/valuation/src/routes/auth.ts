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
  deps: { pool: pg.Pool; jwt: JwtConfig; google?: GoogleOidc },
): void {
  const issueToken = (u: UserWithRoles) =>
    signSession({ sub: u.id, roles: u.roles, partner_id: u.partner_id }, deps.jwt);

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
    // Same error for unknown email and bad password — no account enumeration.
    if (!user?.password_digest || !(await verifyPassword(password, user.password_digest))) {
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
}
