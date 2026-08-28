import { problems } from '@n409/shared';
import { SlidingWindowRateLimiter } from '../plugins/rateLimit.js';
import { verifyPassword } from './password.js';

/**
 * The throttle on re-authentication: the password prompts that sit in front of
 * a credential-level action on an *already signed-in* session — changing the
 * password or the login email, closing the account, disabling 2FA, regenerating
 * backup codes, and minting a personal API token.
 *
 * Those prompts exist for the case where the session is not the owner's: a
 * stolen token, a walk-up on an unlocked laptop, an XSS-borrowed cookie. The
 * attacker in that story already has the session, so the password is the only
 * thing still in their way — which makes these endpoints a password oracle, and
 * they were the only ones in the service that answered an unlimited number of
 * times. `/auth/login` allows ten tries per quarter hour; the same guess posted
 * to `/account/mfa/disable` could be repeated forever.
 *
 * The budget is per user and *shared across every prompt*, because the endpoints
 * are interchangeable to a guesser: six separate ten-try budgets is a sixty-try
 * budget for anyone willing to rotate between them. Sharing it is also what
 * makes adding a sixth prompt free: `POST /me/tokens` joined the list without
 * widening the budget by a single guess.
 *
 * Only failures are charged. A legitimate owner passes on the first try, so the
 * window never fills for them however many settings they change; a guesser pays
 * for every miss.
 */
const limiter = new SlidingWindowRateLimiter();

export const REAUTH_MAX_FAILURES = 10;
export const REAUTH_WINDOW_MS = 15 * 60 * 1000;

const key = (userId: string) => `reauth:${userId}`;

/**
 * Check a re-authentication password against the caller's own digest.
 *
 * Throws 429 once the failure budget is spent — deliberately before the scrypt
 * comparison, so a flood cannot pin the CPU on password hashing. Returns false
 * for a wrong (or absent) password so each caller can keep its own wording.
 */
export async function verifyReauthPassword(
  userId: string,
  password: string,
  digest: string | null | undefined,
): Promise<boolean> {
  if (!limiter.allow(key(userId), REAUTH_MAX_FAILURES, REAUTH_WINDOW_MS, { peek: true })) {
    throw problems.tooManyRequests(
      'Too many incorrect password attempts — try again later',
      // The window is a quarter hour, so a client left to guess at the wait
      // guesses low and is refused again. `PROBLEM_CATALOG` promises the caller
      // a number; this is where the number for these six prompts comes from.
      limiter.retryAfterSeconds(key(userId), REAUTH_MAX_FAILURES, REAUTH_WINDOW_MS),
    );
  }
  // No digest means an SSO-only account; callers reject that with their own
  // message, but an attempt against one still counts as a failed guess.
  const ok = digest ? await verifyPassword(password, digest) : false;
  if (!ok) limiter.allow(key(userId), REAUTH_MAX_FAILURES, REAUTH_WINDOW_MS);
  return ok;
}
