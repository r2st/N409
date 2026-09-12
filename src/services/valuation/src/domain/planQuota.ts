import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { ApiProblem } from '@n409/shared';
import {
  consumeValuation,
  findActiveSubscription,
  findPlanForSubscription,
  releaseValuation,
  type SubscriptionRow,
} from '../repos/billing.js';
import { planLimitDetail, quotaAwaitsRenewal } from './billing.js';

/**
 * The plan's valuation quota, drawn at every door that opens an engagement.
 *
 * Feature 7's rule is one sentence: a subscriber's new engagements are drawn
 * against the plan's `valuation_limit`, and the thirteenth on a twelve-a-year
 * retainer is a 402 that names the plan, the figure and the renewal date. A
 * user with no served subscription is on the per-valuation flow and never
 * reaches the counter.
 *
 * That rule lived inline in `POST /valuations` and nowhere else, and the
 * platform has four doors that open an engagement for a user (R449):
 *
 *   * `POST /valuations` — metered.
 *   * `POST /valuations/:id/clone` — a client rolling last year's 409A
 *     forward, which is precisely the engagement an annual retainer counts,
 *     and was free. `flowBilling.test.ts` proves the console refuses the
 *     thirteenth; one press of "Roll forward" on the twelfth opened it.
 *   * The partner API's `POST /valuations` — the same subscriber, the same
 *     row, over a token instead of a session.
 *   * `POST /firm/intake-links/:id/convert` — a firm turning a submitted
 *     questionnaire into an engagement.
 *
 * So: one helper, drawn before the row is written and returned if the write
 * fails, and every door calls it with the id of the user the engagement is
 * opened *for* — which is the body's `user_id` when ops open one on a client's
 * behalf, and the source's owner when ops clone for them. Metering the
 * operator would charge the wrong account and meter nobody who pays.
 *
 * THE DRAW IS A STATEMENT AND THE REFUND IS A COMPENSATION, deliberately, and
 * the shape is `POST /valuations`'s own: the gate has to answer before any
 * work is done, and the creates are their own transactions (or, for the
 * conversion, a transaction that can *return* a refusal rather than throw).
 * `releaseValuation` is bounded below at zero and lands on the current period
 * whatever period the draw was in; erring toward the customer is the right
 * side of that to be wrong on. A refund that itself fails is logged with
 * `alert: true` and never replaces the error the caller needs to see.
 *
 * SAID OUT LOUD, WHICH A 402 IS NOT. The shared error handler logs 5xx and the
 * two database branches; a 4xx `ApiProblem` is a described refusal and passes
 * without a line — right for a bad request, wrong for a paying customer being
 * turned away from the product. The `warn` carries the two period columns
 * that decide whether the refusal is the plan working or the quota accounting
 * going wrong (a renewal that moved `current_period_start` without moving
 * `quota_period_start`, or a release that failed and left the counter one
 * high forever). `door` says which of the four it was.
 */
export type QuotaDoor = 'create' | 'clone' | 'partner-api' | 'intake-convert';

/**
 * Draws one valuation from `userId`'s plan, or throws the 402.
 *
 * Returns the subscription drawn against, or `null` when the user has none —
 * the caller passes it back to {@link returnPlanQuota} so a refund is only
 * attempted where a draw happened.
 */
export async function drawPlanQuota(
  pool: pg.Pool,
  log: FastifyBaseLogger,
  userId: string,
  door: QuotaDoor,
): Promise<SubscriptionRow | null> {
  const subscription = await findActiveSubscription(pool, userId);
  if (!subscription) return null;
  if (await consumeValuation(pool, userId)) return subscription;

  // The plan is read only on the refusal, never on the way through: the limit
  // itself is enforced inside `consumeValuation`'s own UPDATE, so this lookup
  // buys nothing but the sentence — and the sentence is the whole of what the
  // caller gets. A tier retired from the catalogue is still the tier this
  // subscriber is on, so `findPlanForSubscription` (which does not filter
  // `active`) rather than `findPlan`; a missing row leaves the figures out and
  // the remedy in.
  const plan = await findPlanForSubscription(pool, subscription.plan_tier);
  log.warn(
    {
      userId,
      door,
      subscriptionId: subscription.id,
      planTier: subscription.plan_tier,
      valuationsUsed: subscription.valuations_used,
      valuationLimit: plan?.valuation_limit ?? null,
      quotaPeriodStart: subscription.quota_period_start?.toISOString() ?? null,
      currentPeriodStart: subscription.current_period_start?.toISOString() ?? null,
      currentPeriodEnd: subscription.current_period_end?.toISOString() ?? null,
      subscriptionStatus: subscription.status,
      awaitingRenewal: quotaAwaitsRenewal(subscription),
    },
    'plan valuation limit reached — creation refused',
  );
  throw new ApiProblem({
    status: 402,
    title: 'Plan limit reached',
    type: 'urn:n409:problem:plan-limit',
    detail: planLimitDetail({
      plan_name: plan?.name ?? 'your plan',
      valuation_limit: plan?.valuation_limit ?? null,
      valuations_used: subscription.valuations_used,
      current_period_end: subscription.current_period_end,
      awaiting_renewal: quotaAwaitsRenewal(subscription),
    }),
  });
}

/**
 * Gives back what {@link drawPlanQuota} charged, when the engagement it was
 * charged for was never opened. Best-effort and logged either way; `cause` is
 * the failure that made the refund necessary, and `err` in the refund's own
 * failure line is the refund's.
 */
export async function returnPlanQuota(
  pool: pg.Pool,
  log: FastifyBaseLogger,
  userId: string,
  door: QuotaDoor,
  cause: unknown,
): Promise<void> {
  try {
    const released = await releaseValuation(pool, userId);
    log.warn({ err: cause, userId, door, released }, 'valuation create failed — plan quota returned');
  } catch (refundErr) {
    log.error(
      { err: refundErr, cause, userId, door, alert: true },
      'valuation create failed and the plan quota it spent could not be returned',
    );
  }
}

/**
 * Draw, open, and refund on failure — the whole rule for a door whose create
 * either returns the engagement or throws.
 *
 * A door whose create can *return* a refusal (the intake conversion) calls
 * the two halves itself, because "the transaction rolled back and told me
 * why" is not a throw and still needs the draw returned.
 */
export async function withPlanQuota<T>(
  pool: pg.Pool,
  log: FastifyBaseLogger,
  userId: string,
  door: QuotaDoor,
  open: () => Promise<T>,
): Promise<T> {
  const drawn = await drawPlanQuota(pool, log, userId, door);
  try {
    return await open();
  } catch (err) {
    if (drawn) await returnPlanQuota(pool, log, userId, door, err);
    throw err;
  }
}
