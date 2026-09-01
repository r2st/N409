import type { FastifyRequest } from 'fastify';
import type { Counter, MetricsRegistry } from '@n409/shared';
import type { SsoRefusalCode } from '../auth/ssoRefusal.js';

/**
 * How the two identity-provider flows are going, as opposed to how they are
 * answered.
 *
 * WHY THIS EXISTS (R329, methodology M11). An SSO refusal is a *302*. R273
 * established that and gave it a log line, in as many words: "a refusal that
 * becomes a 302 is a 302 in the access log, indistinguishable from the
 * successful hand-off two lines below it". The half that was left is that the
 * log is not the alerting channel on this box — `infra/journald` is retention
 * and rate-limit configuration, nothing consumes a log field, and `/metrics` is
 * what a rule can be written against.
 *
 * So the failure mode is the one this estate keeps finding in other shapes: an
 * outage that produces successful-looking responses. An IdP signing certificate
 * expires, a firm's administrator narrows the allowed domain, the Google client
 * secret is rotated — and every single sign-in attempt is refused, as a 302,
 * counted by `http_requests_total` in the 3xx class alongside every ordinary
 * redirect on the platform. `HighServerErrorRate` sees nothing (no 5xx),
 * `SlowRequests` sees nothing, the circuit breakers see nothing (the IdP is not
 * one of ours). Nobody at that firm can sign in and every instrument on the box
 * reads green.
 *
 * `signed_in` is the denominator and is the reason this can be a rule rather
 * than a dashboard: one person hitting `domain_not_allowed` with a personal
 * address is Tuesday, and the same code on every attempt for half an hour is a
 * setting somebody changed. A bare refusal count cannot separate those, and the
 * number of sign-ins a deployment does per hour is not something a dashboard
 * holds.
 *
 * The outcome label is the refusal *code*, not a coarse `refused`, because the
 * codes divide into two groups an operator treats completely differently —
 * `assertion_rejected` and `provider_error` are the estate's or the IdP's
 * problem, `registration_closed` and `domain_not_allowed` are a policy working
 * as configured. `SSO_REFUSAL_CODES` is a fixed vocabulary of ten, so the
 * series set is bounded by construction: eleven outcomes across two flows.
 */
let outcomes: Counter | null = null;

/** Which door. Derived from the route rather than passed, so it cannot drift. */
export type SsoFlow = 'saml' | 'google';

/** The refusal codes, plus the one outcome that is not a refusal. */
export type SsoOutcome = SsoRefusalCode | 'signed_in';

export function registerSsoMetrics(registry: MetricsRegistry): void {
  outcomes = registry.counter(
    'sso_outcomes_total',
    'Single sign-on attempts by flow and outcome. Every refusal here is answered as a 302, so nothing in the HTTP metrics can tell an IdP outage from a successful hand-off.',
    ['flow', 'outcome'],
  );
}

/** Test seam: drops the instrument so one suite's counts cannot leak into another. */
export function resetSsoMetrics(): void {
  outcomes = null;
}

export function recordSsoOutcome(flow: SsoFlow, outcome: SsoOutcome): void {
  outcomes?.inc({ flow, outcome });
}

/**
 * The flow a request is part of, read off the matched route.
 *
 * Read rather than passed because `refuseSso` has seventeen call sites across
 * two files and an argument at each is an argument one of them gets wrong —
 * the same reasoning that put the sweep name in `scheduleSweep`. Both SAML
 * routes are mounted under `/api/v1/auth/saml`; everything else that refuses is
 * the Google callback.
 */
export function ssoFlowOf(req: FastifyRequest): SsoFlow {
  return (req.routeOptions?.url ?? req.url).includes('/auth/saml') ? 'saml' : 'google';
}
