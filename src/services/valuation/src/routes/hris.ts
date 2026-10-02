import type { FastifyInstance } from 'fastify';
import { stoppedEngagementReason } from '../domain/operations.js';
import type pg from 'pg';
import pLimit from 'p-limit';
import { z } from 'zod';
import { ApiProblem, isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { signHrisState, verifyHrisState, type JwtConfig } from '../auth/jwt.js';
import {
  HRIS_PROVIDERS,
  HRIS_PROVIDER_LABELS,
  authorizeUrl,
  exchangeCode,
  fetchRosterAndGrants,
  refreshTokens,
  type FetchFn,
  type HrisProvider,
  type ProviderCredentials,
  type RejectedGrant,
} from '../clients/hris.js';
import {
  existingGrantExternalIds,
  findConnection,
  findDueConnections,
  listConnections,
  recordSync,
  recordSyncError,
  revokeConnection,
  setSyncFrequency,
  toPublic,
  updateTokens,
  upsertConnection,
  type HrisConnectionRow,
} from '../repos/hrisConnections.js';
import {
  describeConnectorFailure,
  IntegrationError,
  ReconnectRequiredError,
  retryAfterSecondsFor,
} from '../clients/deadline.js';
import { isUniqueViolation } from '../db/pgError.js';
import { storeRefreshedTokens, tokenNeedsRefresh } from '../clients/oauthRefresh.js';
import { createGrant } from '../repos/grants.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';
import { isRetiredNow, refuseIfRetired, refuseIfRetiredNow } from '../domain/retiredEngagement.js';
import { integrationActorStillAuthorized } from '../domain/integrationActor.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { CONNECTOR_PANELS, notConnected } from '../domain/connectorRefusal.js';
import { integrationCallbackRefusal } from '../domain/oauthCallbackRefusal.js';
import {
  logConnectorSyncFailure,
  logConnectorSyncRecovered,
  logSyncBookkeepingFailure,
  logSyncOutcomeSuperseded,
  type ConnectorLogger,
  type ConnectorScanTally,
} from '../domain/connectorSyncLog.js';
import {
  recordIntegrationCallbackOutcome,
  type IntegrationCallbackOutcome,
} from '../observability/integrationCallbacks.js';

/**
 * HRIS / payroll integration for ASC 718 (feature 11). OAuth2 connect + pull of
 * the employee roster and equity grants from Rippling / Gusto / Deel straight
 * into ASC 718 grant management (option_grants). Follows the cap-table sync
 * pattern; grants are idempotent on their provider external_id, so re-syncing
 * doesn't duplicate. Reuses the generic captable-state signer for the OAuth
 * round-trip (same {valuation, provider, user} shape).
 */

export interface HrisDeps {
  pool: pg.Pool;
  jwt: JwtConfig;
  publicBaseUrl: string;
  credentials: Partial<Record<HrisProvider, ProviderCredentials>>;
  fetchFn?: FetchFn;
}

function parseProvider(value: string): HrisProvider {
  if (!(HRIS_PROVIDERS as readonly string[]).includes(value)) throw problems.notFound();
  return value as HrisProvider;
}

const providerUnavailable = (provider: HrisProvider) =>
  new ApiProblem({
    status: 503,
    title: 'Integration not configured',
    type: 'urn:n409:problem:hris-unavailable',
    detail: `${HRIS_PROVIDER_LABELS[provider]} is not configured on this deployment`,
  });

const FrequencyBody = z.object({ frequency: z.enum(['manual', 'daily', 'weekly']) }).strict();

/**
 * Query string of the OAuth callback. Unknown keys are stripped rather than
 * rejected — providers append their own (`scope`, `session_state`) and a strict
 * schema would fail real callbacks. What this does buy is a bound on every
 * field we go on to use: `state` and `code` before they are verified and spent,
 * and `company_id` before it is written to
 * `hris_connections.external_company_id`. A repeated parameter arrives from
 * Fastify as an array, which the string schema refuses outright.
 */
const CallbackQuery = z.object({
  state: z.string().max(4096).optional(),
  code: z.string().max(4096).optional(),
  error: z.string().max(256).optional(),
  company_id: z.string().max(128).optional(),
});

export interface HrisSyncOutcome {
  roster_count: number;
  grants_found: number;
  grants_created: number;
  grants_skipped: number;
  /**
   * Grants the provider sent that this platform will not store — a strike
   * price below zero, an options count past `integer`, an external id longer
   * than the unique index can hold, a NUL in a text field.
   *
   * Reported rather than silently absent, for the reason every other cap in
   * this estate is reported: `mapEmployees` drops these so that one malformed
   * record cannot end the whole import, and a drop nobody is told about is a
   * roster that reads as complete. `grants_found` counts what could be mapped,
   * so `found + rejected` is what the provider actually sent.
   */
  grants_rejected: number;
  /**
   * Which of them, and why — a prefix, capped in `clients/hris.ts`. `grants_
   * rejected` alone names a count and not a record; a roster of hundreds is
   * not a population an analyst can scan by eye looking for the handful that
   * came up short, and "check the record in the provider" with nothing to
   * search for is not something a person can act on.
   */
  grants_rejected_detail: RejectedGrant[];
  /** True when `grants_rejected` is larger than `grants_rejected_detail.length`. */
  grants_rejected_detail_truncated: boolean;
  external_company_name: string | null;
}

/**
 * The access token to present to the provider, renewed first if it is spent.
 *
 * The connection row has carried a `refresh_token` and a `token_expires_at`
 * since the feature shipped and nothing read either one, so a connection
 * worked for exactly as long as its first access token did. What happened next
 * was not a visible break: the pull came back `401`, `describeTransportFailure`
 * wrote "Gusto roster fetch failed (401)" to `last_error`, `recordSyncError`
 * moved the connection to `error` — and `findDueConnections` only returns
 * `connected` rows, so the schedule stopped there and stayed stopped. The card
 * shows an error against a `last_synced_at` that quietly recedes, and the ASC
 * 718 roster behind it goes stale while the credential that would have renewed
 * it sits unread in the next column.
 *
 * Refreshed proactively rather than on the 401, because the 401 is not
 * self-describing: a provider answers it for an expired token, a revoked app
 * and a token belonging to a company the connection can no longer read, and
 * `token_expires_at` is the one of those we were told about at connect time.
 *
 * Three ways this declines to refresh, each falling through to the stored
 * token so the provider gets to give the real answer:
 *   - the provider never told us an expiry (`token_expires_at IS NULL`);
 *   - it gave us no refresh token to spend;
 *   - this deployment has no client credentials for the provider, which is a
 *     configuration fact rather than something about this connection.
 */
async function accessTokenFor(
  deps: {
    pool: pg.Pool;
    fetchFn: FetchFn;
    credentials?: Partial<Record<HrisProvider, ProviderCredentials>>;
    log?: ConnectorLogger;
  },
  connection: HrisConnectionRow,
): Promise<string> {
  if (!tokenNeedsRefresh(connection.token_expires_at)) return connection.access_token;
  const creds = deps.credentials?.[connection.provider];
  if (!creds || !connection.refresh_token) return connection.access_token;
  const refreshed = await refreshTokens(connection.provider, creds, connection.refresh_token, deps.fetchFn);
  // Not a bare `await updateTokens(...)`: the exchange above may have retired
  // the refresh token in the row, so a rejection here loses the only live
  // credential the connection has. See `storeRefreshedTokens`.
  await storeRefreshedTokens(refreshed, (tokens) => updateTokens(deps.pool, connection, tokens), {
    log: deps.log,
    connectionId: connection.id,
    provider: connection.provider,
    family: 'hris',
  });
  return refreshed.accessToken;
}

/**
 * What the connection says when the failure was not the provider's.
 *
 * Deliberately says where to look rather than what happened: the message an
 * analyst needs is one nothing vouched for, so it goes to the log line beside
 * this write, which both callers already emit with `err` intact.
 */
const OUR_SYNC_FAILURE =
  'the sync could not be completed, and the reason was not the provider — it is in the service log';

/**
 * What the connection says when the pull worked and the bookkeeping did not.
 *
 * Deliberately says the import stands: the grants are written and a re-run
 * skips them, so the thing to act on is the connection, not the roster.
 */
const SYNC_UNRECORDED =
  'the roster was imported, but the result could not be recorded against this connection — the next ' +
  'scheduled sync will pick up where this one left off';

/**
 * Pull the roster + grants and create any grants not already imported. Shared
 * by the pull route and the scheduler. Records success/error on the connection.
 */
export async function syncHrisConnection(
  deps: {
    pool: pg.Pool;
    fetchFn: FetchFn;
    credentials?: Partial<Record<HrisProvider, ProviderCredentials>>;
    /**
     * Where a *bookkeeping* failure goes. The pull's own failure is logged by
     * both callers, which hold the request or the sweep's logger; the three
     * best-effort `recordSyncError` writes below are inside this function and
     * had nowhere to report to at all. See `logSyncBookkeepingFailure`.
     */
    log?: ConnectorLogger;
  },
  connection: HrisConnectionRow,
  opts: { actorId: string },
): Promise<HrisSyncOutcome> {
  let pull;
  try {
    const accessToken = await accessTokenFor(deps, connection);
    pull = await fetchRosterAndGrants(
      connection.provider,
      {
        accessToken,
        externalCompanyId: connection.external_company_id,
        externalCompanyName: connection.external_company_name,
      },
      deps.fetchFn,
    );
  } catch (err) {
    // `terminal` is the difference between a provider that is briefly unwell
    // and an authorisation that has ended: the first is worth another tick on
    // a backoff, the second will be refused identically forever and its
    // message asks for a reconnect instead.
    // Only a message something vouched for. The guarded block above is no
    // longer a provider call alone: `accessTokenFor` renews a spent token and
    // then *writes it back*, so a Postgres error can reach here and
    // `describeTransportFailure` would put the driver's wording — constraint
    // names, column names, refused values — into the column `toPublic` serves
    // the client verbatim. See `describeConnectorFailure`.
    await recordSyncError(deps.pool, connection, describeConnectorFailure(err, OUR_SYNC_FAILURE), {
      terminal: err instanceof ReconnectRequiredError,
      // When the provider named a time, the schedule waits at least that long
      // — the sentence has said "try again in about 120s" since R255 while the
      // sweep came back in fifteen minutes regardless.
      retryAfterSeconds: retryAfterSecondsFor(err),
    }).catch((bookErr: unknown) => {
      if (deps.log)
        logSyncBookkeepingFailure(
          deps.log,
          bookErr,
          {
            family: 'hris',
            provider: connection.provider,
            connectionId: connection.id,
            valuationId: connection.valuation_id,
          },
          'provider fetch failed',
        );
    });
    throw err;
  }

  /*
   * The engagement, asked again on the way back (R308, methodology M5).
   *
   * `refuseIfRetired` runs on the route above, and both doors into this
   * function then leave the process for as long as the pull takes —
   * `PAGED_PULL_BUDGET_MS` allows two minutes, and the sweep's own tick allows
   * four of these at once. `staleEngagementWriteCensus` states the rule for
   * every handler that spends an engine or an AI round trip before it writes,
   * and the reason it could not state it here is that it matches `postJson`:
   * a connector pull is the same gap through a different door, and a longer
   * one than any engine call.
   *
   * The sweep's due query already excludes an archived engagement
   * (`findDueConnections`), which is the same "a list that stops offering
   * something is not a write that refuses it" the helper's own header is about:
   * the row was live when the tick picked it up.
   *
   * Before the apply rather than inside it, so the partial-import bookkeeping
   * below keeps describing an import that was attempted. Nothing has been
   * written at this point, so there is nothing to record on the connection
   * either — a `409` is the whole answer, and restoring the engagement makes
   * the next pull work.
   */
  await refuseIfRetiredNow(deps.pool, connection.valuation_id, 'importing grants');

  const actor: EventActor = {
    actorType: 'system',
    actorId: `hris-sync:${connection.provider}`,
    source: 'hris_sync',
  };
  let created = 0;
  let skipped = 0;
  try {
    // Inside the guard, not above it (R261, M5). R186 put a catch around the
    // insert loop for the reason spelled out below, and left the dedupe read
    // three lines above it — a Postgres query, on a pool that is exactly as
    // able to time out here as it is one statement later. A throw from it
    // escaped both bookkeeping writes and left the state R186 exists to
    // remove: `connected`, a due date in the past, and the provider's whole
    // roster re-pulled every fifteen minutes behind a card reading healthy.
    const seen = await existingGrantExternalIds(
      deps.pool,
      connection.valuation_id,
      pull.grants.map((g) => g.external_id),
    );
    for (const g of pull.grants) {
      if (seen.has(g.external_id)) {
        skipped++;
        continue;
      }
      try {
        await createGrant(
          deps.pool,
          {
            valuationId: connection.valuation_id,
            granteeName: g.grantee_name,
            granteeEmail: g.grantee_email,
            grantDate: g.grant_date,
            optionsCount: g.options_count,
            exercisePrice: g.exercise_price,
            currency: 'USD',
            vestingTemplate: 'imported',
            vestingStartDate: g.vesting_start_date,
            vestingMonths: g.vesting_months,
            cliffMonths: g.cliff_months,
            frequencyMonths: g.frequency_months,
            createdBy: opts.actorId,
            source: `hris:${connection.provider}`,
            externalId: g.external_id,
          },
          actor,
        );
        created++;
        seen.add(g.external_id);
      } catch (err) {
        /*
         * The grant somebody else imported while this pull was in flight
         * (R261, methodology M5).
         *
         * `seen` is a snapshot taken before the loop, and it is the only thing
         * standing between two concurrent syncs of one connection. Two doors
         * reach this function — the scheduler's fifteen-minute tick and the
         * analyst's Import button — with no lock between them, and pressing
         * Import while a scheduled pull is running is the ordinary way to
         * arrive here, not an exotic one.
         *
         * What happened then was that the loser of the race hit
         * `option_grants_external_idx`, and a unique violation is not one of
         * the failures the catch below is for: it threw past the rest of the
         * roster, moved a healthy connection to `error` on a backoff, and told
         * the analyst their import "stopped before finishing" — for a grant
         * that had just been imported successfully by the other door.
         *
         * `external_id` is this import's idempotency key; the index is the
         * authoritative answer to the question `seen` was asked, one moment
         * later. So the row already existing means already imported, which is
         * what `skipped` counts. Narrowed to that one index, because any other
         * unique violation on this table is a real refusal.
         */
        if (!isUniqueViolation(err, 'option_grants_external_idx')) throw err;
        skipped++;
        seen.add(g.external_id);
      }
    }
  } catch (err) {
    /*
     * An import that stops partway (round 186, methodology M5).
     *
     * The fetch above is guarded and the whole-connection outcome below is
     * recorded, but the loop between them was neither, and it is the longest
     * part of the operation: one INSERT and one audit event per grant, against
     * a roster that can be hundreds. One row refused — a constraint, a
     * retired engagement, a pool that ran out mid-import — threw straight past
     * both bookkeeping writes.
     *
     * What that left is the state this round exists to remove. The grants
     * already written stay written, which is right: they are real, and
     * `external_id` makes a re-run skip them. What is not right is the
     * connection, which keeps `status = 'connected'`, keeps whatever
     * `last_error` it had (usually none), and — because `recordSync` is the
     * only thing that moves `next_sync_at` — keeps a due date in the past. So
     * `findDueConnections` picks the same connection up on *every* 15-minute
     * tick, re-pulling the provider's whole roster each time, and the only
     * trace of any of it is a `warn` in the scheduler. On screen the connection
     * reads as healthy and last synced whenever it last succeeded.
     *
     * Recording the failure fixes both halves at once: `status = 'error'` takes
     * the connection out of the due query, so the re-pull stops, and the
     * message is on the row the client is looking at. Best-effort, like the
     * fetch handler above it: if this write is what is failing, the original
     * error is the more useful one to raise.
     */
    // How far it got, and not a word of the driver's. `last_error` is returned
    // verbatim by `toPublic`, so it is subject to the rule `errorBodyDisclosure`
    // states for every field that reaches a person: an error's own wording is
    // publishable only when something vouched for it, and what fails here is
    // Postgres refusing a row — constraint names, column names and the values
    // it rejected. The count is the part a person can act on; the throw itself
    // is logged in full by both callers.
    await recordSyncError(
      deps.pool,
      connection,
      `imported ${created} of ${pull.grants.length - skipped} grants, then stopped before finishing`,
    ).catch((bookErr: unknown) => {
      if (deps.log)
        logSyncBookkeepingFailure(
          deps.log,
          bookErr,
          {
            family: 'hris',
            provider: connection.provider,
            connectionId: connection.id,
            valuationId: connection.valuation_id,
          },
          'import stopped partway',
        );
    });
    throw err;
  }

  const outcome: HrisSyncOutcome = {
    roster_count: pull.roster.length,
    grants_found: pull.grants.length,
    grants_created: created,
    grants_skipped: skipped,
    grants_rejected: pull.rejected,
    grants_rejected_detail: pull.rejectedDetail,
    grants_rejected_detail_truncated: pull.rejectedDetailTruncated,
    external_company_name: pull.external_company_name,
  };
  try {
    const landed = await recordSync(deps.pool, connection, { ...outcome, provider: connection.provider });
    if (!landed && deps.log) {
      logSyncOutcomeSuperseded(deps.log, {
        family: 'hris',
        provider: connection.provider,
        connectionId: connection.id,
        valuationId: connection.valuation_id,
      });
    }
  } catch (err) {
    /*
     * The last unguarded statement in the sync (R261, M5).
     *
     * `recordSync` is the only thing that moves `next_sync_at`, so a throw
     * from it leaves precisely the state R186 wrote the two catches above to
     * remove — `connected`, a due date already in the past — except reached
     * from a *success*, which is why nothing noticed it. `findDueConnections`
     * then re-pulls the provider's whole roster every fifteen minutes,
     * forever, behind a card that reads healthy and a `last_synced_at` from
     * whenever the last write did land.
     *
     * Not hypothetical: this statement writes `last_sync_summary` as `jsonb`,
     * and the driver *refuses* a jsonb value carrying a NUL or a lone
     * surrogate (`domain/nulBytes.ts`). R259 stopped provider text reaching it
     * unchecked; the shape stays open for anything else that can make one
     * UPDATE fail.
     *
     * Recorded rather than swallowed. The import really did happen and the
     * grants are written — `external_id` makes the re-run skip them — but the
     * connection's own bookkeeping did not, and an errored row on a backoff is
     * the honest version of that: it stops the re-pull, and it is in front of
     * the person who can look. Best-effort, like every write in a catch here.
     */
    await recordSyncError(deps.pool, connection, SYNC_UNRECORDED).catch((bookErr: unknown) => {
      if (deps.log)
        logSyncBookkeepingFailure(
          deps.log,
          bookErr,
          {
            family: 'hris',
            provider: connection.provider,
            connectionId: connection.id,
            valuationId: connection.valuation_id,
          },
          'sync succeeded',
        );
    });
    throw err;
  }
  return outcome;
}

export async function runDueHrisSyncs(deps: {
  pool: pg.Pool;
  fetchFn?: FetchFn;
  /**
   * The same OAuth client credentials the routes hold. Without them the sweep
   * cannot renew an expired token, which is the failure this whole path exists
   * to survive — so the scheduler passes them in rather than the sweep
   * silently doing less than the manual pull beside it.
   */
  credentials?: Partial<Record<HrisProvider, ProviderCredentials>>;
  log?: ConnectorLogger;
}): Promise<ConnectorScanTally> {
  const fetchFn = deps.fetchFn ?? fetch;
  const due = await findDueConnections(deps.pool);
  // Bounded concurrency (P2-7): connections are independent, so run up to 4 in
  // parallel rather than strictly serially — capped to avoid hammering the
  // providers' APIs and the DB pool. A failing connection is logged and counted
  // as unprocessed without aborting the others.
  const limit = pLimit(4);
  const results = await Promise.all(
    due.map((connection) =>
      limit(async () => {
        try {
          await syncHrisConnection(
            { pool: deps.pool, fetchFn, credentials: deps.credentials, log: deps.log },
            connection,
            { actorId: connection.connected_by ?? connection.id },
          );
          // A connection the backoff brought back. Read off the row this tick
          // started from, because `recordSync` has just cleared it.
          if (deps.log) {
            logConnectorSyncRecovered(deps.log, {
              family: 'hris',
              provider: connection.provider,
              connectionId: connection.id,
              valuationId: connection.valuation_id,
              priorFailures: connection.sync_failures,
            });
          }
          return true;
        } catch (err) {
          if (deps.log) {
            logConnectorSyncFailure(
              deps.log,
              err,
              {
                family: 'hris',
                provider: connection.provider,
                connectionId: connection.id,
                valuationId: connection.valuation_id,
                priorFailures: connection.sync_failures,
              },
              { scheduled: true },
            );
          }
          return false;
        }
      }),
    ),
  );
  const synced = results.filter(Boolean).length;
  // All three, not just the successes. See `ConnectorScanTally`: a scan whose
  // every connection failed returned `0` here, which is what a scan with
  // nothing due returns, so both the `info` line gated on it and every
  // instrument built off this tick read a total provider outage as an idle
  // schedule.
  return { due: due.length, synced, failed: due.length - synced };
}

export function registerHrisRoutes(app: FastifyInstance, deps: HrisDeps): void {
  const fetchFn = deps.fetchFn ?? fetch;
  const redirectUri = `${deps.publicBaseUrl.replace(/\/$/, '')}/api/v1/hris/callback`;

  const loadAuthorized = async (principal: Principal, id: string): Promise<ValuationRow> => {
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (
      !valuation ||
      !canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })
    ) {
      throw problems.notFound();
    }
    return valuation;
  };
  // Importing grants is analyst work (ASC 718 management is ops-only).
  const requireOps = (principal: Principal) => {
    if (!isOps(principal)) throw problems.forbidden('HRIS import is operations-only');
  };

  app.get('/api/v1/valuations/:id/hris', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadAuthorized(principal, id);
    const connections = await listConnections(deps.pool, valuation.id);
    const byProvider = new Map(connections.map((c) => [c.provider, c]));
    /*
     * Whether the schedule this card describes will actually run (R401,
     * methodology M11).
     *
     * R400 dropped retired and closed engagements out of `findDueConnections`,
     * and did it there rather than by disabling the connection, because a close
     * is reversible: restore the engagement and the schedule picks up where it
     * was. The consequence is that the row keeps saying `connected`, keeps its
     * cadence, and keeps a `next_sync_at` that stops advancing — and this
     * endpoint hands all three to a card that reads 'Connected · syncs daily'.
     *
     * Nothing else on the page contradicts it: the workspace's retired banner
     * is gated on `archived_at`, so a called-off engagement carries no banner
     * at all, and the only outward sign is a next-sync date drifting into the
     * past on a panel that never says why. An analyst reading the card believes
     * the cap table in front of them is being kept current by the provider.
     *
     * Reported, not disabled — the same reversibility argument the filter
     * makes — and asked of the shared predicate so this cannot come to disagree
     * with the sweep's own WHERE clause.
     */
    const stopped = stoppedEngagementReason(valuation);
    return {
      scheduled: stopped === null,
      // Named only when it is not: a live engagement has no reason, and a null
      // field invites a caller to render one.
      ...(stopped === null ? {} : { unscheduled_reason: stopped }),
      providers: HRIS_PROVIDERS.map((provider) => ({
        provider,
        label: HRIS_PROVIDER_LABELS[provider],
        configured: Boolean(deps.credentials[provider]),
        connection: byProvider.has(provider) ? toPublic(byProvider.get(provider)!) : null,
      })),
    };
  });

  app.post('/api/v1/valuations/:id/hris/:provider/connect', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id, provider: rawProvider } = req.params as { id: string; provider: string };
    const provider = parseProvider(rawProvider);
    const valuation = await loadAuthorized(principal, id);
    refuseIfRetired(valuation, 'accepting integration changes');
    const creds = deps.credentials[provider];
    if (!creds) throw providerUnavailable(provider);
    const state = await signHrisState(
      { valuationId: valuation.id, provider, userId: principal.id },
      deps.jwt,
    );
    return { authorize_url: authorizeUrl(provider, creds, redirectUri, state) };
  });

  app.get('/api/v1/hris/callback', async (req, reply) => {
    const parsedQuery = CallbackQuery.safeParse(req.query);
    if (!parsedQuery.success) {
      throw invalidQuery(parsedQuery.error, 'Invalid callback parameters');
    }
    const q = parsedQuery.data;
    if (!q.state) throw problems.badRequest(integrationCallbackRefusal('hris'));
    let state;
    try {
      state = await verifyHrisState(q.state, deps.jwt);
    } catch {
      throw problems.unprocessable(integrationCallbackRefusal('hris'));
    }
    const provider = parseProvider(state.provider);
    /*
     * Recorded inside `back` rather than at the five call sites (R341,
     * methodology M11). Every outcome of this handler, refusals included, is a
     * 302 — counted in `http_requests_total`'s 3xx class beside every ordinary
     * navigation — and three of the five wrote nothing anywhere at all. See
     * `observability/integrationCallbacks.ts`. Here rather than beside each
     * `return` for the reason `scheduleSweep` takes its name once: a recorder
     * per call site is a recorder one call site is later added without.
     */
    const back = (result: IntegrationCallbackOutcome) => {
      recordIntegrationCallbackOutcome('hris', result);
      return reply.redirect(
        `${deps.publicBaseUrl.replace(/\/$/, '')}/valuations/${state.valuationId}/grants?hris=${result}&provider=${provider}`,
      );
    };
    if (q.error || !q.code) return back('denied');

    /*
     * The retirement question, asked again on the far side of the hop.
     *
     * `/connect` refuses to start this on a withdrawn engagement, and every
     * other write in this file re-asks (`refuseIfRetiredNow` in the pull, the
     * `archived_at IS NULL` join in `findDueConnections`). The callback was the
     * one door that asked nobody. Its window is not a millisecond either: the
     * signed state lives 30 minutes and the thing it has to survive is a person
     * reading a provider's consent screen, so a firm withdrawing the engagement
     * between Connect and Allow is the ordinary case — it is exactly the length
     * of time in which a decision about a file gets made.
     *
     * `retiredEngagementWrites.test.ts` structurally could not see this: the
     * census drives the routes under `/api/v1/valuations/:id/…`, and a callback
     * names its engagement in a signed token instead. Same blind spot the
     * subject-id writes of R279/R282 fell into.
     *
     * What it wrote was not nothing. `upsertConnection` stores the provider's
     * access *and refresh* tokens for a client whose work the firm has closed,
     * records a `connected` event against the withdrawn file, and — because a
     * retirement is reversible (R90) and `findDueConnections` skips rather than
     * disables — arms a schedule that starts pulling the client's data the
     * moment an admin restores the engagement.
     *
     * Before the exchange, not after, for the reason `findDueConnections` gives
     * for filtering in the query: spending the code is itself telling a third
     * party we are working a file the firm has withdrawn, and it mints a
     * refresh token that then has to be disposed of. Nothing is connected and
     * nothing is granted.
     *
     * A redirect, not a 409. This handler is a browser navigation with no
     * session; `back()` is how its every other refusal answers, and the reader
     * has to land somewhere they can read the reason.
     */
    if (await isRetiredNow(deps.pool, state.valuationId)) {
      // The counter inside `back` is what a rule reads; this is the half a
      // person needs once it has fired. A refusal here names an engagement the
      // firm withdrew while somebody was on a provider's consent screen, and
      // until R341 the only record of it anywhere was a query parameter in that
      // person's browser.
      req.log.warn(
        { provider, valuationId: state.valuationId, userId: state.userId },
        'integration callback refused: the engagement was withdrawn during the OAuth hop',
      );
      return back('retired');
    }
    /*
     * And whether the person who started the hop may still finish it.
     *
     * The check above re-asks about the engagement; this one re-asks about the
     * actor, and it is the same argument applied to the other half of the
     * token. See `integrationActorStillAuthorized`: a callback carries no
     * session, its whole authority is a thirty-minute JWT that nothing can
     * withdraw, and every way an operator's access can end in that window —
     * closed, suspended, the ops role taken away, the partner scope changed —
     * left the connection completing anyway, with a third party's refresh token
     * stored and a standing pull armed in the name of an account that can no
     * longer open the file.
     *
     * `'ops'`, and it is the only one of the three callbacks that passes it:
     * `/connect` here calls `requireOps` where accounting and cap-table sync do
     * not, because what this connects pulls a client's employee roster and
     * payroll. Until R340 the re-check asked `canReadValuation` on all three,
     * so on this door the one case it did not close was the demotion.
     */
    if (!(await integrationActorStillAuthorized(deps.pool, state.userId, state.valuationId, 'ops'))) {
      // Same argument as the retirement line above, with a stronger case for
      // it: this is a thirty-minute token presented by somebody whose access
      // ended inside those thirty minutes — closed, suspended, demoted, or
      // moved out of a partner's scope. A security-relevant refusal of a stale
      // credential, and it wrote nothing anywhere.
      req.log.warn(
        { provider, valuationId: state.valuationId, userId: state.userId },
        'integration callback refused: the actor may no longer complete this connection',
      );
      return back('unauthorized');
    }

    const creds = deps.credentials[provider];
    if (!creds) throw providerUnavailable(provider);
    /*
     * The exchange and the store, in separate guards (R382, methodology M5).
     *
     * One `try` used to hold both, so every failure answered `back('error')`
     * under a line reading "'HRIS token exchange failed'" — and after the exchange has
     * returned, that sentence names the half that worked. The two are not the
     * same incident. A failed exchange leaves nothing anywhere. A failed store
     * leaves an access token and a refresh token minted at the provider against
     * this deployment's OAuth app — standing access to the client's employee roster and payroll
     * — which nothing here recorded, so nothing here can spend it and nothing
     * here can revoke it.
     *
     * What the reader was told about that is the part that decided this:
     * `describeCallbackOutcome`'s `error` sentence is "nothing was connected —
     * press Connect to try again", and its module header states the reasoning
     * out loud ("a failed exchange stored nothing"). It was true of the
     * exchange and false of the store, on the one page whose whole job is to
     * say what a third party was just granted; and pressing Connect again mints
     * a second grant beside the first.
     */
    let tokens;
    try {
      tokens = await exchangeCode(provider, creds, redirectUri, q.code, fetchFn);
    } catch (err) {
      req.log.warn({ err, provider }, 'HRIS token exchange failed');
      return back('error');
    }
    try {
      await upsertConnection(
        deps.pool,
        {
          valuationId: state.valuationId,
          provider,
          tokens,
          connectedBy: state.userId,
          externalCompanyId: q.company_id ?? null,
        },
        // The person who completed the OAuth hop, from the signed state — this
        // callback carries no session of its own.
        { actorType: 'human', actorId: state.userId, source: 'hris' },
      );
      return back('connected');
    } catch (err) {
      // `error` rather than this, and `warn` rather than this level, is what a
      // provider refusing us deserves. This is a credential that exists at a
      // third party and nowhere here: no retry reaches it, no revoke reaches
      // it, and the only way anyone learns of it is this line. `alert: true`
      // for the same reason `autoPipeline` raises it — a failure nothing is
      // coming back for is the one that wants a person.
      req.log.error(
        {
          err,
          provider,
          valuationId: state.valuationId,
          userId: state.userId,
          alert: true,
        },
        'integration callback: the provider granted access and it could not be stored',
      );
      return back('unstored');
    }
  });

  app.post('/api/v1/valuations/:id/hris/:provider/pull', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id, provider: rawProvider } = req.params as { id: string; provider: string };
    const provider = parseProvider(rawProvider);
    const valuation = await loadAuthorized(principal, id);
    refuseIfRetired(valuation, 'accepting integration changes');
    const connection = await findConnection(deps.pool, valuation.id, provider);
    if (!connection || connection.status === 'revoked') {
      throw notConnected(HRIS_PROVIDER_LABELS[provider], CONNECTOR_PANELS.hris, connection?.status);
    }
    try {
      return await syncHrisConnection(
        { pool: deps.pool, fetchFn, credentials: deps.credentials, log: req.log },
        connection,
        { actorId: principal.id },
      );
    } catch (err) {
      // A refusal this service wrote for this caller — the retirement re-ask in
      // the sync — is already the answer. Wrapping it in "sync failed" would
      // report a decision as a fault and log a connector failure for it.
      if (err instanceof ApiProblem) throw err;
      // Only a provider-attributable failure is echoed. This catch used to
      // forward `err.message` whatever it was, and the sync's insert loop had
      // no catch of its own — so a grant the driver refused answered the
      // analyst with Postgres's own wording, constraint and column names
      // included. See `IntegrationError` in clients/deadline.ts.
      //
      // The other half of that — "the details are in the connection's last
      // error" — was a promise nothing kept for the insert loop, which threw
      // past every write that would have put anything there. R186 gave the
      // loop the catch that makes this sentence true.
      logConnectorSyncFailure(
        req.log,
        err,
        {
          family: 'hris',
          provider,
          connectionId: connection.id,
          valuationId: valuation.id,
          priorFailures: connection.sync_failures,
        },
        { scheduled: false },
      );
      throw problems.unprocessable(
        err instanceof IntegrationError
          ? `Sync failed: ${err.message}`
          : `${HRIS_PROVIDER_LABELS[provider]} sync failed — the details are in the connection's last error`,
      );
    }
  });

  app.post(
    '/api/v1/valuations/:id/hris/:provider/frequency',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requirePrincipal(req);
      requireOps(principal);
      const { id, provider: rawProvider } = req.params as { id: string; provider: string };
      const provider = parseProvider(rawProvider);
      const valuation = await loadAuthorized(principal, id);
      refuseIfRetired(valuation, 'accepting integration changes');
      const parsed = FrequencyBody.safeParse(req.body);
      if (!parsed.success) throw invalidBody('Invalid frequency', parsed.error);
      const connection = await findConnection(deps.pool, valuation.id, provider);
      if (!connection || connection.status === 'revoked') {
        throw notConnected(HRIS_PROVIDER_LABELS[provider], CONNECTOR_PANELS.hris, connection?.status);
      }
      await setSyncFrequency(deps.pool, connection.id, parsed.data.frequency, {
        actorType: 'human',
        actorId: principal.id,
        source: 'hris',
      });
      return { frequency: parsed.data.frequency };
    },
  );

  app.delete(
    '/api/v1/valuations/:id/hris/:provider',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      requireOps(principal);
      const { id, provider: rawProvider } = req.params as { id: string; provider: string };
      const provider = parseProvider(rawProvider);
      const valuation = await loadAuthorized(principal, id);
      refuseIfRetired(valuation, 'accepting integration changes');
      const actor = { actorType: 'human' as const, actorId: principal.id, source: 'hris' };
      if (!(await revokeConnection(deps.pool, valuation.id, provider, actor))) throw problems.notFound();
      return reply.status(204).send();
    },
  );
}
