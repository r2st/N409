import type { FastifyInstance } from 'fastify';
import { stoppedEngagementReason } from '../domain/operations.js';
import type pg from 'pg';
import pLimit from 'p-limit';
import { z } from 'zod';
import { ApiProblem, isUlid, problems } from '@n409/shared';
import { canReadValuation, type Principal } from '../auth/rbac.js';
import { signCapTableSyncState, verifyCapTableSyncState, type JwtConfig } from '../auth/jwt.js';
import {
  CAP_TABLE_PROVIDERS,
  CAP_TABLE_PROVIDER_LABELS,
  authorizeUrl,
  exchangeCode,
  fetchCapTable,
  refreshTokens,
  type CapTableProvider,
  type FetchFn,
  type ProviderCredentials,
} from '../clients/capTableSync.js';
import {
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
  type CapTableConnectionRow,
} from '../repos/capTableConnections.js';
import { CapTableAppearedError, findCapTable, saveCapTable } from '../repos/capTables.js';
import { MAX_CAP_TABLE_ENTRIES, validateCapTable } from '../domain/capTable.js';
import { diffCapTables, type CapTableDiff } from '../domain/capTableSync.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';
import { isRetiredNow, refuseIfRetired, refuseIfRetiredNow } from '../domain/retiredEngagement.js';
import { integrationActorStillAuthorized } from '../domain/integrationActor.js';
import {
  describeConnectorFailure,
  IntegrationError,
  ReconnectRequiredError,
  retryAfterSecondsFor,
} from '../clients/deadline.js';
import { storeRefreshedTokens, tokenNeedsRefresh } from '../clients/oauthRefresh.js';
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
 * Live cap-table sync (feature 4). Flow mirrors the accounting integration:
 * POST …/connect returns the provider OAuth authorize URL with a signed state;
 * the provider redirects to GET /api/v1/cap-table-sync/callback (authenticated
 * by the state signature); POST …/pull fetches the cap table, diffs it against
 * the one on file, and either previews the conflicts or applies the pull. A
 * background scheduler pulls connections whose cadence is due.
 */

export interface CapTableSyncDeps {
  pool: pg.Pool;
  jwt: JwtConfig;
  publicBaseUrl: string;
  credentials: Partial<Record<CapTableProvider, ProviderCredentials>>;
  fetchFn?: FetchFn;
}

function parseProvider(value: string): CapTableProvider {
  if (!(CAP_TABLE_PROVIDERS as readonly string[]).includes(value)) throw problems.notFound();
  return value as CapTableProvider;
}

const providerUnavailable = (provider: CapTableProvider) =>
  new ApiProblem({
    status: 503,
    title: 'Integration not configured',
    type: 'urn:n409:problem:captable-sync-unavailable',
    detail: `${CAP_TABLE_PROVIDER_LABELS[provider]} is not configured on this deployment`,
  });

const FrequencyBody = z.object({ frequency: z.enum(['manual', 'daily', 'weekly']) }).strict();
const PullBody = z.object({ apply: z.boolean().default(false) }).strict().default({ apply: false });

/**
 * Query string of the OAuth callback. Unknown keys are stripped rather than
 * rejected — providers append their own (`scope`, `session_state`) and a strict
 * schema would fail real callbacks. What this does buy is a bound on every
 * field we go on to use: `state` and `code` before they are verified and spent,
 * and `company_id` before it is written to
 * `cap_table_connections.external_company_id`. A repeated parameter arrives
 * from Fastify as an array, which the string schema refuses outright.
 */
const CallbackQuery = z.object({
  state: z.string().max(4096).optional(),
  code: z.string().max(4096).optional(),
  error: z.string().max(256).optional(),
  company_id: z.string().max(128).optional(),
});

/**
 * What the connection says when the failure was not the provider's.
 *
 * Deliberately says where to look rather than what happened: the message an
 * analyst needs is one nothing vouched for, so it goes to the log line beside
 * this write, which every caller already emits with `err` intact.
 */
const OUR_SYNC_FAILURE =
  'the sync could not be completed, and the reason was not the provider — it is in the service log';

/**
 * What the connection says when the pull worked and the bookkeeping did not.
 * The cap table on file is whatever this sync decided; what did not happen is
 * the connection's own record of it.
 */
