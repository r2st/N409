import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import pLimit from 'p-limit';
import { z } from 'zod';
import { ApiProblem, describeTransportFailure, isUlid, problems } from '@n409/shared';
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
import { findCapTable, saveCapTable } from '../repos/capTables.js';
import { MAX_CAP_TABLE_ENTRIES, validateCapTable } from '../domain/capTable.js';
import { diffCapTables, type CapTableDiff } from '../domain/capTableSync.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { IntegrationError, ReconnectRequiredError } from '../clients/deadline.js';
import { tokenNeedsRefresh } from '../clients/oauthRefresh.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { integrationCallbackRefusal } from '../domain/oauthCallbackRefusal.js';

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

const FrequencyBody = z.object({ frequency: z.enum(['manual', 'daily', 'weekly']) });
const PullBody = z.object({ apply: z.boolean().default(false) }).default({ apply: false });

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
  },
  connection: CapTableConnectionRow,
): Promise<string> {
  if (!tokenNeedsRefresh(connection.token_expires_at)) return connection.access_token;
  const creds = deps.credentials?.[connection.provider];
  if (!creds || !connection.refresh_token) return connection.access_token;
  const refreshed = await refreshTokens(connection.provider, creds, connection.refresh_token, deps.fetchFn);
  await updateTokens(deps.pool, connection.id, refreshed);
  return refreshed.accessToken;
}

export async function syncCapTableConnection(
  deps: {
    pool: pg.Pool;
    fetchFn: FetchFn;
    credentials?: Partial<Record<CapTableProvider, ProviderCredentials>>;
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
    const message = describeTransportFailure(err);
    // `terminal` is the difference between a provider that is briefly unwell
    // and an authorisation that has ended: the first is worth another tick on
    // a backoff, the second will be refused identically forever and its
    // message asks for a reconnect instead.
    await recordSyncError(deps.pool, connection.id, message, {
      terminal: err instanceof ReconnectRequiredError,
    }).catch(() => undefined);
    throw err;
  }

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
    await recordSyncError(deps.pool, connection.id, message).catch(() => undefined);
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
      );
    }
  } catch (err) {
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
      connection.id,
      'the provider cap table was pulled but could not be saved',
    ).catch(() => undefined);
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
  await recordSync(deps.pool, connection.id, summary, connection.sync_frequency);

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
  log?: { warn: (o: unknown, m?: string) => void };
}): Promise<number> {
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
            { pool: deps.pool, fetchFn, credentials: deps.credentials },
            connection,
            {
              apply: true,
              actorId: connection.connected_by ?? connection.id,
            },
          );
          return true;
        } catch (err) {
          deps.log?.warn({ err, connectionId: connection.id }, 'scheduled cap-table sync failed');
          return false;
        }
      }),
    ),
  );
  return results.filter(Boolean).length;
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
    return {
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
    } catch {
      throw problems.unprocessable(integrationCallbackRefusal('capTable'));
    }
    const provider = parseProvider(state.provider);
    const back = (result: string) =>
      reply.redirect(
        `${deps.publicBaseUrl}/valuations/${state.valuationId}/cap-table?sync=${result}&provider=${provider}`,
      );
    if (q.error || !q.code) return back('denied');
    const creds = deps.credentials[provider];
    if (!creds) throw providerUnavailable(provider);
    try {
      const tokens = await exchangeCode(provider, creds, redirectUri, q.code, fetchFn);
      await upsertConnection(deps.pool, {
        valuationId: state.valuationId,
        provider,
        tokens,
        connectedBy: state.userId,
        externalCompanyId: q.company_id ?? null,
      });
      return back('connected');
    } catch (err) {
      req.log.warn({ err, provider }, 'cap-table sync token exchange failed');
      return back('error');
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
        throw problems.unprocessable(`${CAP_TABLE_PROVIDER_LABELS[provider]} is not connected`);
      }

      let outcome;
      try {
        outcome = await syncCapTableConnection(
          { pool: deps.pool, fetchFn, credentials: deps.credentials },
          connection,
          { apply: body.apply, actorId: principal.id },
        );
      } catch (err) {
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
        req.log.warn({ err, provider, connectionId: connection.id }, 'cap-table sync failed');
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
        throw problems.unprocessable(`${CAP_TABLE_PROVIDER_LABELS[provider]} is not connected`);
      }
      await setSyncFrequency(deps.pool, connection.id, parsed.data.frequency);
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
      if (!(await revokeConnection(deps.pool, valuation.id, provider))) throw problems.notFound();
      return reply.status(204).send();
    },
  );
}
