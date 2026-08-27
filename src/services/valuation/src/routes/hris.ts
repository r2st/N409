import type { FastifyInstance } from 'fastify';
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
  type FetchFn,
  type HrisProvider,
  type ProviderCredentials,
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
  upsertConnection,
  type HrisConnectionRow,
} from '../repos/hrisConnections.js';
import { IntegrationError } from '../clients/deadline.js';
import { createGrant } from '../repos/grants.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';

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

const FrequencyBody = z.object({ frequency: z.enum(['manual', 'daily', 'weekly']) });

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
  external_company_name: string | null;
}

/**
 * Pull the roster + grants and create any grants not already imported. Shared
 * by the pull route and the scheduler. Records success/error on the connection.
 */
export async function syncHrisConnection(
  deps: { pool: pg.Pool; fetchFn: FetchFn },
  connection: HrisConnectionRow,
  opts: { actorId: string },
): Promise<HrisSyncOutcome> {
  let pull;
  try {
    pull = await fetchRosterAndGrants(
      connection.provider,
      {
        accessToken: connection.access_token,
        externalCompanyId: connection.external_company_id,
        externalCompanyName: connection.external_company_name,
      },
      deps.fetchFn,
    );
  } catch (err) {
    await recordSyncError(deps.pool, connection.id, err instanceof Error ? err.message : String(err));
    throw err;
  }

  const seen = await existingGrantExternalIds(deps.pool, connection.valuation_id);
  const actor: EventActor = {
    actorType: 'system',
    actorId: `hris-sync:${connection.provider}`,
    source: 'hris_sync',
  };
  let created = 0;
  let skipped = 0;
  for (const g of pull.grants) {
    if (seen.has(g.external_id)) {
      skipped++;
      continue;
    }
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
  }

  const outcome: HrisSyncOutcome = {
    roster_count: pull.roster.length,
    grants_found: pull.grants.length,
    grants_created: created,
    grants_skipped: skipped,
    external_company_name: pull.external_company_name,
  };
  await recordSync(
    deps.pool,
    connection.id,
    { ...outcome, provider: connection.provider },
    connection.sync_frequency,
  );
  return outcome;
}

export async function runDueHrisSyncs(deps: {
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
          await syncHrisConnection({ pool: deps.pool, fetchFn }, connection, {
            actorId: connection.connected_by ?? connection.id,
          });
          return true;
        } catch (err) {
          deps.log?.warn({ err, connectionId: connection.id }, 'scheduled HRIS sync failed');
          return false;
        }
      }),
    ),
  );
  return results.filter(Boolean).length;
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
    return {
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
    if (!q.state) throw problems.badRequest('Missing state');
    let state;
    try {
      state = await verifyHrisState(q.state, deps.jwt);
    } catch {
      throw problems.unprocessable('Invalid or expired state');
    }
    const provider = parseProvider(state.provider);
    const back = (result: string) =>
      reply.redirect(
        `${deps.publicBaseUrl.replace(/\/$/, '')}/valuations/${state.valuationId}/grants?hris=${result}&provider=${provider}`,
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
      req.log.warn({ err, provider }, 'HRIS token exchange failed');
      return back('error');
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
      throw problems.unprocessable(`${HRIS_PROVIDER_LABELS[provider]} is not connected`);
    }
    try {
      return await syncHrisConnection({ pool: deps.pool, fetchFn }, connection, { actorId: principal.id });
    } catch (err) {
      // Only a provider-attributable failure is echoed. This catch used to
      // forward `err.message` whatever it was, and the sync's insert loop has
      // no catch of its own — so a grant the driver refused answered the
      // analyst with Postgres's own wording, constraint and column names
      // included. See `IntegrationError` in clients/deadline.ts.
      req.log.warn({ err, provider, connectionId: connection.id }, 'HRIS sync failed');
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
        throw problems.unprocessable(`${HRIS_PROVIDER_LABELS[provider]} is not connected`);
      }
      await setSyncFrequency(deps.pool, connection.id, parsed.data.frequency);
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
      if (!(await revokeConnection(deps.pool, valuation.id, provider))) throw problems.notFound();
      return reply.status(204).send();
    },
  );
}
