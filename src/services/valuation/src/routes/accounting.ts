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
  refreshTokens,
  storableLedgerCents,
  storableRevenueCents,
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
  updateTokens,
  upsertConnection,
  type AccountingConnectionRow,
} from '../repos/accountingConnections.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { applyEngineInputs, findParams, patchParams } from '../repos/params.js';
import { requirePrincipal } from '../plugins/auth.js';
import { isRetiredNow, refuseIfRetired, refuseIfRetiredNow } from '../domain/retiredEngagement.js';
import { integrationActorStillAuthorized } from '../domain/integrationActor.js';
import { logConnectorSyncFailure } from '../domain/connectorSyncLog.js';
import { describeConnectorFailure, IntegrationError } from '../clients/deadline.js';
import { tokenNeedsRefresh } from '../clients/oauthRefresh.js';
import { invalidQuery } from '../domain/validationProblem.js';
import { integrationCallbackRefusal } from '../domain/oauthCallbackRefusal.js';
import { CONNECTOR_PANELS, notConnected } from '../domain/connectorRefusal.js';
import {
  recordIntegrationCallbackOutcome,
  type IntegrationCallbackOutcome,
} from '../observability/integrationCallbacks.js';

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

/**
 * The access token to present to the provider, renewed first if it is spent.
 * The rule, and why it is proactive on the stored expiry rather than reactive
 * on a 401, is written out in `routes/hris.ts`.
 */
async function accessTokenFor(
  deps: {
    pool: pg.Pool;
    fetchFn: FetchFn;
    credentials: Partial<Record<AccountingProvider, ProviderCredentials>>;
  },
  connection: AccountingConnectionRow,
): Promise<string> {
  if (!tokenNeedsRefresh(connection.token_expires_at)) return connection.access_token;
  const creds = deps.credentials[connection.provider];
  if (!creds || !connection.refresh_token) return connection.access_token;
  const refreshed = await refreshTokens(connection.provider, creds, connection.refresh_token, deps.fetchFn);
  await updateTokens(deps.pool, connection.id, refreshed);
  return refreshed.accessToken;
}

/**
 * What the connection says when the failure was not the provider's.
 *
 * Deliberately says where to look rather than what happened: the message an
 * analyst needs is one nothing vouched for, so it goes to the log line beside
 * this write, which every caller already emits with `err` intact.
 */