const SYNC_UNRECORDED =
  'the cap table was pulled, but the result could not be recorded against this connection — the next ' +
  'scheduled sync will pull it again';

export interface SyncOutcome {
  diff: CapTableDiff;
  applied: boolean;
  validation: ReturnType<typeof validateCapTable>;
  external_company_name: string | null;
  as_of: string | null;
  class_count: number;
}

/**
 * Pull the provider cap table, diff it against the one on file, and apply it
 * when `apply` is set (or there is nothing on file to conflict with). Shared by
 * the pull route and the periodic scheduler. Records success/error on the
 * connection. Throws on fetch failure after recording the error.
 */
/**
 * The access token to present to the provider, renewed first if it is spent.
 *
 * Both providers' authorize URLs ask for `offline_access`, and the refresh
 * token that scope exists to obtain went into the row at connect time and was
 * never read again — so a scheduled cap-table sync worked until the first
 * access token expired and then answered `401` on every tick. Because
 * `recordSyncError` moves the connection to `error` and `findDueConnections`
 * returns only `connected` rows, the schedule stopped there permanently: the
 * cap table on file quietly stops tracking the provider's while the card shows
 * an error nobody reads as "reconnect".
 *
 * See `routes/hris.ts` for why this is proactive on the stored expiry rather
 * than reactive on the 401, and `clients/oauthRefresh.ts` for which refusals a
 * retry can clear.
 */
async function accessTokenFor(
  deps: {
    pool: pg.Pool;
    fetchFn: FetchFn;
    credentials?: Partial<Record<CapTableProvider, ProviderCredentials>>;
    log?: ConnectorLogger;
  },
  connection: CapTableConnectionRow,
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
    family: 'cap_table',
  });
  return refreshed.accessToken;
}

