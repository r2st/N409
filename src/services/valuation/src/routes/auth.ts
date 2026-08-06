import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { problems } from '@n409/shared';
import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPasswordOrDecoy } from '../auth/password.js';
import { verifyReauthPassword } from '../auth/reauth.js';
import {
  signMfaChallenge,
  signOidcState,
  signSession,
  verifyMfaChallenge,
  verifyOidcState,
  verifySession,
  type JwtConfig,
} from '../auth/jwt.js';
import {
  clearSessionCookie,
  setSessionCookie,
  setDeviceCookie,
  SESSION_COOKIE,
  DEVICE_COOKIE,
  DEVICE_TRUST_DAYS,
  type SessionCookieConfig,
} from '../auth/cookies.js';
import { verifyTotpCounter } from '../auth/totp.js';
import { decryptSecret, backupCodeMatches } from '../auth/mfaCrypto.js';
import {
  consumeBackupCode,
  consumeTotpCounter,
  isDeviceTrusted,
  listUnusedBackupCodeHashes,
  trustDevice,
} from '../repos/mfa.js';
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
import { SlidingWindowRateLimiter } from '../plugins/rateLimit.js';
import { findUserById } from '../repos/users.js';
import { createPasswordResetToken, resetPasswordWithToken } from '../repos/passwordResets.js';
import { createEmailVerificationToken, verifyEmailWithToken } from '../repos/emailVerifications.js';
import { acceptInvitation, findPendingInvitationByToken } from '../repos/invitations.js';
import { getSamlConfig } from '../repos/ssoConfig.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { emailVerificationEmail, passwordResetEmail } from '../domain/emailWorkflows.js';
import { sendTransactionalEmail, sendTransactionalEmailInBackground } from '../email/transactional.js';
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

