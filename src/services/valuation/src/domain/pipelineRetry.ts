/**
 * When a failed auto-pipeline run may be tried again.
 *
 * The run row survives the failure with everything needed to do the work over —
 * the valuation, the document, the trigger, who caused it — and until migration
 * 0161 nothing read it. See that migration for the case this exists for: an AI
 * outage overnight is every upload in it arriving as an empty valuation, with
 * no record that anything is owed.
 *
 * Two rules, and the second is the one that keeps this from being a machine for
 * wasting upstream calls:
 *
 *   1. **Only transient failures are scheduled.** A run that failed because the
 *      valuation has no params row will fail identically on every attempt. The
 *      classification comes from the shared table (`shared/failure.ts`), so a
 *      refused connection and a 500 from the AI service are retried, and a 422
 *      about a malformed payload is not.
 *   2. **The ladder is bounded.** Four retries over roughly eight and a half
 *      hours, then the run stays failed and an operator's manual trigger is the
 *      only thing that moves it. Retrying forever would turn a permanently
 *      broken valuation into permanent load.
 *
 * The figures are deliberately identical to `EMAIL_RETRY_BACKOFF_MINUTES` and
 * `WEBHOOK_RETRY_BACKOFF_MINUTES`. Three subsystems are answering the same
 * question about the same kind of upstream, and there is no argument for three
 * different ladders — only three different things to remember at 03:00.
 */

/**
 * Minutes to wait before each retry, indexed by attempts already made.
 *
 * One minute covers a service restart, five covers a deploy, thirty covers an
 * incident someone has to be paged for, and the two long steps are what carry a
 * run across an overnight provider outage — which for a free-tier LLM quota is
 * the ordinary case rather than the exotic one: OpenRouter's daily allowance
 * resets on a clock, and a run that failed on an exhausted quota needs to still
 * be owed something hours later.
 */
export const PIPELINE_RETRY_BACKOFF_MINUTES: readonly number[] = [1, 5, 30, 120, 360];

/** The initial attempt plus one per backoff step. */
export const PIPELINE_MAX_ATTEMPTS = PIPELINE_RETRY_BACKOFF_MINUTES.length + 1;

/**
 * How long to wait before attempt number `attemptsMade + 1`, or null when the
 * run is out of attempts.
 *
 * `attemptsMade` includes the attempt that just failed — which is how the row
 * reads at the moment the failure is recorded — so a first failure asks for
 * `BACKOFF[0]`.
 *
 * A `maxAttempts` above the ladder's length holds at the longest step rather
 * than falling through to terminal, so raising the ceiling adds attempts
 * instead of silently doing nothing. Same rule as `emailRetryDelayMinutes`, and
 * for the same reason.
 */
export function pipelineRetryDelayMinutes(
  attemptsMade: number,
  maxAttempts = PIPELINE_MAX_ATTEMPTS,
): number | null {
  if (!Number.isFinite(attemptsMade) || attemptsMade < 1) return PIPELINE_RETRY_BACKOFF_MINUTES[0]!;
  if (attemptsMade >= maxAttempts) return null;
  const step = PIPELINE_RETRY_BACKOFF_MINUTES[attemptsMade - 1];
  return step ?? PIPELINE_RETRY_BACKOFF_MINUTES.at(-1) ?? 30;
}

/**
 * The smallest share of a backoff step that may actually be waited.
 *
 * Equal jitter, for the reason the outbox ladder documents: one outage fails
 * every run in flight at roughly the same moment, so a fixed ladder gives the
 * whole backlog one next-attempt time and the sweep serves a just-recovered AI
 * service its entire outage in a single batch. Half a step keeps each attempt
 * inside the order of magnitude its step was chosen for.
 */
export const PIPELINE_JITTER_FLOOR = 0.5;

/**
 * The window a scheduled attempt must land in, given the jitter above.
 *
 * The schedule is stamped by the same UPDATE that records the failure — one
 * statement, so a process that dies mid-settle cannot leave a run failed with a
 * half-written schedule. That puts the arithmetic in SQL, and this is what pins
 * the two together: the ladder above is the specification, and the test asserts
 * the stamped column falls inside this window at every step.
 */
export function pipelineRetryWindowMs(
  attemptsMade: number,
  maxAttempts = PIPELINE_MAX_ATTEMPTS,
): { minMs: number; maxMs: number } | null {
  const minutes = pipelineRetryDelayMinutes(attemptsMade, maxAttempts);
  if (minutes === null) return null;
  const stepMs = minutes * 60_000;
  return { minMs: stepMs * PIPELINE_JITTER_FLOOR, maxMs: stepMs };
}
