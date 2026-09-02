import type { Counter, MetricsRegistry } from '@n409/shared';
import type { ApiTokenRefusal } from '../repos/apiTokens.js';

/**
 * What the API-key door is doing with the credentials presented to it.
 *
 * WHY THIS EXISTS (R345, methodology M11). This estate has now instrumented
 * every machine-facing door it has, one round at a time and each for the same
 * reason: the inbound webhooks and the two SSO flows in R329, the directory
 * connector in R337, the three OAuth connect callbacks in R341. The argument is
 * written out in full on `scimRequests.ts` and it is not different here —
 * `registerProblemHandler` leaves 4xx unlogged on purpose, which is right for a
 * browser and wrong for the one caller that is a machine and cannot tell
 * anybody it is being turned away.
 *
 * The partner API key is the door that was left, and it is the one the estate
 * itself calls "the door with no person behind it to notice"
 * (`ApiTokenRefusal.partner_retired`). A refused key is answered
 * `problems.unauthorized(...)` in `plugins/auth.ts` — one 401, no log line, no
 * event row, counted in `http_requests_total`'s 4xx class beside every mistyped
 * password on the estate. So a firm's integration stops dead and:
 *
 *   * the firm cannot see why. The console it would look in is behind the same
 *     key, and for `partner_retired` and `orphaned` that console is refused too;
 *   * and this side cannot see that it happened at all. R342 closed four doors
 *     an archived or suspended firm still had open, and three of the five
 *     refusal reasons the credential layer can now give are conditions *this
 *     platform caused*: an administrator archived the firm, moved the member who
 *     minted the key, or closed their account. Each is a deliberate act with a
 *     consequence — a running integration ends — that nobody was told about on
 *     either side of the wire.
 *
 * NOT AN ACCESS LOG. `identityAuditCensus.test.ts` settles the shape this is
 * allowed to take: `resolveApiTokenWithReason` is on the read path of every
 * authenticated API call, and "requiring an event for these would mean a row
 * per API request, which is not an audit trail — it is an access log, and the
 * service already has one". A counter is the instrument that answers the
 * question at that rate, and the log line below is written only for the
 * refusals, which are bounded by how often somebody's integration breaks.
 *
 * DELIBERATELY NOT LABELLED BY TOKEN OR BY PARTNER, the same choice
 * `scimRequests.ts` makes: one series per outcome, with the token and the firm
 * on the log line where an operator reads them. Six outcomes is the whole set,
 * and it is `ApiTokenRefusal` itself rather than a second spelling of it, so a
 * sixth refusal added to that union fails to compile here until it is given a
 * home.
 */
let attempts: Counter | null = null;

/**
 * What became of one presented API token.
 *
 * `accepted` is the denominator, and it is recorded where the credential
 * resolves rather than where the handler finishes: what this answers is whether
 * integrations are getting *in*. A 403 from a route's own scope check is that
 * guard working, not this door being shut.
 *
 * The refusals are `ApiTokenRefusal` unchanged. `unknown` is the stranger of
 * the set — a typo, a key from another environment, or the internet finding a
 * bearer endpoint — and is the one that must not be able to page anybody, for
 * the reason `unauthenticated` is kept apart from `bad_token` on the SCIM door.
 * The other four are all keys this platform issued and then stopped honouring.
 */
export type ApiTokenAuthOutcome = 'accepted' | ApiTokenRefusal;

/**
 * The refusals this platform causes, rather than ones the presenter caused.
 *
 * `revoked` is a deliberate act with a person behind it who knows they did it,
 * and `unknown` is a stranger. The three here are the ones where somebody
 * archived a firm, moved a member or closed an account, and a running
 * integration stopped as a side effect nobody was looking at. They are what
 * `PartnerIntegrationLockedOut` fires on.
 */
export const SELF_INFLICTED_REFUSALS: readonly ApiTokenRefusal[] = [
  'no_owner',
  'orphaned',
  'partner_retired',
];

export function registerApiTokenAuthMetrics(registry: MetricsRegistry): void {
  attempts = registry.counter(
    'api_token_auth_total',
    'API token authentications by outcome. outcome="partner_retired"/"orphaned"/"no_owner" is an integration this platform stopped honouring — archiving a firm, moving a member or closing an account ends a running integration, and the 401 that says so is invisible in the HTTP metrics.',
    ['outcome'],
  );
}

/** Test seam: drops the instrument so one suite's counts cannot leak into another. */
export function resetApiTokenAuthMetrics(): void {
  attempts = null;
}

export function recordApiTokenAuth(outcome: ApiTokenAuthOutcome): void {
  attempts?.inc({ outcome });
}

/** A logger shaped like the one every route handler already holds. */
interface ApiTokenLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Counts the refusal and, for the ones that are ours rather than a stranger's,
 * says which key and which firm in the log.
 *
 * The metric is what a rule fires on; this line is what an operator reads once
 * it has, and it is the half that answers "whose integration is down" — the
 * question the metric deliberately cannot answer, because a label per firm is a
 * series per firm.
 *
 * `unknown` writes nothing, for the reason SCIM's `unauthenticated` writes
 * nothing: a bearer-guarded API refusing a bearer it has never issued is the
 * API working, and a scanner must not get to choose how much this box logs. It
 * is still counted, because the *rate* of it is a signal even when no single
 * one is.
 *
 * No `alert: true`: the alerting channel here is the scrape, and a hand-stamped
 * flag on a line nothing consumes is the shape R155 found six copies of.
 */
export function refuseApiToken(
  log: ApiTokenLogger,
  refusal: ApiTokenRefusal,
  token: { tokenId: string | null; partnerId: string | null },
): void {
  recordApiTokenAuth(refusal);
  if (refusal === 'unknown') return;
  log.warn(
    {
      source: 'api-token',
      outcome: refusal,
      // Which key, and which firm's key. Neither is a metric label and both are
      // what the operator needs: `partner_retired` is remedied by un-archiving
      // one partner row, and there is no way to find out which one from a
      // counter.
      //
      // The correlation mixin's own spellings (`logger.ts`), not a second pair.
      // `partnerId` and `apiTokenId` are what every other line in this estate
      // carries these two facts under, so a filter for one firm's trouble finds
      // this line too — writing `partner_id` here would have hidden the refusal
      // from the exact query somebody runs to find it, which is the failure
      // this whole module exists against, one level down.
      //
      // Safe from the duplicate-key shape that note warns about: the mixin
      // emits these only from a bound actor, `bindActor` runs after the
      // credential resolves, and a refused request never reaches it. Even if it
      // did, pino's mixin merge is `Object.assign(mixin, obj)` and the call's
      // own object wins — the collision case is a *child logger binding*, which
      // neither of these is.
      apiTokenId: token.tokenId,
      partnerId: token.partnerId,
    },
    REFUSAL_LOG[refusal],
  );
}

/**
 * One line each, written for the person reading it at the point the alert
 * fires, and saying what was done rather than what was refused — the refusal is
 * the `outcome` field beside it.
 */
const REFUSAL_LOG: Record<ApiTokenRefusal, string> = {
  unknown: 'API token refused: not recognised',
  revoked: 'API token refused: it was revoked, and the integration using it is now failing every call',
  no_owner:
    'API token refused: the account that minted it has been closed, so this integration has stopped — it needs a replacement key under a current user',
  orphaned:
    'API token refused: the member who minted it has left the organization it acts for, so this integration has stopped',
  partner_retired:
    'API token refused: the organization it acts for is archived, so every key it holds is refused — un-archiving the partner restores them',
};
