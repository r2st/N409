import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { ApiProblem, isUlid, problems } from '@n409/shared';
import { canReadValuation, type Principal } from '../auth/rbac.js';
import { signAccountingState, verifyAccountingState, type JwtConfig } from '../auth/jwt.js';
import {
  ACCOUNTING_PROVIDERS,
  IMPORT_SUPPORTED,
  PROVIDER_LABELS,
  authorizeUrl,
  exchangeCode,
  fetchFinancials,
  type AccountingProvider,
  type FetchFn,
  type ProviderCredentials,
} from '../clients/accounting.js';
import {
  findConnection,
  listConnections,
  recordImport,
  recordImportError,
  revokeConnection,
  toPublic,
  upsertConnection,
} from '../repos/accountingConnections.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { applyEngineInputs, findParams, patchParams } from '../repos/params.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * Accounting software integrations (409.ai §23).
 *
 * Flow: POST …/connect returns the provider's OAuth authorize URL carrying a
 * signed state (valuation + provider + user). The provider redirects the
 * browser to GET /api/v1/accounting/callback — authenticated by the state
 * signature alone — which exchanges the code, stores the connection, and
 * bounces back to the valuation's documents tab. POST …/import pulls the
 * profit-and-loss report, normalizes it, and applies it to the valuation
 * params (ytd/last-year revenue, revenue status) plus engine inputs.
 */

export interface AccountingDeps {
  pool: pg.Pool;
  jwt: JwtConfig;
  publicBaseUrl: string;
  credentials: Partial<Record<AccountingProvider, ProviderCredentials>>;
  /** injectable for tests */
  fetchFn?: FetchFn;
}

function parseProvider(value: string): AccountingProvider {
  if (!(ACCOUNTING_PROVIDERS as readonly string[]).includes(value)) throw problems.notFound();
  return value as AccountingProvider;
}

const providerUnavailable = (provider: AccountingProvider) =>
  new ApiProblem({
    status: 503,
    title: 'Integration not configured',
    type: 'urn:n409:problem:accounting-unavailable',
    detail: `${PROVIDER_LABELS[provider]} is not configured on this deployment`,
  });

/**
 * Query string of the OAuth callback. Unknown keys are stripped rather than
 * rejected — providers append their own (`scope`, `session_state`, and
 * QuickBooks' `realmId`), and a strict schema would fail real callbacks. What
 * this does buy is a bound on every field we go on to use: `state` and `code`
 * before they are verified and spent, and `realmId` before it is written to
 * `accounting_connections.external_org_id`.
 */
const CallbackQuery = z.object({
  state: z.string().max(4096).optional(),
  code: z.string().max(4096).optional(),
  error: z.string().max(256).optional(),
  realmId: z.string().max(128).optional(), // QuickBooks appends the company (realm) id
});

