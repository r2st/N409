import type { Counter, MetricsRegistry } from '@n409/shared';

/**
 * What the partner API's own gate refuses, after the credential has resolved.
 *
 * WHY THIS EXISTS (R376, methodology M11). `apiTokenAuth.ts` instrumented the
 * *credential* layer — the five ways `resolveApiTokenWithReason` declines a key
 * — and R345 and R346 both closed with the same open item beside it: the gate a
 * layer above it refuses on its own account and counts none of it. The gate is
 * `apiKeyGuard` in `routes/partnerApi.ts`, and by construction everything it
 * refuses is a key this platform issued and still honours, presented to a
 * surface it is not allowed onto or faster than it is allowed to be.
 *
 * Its own instrument rather than more `outcome` values on `api_token_auth_total`,
 * which is the call R345 declined to make. That counter's population is *every
 * presented token* and `accepted` is its denominator; these refusals happen on
 * the partner routes only, so folding them in would put a numerator over a
 * denominator that counts the whole estate's API traffic and make both numbers
 * mean less than they do apart. Refusals-only and no denominator, the shape
 * `realtime_stream_refusals_total` already uses here.
 *
 * The one that matters most is `account_suspended` (R342). Suspending a firm's
 * administrator now reaches their API key, which is right — and it ends a
 * running integration as a side effect of an unrelated administrative act, with
 * a 403 that `registerProblemHandler` leaves unlogged by design. The partner
 * sees every call fail; this side saw one more 4xx in `http_requests_total`,
 * beside every mistyped path on the platform.
 *
 * Not labelled by partner or by key, the same choice `apiTokenAuth.ts` and
 * `scimRequests.ts` make for the same reason: a label per firm is a series per
 * firm. The log line below carries both, for the operator who reads it once a
 * rule has fired.
 */
export type PartnerApiRefusal =
  /** A browser session bearer sent to a partner route. */
  | 'session_token'
  /** A personal token: no partner to scope by, so every route below would over-match. */
  | 'personal_token'
  /** The account the key acts as is suspended (R342). */
  | 'account_suspended'
  /** This key's own budget is spent. */
  | 'key_rate_limited'
  /** The firm's budget across all of its keys is spent. */
  | 'partner_rate_limited';

let refusals: Counter | null = null;

export function registerPartnerApiGuardMetrics(registry: MetricsRegistry): void {
  refusals = registry.counter(
    'partner_api_refusals_total',
    'Partner API requests refused by the gate above the credential layer. reason="account_suspended" is a running integration this platform stopped as a side effect of suspending an account; the two rate_limited reasons are a partner at its ceiling.',
    ['reason'],
  );
}

/** Test seam: drops the instrument so one suite's counts cannot leak into another. */
export function resetPartnerApiGuardMetrics(): void {
  refusals = null;
}

/** A logger shaped like the one every route handler already holds. */
interface GuardLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Count one refusal, and say whose integration stopped when that is the answer.
 *
 * Only `account_suspended` is logged, and the split is the same one
 * `refuseApiToken` makes between a condition this platform caused and one the
 * caller did. A session bearer or a personal token on a partner route is an
 * integrator pointing a client at the wrong door — their mistake, visible to
 * them in the 403 body, which names exactly what the surface wants. The two
 * throttles answer with the ceiling and the reset in headers and in the problem
 * detail, so the caller already knows; the rate is the part only this side can
 * see, and that is what the counter is for.
 *
 * `account_suspended` is neither. Nobody at the firm did anything: an
 * administrator here suspended a seat, and a key that has nothing to do with
 * that seat's browsing stopped working. The line names the key, the firm and
 * the account, because the remedy is one DELETE against a role row and there is
 * no way to find which one from a counter.
 *
 * No `alert: true`: the alerting channel here is the scrape, and R376's
 * `log_alert_lines_total` counts that field for failures nothing will retry —
 * which this is not. Lifting the suspension resumes the key on its own.
 */
export function refusePartnerApiRequest(
  log: GuardLogger,
  reason: PartnerApiRefusal,
  token?: { tokenId: string | null; partnerId: string | null; userId: string | null },
): void {
  refusals?.inc({ reason });
  if (reason !== 'account_suspended' || !token) return;
  log.warn(
    {
      source: 'partner-api',
      outcome: reason,
      // The correlation mixin's own spellings, for the reason `refuseApiToken`
      // spells out: a filter for one firm's trouble has to find this line too.
      apiTokenId: token.tokenId,
      partnerId: token.partnerId,
      userId: token.userId,
    },
    'partner API key refused: the account it acts as is suspended, so this integration has stopped until the suspension is lifted',
  );
}
