import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { logFailure, logUnretried, problems } from '@n409/shared';
import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPasswordOrDecoy } from '../auth/password.js';
import { verifyReauthPassword } from '../auth/reauth.js';
import { toPublicUser } from '../domain/publicUser.js';
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
import { refuseSso } from '../auth/ssoRefusal.js';
import { recordSsoOutcome } from '../observability/ssoOutcomes.js';
import { recordSignInOutcome } from '../observability/signInOutcomes.js';
import {
  bumpSessionEpoch,
  createUser,
  findUserByEmail,
  setPasswordDigest,
  upsertGoogleUser,
  type UserWithRoles,
} from '../repos/users.js';
import { EmailAddress } from '../domain/email.js';
import { PASSWORD_MIN_LENGTH, passwordPolicyError } from '../domain/passwordPolicy.js';
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
import { invalidBody } from '../domain/validationProblem.js';
import { DEAD_LINK_DETAIL } from '../domain/linkRefusal.js';
import { nonBlankText } from '../domain/nonBlankText.js';
import { recordThrottleRefusal } from '../observability/requestThrottle.js';

const RegisterBody = z.object({
  email: EmailAddress,
  password: z.string().min(10, 'password must be at least 10 characters'),
  first_name: nonBlankText(1, 100).optional(),
  last_name: nonBlankText(1, 100).optional(),
});