export function registerAccountingRoutes(app: FastifyInstance, deps: AccountingDeps): void {
  const fetchFn = deps.fetchFn ?? fetch;
  const redirectUri = `${deps.publicBaseUrl}/api/v1/accounting/callback`;

  const loadAuthorizedValuation = async (principal: Principal, id: string): Promise<ValuationRow> => {
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

  // Provider availability + this valuation's connections (tokens redacted).
  app.get('/api/v1/valuations/:id/accounting', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadAuthorizedValuation(principal, id);

    const connections = await listConnections(deps.pool, valuation.id);
    const byProvider = new Map(connections.map((c) => [c.provider, c]));
    return {
      providers: ACCOUNTING_PROVIDERS.map((provider) => ({
        provider,
        label: PROVIDER_LABELS[provider],
        configured: Boolean(deps.credentials[provider]),
        import_supported: IMPORT_SUPPORTED.has(provider),
        connection: byProvider.has(provider) ? toPublic(byProvider.get(provider)!) : null,
      })),
    };
  });

  app.post(
    '/api/v1/valuations/:id/accounting/:provider/connect',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requirePrincipal(req);
      const { id, provider: rawProvider } = req.params as { id: string; provider: string };
      const provider = parseProvider(rawProvider);
      const valuation = await loadAuthorizedValuation(principal, id);

      const creds = deps.credentials[provider];
      if (!creds) throw providerUnavailable(provider);
      const state = await signAccountingState(
        { valuationId: valuation.id, provider, userId: principal.id },
        deps.jwt,
      );
      return { authorize_url: authorizeUrl(provider, creds, redirectUri, state) };
    },
  );

  // OAuth callback — browser redirect; the signed state is the authentication.
  // Unauthenticated, so everything here is attacker-controlled until the state
  // JWT verifies: bound before use, and `realmId` before it is persisted.
  app.get('/api/v1/accounting/callback', async (req, reply) => {
    const parsedQuery = CallbackQuery.safeParse(req.query);
    if (!parsedQuery.success) {
      throw problems.unprocessable('Invalid callback parameters', {
        errors: parsedQuery.error.issues,
      });
    }
    const q = parsedQuery.data;
    if (!q.state) throw problems.unprocessable('Missing state');

    let state;
    try {
      state = await verifyAccountingState(q.state, deps.jwt);
    } catch {
      throw problems.unprocessable('Invalid or expired state');
    }
    const provider = parseProvider(state.provider);
    const back = (result: string) =>
      reply.redirect(
        `${deps.publicBaseUrl}/valuations/${state.valuationId}/documents?accounting=${result}&provider=${provider}`,
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
        externalOrgId: q.realmId ?? null,
      });
      return back('connected');
    } catch (err) {
      req.log.warn({ err, provider }, 'accounting token exchange failed');
      return back('error');
    }
  });

  app.post(
    '/api/v1/valuations/:id/accounting/:provider/import',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requirePrincipal(req);
      const { id, provider: rawProvider } = req.params as { id: string; provider: string };
      const provider = parseProvider(rawProvider);
      const valuation = await loadAuthorizedValuation(principal, id);

      if (!IMPORT_SUPPORTED.has(provider)) {
        throw problems.unprocessable(
          `${PROVIDER_LABELS[provider]} import isn't available yet — connect it now and we'll pull the data as soon as the importer ships`,
        );
      }
      const connection = await findConnection(deps.pool, valuation.id, provider);
      if (!connection || connection.status === 'revoked') {
        throw problems.unprocessable(`${PROVIDER_LABELS[provider]} is not connected`);
      }

      let financials;
      try {
        financials = await fetchFinancials(
          provider,
          { accessToken: connection.access_token, externalOrgId: connection.external_org_id },
          fetchFn,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await recordImportError(deps.pool, connection.id, message);
        throw problems.unprocessable(`Import failed: ${message}`);
      }

      // Apply to the valuation: revenue params + the full snapshot as engine
      // input, all under a system actor so the audit trail shows the source.
      const actor = {
        actorType: 'system' as const,
        actorId: `accounting:${provider}`,
        source: 'accounting_import',
      };
      const paramsPatch: Record<string, unknown> = {};
      if (financials.revenue_cents !== null) {
        paramsPatch.ytd_revenue_cents = financials.revenue_cents;
        paramsPatch.revenue_status = financials.revenue_cents > 0 ? 'post_revenue' : 'pre_revenue';
      }
      if (financials.prior_year_revenue_cents !== null) {
        paramsPatch.last_year_revenue_cents = financials.prior_year_revenue_cents;
      }
      const current = await findParams(deps.pool, valuation.id);
      if (Object.keys(paramsPatch).length > 0 && current) {
        await patchParams(deps.pool, current, paramsPatch, actor);
      }

      /**
       * The balance sheet is not just a record — it is the asset approach's
       * two required inputs. `approaches.asset_value` refuses to run without
       * `inputs.asset.total_assets` and `inputs.asset.total_liabilities`, and
       * until now the only way to supply them was to type them in from a PDF
       * the client had uploaded. Pulling them from the ledger is the whole
       * point of connecting the software.
       *
       * Merged into the existing `asset` object rather than assigned over it:
       * `applyEngineInputs` concatenates with jsonb `||`, which replaces a key
       * wholesale, so writing `{ asset: {…} }` would silently drop whatever an
       * analyst had already set beside these two.
       *
       * Cents to currency units, because the engine works in the latter — the
       * `_cents` suffix stops at the boundary of this service.
       */
      const engineInputs: Record<string, unknown> = { accounting_import: financials };
      const sheet = financials.balance_sheet;
      if (sheet && sheet.total_assets_cents !== null && sheet.total_liabilities_cents !== null) {
        const existing = ((current?.engine_inputs as Record<string, unknown> | undefined)?.asset ??
          {}) as Record<string, unknown>;
        engineInputs.asset = {
          ...existing,
          total_assets: sheet.total_assets_cents / 100,
          total_liabilities: sheet.total_liabilities_cents / 100,
        };
      }
      await applyEngineInputs(deps.pool, valuation.id, engineInputs, actor);
      await recordImport(deps.pool, connection.id, financials);

      return { imported: financials };
    },
  );

  app.delete(
    '/api/v1/valuations/:id/accounting/:provider',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { id, provider: rawProvider } = req.params as { id: string; provider: string };
      const provider = parseProvider(rawProvider);
      const valuation = await loadAuthorizedValuation(principal, id);
      if (!(await revokeConnection(deps.pool, valuation.id, provider))) throw problems.notFound();
      return reply.status(204).send();
    },
  );
}
