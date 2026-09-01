import type { Counter, MetricsRegistry } from '@n409/shared';

/**
 * What the directory connector's door is doing with what arrives at it.
 *
 * WHY THIS EXISTS (R337, methodology M11). `/scim/v2/*` is the third door onto
 * this platform whose whole authority is a shared secret held on two machines
 * neither of which tells the other when it changes — after the inbound webhooks
 * and the two SSO flows, both of which got this treatment in R329 for exactly
 * the same reason. It was the one left, and it is the one with the longest
 * silence:
 *
 *   * a SCIM token is rotated or revoked in the admin console, or the value in
 *     Okta / Entra / OneLogin is retyped wrong. `requireToken` answers 401 and
 *     writes nothing anywhere. Every create, every `PATCH active:false`, every
 *     `DELETE` is refused;
 *   * so an employee who left the firm on Monday keeps their account, their
 *     roles and — since R336 released assigned work at the same three doors —
 *     their engagements and review tasks. The one automated path that takes
 *     access away has stopped, and the platform's own answer to "is anything
 *     wrong" is a 401 counted in `http_requests_total`'s 4xx class beside every
 *     mistyped password on the estate.
 *
 * Nothing else can see it. `registerProblemHandler` and this route's own scoped
 * error handler both leave 4xx unlogged on purpose — right for a browser, wrong
 * for the one caller that is a machine and cannot tell anybody it is being
 * turned away — and there is no 4xx rule on this box at all. The IdP surfaces
 * the failure in *its* connector log, which is inside somebody else's tenant.
 *
 * DELIBERATELY NOT LABELLED BY TOKEN OR BY ROUTE. Which token failed is on the
 * log line and in `scim_tokens`; the label set here is bounded by construction
 * at one series per outcome, because the caller supplying the label values is
 * the open internet.
 */
let requests: Counter | null = null;

/**
 * What became of one request under `/scim/v2`.
 *
 * `unauthenticated` and `bad_token` are kept apart for the reason `unsigned`
 * and `bad_signature` are kept apart on the webhook door: they are different
 * incidents with opposite first moves. A request arriving with no `Bearer`
 * header at all is a stranger — this prefix faces the open internet — and is
 * nobody's emergency, so it must not be able to fire a page. A well-formed
 * bearer that does not verify is a secret mismatch, and the sender is almost
 * certainly the directory the firm is relying on.
 *
 * `accepted` is the denominator, recorded the moment the token verifies rather
 * than when the handler finishes: what this instrument answers is whether the
 * connector is getting *in*, and a 404 for an account it may not manage is the
 * guard working, not the door being shut.
 *
 * `rate_limited` is refused before the token is even read, so it cannot be
 * classified as either of the two above — and it is its own kind of silence: a
 * full resync of a large directory that crosses `SCIM_RATE_LIMIT` stops
 * provisioning just as completely as a wrong secret does, and answers 429 to a
 * connector whose retry the firm never sees.
 */
export type ScimOutcome = 'accepted' | 'unauthenticated' | 'bad_token' | 'rate_limited';

export function registerScimMetrics(registry: MetricsRegistry): void {
  requests = registry.counter(
    'scim_requests_total',
    'SCIM directory requests by outcome. outcome="bad_token" against a nonzero accepted count is a provisioning secret that has drifted — the directory is calling and every deprovision is being dropped.',
    ['outcome'],
  );
}

/** Test seam: drops the instrument so one suite's counts cannot leak into another. */
export function resetScimMetrics(): void {
  requests = null;
}

export function recordScimRequest(outcome: ScimOutcome): void {
  requests?.inc({ outcome });
}

/** A logger shaped like the one every route handler already holds. */
interface ScimLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Counts the refusal and, for the two that are ours rather than a stranger's,
 * says so in the log too.
 *
 * The metric is what a rule fires on; this line is what an operator reads once
 * it has. `unauthenticated` deliberately writes nothing — a bearer-guarded
 * endpoint on the public internet refusing a request with no bearer is the
 * endpoint working, and a scanner should not get to choose how much this box
 * logs. No `alert: true`: the alerting channel here is the scrape, and a
 * hand-stamped flag on a line nothing consumes is the shape R155 found six
 * copies of.
 */
export function refuseScimRequest(log: ScimLogger, outcome: Exclude<ScimOutcome, 'accepted'>): void {
  recordScimRequest(outcome);
  if (outcome === 'unauthenticated') return;
  log.warn(
    { source: 'scim', outcome },
    outcome === 'bad_token'
      ? 'SCIM request refused: the bearer token did not verify — the directory’s token and ours have drifted'
      : 'SCIM request refused: the directory is over the per-address rate limit and is being throttled',
  );
}
