import type { Counter, MetricsRegistry } from '@n409/shared';

/**
 * How the three OAuth connect flows are going, as opposed to how they are
 * answered.
 *
 * WHY THIS EXISTS (R341, methodology M11). An integration callback's every
 * outcome — the refusals included — is a *302*. `/api/v1/hris/callback`,
 * `/api/v1/accounting/callback` and `/api/v1/captable/callback` each build one
 * `back(result)` helper that redirects to the engagement's page with
 * `?hris=<result>`, and five results go through it: `connected`, and the four
 * ways a connection does not happen. Only two of the five leave a trace
 * anywhere. `connected` writes an audit event through `upsertConnection`;
 * `error` writes a `warn` for the token exchange. `denied`, `retired` and
 * `unauthorized` write nothing at all, on any of the three doors.
 *
 * This is the shape `ssoOutcomes.ts` next door was built for, one flow over,
 * and the argument transfers whole: a refusal answered as a redirect is counted
 * by `http_requests_total` in the 3xx class beside every ordinary navigation on
 * the platform. `HighServerErrorRate` sees nothing, `SlowRequests` sees
 * nothing, and the circuit breakers see nothing because the provider is not one
 * of ours. So a Rippling client secret rotated without this deployment, an OAuth
 * app whose redirect URI no longer matches, or a role migration that breaks
 * `isOps` refuses *every* connection attempt while every instrument on the box
 * reads green — and the only symptom is a query parameter in one person's
 * browser.
 *
 * `connected` is the denominator, and is what makes this a rule rather than a
 * dashboard: one person clicking Deny on a consent screen is Tuesday, and
 * nothing but `denied` for an afternoon is a configuration somebody changed.
 * A bare refusal count cannot separate those, and how many connections a
 * deployment makes per day is not something a dashboard holds.
 *
 * Bounded by construction: three families times five outcomes.
 */
let outcomes: Counter | null = null;

/**
 * Which connect flow. Three families, not the individual providers — `provider`
 * would be a second, wider label (five HRIS providers, three accounting, four
 * cap-table) for a question the family already answers, and the failures that
 * matter here are per-door: the retirement re-check, the actor re-check and the
 * `requireOps` asymmetry between them are all properties of the family.
 */
export type IntegrationFamily = 'hris' | 'accounting' | 'cap-table';

/**
 * What the callback did. The `back(result)` vocabulary verbatim, because the
 * five words are already what the page the user lands on reads, and a second
 * spelling here would be a second vocabulary for one thing.
 *
 * The three that were silent divide into two groups an operator treats
 * completely differently. `denied` is the provider's side saying no — the
 * person clicked Deny, or the OAuth app is misconfigured and the provider is
 * refusing before we are ever asked. `retired` and `unauthorized` are this
 * platform refusing on the far side of the hop: the engagement was withdrawn,
 * or the person who started it can no longer finish it. The second pair is a
 * security-relevant refusal of a stale thirty-minute token, and it left nothing
 * behind at all.
 */
export type IntegrationCallbackOutcome = 'connected' | 'denied' | 'retired' | 'unauthorized' | 'error';

export function registerIntegrationCallbackMetrics(registry: MetricsRegistry): void {
  outcomes = registry.counter(
    'integration_callback_outcomes_total',
    'OAuth connect callbacks by family and outcome. Every outcome here is answered as a 302, so nothing in the HTTP metrics can tell a refused connection from a completed one.',
    ['family', 'outcome'],
  );
}

/** Test seam: drops the instrument so one suite's counts cannot leak into another. */
export function resetIntegrationCallbackMetrics(): void {
  outcomes = null;
}

export function recordIntegrationCallbackOutcome(
  family: IntegrationFamily,
  outcome: IntegrationCallbackOutcome,
): void {
  outcomes?.inc({ family, outcome });
}