const OUR_IMPORT_FAILURE =
  'the import could not be completed, and the reason was not the provider — it is in the service log';

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
      refuseIfRetired(valuation, 'accepting integration changes');

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
      throw invalidQuery(parsedQuery.error, 'Invalid callback parameters');
    }
    const q = parsedQuery.data;
    if (!q.state) throw problems.badRequest(integrationCallbackRefusal('accounting'));

    let state;
    try {
      state = await verifyAccountingState(q.state, deps.jwt);
    } catch {
      throw problems.unprocessable(integrationCallbackRefusal('accounting'));
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
      recordIntegrationCallbackOutcome('accounting', result);
      return reply.redirect(
        `${deps.publicBaseUrl}/valuations/${state.valuationId}/documents?accounting=${result}&provider=${provider}`,
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

    try {
      const tokens = await exchangeCode(provider, creds, redirectUri, q.code, fetchFn);
      await upsertConnection(
        deps.pool,
        {
          valuationId: state.valuationId,
          provider,
          tokens,
          connectedBy: state.userId,
          externalOrgId: q.realmId ?? null,
        },
        // The person who completed the OAuth hop, from the signed state — this
        // callback carries no session of its own.
        { actorType: 'human', actorId: state.userId, source: 'accounting' },
      );
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
      refuseIfRetired(valuation, 'accepting integration changes');

      if (!IMPORT_SUPPORTED.has(provider)) {
        throw problems.unprocessable(
          `${PROVIDER_LABELS[provider]} import isn't available yet — connect it now and we'll pull the data as soon as the importer ships`,
        );
      }
      const connection = await findConnection(deps.pool, valuation.id, provider);
      if (!connection || connection.status === 'revoked') {
        throw notConnected(PROVIDER_LABELS[provider], CONNECTOR_PANELS.accounting, connection?.status);
      }

      let financials;
      try {
        // A spent access token is renewed before the import rather than being
        // presented and refused: QuickBooks' lasts an hour and Xero's thirty
        // minutes, so all but the first import after a connect was a 401 with
        // the refresh token that would have fixed it sitting unread in the next
        // column. Falls through to the stored token when the provider named no
        // expiry, gave no refresh token, or this deployment holds no client
        // credentials for it — in each case the provider gets to give the real
        // answer.
        const accessToken = await accessTokenFor(
          { pool: deps.pool, fetchFn, credentials: deps.credentials },
          connection,
        );
        financials = await fetchFinancials(
          provider,
          { accessToken, externalOrgId: connection.external_org_id },
          fetchFn,
        );
      } catch (err) {
        /**
         * Same rule as the cap-table sync beside it: an echoed message has to
         * come from a type whose wording this codebase vouched for. The client
         * throws `IntegrationError` for everything a provider did — a refusal,
         * a rate limit, a non-JSON body, a deadline — and those name the
         * provider and nothing else. Anything else reaching here is ours.
         *
         * The `recordImportError` write is now best-effort. It sits in a catch
         * whose whole job is to report the failure it caught, and it is a query
         * against the same pool: if the import failed *because* the database is
         * unwell, this write fails too, and the rejection replaced an accurate
         * "Xero report fetch failed (503)" with a 500 about something else.
         */
        // Only a message something vouched for: since round 252 this block
        // also renews the access token and writes it back, so a driver error
        // can land here and `last_error` is served to the client verbatim. See
        // `describeConnectorFailure`.
        const message = describeConnectorFailure(err, OUR_IMPORT_FAILURE);
        await recordImportError(deps.pool, connection.id, message).catch((bookErr: unknown) => {
          req.log.warn({ err: bookErr, connectionId: connection.id }, 'could not record import error');
        });
        logConnectorSyncFailure(
          req.log,
          err,
          {
            family: 'accounting',
            provider,
            connectionId: connection.id,
            valuationId: valuation.id,
          },
          { scheduled: false },
        );
        throw problems.unprocessable(
          err instanceof IntegrationError
            ? `Import failed: ${err.message}`
            : `${PROVIDER_LABELS[provider]} import failed — the details are in the connection's last error`,
        );
      }

      /*
       * The bound the params form enforces, on the figures nobody typed
       * (round 259, methodology M6).
       *
       * `ytd_revenue_cents` and `last_year_revenue_cents` are `bigint` columns
       * that `PATCH .../params` holds to `int, >= 0, <= MAX_SAFE_INTEGER`. This
       * path wrote whatever `toCents` made of the provider's cell. Two figures
       * a ledger can genuinely produce were out of range in different
       * directions, and neither said so:
       *
       *   - a negative Total Income — a period whose credit notes exceed its
       *     invoices — went in as a negative revenue *and* set
       *     `revenue_status` to `pre_revenue`, because the route reads the
       *     sign; a trading company with a bad quarter was filed and valued as
       *     one that has never sold anything.
       *   - a figure past the column went to `patchParams`, which is outside
       *     the catch above, so the driver's `value out of range for type
       *     bigint` left the connection with no error recorded and the request
       *     with a 500 in Postgres's words.
       *
       * Refused before either write, and recorded on the connection like the
       * cap-table sync's row cap, so the analyst is told which figure and can
       * enter it by hand. The rest of the snapshot is still on the response, so
       * nothing about what the ledger said is hidden by the refusal.
       */
      const outOfRange = (
        [
          ['this year', financials.revenue_cents],
          ['last year', financials.prior_year_revenue_cents],
        ] as const
      ).find(([, cents]) => !storableRevenueCents(cents));
      if (outOfRange) {
        const [which, cents] = outOfRange;
        const message =
          `the revenue ${PROVIDER_LABELS[provider]} reported for ${which} — ` +
          `${(cents as number) / 100} — is not a figure this engagement can store. ` +
          'Revenue must be a whole amount of at least zero; enter it by hand if the ledger is right.';
        await recordImportError(deps.pool, connection.id, message).catch((bookErr: unknown) => {
          req.log.warn({ err: bookErr, connectionId: connection.id }, 'could not record import error');
        });
        throw problems.unprocessable(`Import failed: ${message}`);
      }

      /*
       * The same rule on the balance sheet, which round 259 left out (round
       * 265, methodology M6).
       *
       * Revenue was bounded because it lands in a `bigint` column the params
       * form already held to a rule. These two land in a `jsonb` document,
       * which has no rule — and that is an argument for checking them here, not
       * against it: `approaches.asset_value` refuses to run NAV without both,
       * so they *are* the asset approach. See `storableLedgerCents` for the two
       * ways an unbounded one arrives, one of which tells the analyst the
       * ledger supplied no balance sheet at all.
       *
       * Only the two that become engine inputs. The rest of the sheet is
       * reported and displayed rather than valued on, and refusing the whole
       * import over a cash line nothing computes with would be a bound wider
       * than the harm.
       */
      const sheetOutOfRange = (
        [
          ['total assets', financials.balance_sheet?.total_assets_cents ?? null],
          ['total liabilities', financials.balance_sheet?.total_liabilities_cents ?? null],
        ] as const
      ).find(([, cents]) => !storableLedgerCents(cents));
      if (sheetOutOfRange) {
        const [which, cents] = sheetOutOfRange;
        const message =
          `the ${which} ${PROVIDER_LABELS[provider]} reported — ${cents} cents — is not a figure ` +
          'this engagement can value on. Enter the balance sheet by hand if the ledger is right.';
        await recordImportError(deps.pool, connection.id, message).catch((bookErr: unknown) => {
          req.log.warn({ err: bookErr, connectionId: connection.id }, 'could not record import error');
        });
        throw problems.unprocessable(`Import failed: ${message}`);
      }

      /*
       * The engagement, asked again on the way back (R308, methodology M5).
       *
       * `refuseIfRetired` ran at the top of this handler and the ledger pull
       * between the two is a call out of the process against a provider doing
       * real work — `IMPORT_TIMEOUT_MS` alone allows thirty seconds.
       * `staleEngagementWriteCensus` states the rule for every handler that
       * spends a round trip before it writes; it matches `postJson`, so the
       * connector door was outside the population rather than exempt from the
       * rule. The twins in the HRIS and cap-table syncs carry the same line.
       *
       * What lands below is not bookkeeping: `ytd_revenue_cents`,
       * `revenue_status` and the balance sheet are engine inputs, so an import
       * that completes after a firm withdraws the work restates what the next
       * calculation values on.
       */
      await refuseIfRetiredNow(deps.pool, valuation.id, 'importing financials');

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
      try {
        await applyEngineInputs(deps.pool, valuation.id, engineInputs, actor);
      } catch (err) {
        /*
         * The apply half of the import (round 186, methodology M5).
         *
         * `patchParams` above has already committed — the two writes go to
         * different columns through different repos, each opening its own
         * transaction — so a failure here leaves the engagement holding the
         * ledger's revenue figures without the balance sheet they were pulled
         * beside. The asset approach reads `inputs.asset.total_assets`; a run
         * against that state concludes from half an import.
         *
         * That is the state on the row. What was on the *screen* was worse:
         * `recordImport` never ran, so the connection went on reporting its
         * last successful import, with no error and no hint that anything had
         * been half-applied. The analyst's next move is to press Import again
         * and get the same silence.
         *
         * Recorded on the connection, like the fetch failure above, and the
         * request is answered with a 500 rather than the fetch handler's 422:
         * this is not the provider refusing us, and telling the analyst to
         * check the provider would send them somewhere the fault is not.
         * Best-effort for the same reason as every other write in a catch.
         */
        await recordImportError(
          deps.pool,
          connection.id,
          'fetched, then failed while applying the figures to this engagement',
        ).catch((bookErr: unknown) => {
          req.log.warn({ err: bookErr, connectionId: connection.id }, 'could not record import error');
        });
        req.log.error(
          { err, provider, connectionId: connection.id, valuationId: valuation.id, alert: true },
          'accounting import applied partway and could not be completed',
        );
        throw err;
      }
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
      const actor = { actorType: 'human' as const, actorId: principal.id, source: 'accounting_import' };
      if (!(await revokeConnection(deps.pool, valuation.id, provider, actor))) throw problems.notFound();
      return reply.status(204).send();
    },
  );
}
