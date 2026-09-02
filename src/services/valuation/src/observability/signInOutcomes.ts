import type { Counter, MetricsRegistry } from '@n409/shared';

/**
 * What the front door is doing with the people arriving at it.
 *
 * WHY THIS EXISTS (R353, methodology M11). Every *machine* door onto this
 * platform has an outcome counter and a rule written against it — inbound
 * webhooks and the two SSO flows in R329, the SCIM connector in R337, partner
 * API keys in R345 — and each of them exists for the same stated reason: the
 * refusal is answered in a status class nothing here alerts on, so an outage
 * that stops everybody getting in reads green on every other instrument.
 *
 * The door people use was the one left. `POST /api/v1/auth/login` and `POST
 * /api/v1/auth/mfa/verify` answer a refusal with 401 and a throttle with 429,
 * and this box has no 4xx rule at all — `scimRequests.ts` says so in as many
 * words. So:
 *
 *   * the password verifier, the session issuer or the challenge signer breaks
 *     in a deploy, or `users` comes back from a migration with the digests in a
 *     column nothing reads, and every sign-in on the estate is refused. No 5xx,
 *     no slow request, no circuit — the identity store is our own Postgres and
 *     it is answering fine. `HighServerErrorRate` sees nothing;
 *   * a credential-stuffing run walks the address list. Each address locks at
 *     ten attempts, the refusals past the lock are not even written to the
 *     spine (`routes/auth.ts` argues why), and the whole event is a rise in a
 *     4xx count nobody is watching;
 *   * `POST /auth/mfa/verify` starts rejecting correct codes — a clock that has
 *     drifted on the box, a secret encrypted under a key that was rotated — and
 *     every 2FA account on the platform is locked out while password sign-in,
 *     which is what most instruments would notice, keeps working.
 *
 * The audit spine already carries all of this: R215 gave every failing branch a
 * `user_login_failed` row and a wrong second factor a
 * `user_mfa_challenge_failed` one. That is the record an investigator reads
 * afterwards, and it is a table on the same database the incident may be
 * about; it is not a channel anybody is woken by.
 * This is the other half, and it is the same half every door above was given.
 *
 * NOT AN ACCESS LOG, and deliberately not labelled by address, account or IP.
 * The vocabulary below is closed and the two doors are named by construction,
 * so the series set is bounded at eleven whatever arrives — and the caller
 * supplying the values here is the open internet. Who was refused is on the
 * spine row, where the reader is an operator entitled to it.
 */
let attempts: Counter | null = null;

/** Which half of the sign-in sequence. */
export type SignInDoor = 'password' | 'mfa';

/**
 * What became of one attempt.
 *
 * `signed_in` is the denominator, and `mfa_challenged` is deliberately neither
 * that nor a refusal: an account with 2FA on is *answered* by the password door
 * with a challenge rather than a session, and counting it as a failure would
 * make a firm that has mandated 2FA look like a firm that cannot sign in. It is
 * its own outcome so the ratio rule can exclude it and so the two doors can be
 * read against each other — challenges issued that never become a verified
 * sign-in is what a broken second factor looks like from here.
 *
 * The three password refusals are the `reason` the spine row already records,
 * not a second spelling of it: the route computes the word once and hands the
 * same value to the spine row and to this counter, so the two cannot drift
 * into two vocabularies for one thing.
 * They are kept apart for the reason the SCIM door keeps `unauthenticated`
 * apart from `bad_token` — `unknown_account` at any volume is somebody walking
 * an address list and must not be able to page anybody, where `bad_password`
 * against accounts that exist is either an attack on known addresses or the
 * verifier itself having stopped working.
 *
 * `throttled` is refused before any credential is read, so it is neither of the
 * above, and it is its own kind of silence: an address at its ceiling is locked
 * out of the platform for the rest of the window, and the owner may be the one
 * being locked out rather than the guesser.
 */
export type SignInOutcome =
  | 'signed_in'
  | 'mfa_challenged'
  | 'unknown_account'
  | 'closed_account'
  | 'bad_password'
  | 'throttled'
  | 'bad_code'
  | 'challenge_invalid'
  | 'not_enrolled';

export function registerSignInMetrics(registry: MetricsRegistry): void {
  attempts = registry.counter(
    'sign_in_outcomes_total',
    'Interactive sign-in attempts by door and outcome. Every refusal here is a 401 and every throttle a 429, and this deployment has no rule on either class — so a password door or a second factor that refuses everybody is invisible to every other instrument.',
    ['door', 'outcome'],
  );
}

/** Test seam: drops the instrument so one suite's counts cannot leak into another. */
export function resetSignInMetrics(): void {
  attempts = null;
}

export function recordSignInOutcome(door: SignInDoor, outcome: SignInOutcome): void {
  attempts?.inc({ door, outcome });
}
