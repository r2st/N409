import type { Counter, MetricsRegistry } from '@n409/shared';

/**
 * Every 429 this service answers that no other instrument counts.
 *
 * WHY THIS EXISTS (R420, methodology M11). Round by round the estate has given
 * each of its doors an instrument, and each time for the same stated reason:
 * `scimRequests.ts` writes it plainly — *"there is no 4xx rule on this box at
 * all"* — and `alerts.yml` repeats it beside the realtime rules, *"the refusal
 * itself is `problems.tooManyRequests`, one 429 in the 4xx class beside every
 * rate-limited request on the estate"*. R329 took the webhook and SSO doors,
 * R337 the directory connector, R345/R346 the partner API, R369 the realtime
 * hub, R376 the sign-in door. Every one of those is a door with a *machine*
 * behind it.
 *
 * What was left is the door with a *person* behind it, and it is the largest
 * surface on the platform: `plugins/auth.ts` runs three limiters over the whole
 * authenticated API — per user, per organisation, and a cost budget for the
 * expensive operations — and each refuses with a `tooManyRequests` that is
 * counted nowhere, logged nowhere, and watched by nothing.
 *
 * The failures that hides are not exotic:
 *
 *   * `SESSION_RATE_LIMIT_PER_MIN` or `SESSION_RATE_LIMIT_ORG_PER_MIN` set low by a
 *     deploy — the numbers are env-driven and `rateLimitPolicy.ts` reads them
 *     off the *installed* limiters precisely because a deployment can change
 *     them. Too low and every screen in the SPA half-loads for everybody at a
 *     firm at once, with `HighServerErrorRate` seeing no 5xx, `SlowRequests`
 *     seeing nothing, and the access log full of a status class nothing reads.
 *   * The organisation limiter is shared, so one firm's runaway integration
 *     spends the budget its analysts are trying to work inside. To the analysts
 *     that is the product being broken; to this box it is invisible.
 *   * The cost budget governs the AI pipeline and the calculation runs — the
 *     operations a customer is paying for — and exhausting it looks, from
 *     every instrument here, exactly like nobody having asked.
 *
 * The token-only public links are the same shape one layer out. An auditor or a
 * board member is sent a link and given a per-IP budget; a firm behind one
 * office NAT spends it collectively, and the person who cannot open the
 * engagement has no account, no console, and no way to tell anyone here. The
 * client intake link, the contact form and the sample-report door share the
 * argument.
 *
 * DELIBERATELY NOT LABELLED BY USER, ORGANISATION OR IP. Which subject was
 * refused is a question for the log line and the audit spine; the label set
 * here is bounded by construction at one series per door, because on the public
 * half the party supplying any finer label would be the open internet — the
 * cardinality trap `MAX_SERIES_PER_METRIC` exists for.
 */
let refusals: Counter | null = null;

/**
 * The doors, named for the throttle rather than for the route.
 *
 * The three `session-*` values are the limiters `registerAuth` installs and are
 * kept apart because they are three different incidents: `user` is one caller
 * over their own budget and is ordinarily somebody's runaway tab; `org` is a
 * budget shared by everyone at a firm, so it refuses people who did nothing;
 * `cost` is the heavy-operation budget and its refusal costs a pipeline run
 * rather than a page of the UI.
 *
 * `reauth` is not a rate limit in the same sense — it is the step-up password
 * failure budget, so a refusal is either a guesser or an owner locked out of
 * their own settings, which is the pair `signInOutcomes.ts` exists to separate
 * one door over.
 *
 * The last four are the unauthenticated identity surface, grouped by what the
 * refusal *costs* rather than by route, because that is the only thing an
 * operator can act on: `password-reset` covers both the request and the redeem
 * (someone locked out cannot get back in), `email-verification` covers the link
 * and the resend, and `invitation` covers the lookup and the accept (a new
 * colleague cannot finish joining). `signInOutcomes.ts` already holds the two
 * doors next to these — the password sign-in and the second factor — which is
 * why neither appears here.
 */
export type ThrottledDoor =
  | 'session-user'
  | 'session-org'
  | 'session-cost'
  | 'reauth'
  | 'auditor-portal'
  | 'board-approval'
  | 'client-intake'
  | 'contact'
  | 'sample-report'
  | 'register'
  | 'password-reset'
  | 'email-verification'
  | 'invitation'
  | 'unsubscribe'
  | 'fmv-estimator'
  | 'valuation-selector';

export function registerRequestThrottleMetrics(registry: MetricsRegistry): void {
  refusals = registry.counter(
    'throttle_refusals_total',
    'Requests refused by a rate limiter, by door. door="session-org" is a whole firm being turned away; the token-only doors are people with no account who cannot tell anyone here.',
    ['door'],
  );
}

/** Test seam: drops the instrument so one suite's counts cannot leak into another. */
export function resetRequestThrottleMetrics(): void {
  refusals = null;
}

/**
 * Counts one refusal.
 *
 * No log line and no `alert: true` here, unlike `refuseScimRequest` beside it.
 * The callers are on the hot path of every authenticated request and of three
 * unauthenticated links the internet can reach, so a line per refusal is a way
 * for a caller to choose how much this box logs — the argument `unsigned` and
 * `unauthenticated` are already silent for. The scrape is the channel, and a
 * hand-stamped flag on a line nothing consumes is the shape R155 found six
 * copies of.
 */
export function recordThrottleRefusal(door: ThrottledDoor): void {
  refusals?.inc({ door });
}