const LoginBody = z.object({
  email: EmailAddress,
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

const ForgotPasswordBody = z.object({ email: EmailAddress });

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
  first_name: nonBlankText(1, 100).optional(),
  last_name: nonBlankText(1, 100).optional(),
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
  const allow = (key: string, limit: number, windowMs: number, opts?: { peek?: boolean }): boolean =>
    limiter.allow(key, limit, windowMs, opts);
  /**
   * Seconds to wait, for whichever of the checked counters is furthest from
   * letting the caller back in.
   *
   * Each of these routes checks two keys — a per-IP ceiling and a per-address
   * one — and being under one of them is not enough. Reporting the smaller wait
   * would send the caller back to be refused again by the other, so the answer
   * is the maximum across the counters the route consulted, and zero when none
   * of them is currently over its limit.
   */
  const retryAfter = (...counters: ReadonlyArray<[string, number, number]>): number =>
    Math.max(0, ...counters.map(([key, limit, windowMs]) => limiter.retryAfterSeconds(key, limit, windowMs)));
  return { allow, retryAfter };
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
  const { allow, retryAfter } = slidingWindowLimiter();

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
          { pool: deps.pool, transport: deps.transport, log, settings: deps.settings },
          {
            toUserId: user.id,
            toEmail: user.email,
            ...template,
            recipientName: user.first_name,
            vars: { link },
          },
        );
      } catch (err) {
        // The enqueue itself failed, so there is no outbox row for the
        // retry sweep to find: this registration has no verification link
        // coming and nothing will notice but the person waiting for it.
        logUnretried(log, err, { userId: user.id }, 'failed to send verification email');
      }
    })();
  };

  /**
   * The route schemas already enforce a 10-character floor; an administrator
   * can only tighten it. Checked at the point of use rather than baked into
   * the zod schema so a settings change takes effect without a restart.
   *
   * The rule itself lives in `domain/passwordPolicy.ts` — it has a second
   * reader now, and a rule with two readers written out once is a rule with
   * one reader and a copy.
   */
  const assertPasswordStrong = async (password: string) => {
    const min = (await deps.settings?.get('password_min_length')) ?? PASSWORD_MIN_LENGTH;
    const problem = passwordPolicyError(password, min);
    if (problem) throw problems.unprocessable(problem, { errors: [{ path: ['password'] }] });
  };

  app.post('/api/v1/auth/register', async (req, reply) => {
    if (deps.settings && !(await deps.settings.get('registration_enabled')))
      throw problems.forbidden('Self-service registration is currently closed');

    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid registration', parsed.error);
    const { email, password, first_name, last_name } = parsed.data;

    // Checked after parsing (so the key is a real address) but before the scrypt
    // hash and the verification email — the two expensive parts of this route.
    if (
      !allow(`register-ip:${req.ip}`, REGISTER_PER_IP, HOUR_MS) ||
      !allow(`register:${email.toLowerCase()}`, REGISTER_PER_EMAIL, HOUR_MS)
    ) {
      // Counted for the reason every door in `observability/requestThrottle.ts`
      // is: a 429 is one line in the 4xx class and this box has no rule on it,
      // so a registration surface that has stopped accepting anybody — a bot
      // run filling the per-IP window everybody behind that NAT shares — looks
      // exactly like nobody having signed up today.
      recordThrottleRefusal('register');
      throw problems.tooManyRequests(
        'Too many sign-up attempts from this address',
        retryAfter(
          [`register-ip:${req.ip}`, REGISTER_PER_IP, HOUR_MS],
          [`register:${email.toLowerCase()}`, REGISTER_PER_EMAIL, HOUR_MS],
        ),
      );
    }

    await assertPasswordStrong(password);

    // Hash the password *before* the duplicate check so the response time is
    // constant regardless of whether the email already exists (audit: account
    // enumeration via timing side-channel).
    const digest = await hashPassword(password);

    if (await findUserByEmail(deps.pool, email)) {
      // The remedy, not just the fact. Somebody who has forgotten they signed
      // up cannot tell from "an account already exists" whether to try a
      // different address or to go and sign in, and the two are the whole
      // decision. No new disclosure: the sentence already conceded the
      // address is registered.
      throw problems.conflict(
        'An account with this email address already exists, so there is nothing to create. ' +
          'Sign in instead — and if you do not remember the password, use “Forgot password” on ' +
          'the sign-in page to set a new one.',
      );
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
    // `user_created`, the same type an administrator minting a seat writes,
    // with the door in the payload — see the catalog's note. Self-service
    // sign-up created accounts that the trail had no row for at all.
    await recordAdminEvent(deps.pool, {
      type: 'user_created',
      actor: { actorType: 'human', actorId: user.id },
      subjectType: 'user',
      subjectId: user.id,
      subjectLabel: user.email,
      payload: { method: 'self_service', roles: user.roles },
    });
    const token = await issueSession(reply, user);
    return reply.status(201).send({ user: toPublicUser(user), token });
  });

  app.post('/api/v1/auth/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid login', parsed.error);
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
      // Counted before any credential is read, because it is refused before any
      // credential is read. Nothing else can see this: the spine deliberately
      // writes no row past the lock (see the failure branch below), so a
      // stuffing run and an owner locked out of their own account are both a
      // 429 in a status class this box has no rule on. See
      // `observability/signInOutcomes.ts`.
      recordSignInOutcome('password', 'throttled');
      throw problems.tooManyRequests(
        'Too many sign-in attempts for this account',
        retryAfter([emailKey, 10, LOGIN_WINDOW_MS], [ipKey, 100, LOGIN_WINDOW_MS]),
      );
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
      // Whether this failure is the one that filled the address window. Asked
      // as a peek *after* consuming rather than read off the consuming call:
      // the check at the top of the route is what refuses, so by the time an
      // attempt is over the limit it never reaches here at all, and the
      // consuming `allow` returns true right up to the last permitted guess.
      // This is the row where the lock begins, and the attempts past it are
      // recorded nowhere — so without the flag the trail ends mid-run with no
      // way to tell a lockout from an attacker who simply stopped.
      const lockedOut = !allow(emailKey, 10, LOGIN_WINDOW_MS, { peek: true });
      /**
       * And on the spine, which had only the successes.
       *
       * Written in every failing branch, unconditionally, for the same reason
       * `forgot-password` records in both of its: the whole route is built so
       * that an unknown address, a wrong password and a closed account are
       * indistinguishable from outside, and a row written for only one of them
       * would put that distinction back — as a latency difference on the one
       * path that skipped an insert. The `reason` is recorded *inside* the row,
       * where the reader is an operator who is entitled to it and an enumeration
       * sweep shows up as a run of `unknown_account`.
       *
       * `subject_id` is the account when there is one, so an owner's failures
       * join to the rest of their history, and null when there is not — the
       * address still travels in `subject_label`, which is how a sweep across
       * addresses that have never existed is visible at all.
       *
       * Bounded by the throttle above rather than by anything here: an
       * unauthenticated route that inserts a row per request is a write
       * amplifier, and the ceiling on rows is the ceiling on attempts — ten per
       * address and a hundred per IP per fifteen minutes. The refusals past
       * that point write nothing, which is why the one that trips the lock says
       * so.
       */
      // One word, two readers. The spine row is what an investigator reads
      // afterwards and the counter is what a rule fires on, and computing the
      // reason once is what stops them becoming two vocabularies for one thing
      // — the same construction that puts the sweep name in `scheduleSweep`.
      const reason = !user ? 'unknown_account' : user.deleted_at ? 'closed_account' : 'bad_password';
      recordSignInOutcome('password', reason);
      await recordAdminEvent(deps.pool, {
        type: 'user_login_failed',
        actor: { actorType: 'human', actorId: user?.id ?? null },
        subjectType: 'user',
        subjectId: user?.id ?? null,
        subjectLabel: email,
        payload: {
          method: 'password',
          reason,
          ip: req.ip,
          locked_out: lockedOut,
        },
      });
      throw problems.unauthorized('Invalid email or password');
    }

    // Second factor: a 2FA-enabled account gets a challenge instead of a
    // session — unless this browser is a remembered, still-trusted device.
    if (user.totp_enabled) {
      const deviceToken = req.cookies?.[DEVICE_COOKIE];
      const trusted = deviceToken ? await isDeviceTrusted(deps.pool, user.id, deviceToken) : false;
      if (!trusted) {
        // Answered, not refused — and neither is it a sign-in. Its own outcome
        // so the refusal ratio can exclude it, and so challenges issued can be
        // read against verifications completed at the door below: a second
        // factor that has stopped verifying shows up as the gap between them.
        recordSignInOutcome('password', 'mfa_challenged');
        return {
          mfa_required: true,
          challenge: await signMfaChallenge(user.id, deps.jwt),
        };
      }
    }
    recordSignInOutcome('password', 'signed_in');
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
    if (!parsed.success) throw invalidBody('Invalid request', parsed.error);

    let userId: string;
    try {
      userId = await verifyMfaChallenge(parsed.data.challenge, deps.jwt);
    } catch {
      // Counted, and it is the one outcome here that is routinely benign: a
      // challenge has a short life and a user who left the tab open gets this.
      // Its *rate* is not benign — the challenge is signed with the same key
      // the session is, so a key rotated out from under a running process
      // refuses every 2FA account on the estate through this branch and
      // through no other.
      recordSignInOutcome('mfa', 'challenge_invalid');
      throw problems.unauthorized('This 2FA challenge is invalid or has expired — sign in again');
    }
    const user = await findUserById(deps.pool, userId);
    if (!user || user.deleted_at || !user.totp_enabled || !user.totp_secret) {
      recordSignInOutcome('mfa', 'not_enrolled');
      throw problems.unauthorized('2FA is not enabled for this account');
    }

    // Throttle second-factor guessing per user.
    if (!allow(`mfa:${user.id}`, 10, LOGIN_WINDOW_MS)) {
      recordSignInOutcome('mfa', 'throttled');
      throw problems.tooManyRequests(
        'Too many verification attempts',
        retryAfter([`mfa:${user.id}`, 10, LOGIN_WINDOW_MS]),
      );
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
    if (!ok) {
      // The strongest single signal this service can emit. A challenge is only
      // issued to a caller who has already presented the right password, so a
      // wrong code here is somebody holding working credentials and missing the
      // factor that stops them — which is what a phished password looks like
      // for the minutes before it works. It was recorded nowhere: the throttle
      // counted it in memory and the successful verification a few attempts
      // later was the only row either way.
      recordSignInOutcome('mfa', 'bad_code');
      await recordAdminEvent(deps.pool, {
        type: 'user_mfa_challenge_failed',
        actor: { actorType: 'human', actorId: user.id },
        subjectType: 'user',
        subjectId: user.id,
        subjectLabel: user.email,
        payload: { factor: parsed.data.code ? 'totp' : 'backup_code', ip: req.ip },
      });
      throw problems.unauthorized('That code is incorrect');
    }

    if (parsed.data.remember_device) {
      const raw = randomBytes(32).toString('base64url');
      const expires = new Date(Date.now() + DEVICE_TRUST_DAYS * 24 * 60 * 60 * 1000);
      await trustDevice(deps.pool, user.id, raw, expires);
      if (deps.cookie) setDeviceCookie(reply, raw, deps.cookie.secure);
    }
    recordSignInOutcome('mfa', 'signed_in');
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
    /*
     * ONE CATCH, THREE FAILURES, TWO OF THEM NOT BENIGN (R305, methodology M11).
     *
     * The swallow below is written for exactly one of them — a token that is
     * expired, missing or malformed, which is the ordinary case this endpoint
     * is public *for*, and which is genuinely nothing to say. It sat around all
     * three, so the two that are not that were swallowed by a handler that was
     * never about them:
     *
     *   * `bumpSessionEpoch` is the whole of "sign out everywhere". When it
     *     throws, this request clears one cookie and every other session and
     *     JWT the user holds stays valid — on the other devices they pressed
     *     this button *about* — and the answer is still `200 Signed out.` The
     *     user is told the opposite of what happened and no line anywhere says
     *     so.
     *   * `recordAdminEvent` is the sign-out half of the identity spine, added
     *     precisely because the trail could say when a session began and never
     *     when it ended. A throw here silently restores that gap for this
     *     session, which is the state an incident reconstruction is done from.
     *
     * Split, so the parse stays silent and the other two are `logUnretried`:
     * nothing comes back for either — no retry, no sweep, no ladder — which is
     * the condition that helper's `alert: true` exists for.
     *
     * The status does not change. The cookie is cleared before any of this and
     * a 5xx would leave the caller believing they are still signed in on the
     * device they are actually signed out of, which is the worse of the two
     * false answers. What the failure needs is a reader, and it now has one.
     */
    let claims: Awaited<ReturnType<typeof verifySession>> | null = null;
    try {
      const header = req.headers.authorization;
      const bearer =
        (header?.startsWith('Bearer ') ? header.slice(7).trim() : '') || req.cookies?.[SESSION_COOKIE] || '';
      if (bearer && !bearer.startsWith('n409_pat_')) claims = await verifySession(bearer, deps.jwt);
    } catch {
      /* expired / missing / invalid — cookie is still cleared */
    }
    if (claims) {
      try {
        await bumpSessionEpoch(deps.pool, claims.sub);
      } catch (err) {
        logUnretried(
          req.log,
          err,
          { userId: claims.sub },
          'could not invalidate the user\u2019s outstanding sessions on logout; their other tokens are still valid',
        );
      }
      // Attempted whichever way the epoch bump went: the sign-out request
      // happened and the trail is answering "when did this session end".
      // Sign-in was audited from the day the spine existed and its counterpart
      // never was.
      try {
        await recordAdminEvent(deps.pool, {
          type: 'user_logout',
          actor: { actorType: 'human', actorId: claims.sub },
          subjectType: 'user',
          subjectId: claims.sub,
        });
      } catch (err) {
        logUnretried(req.log, err, { userId: claims.sub }, 'could not record a logout on the audit spine');
      }
    }
    return reply.status(200).send({ message: 'Signed out.' });
  });

  // Public: lets the SPA know which login methods to offer.
  app.get('/api/v1/auth/providers', async (req) => {
    /*
     * A read that failed and a tenant with no SSO are the same answer here
     * (round 267, methodology M11).
     *
     * The catch is right: this route is the login screen's first call, and a
     * 500 from it leaves a visitor with no form at all rather than with the
     * password box that still works. What it must not be is unrecorded.
     * `saml: false` is not "we could not tell" — the SPA reads it as a fact and
     * draws no SSO button, so an organisation whose people sign in *only*
     * through their IdP is shown a password field for a password they were
     * never issued, and every one of them lands in support instead. Every other
     * trace of that is absent by construction: nothing throws, the request is a
     * 200, and the access log records a successful call.
     *
     * `logFailure` rather than a hand-picked level, because the two causes
     * differ in exactly the way it splits on: a busy pool is a blip the next
     * poll clears, and a broken query or a missing column is not going to fix
     * itself and is worth waking somebody for.
     */
    const saml = await getSamlConfig(deps.pool).catch((err: unknown) => {
      logFailure(
        req.log,
        err,
        {},
        'could not read the SAML configuration — SSO omitted from the login options',
      );
      return null;
    });
    return {
      password: true,
      google: Boolean(deps.google),
      saml: Boolean(saml?.enabled && saml.idp_sso_url && saml.idp_cert),
    };
  });

  const googleUnconfigured = () => problems.badRequest('Google SSO is not configured');

  app.get('/api/v1/auth/google', async (req, reply) => {
    if (!deps.google) return refuseSso(req, reply, 'not_configured', googleUnconfigured());
    const state = await signOidcState(deps.jwt);
    return reply.redirect(deps.google.authorizationUrl(state), 302);
  });

  app.get('/api/v1/auth/google/callback', async (req, reply) => {
    const google = deps.google;
    if (!google) return refuseSso(req, reply, 'not_configured', googleUnconfigured());
    const query = z.object({ code: z.string().min(1), state: z.string().min(1) }).safeParse(req.query);
    if (!query.success) {
      return refuseSso(req, reply, 'invalid_request', problems.badRequest('Missing code/state'));
    }

    try {
      await verifyOidcState(query.data.state, deps.jwt);
    } catch {
      return refuseSso(req, reply, 'invalid_request', problems.unauthorized('Invalid OIDC state'));
    }
    /*
     * The exchange is the one step here that fails for reasons neither end
     * chose — a spent or expired authorization code, Google unreachable — and
     * it is reached only by a browser following Google's redirect. Left to the
     * error handler it is a 500 rendered as a JSON body; `logFailure` keeps the
     * record a 500 would have written, and the reader gets a page.
     */
    let identity: Awaited<ReturnType<GoogleOidc['verifyIdToken']>>;
    try {
      const idToken = await google.exchangeCode(query.data.code);
      identity = await google.verifyIdToken(idToken);
    } catch (err) {
      logFailure(req.log, err, {}, 'Google sign-in could not be completed with the provider');
      return refuseSso(
        req,
        reply,
        'provider_error',
        problems.unauthorized('Google sign-in could not be completed'),
      );
    }
    if (!identity.emailVerified) {
      return refuseSso(
        req,
        reply,
        'email_unverified',
        problems.unauthorized('Google account email is not verified'),
      );
    }

    /*
     * The second door onto account creation.
     *
     * `registration_enabled` was read by `POST /auth/register` and nowhere
     * else, so a platform with self-service registration closed — "new accounts
     * can only be created by invitation", which is what the admin console says
     * the switch does — went on minting a seat for any Google identity that had
     * never signed in here before. The sign-in button is on the public page, so
     * the invitation-only rule held for exactly the door people were being sent
     * away from and not for the one beside it.
     *
     * Creation only. An account that already exists signs in as normal, which
     * is the other half of the same sentence and the reason this is not simply
     * "hide the Google button": closing registration must not sign out the firm.
     *
     * The SAML ACS is deliberately not gated the same way. An IdP there is
     * configured by an administrator of this platform, optionally pinned to one
     * email domain, and JIT provisioning from it *is* the firm's invitation
     * mechanism — turning it off would be a different setting, and one nobody
     * asked for.
     */
    const allowCreate = deps.settings ? await deps.settings.get('registration_enabled') : true;
    const user = await upsertGoogleUser(deps.pool, identity, { allowCreate });
    if (!user) {
      return refuseSso(
        req,
        reply,
        'registration_closed',
        problems.forbidden(
          'This platform is invitation-only — there is no account for this address. ' +
            'Ask an administrator to invite you.',
        ),
      );
    }
    /*
     * The third door onto a closed account (round 272, methodology M3).
     *
     * `deleted_at` is terminal: the password route refuses it above and the SAML
     * ACS refuses it with `account_deactivated`. This one did not check, so a
     * closed account signing in with Google was handed a session token and a
     * redirect into the SPA — and then every call it made was answered 401 "The
     * account this sign-in belongs to has been closed" by the authenticate
     * plugin. Not an authorization hole, but the same state reached through
     * three doors and answered three different ways, and the one that answers
     * with a token is the one that cannot say why.
     *
     * `user_login` was written before the plugin got a say, so the spine also
     * recorded a sign-in for an account nobody can sign into. It is a
     * `user_login_failed` with the same `reason` vocabulary the password door
     * uses, so a closed account being tried at any door reads the same way to
     * the operator looking at it.
     */
    if (user.deleted_at) {
      await recordAdminEvent(deps.pool, {
        type: 'user_login_failed',
        actor: { actorType: 'human', actorId: user.id },
        subjectType: 'user',
        subjectId: user.id,
        subjectLabel: user.email,
        payload: { method: 'google', reason: 'closed_account', ip: req.ip },
      });
      return refuseSso(req, reply, 'account_deactivated', problems.forbidden('This account is deactivated'));
    }
    /*
     * THE SECOND FACTOR, ON THE DOOR THAT NEVER ASKED FOR IT (R354, M6).
     *
     * `POST /auth/login` answers a 2FA-enabled account with a challenge instead
     * of a session, and `POST /auth/mfa/verify` is the only thing that turns
     * one into the other. This door issued the session outright.
     *
     * `upsertGoogleUser` matches on the address alone: an account created with
     * a password here, which then enrolled TOTP here, is *linked* the first
     * time that address arrives from Google — its `password_digest` and its
     * `totp_secret` are left exactly as they were, and `sso_provider` is
     * stamped `google` on the way past. So the factor the owner enrolled, and
     * the one `require_mfa` refuses to let them remove, was skipped in full by
     * the button next to the password box: whoever controls the Google identity
     * for that address holds the account, and the second factor never came into
     * it. That is the one thing enrolling a second factor is done to prevent,
     * and no trace of the bypass appears anywhere — the sign-in is an ordinary
     * `user_login` on the spine.
     *
     * The trusted-device exemption is the password door's, unchanged and read
     * from the same cookie: a browser this account has already completed a
     * challenge on stays exempt for its 30 days whichever door it comes back
     * through.
     *
     * Answered the way the password door answers it, in each of this route's
     * two response shapes — the fragment the SPA reads, and the JSON body an
     * API caller gets. No `user_login` row and no `signed_in`: nobody has
     * signed in yet.
     */
    if (user.totp_enabled) {
      const deviceToken = req.cookies?.[DEVICE_COOKIE];
      const trusted = deviceToken ? await isDeviceTrusted(deps.pool, user.id, deviceToken) : false;
      if (!trusted) {
        recordSsoOutcome('google', 'mfa_challenged');
        const challenge = await signMfaChallenge(user.id, deps.jwt);
        if (req.headers.accept?.includes('text/html')) {
          return reply.redirect(`/auth/google/complete#mfa=${encodeURIComponent(challenge)}`, 302);
        }
        return { mfa_required: true, challenge };
      }
    }
    await recordAdminEvent(deps.pool, {
      type: 'user_login',
      actor: { actorType: 'human', actorId: user.id },
      subjectType: 'user',
      subjectId: user.id,
      subjectLabel: user.email,
      payload: { method: 'google' },
    });
    // The denominator for `sso_outcomes_total` — see ssoOutcomes.ts. Every
    // refusal above this line leaves as a 302, which the HTTP metrics count
    // beside every ordinary redirect on the platform.
    recordSsoOutcome('google', 'signed_in');
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
    if (!parsed.success) throw invalidBody('Invalid request', parsed.error);
    const email = parsed.data.email;

    if (!allow(`email:${email.toLowerCase()}`, 3, HOUR_MS) || !allow(`ip:${req.ip}`, 30, HOUR_MS)) {
      // The refusal that costs the most on this surface: the person being
      // turned away is already locked out, and the only other party who can see
      // it is them. See `observability/requestThrottle.ts`.
      recordThrottleRefusal('password-reset');
      throw problems.tooManyRequests(
        'Too many password-reset requests from this address',
        retryAfter([`email:${email.toLowerCase()}`, 3, HOUR_MS], [`ip:${req.ip}`, 30, HOUR_MS]),
      );
    }

    const user = await findUserByEmail(deps.pool, email);
    // Recorded in *both* branches, and before either of them does its work.
    // The obvious placement — inside the `if` below — would put one extra
    // insert on the round trip only when the address exists, which is the
    // timing oracle this whole route is written to avoid (see the note on the
    // unawaited send). Recording the request either way costs nothing and is
    // the better record besides: a run of resets requested for addresses that
    // have no account is enumeration, and it is only visible if the misses are
    // written down too.
    await recordAdminEvent(deps.pool, {
      type: 'user_password_reset_sent',
      actor: { actorType: 'system', actorId: null, source: 'self_service' },
      subjectType: 'user',
      subjectId: user?.id ?? null,
      subjectLabel: email,
      payload: { self_service: true, sent: Boolean(user?.password_digest && !user.deleted_at) },
    });
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
        { pool: deps.pool, transport: deps.transport, log: req.log, settings: deps.settings },
        {
          toUserId: user.id,
          toEmail: user.email,
          ...template,
          recipientName: user.first_name,
          vars: { link },
        },
      );
    }
    return reply
      .status(202)
      .send({ message: "If an account exists for this email, we've sent a reset link." });
  });

  app.post('/api/v1/auth/reset-password', async (req) => {
    const parsed = ResetPasswordBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid request', parsed.error);

    // Bounds token guessing. The tokens are long random secrets, so this is a
    // belt-and-braces limit — but an unbounded redeem endpoint also lets an
    // attacker burn CPU on a scrypt hash per request.
    if (!allow(`reset-ip:${req.ip}`, TOKEN_REDEEM_PER_IP, HOUR_MS)) {
      recordThrottleRefusal('password-reset');
      throw problems.tooManyRequests(
        'Too many password-reset attempts',
        retryAfter([`reset-ip:${req.ip}`, TOKEN_REDEEM_PER_IP, HOUR_MS]),
      );
    }

    await assertPasswordStrong(parsed.data.password);

    const digest = await hashPassword(parsed.data.password);
    const reset = await resetPasswordWithToken(deps.pool, parsed.data.token, digest);
    if (!reset.ok) {
      /*
       * The refusal half of this door (R344, methodology M5).
       *
       * Every other way into an account writes a row when it says no, and says
       * why inside it — R272 argued that at the SAML door and
       * `failedAuthPayloadCensus` holds it for the four that existed then.
       * This one wrote nothing: a redeem that failed answered 400, and a 4xx
       * raised on purpose leaves no log line either, so the whole event was a
       * message in one browser.
       *
       * `address_changed` is why that matters now rather than in general. It
       * is migration 0204's guard — one round old — and the case it exists for
       * is an attacker holding a live link into the mailbox an account has
       * just moved away from *because* that mailbox was compromised. The guard
       * refuses them. Until this it also told nobody, so the operator who
       * moved the address had no way to learn the link had been tried.
       *
       * `user_login_failed` rather than an event of its own: this is an
       * authentication door, the payload vocabulary is already `method` +
       * `reason` + `ip`, and `closed_account` here is the same state the
       * password and Google doors record under that word. One query answers
       * "who has been trying to get into this account, and from where" across
       * all of them.
       *
       * Written in every refusing branch, and the success path above records
       * too, so nothing about which branch ran is visible from outside as a
       * latency difference — the property `forgot-password` is built around.
       * Bounded by the same throttle that bounds the scrypt hash above:
       * `TOKEN_REDEEM_PER_IP` an hour is the ceiling on rows this route can be
       * made to write.
       */
      await recordAdminEvent(deps.pool, {
        type: 'user_login_failed',
        actor: { actorType: 'human', actorId: reset.userId, source: 'password_reset' },
        subjectType: 'user',
        subjectId: reset.userId,
        // The address the link was sent to. For `address_changed` that is not
        // the account's address any more, and it is the field that says which
        // mailbox the presenter is holding a link in.
        subjectLabel: reset.email,
        payload: { method: 'password_reset', reason: reset.reason, ip: req.ip },
      });
      throw problems.badRequest(DEAD_LINK_DETAIL.reset);
    }
    await recordAdminEvent(deps.pool, {
      type: 'user_password_changed',
      // Nobody is signed in here — the token is the whole authority — so the
      // actor is the subject rather than a principal we verified.
      actor: { actorType: 'human', actorId: reset.userId, source: 'password_reset' },
      subjectType: 'user',
      subjectId: reset.userId,
      payload: { method: 'reset' },
    });
    return { message: 'Password updated — you can now sign in.' };
  });

  // ── Email verification (gap #26) ───────────────────────────────────────────

  // Public: the link lands unauthenticated. POST so the token stays out of
  // URLs/server logs — the SPA reads it from the fragment and posts it here.
  app.post('/api/v1/auth/verify-email', async (req) => {
    const parsed = VerifyEmailBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid request', parsed.error);

    if (!allow(`verify-email-ip:${req.ip}`, TOKEN_REDEEM_PER_IP, HOUR_MS)) {
      recordThrottleRefusal('email-verification');
      throw problems.tooManyRequests(
        'Too many verification attempts',
        retryAfter([`verify-email-ip:${req.ip}`, TOKEN_REDEEM_PER_IP, HOUR_MS]),
      );
    }

    const { outcome, userId } = await verifyEmailWithToken(deps.pool, parsed.data.token);
    if (outcome === 'invalid') throw problems.badRequest(DEAD_LINK_DETAIL.verification);
    if (outcome === 'verified')
      await recordAdminEvent(deps.pool, {
        type: 'user_email_verified',
        actor: { actorType: 'human', actorId: userId, source: 'email_verification' },
        subjectType: 'user',
        subjectId: userId,
      });
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
      recordThrottleRefusal('email-verification');
      throw problems.tooManyRequests(
        'Too many verification emails requested for this address',
        retryAfter([`verify:${user.id}`, 3, HOUR_MS], [`verify-ip:${req.ip}`, 30, HOUR_MS]),
      );
    }
    sendVerificationEmail(user, req.log);
    return { message: "We've sent a fresh verification link to your email." };
  });

  app.post('/api/v1/auth/change-password', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const parsed = ChangePasswordBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid request', parsed.error);
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
    await recordAdminEvent(deps.pool, {
      type: 'user_password_changed',
      actor: { actorType: 'human', actorId: user.id },
      subjectType: 'user',
      subjectId: user.id,
      subjectLabel: user.email,
      // The epoch bump signs every other session out, which is the same effect
      // `user_sessions_revoked` records when an administrator does it. Named
      // here rather than written as a second event, so one action is one row.
      payload: { method: 'change', sessions_revoked: true },
    });
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
    if (!parsed.success) throw invalidBody('Invalid request', parsed.error);

    // Same token space as accept-invite below, and it answers "is this token
    // real?" directly — limiting only the redeem route would leave the
    // enumeration oracle wide open.
    if (!allow(`invite-info-ip:${req.ip}`, TOKEN_REDEEM_PER_IP, HOUR_MS)) {
      recordThrottleRefusal('invitation');
      throw problems.tooManyRequests(
        'Too many invitation lookups from this address',
        retryAfter([`invite-info-ip:${req.ip}`, TOKEN_REDEEM_PER_IP, HOUR_MS]),
      );
    }

    const invitation = await findPendingInvitationByToken(deps.pool, parsed.data.token);
    if (!invitation) throw problems.badRequest(DEAD_LINK_DETAIL.invitation);
    return { email: invitation.email, expires_at: invitation.expires_at };
  });

  app.post('/api/v1/auth/accept-invite', async (req, reply) => {
    const parsed = AcceptInviteBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid invitation', parsed.error);
    const { token, password, first_name, last_name } = parsed.data;

    // Accepting an invite mints an account, so an unbounded endpoint is both a
    // token-guessing surface and a scrypt-CPU sink.
    if (!allow(`invite-ip:${req.ip}`, TOKEN_REDEEM_PER_IP, HOUR_MS)) {
      // A colleague who cannot finish joining, and nobody here to tell.
      recordThrottleRefusal('invitation');
      throw problems.tooManyRequests(
        'Too many invitation attempts from this address',
        retryAfter([`invite-ip:${req.ip}`, TOKEN_REDEEM_PER_IP, HOUR_MS]),
      );
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
    if (result.status === 'invalid') throw problems.badRequest(DEAD_LINK_DETAIL.invitation);
    if (result.status === 'conflict') {
      // Reached by somebody who *was* invited, so "an account already exists"
      // reads as the invitation having failed. It has not: the address is
      // already on the platform, the invitation needed a new account and
      // therefore has nothing to do, and what they want is to sign in.
      throw problems.conflict(
        'An account already exists for the address this invitation was sent to, so there is no ' +
          'new account to set up. Sign in with that address — use “Forgot password” if you need a ' +
          'new one. If you still cannot see the organisation you were invited to, ask whoever ' +
          'invited you to add your existing account to it.',
      );
    }
    await recordAdminEvent(deps.pool, {
      type: 'invitation_accepted',
      actor: { actorType: 'human', actorId: result.user.id },
      subjectType: 'user',
      subjectId: result.user.id,
      subjectLabel: result.user.email,
    });
    const sessionToken = await issueSession(reply, result.user);
    return reply.status(201).send({ user: toPublicUser(result.user), token: sessionToken });
  });
}
