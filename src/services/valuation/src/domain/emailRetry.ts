/**
 * When a failed outbox row may be tried again.
 *
 * The outbox had a retry ceiling and no schedule. `settleClaimedEmail` released
 * the lease on failure so the row was claimable again immediately, and the
 * comment above it said so deliberately: "picked up by the next sweep instead
 * of waiting one out". That reads as promptness, and it is the same mistake
 * migration 0139 found in the webhook ladder and fixed — with no schedule, the
 * only thing spacing the attempts out is the sweep interval, so every attempt a
 * message has is spent at one fixed cadence.
 *
 * `EMAIL_RETRY_SCAN_MINUTES` defaults to 30 and the ceiling was 5 attempts, so
 * a message reached terminal 'failed' about two hours after its first attempt —
 * and against an SMTP outage all five of those attempts land inside the same
 * outage. That is the one outcome a retry mechanism exists to prevent: not a
 * message lost to a bad address, which should stop, but a message lost to a
 * relay that was down from 02:00 and back at 05:00, which should not.
 *
 * So the same ladder the webhook deliveries got, for the same reason and in the
 * same shape. Two things differ, both because the outbox is polled rather than
 * scheduled:
 *
 *   * a step shorter than the sweep interval is rounded up to it in practice.
 *     The short steps are kept anyway — they are what an operator-triggered
 *     POST /admin/emails/retry gets, and they cost nothing.
 *   * there is no `Retry-After` to honour. SMTP's own deferral codes are not
 *     carried through the transport interface, so the ladder is the whole
 *     schedule.
 */

/**
 * Minutes to wait before each retry, indexed by attempts already made.
 *
 * One minute covers a relay restart or a momentary connection reset; five
 * covers a deploy; thirty covers an incident someone has to be paged for; the
 * two long steps are what carry a message across an overnight outage and a
 * business day's response. Reach is ~8.5 hours, and it is still bounded — a
 * genuinely undeliverable address exhausts the ladder and settles, rather than
 * being retried forever behind an ever-growing counter.
 *
 * Deliberately the same figures as `WEBHOOK_RETRY_BACKOFF_MINUTES`: the two
 * subsystems are answering the same question about the same kind of upstream,
 * and two different ladders would be two different things to reason about at
 * 03:00 with no argument for either.
 */
export const EMAIL_RETRY_BACKOFF_MINUTES: readonly number[] = [1, 5, 30, 120, 360];

/** The initial attempt plus one per backoff step. */
export const EMAIL_MAX_ATTEMPTS = EMAIL_RETRY_BACKOFF_MINUTES.length + 1;

/**
 * How long to wait before attempt number `attemptsMade + 1`, or null when the
 * row is out of attempts and the failure is terminal.
 *
 * `attemptsMade` is the count *including* the one that just failed, which is
 * how the row reads after a claim — the claim increments before the send. So a
 * first failure asks for BACKOFF[0].
 *
 * A `maxAttempts` above the ladder's length holds at the longest step rather
 * than falling through to terminal, so raising `EMAIL_RETRY_MAX_ATTEMPTS` adds
 * attempts instead of silently doing nothing.
 */
export function emailRetryDelayMinutes(
  attemptsMade: number,
  maxAttempts = EMAIL_MAX_ATTEMPTS,
): number | null {
  if (!Number.isFinite(attemptsMade) || attemptsMade < 1) return EMAIL_RETRY_BACKOFF_MINUTES[0]!;
  if (attemptsMade >= maxAttempts) return null;
  const step = EMAIL_RETRY_BACKOFF_MINUTES[attemptsMade - 1];
  return step ?? EMAIL_RETRY_BACKOFF_MINUTES.at(-1) ?? 30;
}

/**
 * The smallest share of a backoff step that may actually be waited.
 *
 * "Equal jitter", for the reason the webhook ladder documents: an outage fails
 * every message in flight at roughly the same moment, so a fixed ladder gives
 * the whole backlog one next-attempt time and the sweep serves a just-restarted
 * relay its entire outage in a single batch. Half a step rather than full
 * jitter keeps each attempt inside the order of magnitude its step was chosen
 * for.
 */
export const EMAIL_JITTER_FLOOR = 0.5;

/**
 * The window a scheduled attempt must land in, given the jitter above.
 *
 * The schedule itself is stamped by the UPDATE that records the failure — one
 * statement, so a process that dies mid-settle cannot leave a row failed with
 * no schedule (which would be claimable immediately, i.e. today's behaviour).
 * That puts the arithmetic in SQL, and this is what pins the two together: the
 * ladder above is the specification, and `emailRetryLadder.test.ts` asserts the
 * stamped column falls inside the window this returns for every step.
 */
export function emailRetryWindowMs(
  attemptsMade: number,
  maxAttempts = EMAIL_MAX_ATTEMPTS,
): { minMs: number; maxMs: number } | null {
  const minutes = emailRetryDelayMinutes(attemptsMade, maxAttempts);
  if (minutes === null) return null;
  const stepMs = minutes * 60_000;
  return { minMs: stepMs * EMAIL_JITTER_FLOOR, maxMs: stepMs };
}
