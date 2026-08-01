import type { FastifyInstance } from 'fastify';
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
  upsertConnection,
  type CapTableConnectionRow,
} from '../repos/capTableConnections.js';
import { findCapTable, saveCapTable } from '../repos/capTables.js';
import { validateCapTable } from '../domain/capTable.js';
import { diffCapTables, type CapTableDiff } from '../domain/capTableSync.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';

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
export async function syncCapTableConnection(
  deps: { pool: pg.Pool; fetchFn: FetchFn },
  connection: CapTableConnectionRow,
  opts: { apply: boolean; actorId: string },
): Promise<SyncOutcome> {
  let pulled;
  try {
    pulled = await fetchCapTable(
      connection.provider,
      {
        accessToken: connection.access_token,
        externalCompanyId: connection.external_company_id,
        externalCompanyName: connection.external_company_name,
      },
      deps.fetchFn,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordSyncError(deps.pool, connection.id, message);
    throw err;
  }

  const existing = await findCapTable(deps.pool, connection.valuation_id);
  const diff = diffCapTables(existing?.entries ?? [], pulled.entries);
  const validation = validateCapTable(pulled.entries);

  // Apply when asked, or when there is no on-file table to disturb. Never
  // persist an invalid pull.
  const applied = validation.valid && (opts.apply || !existing);
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
          await syncCapTableConnection({ pool: deps.pool, fetchFn }, connection, {
            apply: true,
            actorId: connection.connected_by ?? connection.id,
          });
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
    const q = req.query as { state?: string; code?: string; error?: string; company_id?: string };
    if (!q.state) throw problems.unprocessable('Missing state');
    let state;
    try {
      state = await verifyCapTableSyncState(q.state, deps.jwt);
    } catch {
      throw problems.unprocessable('Invalid or expired state');
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
      const body = PullBody.parse(req.body ?? {});

      const connection = await findConnection(deps.pool, valuation.id, provider);
      if (!connection || connection.status === 'revoked') {
        throw problems.unprocessable(`${CAP_TABLE_PROVIDER_LABELS[provider]} is not connected`);
      }

      let outcome;
      try {
        outcome = await syncCapTableConnection({ pool: deps.pool, fetchFn }, connection, {
          apply: body.apply,
          actorId: principal.id,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw problems.unprocessable(`Sync failed: ${message}`);
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
      const parsed = FrequencyBody.safeParse(req.body);
      if (!parsed.success) throw problems.unprocessable('Invalid frequency', { errors: parsed.error.issues });
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
