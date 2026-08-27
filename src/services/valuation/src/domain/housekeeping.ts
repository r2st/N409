/**
 * What the housekeeping sweep is allowed to delete, and why each row is safe to
 * lose.
 *
 * Every table here holds records that stop meaning anything on a clock: a
 * single-use credential past its expiry, an invitation that was taken or
 * withdrawn, an idempotency claim whose replay window has closed. Nothing ever
 * removed them. `saml_assertions_seen` was the only table in the schema with a
 * purge, and it purges itself on write; the rest have grown monotonically since
 * the day they were added.
 *
 * That is three separate costs. The rows accumulate without bound, on tables
 * whose indexes are on the sign-in path. They are a standing store of live-
 * shaped secret material — sha256 of a reset token is not a secret, but a table
 * of a hundred thousand of them is a better target than a table of nine. And
 * they make every question about the recent past slower to answer, which is the
 * one that bites during an incident rather than after it.
 *
 * ## Why a grace period rather than deleting at expiry
 *
 * `RETENTION` is deliberately much longer than any TTL here — the longest is
 * the invitation's seven days. A row is unusable the moment it expires, so the
 * gap buys nothing operationally; it buys the ability to answer "was a reset
 * link ever issued for this address" during the weeks when someone might ask.
 * Deleting on the stroke of expiry would make the sweep the reason an incident
 * cannot be reconstructed.
 *
 * ## What is deliberately not here
 *
 * Anything a person reads. The email outbox ages out through the retention
 * policy engine (`domain/retention.ts`), which has per-type ages, legal holds
 * and an operator to set them. This sweep is for machine bookkeeping with no
 * policy question attached — the distinction being that nobody would ever want
 * to configure the answer.
 *
 * This paragraph used to name audit events, activity and notifications
 * alongside the outbox, and none of them was true: the retention sweep
 * implemented one data type out of five, so four of the console's controls
 * saved and did nothing. What each type is actually subject to is now declared
 * in `RETENTION_ENFORCEMENT` and held against the sweep by a test, rather than
 * asserted in prose here — which is how this sentence came to be wrong and
 * stay wrong.
 */

export interface HousekeepingTarget {
  /** Table to sweep. A literal from this file — never interpolated from input. */
  table: string;
  /** Predicate selecting removable rows. `$1` is the retention interval. */
  where: string;
  /** What is being thrown away, for the sweep's log line and the reader. */
  reason: string;
}

/**
 * How long a spent record is kept before the sweep takes it.
 *
 * One value across every target rather than one per table. These are all the
 * same kind of thing — bookkeeping whose usefulness ended — and a per-table
 * ladder would be five numbers nobody could justify against each other.
 */
export const HOUSEKEEPING_RETENTION = '30 days';

/**
 * The most rows one pass will remove from one table.
 *
 * The first sweep after this ships deletes everything that has accumulated
 * since each table was created, which on the busiest of them is not a statement
 * to run in one transaction against a live sign-in path. Capping it makes the
 * backlog drain over several ticks instead, and the tick is frequent enough
 * that a table at the cap is caught up within the hour.
 */
export const HOUSEKEEPING_BATCH = 5_000;

export const HOUSEKEEPING_TARGETS: readonly HousekeepingTarget[] = [
  {
    table: 'password_reset_tokens',
    // Spent means redeemed or lapsed. Both conditions are stated rather than
    // inferred from the age, so the predicate stays correct if the one-hour TTL
    // is ever raised past the retention window.
    where: 'created_at <= now() - $1::interval AND (used_at IS NOT NULL OR expires_at <= now())',
    reason: 'spent password reset tokens',
  },
  {
    table: 'email_verification_tokens',
    where: 'created_at <= now() - $1::interval AND (used_at IS NOT NULL OR expires_at <= now())',
    reason: 'spent email verification tokens',
  },
  {
    // An invitation that was accepted, withdrawn or left to lapse. The live
    // ones — unaccepted, unrevoked, unexpired — are what the admin list is for
    // and are never touched. Note that a lapsed invitation is now revoked by
    // the next invite to that address (`createInvitation`), so most rows here
    // arrive already carrying `revoked_at`.
    table: 'user_invitations',
    where:
      'created_at <= now() - $1::interval AND ' +
      '(accepted_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at <= now())',
    reason: 'settled user invitations',
  },
  {
    // "Remember this device" cookies whose thirty days are up. The device is no
    // longer trusted the instant it expires; the row is only a record that it
    // once was.
    table: 'mfa_trusted_devices',
    where: 'expires_at <= now() - $1::interval',
    reason: 'expired MFA trusted devices',
  },
  {
    // Idempotency claims past any plausible retry. Aged on `created_at` rather
    // than `completed_at` so an abandoned claim — a process that died holding a
    // key — is collected too; those are already reclaimable after minutes
    // (migration 0160), and this is what stops the row itself outliving the
    // question.
    table: 'partner_api_idempotency',
    where: 'created_at <= now() - $1::interval',
    reason: 'expired partner API idempotency records',
  },
];