const MfaVerifyBody = z
  .object({
    challenge: z.string().min(1),
    code: z.string().min(6).max(10).optional(),
    backup_code: z.string().min(1).max(20).optional(),
    remember_device: z.boolean().optional(),
  })
  .refine((b) => b.code != null || b.backup_code != null, {
    message: 'A TOTP code or a backup code is required.',
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
 * In-memory sliding-window limiter for the unauthenticated auth routes —
 * per-instance state is fine here: the worst case after a restart is a few
 * extra reset emails, and anything sturdier needs shared storage we don't
 * have a second use for.
 *
 * The eviction policy lives with the limiter (plugins/rateLimit.ts); it matters
 * because every key here embeds a request-supplied IP or email address.
 */
function slidingWindowLimiter() {
  const limiter = new SlidingWindowRateLimiter();
  return (key: string, limit: number, windowMs: number, opts?: { peek?: boolean }): boolean =>
    limiter.allow(key, limit, windowMs, opts);
}

const HOUR_MS = 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/**
 * Throttles for the remaining unauthenticated auth routes (audit follow-up).
 * Login and forgot-password were limited from the start; register, verify-email,
 * reset-password and accept-invite were not, which left four ways to hammer the
 * service from the open internet: bulk account creation, mailbox flooding, and —
 * on the two token-redeeming routes — unbounded guessing of a reset/invite
 * secret. All four are keyed per IP; register additionally per email so one
 * address can't be re-registered in a loop.
 *
 * The numbers are set well above any human's plausible rate: a real person hits
 * each of these once or twice, ever.
 */
const REGISTER_PER_IP = 10;
const REGISTER_PER_EMAIL = 3;
/** Token-redeeming and mail-triggering routes: per-IP ceiling per hour. */
const TOKEN_REDEEM_PER_IP = 20;

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
    totp_enabled: u.totp_enabled,
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
    cookie?: SessionCookieConfig;
  },
): void {
  const issueToken = (u: UserWithRoles, sessionEpoch = u.session_epoch) =>
    signSession(
      { sub: u.id, roles: u.roles, partner_id: u.partner_id, session_epoch: sessionEpoch },
      deps.jwt,
    );
  // Mint a session token and, when cookies are configured, also drop it in the
  // httpOnly cookie so the SPA authenticates without a JS-readable token.
  const issueSession = async (
    reply: FastifyReply,
    u: UserWithRoles,
    sessionEpoch?: number,
  ): Promise<string> => {
    const token = await issueToken(u, sessionEpoch);
    if (deps.cookie) setSessionCookie(reply, token, deps.cookie);
    return token;
  };
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
  const assertPasswordStrong = async (password: string) => {
    const min = (await deps.settings?.get('password_min_length')) ?? 10;
    if (password.length < min)
      throw problems.unprocessable(`Password must be at least ${min} characters`, {
        errors: [{ path: ['password'] }],
      });
    // Basic complexity: require at least one letter and one digit so passwords
    // like "1234567890" or "aaaaaaaaaa" are rejected. Full entropy scoring is
    // overkill for a B2B SaaS, but this catches the low-hanging fruit.
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))
      throw problems.unprocessable('Password must contain at least one letter and one number', {
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

    // Checked after parsing (so the key is a real address) but before the scrypt
    // hash and the verification email — the two expensive parts of this route.
    if (
      !allow(`register-ip:${req.ip}`, REGISTER_PER_IP, HOUR_MS) ||
      !allow(`register:${email.toLowerCase()}`, REGISTER_PER_EMAIL, HOUR_MS)
    ) {
      throw problems.tooManyRequests('Too many sign-up attempts — try again later');
    }

    await assertPasswordStrong(password);

    // Hash the password *before* the duplicate check so the response time is
    // constant regardless of whether the email already exists (audit: account
    // enumeration via timing side-channel).
    const digest = await hashPassword(password);

    if (await findUserByEmail(deps.pool, email)) {
      throw problems.conflict('An account with this email already exists');
    }
    const user = await createUser(deps.pool, {
      email,
      passwordDigest: digest,
      firstName: first_name,
      lastName: last_name,
      roles: ['valuation_user'],
    });
    // Prove ownership of the address before the account is trusted (gap #26).
    sendVerificationEmail(user, req.log);
    const token = await issueSession(reply, user);
    return reply.status(201).send({ user: toPublicUser(user), token });
  });

  app.post('/api/v1/auth/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid login', { errors: parsed.error.issues });
    const { email, password } = parsed.data;

    // Throttle credential brute-force / stuffing (audit B-1 P1): 10 attempts /
    // 15 min per email and 100 / 15 min per IP. Checked before any DB/scrypt
    // work so a flood can't pin the CPU either. The counter only advances on a
    // *failed* login (see below), so a legitimate user is never locked out by
    // their own successful sign-ins.
    const emailKey = `login:${email.toLowerCase()}`;
    const ipKey = `login-ip:${req.ip}`;
    if (
      !allow(emailKey, 10, LOGIN_WINDOW_MS, { peek: true }) ||
      !allow(ipKey, 100, LOGIN_WINDOW_MS, { peek: true })
    ) {
      throw problems.tooManyRequests('Too many sign-in attempts — try again later');
    }

    const user = await findUserByEmail(deps.pool, email);
    // Same error *and the same latency* for unknown email, bad password, and
    // deleted account — no account enumeration. Matching the error body is only
    // half of it: scrypt is ~33ms and it is the entire cost of this request, so
    // short-circuiting past it whenever there is no digest to check answered
    // "does this address have an account?" in the response time. Hence the
    // decoy hash for the no-user / no-password / deleted cases, and hence the
    // comparison running before the branch rather than inside it.
    const passwordOk = await verifyPasswordOrDecoy(
      password,
      user && !user.deleted_at ? user.password_digest : null,
    );
    // The remaining checks are pure narrowing for the compiler's benefit — the
    // work that could be timed is already done above, so ordering is free here.
    if (!user || user.deleted_at || !passwordOk) {
      // Record the failed attempt against both windows so guesses accumulate.
      allow(emailKey, 10, LOGIN_WINDOW_MS);
      allow(ipKey, 100, LOGIN_WINDOW_MS);
      throw problems.unauthorized('Invalid email or password');
    }

    // Second factor: a 2FA-enabled account gets a challenge instead of a
    // session — unless this browser is a remembered, still-trusted device.
    if (user.totp_enabled) {
      const deviceToken = req.cookies?.[DEVICE_COOKIE];
      const trusted = deviceToken ? await isDeviceTrusted(deps.pool, user.id, deviceToken) : false;
      if (!trusted) {
        return {
          mfa_required: true,
          challenge: await signMfaChallenge(user.id, deps.jwt),
        };
      }
    }
    await recordAdminEvent(deps.pool, {
      type: 'user_login',
      actor: { actorType: 'human', actorId: user.id },
      subjectType: 'user',
      subjectId: user.id,
      subjectLabel: user.email,
      payload: { method: 'password' },
    });
    return { user: toPublicUser(user), token: await issueSession(reply, user) };
  });

  // Second-factor verification: redeem the challenge token from login with a
  // TOTP code or a one-time backup code, and (optionally) remember the device.
  app.post('/api/v1/auth/mfa/verify', async (req, reply) => {
    const parsed = MfaVerifyBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });

    let userId: string;
    try {
      userId = await verifyMfaChallenge(parsed.data.challenge, deps.jwt);
    } catch {
      throw problems.unauthorized('This 2FA challenge is invalid or has expired — sign in again');
    }
    const user = await findUserById(deps.pool, userId);
    if (!user || user.deleted_at || !user.totp_enabled || !user.totp_secret) {
      throw problems.unauthorized('2FA is not enabled for this account');
    }

    // Throttle second-factor guessing per user.
    if (!allow(`mfa:${user.id}`, 10, LOGIN_WINDOW_MS)) {
      throw problems.tooManyRequests('Too many verification attempts — try again later');
    }

    let ok = false;
    if (parsed.data.code) {
      // A TOTP code is good for one login (RFC 6238 §5.2), so claiming its time
      // step is part of verifying it, not a step after it — otherwise the code
      // stays usable for the rest of its ±1-step window and a phishing proxy
      // can replay what the user just typed.
      const counter = verifyTotpCounter(decryptSecret(user.totp_secret), parsed.data.code);
      ok = counter !== null && (await consumeTotpCounter(deps.pool, user.id, counter));
    } else if (parsed.data.backup_code) {
      const hashes = await listUnusedBackupCodeHashes(deps.pool, user.id);
      const matched = backupCodeMatches(parsed.data.backup_code, hashes);
      if (matched) ok = await consumeBackupCode(deps.pool, user.id, matched);
    }
    if (!ok) throw problems.unauthorized('That code is incorrect');

    if (parsed.data.remember_device) {
      const raw = randomBytes(32).toString('base64url');
      const expires = new Date(Date.now() + DEVICE_TRUST_DAYS * 24 * 60 * 60 * 1000);
      await trustDevice(deps.pool, user.id, raw, expires);
      if (deps.cookie) setDeviceCookie(reply, raw, deps.cookie.secure);
    }
    await recordAdminEvent(deps.pool, {
      type: 'user_login',
      actor: { actorType: 'human', actorId: user.id },
      subjectType: 'user',
      subjectId: user.id,
      subjectLabel: user.email,
      payload: { method: 'password', mfa: true },
    });
    return { user: toPublicUser(user), token: await issueSession(reply, user) };
  });

  // Clears the session cookie (audit F-2). Public + idempotent: logging out
  // must work even with an already-expired or missing session.
  app.post('/api/v1/auth/logout', async (req, reply) => {
    if (deps.cookie) clearSessionCookie(reply, deps.cookie);
    // Bump session_epoch so outstanding JWTs for this user are immediately
    // invalidated, not just the one in the cleared cookie. The endpoint is
    // public (must work with an expired/missing token), so parse best-effort.
    try {
      const header = req.headers.authorization;
      const bearer =
        (header?.startsWith('Bearer ') ? header.slice(7).trim() : '') || req.cookies?.[SESSION_COOKIE] || '';
      if (bearer && !bearer.startsWith('n409_pat_')) {
        const claims = await verifySession(bearer, deps.jwt);
        await bumpSessionEpoch(deps.pool, claims.sub);
      }
    } catch {
      /* expired / missing / invalid — cookie is still cleared */
    }
    return reply.status(200).send({ message: 'Signed out.' });
  });

  // Public: lets the SPA know which login methods to offer.
  app.get('/api/v1/auth/providers', async () => {
    const saml = await getSamlConfig(deps.pool).catch(() => null);
    return {
      password: true,
      google: Boolean(deps.google),
      saml: Boolean(saml?.enabled && saml.idp_sso_url && saml.idp_cert),
    };
  });

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
    await recordAdminEvent(deps.pool, {
      type: 'user_login',
      actor: { actorType: 'human', actorId: user.id },
      subjectType: 'user',
      subjectId: user.id,
      subjectLabel: user.email,
      payload: { method: 'google' },
    });
    const token = await issueSession(reply, user);
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
    if (!parsed.success) throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });
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
      // an account exists. The outbox row tracks delivery either way. Through
      // the background helper rather than a bare `void`, because a rejection
      // from an unawaited promise is an unhandled rejection, and this service
      // exits on those — so a database hiccup here took the process down from
      // an unauthenticated endpoint.
      sendTransactionalEmailInBackground(
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
    if (!parsed.success) throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });

    // Bounds token guessing. The tokens are long random secrets, so this is a
    // belt-and-braces limit — but an unbounded redeem endpoint also lets an
    // attacker burn CPU on a scrypt hash per request.
    if (!allow(`reset-ip:${req.ip}`, TOKEN_REDEEM_PER_IP, HOUR_MS)) {
      throw problems.tooManyRequests('Too many reset attempts — try again later');
    }

    await assertPasswordStrong(parsed.data.password);

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
    if (!parsed.success) throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });

    if (!allow(`verify-email-ip:${req.ip}`, TOKEN_REDEEM_PER_IP, HOUR_MS)) {
      throw problems.tooManyRequests('Too many verification attempts — try again later');
    }

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

  app.post('/api/v1/auth/change-password', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const parsed = ChangePasswordBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });
    await assertPasswordStrong(parsed.data.new_password);

    const user = await findUserById(deps.pool, principal.id);
    if (!user) throw problems.unauthorized();
    if (!user.password_digest)
      throw problems.badRequest('This account signs in with Google SSO and has no password');
    if (!(await verifyReauthPassword(user.id, parsed.data.current_password, user.password_digest)))
      throw problems.badRequest('Current password is incorrect');

    await setPasswordDigest(deps.pool, user.id, await hashPassword(parsed.data.new_password));
    // A password change signs out every other session — the whole point of
    // changing it may be that someone else holds a token. The caller gets a
    // replacement so they aren't logged out of the tab they're standing in.
    const epoch = await bumpSessionEpoch(deps.pool, user.id);
    return {
      message: 'Password updated. Other sessions have been signed out.',
      token: await issueSession(reply, user, epoch),
    };
  });

  // ── Invitation acceptance (feature #9; public side) ────────────────────────

  // POST so the token stays out of URLs/server logs; the page reads it from
  // the link's fragment and posts it here to show who the invite is for.
  app.post('/api/v1/auth/invite-info', async (req) => {
    const parsed = InviteTokenBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });

    // Same token space as accept-invite below, and it answers "is this token
    // real?" directly — limiting only the redeem route would leave the
    // enumeration oracle wide open.
    if (!allow(`invite-info-ip:${req.ip}`, TOKEN_REDEEM_PER_IP, HOUR_MS)) {
      throw problems.tooManyRequests('Too many invitation lookups — try again later');
    }

    const invitation = await findPendingInvitationByToken(deps.pool, parsed.data.token);
    if (!invitation) throw problems.badRequest('This invitation is invalid, expired, or has been revoked');
    return { email: invitation.email, expires_at: invitation.expires_at };
  });

  app.post('/api/v1/auth/accept-invite', async (req, reply) => {
    const parsed = AcceptInviteBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid invitation', { errors: parsed.error.issues });
    const { token, password, first_name, last_name } = parsed.data;

    // Accepting an invite mints an account, so an unbounded endpoint is both a
    // token-guessing surface and a scrypt-CPU sink.
    if (!allow(`invite-ip:${req.ip}`, TOKEN_REDEEM_PER_IP, HOUR_MS)) {
      throw problems.tooManyRequests('Too many invitation attempts — try again later');
    }

    // The same policy register, reset-password and change-password all apply.
    // This route was the one that did not, and it is how every seat inside a
    // firm is created — so an administrator who raised `password_min_length`
    // raised it for self-service sign-ups only, while the accounts that came in
    // by invitation kept the schema's 10-character floor and could still be
    // all-letters. Ordered ahead of the hash for the same reason register is:
    // the scrypt call is the expensive half of the request.
    await assertPasswordStrong(password);

    const result = await acceptInvitation(deps.pool, {
      rawToken: token,
      passwordDigest: await hashPassword(password),
      firstName: first_name,
      lastName: last_name,
    });
    if (result.status === 'invalid')
      throw problems.badRequest('This invitation is invalid, expired, or has been revoked');
    if (result.status === 'conflict') throw problems.conflict('An account with this email already exists');
    const sessionToken = await issueSession(reply, result.user);
    return reply.status(201).send({ user: toPublicUser(result.user), token: sessionToken });
  });
}