export async function syncCapTableConnection(
  deps: {
    pool: pg.Pool;
    fetchFn: FetchFn;
    credentials?: Partial<Record<CapTableProvider, ProviderCredentials>>;
    /**
     * Where a *bookkeeping* failure goes. The pull's own failure is logged by
     * both callers, which hold the request or the sweep's logger; the three
     * best-effort `recordSyncError` writes below are inside this function and
     * had nowhere to report to at all. See `logSyncBookkeepingFailure`.
     */
    log?: ConnectorLogger;
  },
  connection: CapTableConnectionRow,
  opts: { apply: boolean; actorId: string },
): Promise<SyncOutcome> {
  let pulled;
  try {
    const accessToken = await accessTokenFor(deps, connection);
    pulled = await fetchCapTable(
      connection.provider,
      {
        accessToken,
        externalCompanyId: connection.external_company_id,
        externalCompanyName: connection.external_company_name,
      },
      deps.fetchFn,
    );
  } catch (err) {
    // Best-effort, like every other write in a catch: this exists to *record*
    // the failure it caught, and it is a query against the same pool the pull
    // may have failed on. A rejection here would replace an accurate provider
    // error with an unrelated one and lose the original entirely — including
    // for the scheduler above, which has no client to report it to at all.
    // Only a message something vouched for: since round 252 this block also
    // renews the access token and writes it back, so a driver error can land
    // here and `last_error` is served to the client verbatim. See
    // `describeConnectorFailure`.
    const message = describeConnectorFailure(err, OUR_SYNC_FAILURE);
    // `terminal` is the difference between a provider that is briefly unwell
    // and an authorisation that has ended: the first is worth another tick on
    // a backoff, the second will be refused identically forever and its
    // message asks for a reconnect instead.
    await recordSyncError(deps.pool, connection, message, {
      terminal: err instanceof ReconnectRequiredError,
      // See `recordSyncError`: a provider that named a wait is waited for.
      retryAfterSeconds: retryAfterSecondsFor(err),
    }).catch((bookErr: unknown) => {
      if (deps.log)
        logSyncBookkeepingFailure(
          deps.log,
          bookErr,
          {
            family: 'cap_table',
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
   * Same rule and same reason as the twin in `routes/hris.ts`:
   * `refuseIfRetired` runs on the route above, and both doors into this
   * function then leave the process for as long as the pull takes — up to
   * `PAGED_PULL_BUDGET_MS`, two minutes. `staleEngagementWriteCensus` states
   * this for every handler that spends an engine or AI round trip before it
   * writes; a connector pull is the same gap through a door the census's
   * `postJson` matcher cannot see, and a longer one.
   *
   * Ahead of the row cap below, because both are refusals of the same pull and
   * this one is about whether the pull may be applied at all. Nothing has been
   * written yet, so unlike the cap there is nothing to record on the
   * connection: restoring the engagement makes the next pull work.
   */
  await refuseIfRetiredNow(deps.pool, connection.valuation_id, 'importing a cap table');

  /*
   * The row cap the import routes enforce, on the writer that had none.
   *
   * `saveCapTable` has four callers. Three of them are the import endpoints and
   * all three refuse a table over `MAX_CAP_TABLE_ENTRIES` — the pasted-CSV path
   * was the last to get it, on the reasoning that silently storing the first
   * 2,000 rows of somebody's cap table is worse than refusing it. This one
   * stored whatever the provider sent: the body cap is 16 MB of JSON, and
   * Pulley's payload is a flat `securities` list rather than a list of classes,
   * so tens of thousands of entries is a large company's ordinary shape rather
   * than a hostile one.
   *
   * All of them land in a single `cap_tables.entries` document that every
   * reader of the valuation loads whole — the workbook, the waterfall
   * projection, the graph's node-and-edge build, the report exhibits, and the
   * monitoring scan, which fetches every monitored valuation's table at once.
   *
   * Refused rather than truncated, and refused *before* the diff: a diff
   * against a table this size is the same read. Recorded on the connection so
   * a scheduled sync stops re-pulling it every fifteen minutes, which is what
   * an unhandled throw here would leave it doing.
   */
  if (pulled.entries.length > MAX_CAP_TABLE_ENTRIES) {
    const message =
      `the provider returned ${pulled.entries.length} securities; at most ` +
      `${MAX_CAP_TABLE_ENTRIES} can be stored as one cap table`;
    await recordSyncError(deps.pool, connection, message).catch((bookErr: unknown) => {
      if (deps.log)
        logSyncBookkeepingFailure(
          deps.log,
          bookErr,
          {
            family: 'cap_table',
            provider: connection.provider,
            connectionId: connection.id,
            valuationId: connection.valuation_id,
          },
          'provider table too large',
        );
    });
    throw new IntegrationError(`${CAP_TABLE_PROVIDER_LABELS[connection.provider]}: ${message}`);
  }

  let diff, validation, applied;
  try {
    const existing = await findCapTable(deps.pool, connection.valuation_id);
    diff = diffCapTables(existing?.entries ?? [], pulled.entries);
    validation = validateCapTable(pulled.entries);

    // Apply when asked, or when there is no on-file table to disturb. Never
    // persist an invalid pull.
    applied = validation.valid && (opts.apply || !existing);
    /*
     * And when the *only* thing authorising the write is that absence, say so
     * to the statement that performs it (round 268, methodology M5).
     *
     * `!existing` is one statement and the write is another, with a diff over
     * both tables, a validation pass and an `await` between them — long enough
     * for the import route next door to commit, which is all a race needs.
     * `saveCapTable` upserts, so the table that arrived is replaced by the
     * provider's, by a pull that was told `apply: false`, under a `system`
     * actor and with no refusal anywhere: the analyst who just imported their
     * spreadsheet sees Carta's table on the tab and their own import event
     * above it.
     *
     * Only in this branch. A pull asked to apply is asked to replace whatever
     * is there, and guarding it would refuse the scheduled sweep — which always
     * applies — every time a person touched the table between two ticks.
     */
    const authorisedByAbsence = applied && !opts.apply;
    if (applied) {
      const actor: EventActor = {
        actorType: 'system',
        actorId: `captable-sync:${connection.provider}`,
        source: 'captable_sync',
      };
      await saveCapTable(
        deps.pool,
        {
          valuationId: connection.valuation_id,
          sourceFormat: connection.provider,
          entries: pulled.entries,
          validation,
          columnMapping: {},
          createdBy: opts.actorId,
        },
        actor,
        { expectAbsent: authorisedByAbsence },
      );
    }
  } catch (err) {
    /*
     * Except the one refusal that is not a sync failure (round 268, M5).
     *
     * `expectAbsent` above refuses a preview whose authorisation — that there
     * was no table to disturb — stopped being true while the provider was
     * answering. Nothing is wrong with the connection: the pull succeeded, and
     * the write was declined on purpose. Recording it would move a healthy
     * connection to `error`, spend a rung of the backoff ladder and put a
     * message on the card about a race between two people, so this one leaves
     * by the door it came in and the caller decides what to say.
     */
    if (err instanceof CapTableAppearedError) throw err;
    /*
     * The half of the sync after the pull (round 186, methodology M5).
     *
     * The fetch above records its failure and the success below records its
     * outcome; everything between them recorded nothing. And this half fails
     * for reasons the pull cannot: `saveCapTable` bumps an optimistic-lock
     * counter and writes an audit event, so an analyst saving the table in
     * another tab, a retired engagement, or a pool with nothing left all land
     * here — after a provider round trip has already been spent.
     *
     * Untouched, the connection then keeps `status = 'connected'` and a
     * `next_sync_at` in the past, because `recordSync` below is the only thing
     * that moves it. `findDueConnections` re-picks it every 15 minutes and
     * re-pulls the provider's whole cap table each time, forever, against a
     * connection whose page says it is healthy. Recording the failure both
     * stops the loop (an errored connection is not due) and puts the reason in
     * front of the person who can act on it.
     *
     * Not the raw message, unlike the fetch handler above. That one catches an
     * `IntegrationError` this codebase authored for a caller to read; this one
     * catches whatever Postgres refused the write with — constraint names,
     * column names, rejected values. `last_error` is served to the caller
     * verbatim by `toPublic`, so it carries only text we wrote. The error
     * itself reaches both callers' log lines intact.
     */
    await recordSyncError(
      deps.pool,
      connection,
      'the provider cap table was pulled but could not be saved',
    ).catch((bookErr: unknown) => {
      if (deps.log)
        logSyncBookkeepingFailure(
          deps.log,
          bookErr,
          {
            family: 'cap_table',
            provider: connection.provider,
            connectionId: connection.id,
            valuationId: connection.valuation_id,
          },
          'pull could not be saved',
        );
    });
    throw err;
  }

  const summary = {
    provider: connection.provider,
    applied,
    class_count: pulled.entries.length,
    conflicts: diff.conflicts.length,
    external_company_name: pulled.external_company_name,
    as_of: pulled.as_of,
  };
  try {
    const landed = await recordSync(deps.pool, connection, summary);
    if (!landed && deps.log) {
      logSyncOutcomeSuperseded(deps.log, {
        family: 'cap_table',
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
     * from it leaves exactly the state the catch above was written to remove —
     * `connected`, a due date already in the past — except reached from a
     * *success*, which is why nothing was watching it. `findDueConnections`
     * then re-pulls the provider's whole cap table every fifteen minutes,
     * forever, behind a card reading healthy.
     *
     * Not hypothetical: this writes `last_sync_summary` as `jsonb`, and the
     * driver refuses a jsonb value carrying a NUL or a lone surrogate
     * (`domain/nulBytes.ts`). R259 stopped provider text reaching it
     * unchecked; the shape stays open for anything else that can fail one
     * UPDATE.
     */
    await recordSyncError(deps.pool, connection, SYNC_UNRECORDED).catch((bookErr: unknown) => {
      if (deps.log)
        logSyncBookkeepingFailure(
          deps.log,
          bookErr,
          {
            family: 'cap_table',
            provider: connection.provider,
            connectionId: connection.id,
            valuationId: connection.valuation_id,
          },
          'sync succeeded',
        );
    });
    throw err;
  }

  return {
    diff,
    applied,
    validation,
    external_company_name: pulled.external_company_name,
    as_of: pulled.as_of,
    class_count: pulled.entries.length,
  };
}

/** Run every due scheduled sync once. Returns how many were processed. */
export async function runDueCapTableSyncs(deps: {
  pool: pg.Pool;
  fetchFn?: FetchFn;
  /**
   * The same OAuth client credentials the routes hold. Without them the sweep
   * cannot renew an expired token — which would leave the scheduled sync doing
   * strictly less than the manual pull beside it, on exactly the connections
   * nobody is watching.
   */
  credentials?: Partial<Record<CapTableProvider, ProviderCredentials>>;
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
          await syncCapTableConnection(
            { pool: deps.pool, fetchFn, credentials: deps.credentials, log: deps.log },
            connection,
            {
              apply: true,
              actorId: connection.connected_by ?? connection.id,
            },
          );
          // A connection the backoff brought back. Read off the row this tick
          // started from, because `recordSync` has just cleared it.
          if (deps.log) {
            logConnectorSyncRecovered(deps.log, {
              family: 'cap_table',
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
                family: 'cap_table',
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

export function registerCapTableSyncRoutes(app: FastifyInstance, deps: CapTableSyncDeps): void {
  const fetchFn = deps.fetchFn ?? fetch;
  const redirectUri = `${deps.publicBaseUrl}/api/v1/cap-table-sync/callback`;

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

  app.get('/api/v1/valuations/:id/cap-table/sync', { preHandler: app.authenticate }, async (req) => {
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
      providers: CAP_TABLE_PROVIDERS.map((provider) => ({
        provider,
        label: CAP_TABLE_PROVIDER_LABELS[provider],
        configured: Boolean(deps.credentials[provider]),
        connection: byProvider.has(provider) ? toPublic(byProvider.get(provider)!) : null,
      })),
    };
  });

  app.post(
    '/api/v1/valuations/:id/cap-table/sync/:provider/connect',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requirePrincipal(req);
      const { id, provider: rawProvider } = req.params as { id: string; provider: string };
      const provider = parseProvider(rawProvider);
      const valuation = await loadAuthorized(principal, id);
      refuseIfRetired(valuation, 'accepting cap table changes');
      const creds = deps.credentials[provider];
      if (!creds) throw providerUnavailable(provider);
      const state = await signCapTableSyncState(
        { valuationId: valuation.id, provider, userId: principal.id },
        deps.jwt,
      );
      return { authorize_url: authorizeUrl(provider, creds, redirectUri, state) };
    },
  );

  app.get('/api/v1/cap-table-sync/callback', async (req, reply) => {
    const parsedQuery = CallbackQuery.safeParse(req.query);
    if (!parsedQuery.success) {
      throw invalidQuery(parsedQuery.error, 'Invalid callback parameters');
    }
    const q = parsedQuery.data;
    if (!q.state) throw problems.badRequest(integrationCallbackRefusal('capTable'));
    let state;
    try {
      state = await verifyCapTableSyncState(q.state, deps.jwt);
    } catch (err) {
      req.log.warn({ err }, 'cap-table sync callback state verification failed');
      throw problems.unprocessable(integrationCallbackRefusal('capTable'));
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
      recordIntegrationCallbackOutcome('cap-table', result);
      return reply.redirect(
        `${deps.publicBaseUrl}/valuations/${state.valuationId}/cap-table?sync=${result}&provider=${provider}`,
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
     */
    if (!(await integrationActorStillAuthorized(deps.pool, state.userId, state.valuationId, 'read'))) {
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
     * under a line reading "'cap-table sync token exchange failed'" — and after the exchange has
     * returned, that sentence names the half that worked. The two are not the
     * same incident. A failed exchange leaves nothing anywhere. A failed store
     * leaves an access token and a refresh token minted at the provider against
     * this deployment's OAuth app — standing access to the client's cap table
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
      req.log.warn({ err, provider }, 'cap-table sync token exchange failed');
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
        { actorType: 'human', actorId: state.userId, source: 'captable_sync' },
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

  app.post(
    '/api/v1/valuations/:id/cap-table/sync/:provider/pull',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requirePrincipal(req);
      const { id, provider: rawProvider } = req.params as { id: string; provider: string };
      const provider = parseProvider(rawProvider);
      const valuation = await loadAuthorized(principal, id);
      refuseIfRetired(valuation, 'accepting cap table changes');
      // `safeParse`, not `parse`: a ZodError thrown out of a handler is not an
      // `ApiProblem` and carries no `statusCode`, so `registerProblemHandler`
      // renders it as `urn:n409:problem:internal` with a 500 — telling a client
      // to retry a body that can never be accepted. Every other body on this
      // service is read this way; this one was the exception.
      const parsedBody = PullBody.safeParse(req.body ?? {});
      if (!parsedBody.success) {
        throw invalidBody('Invalid pull body', parsedBody.error);
      }
      const body = parsedBody.data;

      const connection = await findConnection(deps.pool, valuation.id, provider);
      if (!connection || connection.status === 'revoked') {
        throw notConnected(
          CAP_TABLE_PROVIDER_LABELS[provider],
          CONNECTOR_PANELS.capTable,
          connection?.status,
        );
      }

      let outcome;
      try {
        outcome = await syncCapTableConnection(
          { pool: deps.pool, fetchFn, credentials: deps.credentials, log: req.log },
          connection,
          { apply: body.apply, actorId: principal.id },
        );
      } catch (err) {
        // A preview refused because somebody else's table landed first is not a
        // sync failure and must not be logged as one — see the sync's own note.
        // It is already a 409 written for this caller to read.
        if (err instanceof CapTableAppearedError) throw err;
        // Likewise the retirement re-ask in the sync: a refusal this service
        // wrote for this caller is already the answer, and reporting it as a
        // provider failure would log a connector fault for a decision.
        if (err instanceof ApiProblem) throw err;
        /**
         * Only wording this codebase vouched for reaches the client.
         *
         * This catch forwarded `err.message` whatever it was, which was written
         * for the client's own failures — "Carta cap-table fetch failed (503)",
         * naming a provider and a status and nothing else. What it actually
         * covers is the whole sync: `saveCapTable` and `recordSync` are inside
         * it, so a row Postgres refused answered the analyst with the driver's
         * wording, its constraint name and, in `err.detail`, the offending
         * values. `IntegrationError` is the type that says a sentence is fit to
         * publish (clients/deadline.ts); everything else gets a constant, and
         * the real one goes to the log.
         *
         * The identical line in `routes/hris.ts` was fixed when that type was
         * introduced. This one was not, and `errorBodyDisclosure.test.ts` — the
         * census written for exactly this shape — could not see it, because
         * binding the message to a local one statement earlier puts it outside
         * the argument the scan reads.
         */
        logConnectorSyncFailure(
          req.log,
          err,
          {
            family: 'cap_table',
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
            : `${CAP_TABLE_PROVIDER_LABELS[provider]} sync failed — the details are in the connection's last error`,
        );
      }
      return outcome;
    },
  );

  app.post(
    '/api/v1/valuations/:id/cap-table/sync/:provider/frequency',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requirePrincipal(req);
      const { id, provider: rawProvider } = req.params as { id: string; provider: string };
      const provider = parseProvider(rawProvider);
      const valuation = await loadAuthorized(principal, id);
      refuseIfRetired(valuation, 'accepting cap table changes');
      const parsed = FrequencyBody.safeParse(req.body);
      if (!parsed.success) throw invalidBody('Invalid frequency', parsed.error);
      const connection = await findConnection(deps.pool, valuation.id, provider);
      if (!connection || connection.status === 'revoked') {
        throw notConnected(
          CAP_TABLE_PROVIDER_LABELS[provider],
          CONNECTOR_PANELS.capTable,
          connection?.status,
        );
      }
      await setSyncFrequency(deps.pool, connection.id, parsed.data.frequency, {
        actorType: 'human',
        actorId: principal.id,
        source: 'captable_sync',
      });
      return { frequency: parsed.data.frequency };
    },
  );

  app.delete(
    '/api/v1/valuations/:id/cap-table/sync/:provider',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { id, provider: rawProvider } = req.params as { id: string; provider: string };
      const provider = parseProvider(rawProvider);
      const valuation = await loadAuthorized(principal, id);
      refuseIfRetired(valuation, 'accepting cap table changes');
      const actor = { actorType: 'human' as const, actorId: principal.id, source: 'captable_sync' };
      if (!(await revokeConnection(deps.pool, valuation.id, provider, actor))) throw problems.notFound();
      return reply.status(204).send();
    },
  );
}
