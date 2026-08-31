import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import {
  buildWebhookPayload,
  isValidWebhookUrl,
  newWebhookSecret,
  WEBHOOK_EVENT_TYPES,
} from '../domain/partnerWebhooks.js';
import { attemptDelivery } from '../hooks/partnerWebhooks.js';
import {
  claimIdempotencyKey,
  completeIdempotentResponse,
  createWebhook,
  deleteWebhook,
  DELIVERIES_PAGE_DEFAULT,
  DELIVERIES_PAGE_MAX,
  findDeliveryForPartner,
  findWebhook,
  listDeliveries,
  listWebhooks,
  releaseIdempotencyClaim,
  requeueDelivery,
  type PartnerWebhookRow,
} from '../repos/partnerWebhooks.js';
import { canReadReport, type Principal } from '../auth/rbac.js';
import { requirePrincipal } from '../plugins/auth.js';
import { FixedWindowRateLimiter } from '../plugins/rateLimit.js';
import { VALUATION_KINDS, VALUATION_STATES } from '../domain/valuation.js';
import { CurrencyCode } from '../domain/currency.js';
import { DOCUMENT_KINDS } from '../domain/pipeline.js';
import {
  createValuation,
  findValuationById,
  listValuations,
  patchValuation,
  type ValuationRow,
} from '../repos/valuations.js';
import { listDocuments } from '../repos/documents.js';
import { isUniqueViolation } from '../db/pgError.js';
import { applyValuationState } from '../domain/applyState.js';
import type { EmailTransport } from '../hooks/stateChange.js';
import { WORKFLOW_TRANSITIONS } from '../domain/workflow.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { findPartnerIdentity } from '../repos/branding.js';
import { findApiTokenById } from '../repos/apiTokens.js';
import { latestCalculationForKind } from '../repos/calculations.js';
import { findReportByValuation, getVersionContent, listVersions } from '../repos/reports.js';
import { reportStatusFor } from '../domain/report.js';
import { deliverablePdf } from './reports.js';
import { MAX_DOCUMENT_BYTES, rethrowRejectedUpload, storeDocument } from './documents.js';
import type { ScanPolicy } from '../documents/virusScan.js';
import { checkUploadType } from '../documents/fileType.js';
import { safeFilename } from '../documents/filename.js';
import { recordEvent, type EventActor } from '../events/record.js';
import { withTransaction } from '../db/pool.js';
import { cursorParam, decodeCursor, pageParam } from '../domain/pagination.js';
import {
  buildOpenApiDocument,
  schemaKey,
  type OpenApiEndpoint,
  type OpenApiSchemas,
} from '../domain/openapi.js';
import {
  CreateValuationResponse,
  CreateWebhookResponse,
  DeleteWebhookResponse,
  GetValuationResponse,
  MeResponse,
  ListDeliveriesResponse,
  ListValuationsResponse,
  ListWebhooksResponse,
  ResultsResponse,
  RetryDeliveryResponse,
  TestWebhookResponse,
  UploadDocumentResponse,
} from '../domain/partnerApiContract.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { forbidden } from '../domain/accessProblem.js';

/**
 * Partner API (improvement 6): a stable, versioned surface for programmatic
 * valuation submission by partners. Authentication is by partner API key only
 * (`n409_pat_…`, managed in partner settings) — session JWTs are rejected, so
 * browser sessions and machine integrations stay cleanly separated. Every
 * request is rate limited per key. The docs endpoint is generated from the
 * same registry the routes are registered from, so it cannot drift.
 */

export const PARTNER_API_PREFIX = '/api/partner/v1';

/** An API token that named an organisation — the only kind this API accepts. */
interface PartnerApiToken {
  tokenId: string;
  partnerId: string;
}

/** Per-key limit: generous for polling, tight enough to protect the engine. */
export const PARTNER_API_RATE_LIMIT = 120;
export const PARTNER_API_RATE_WINDOW_MS = 60_000;

/**
 * Per-organisation ceiling, checked alongside the per-key limit.
 *
 * The per-key limit is not a ceiling on anything by itself, because the number
 * of keys is a knob the partner holds: `POST /partners/{id}/tokens` is
 * self-service and caps nothing, so an organisation's real budget was 120/min
 * multiplied by however many keys it cared to mint. "Rate limited to 120
 * requests per minute", which is what the spec and the docs endpoint both say,
 * was therefore a statement about a key rather than about a caller — and the
 * thing the limit exists to protect (one shared engine and one database) is
 * saturated by the caller.
 *
 * `sessionOrgLimiter` is not this. It sits in `app.authenticate` and covers the
 * whole authenticated surface at 1500/min, so a partner's browser users and
 * their integration share one figure, it is only installed in production, and
 * at that height it binds after twelve keys rather than before. This is the
 * partner API having a ceiling of its own.
 *
 * 600 = five keys' worth. Chosen so the ordinary reason to hold several keys —
 * one per environment, one per internal service, rotating one in — costs a
 * partner nothing, while the ceiling still lands well below the per-surface
 * figure above. Configurable, and 0 disables it.
 */
export const PARTNER_API_RATE_LIMIT_ORG = 600;

/**
 * A registry entry. Structurally this was a second copy of `OpenApiEndpoint`,
 * kept in step by hand — which is exactly the drift the registry exists to
 * prevent, one level up. It is now the same type under the local name the
 * routes read better with.
 */
export type PartnerEndpointDoc = OpenApiEndpoint;

/** Registry the routes are registered from — GET /docs serializes exactly this. */
export const PARTNER_API_ENDPOINTS: PartnerEndpointDoc[] = [];

/**
 * The zod schemas each endpoint validates with, keyed by `METHOD /path`.
 *
 * Kept beside `PARTNER_API_ENDPOINTS` rather than inside it because that array
 * is serialized straight to JSON by `GET /docs`, and a zod schema serializes to
 * an empty object — the docs response would gain a field that says nothing.
 * `GET /openapi.json` joins the two: prose from the registry, types from the
 * validator. An endpoint absent from this map is still documented, just with a
 * looser body schema, so registering a route is never blocked on adding one.
 */
export const PARTNER_API_SCHEMAS = new Map<string, OpenApiSchemas>();

const CreateBody = z.object({
  kind: z.enum(VALUATION_KINDS),
  company_name: z.string().min(1).max(300),
  service_name: z.string().min(1).max(300).optional(),
  currency: CurrencyCode.optional(),
  service_countries: z.array(z.string().length(2)).max(50).optional(),
  /**
   * The partner's own id for this engagement (migration 0164). Bounded and
   * trimmed rather than taken as sent: it is a durable lookup key, so
   * `"abc"` and `"abc "` resolving to two different engagements would be a
   * trap rather than a feature, and the uniqueness index cannot see the
   * difference between a typo and a namespace.
   */
  external_id: z.string().trim().min(1).max(200).optional(),
});

/**
 * The fields a partner may still correct, and nothing else.
 *
 * Not a copy of `CreateBody` with everything optional. `kind` is deliberately
 * absent: it selects the report skeleton, the engine pipeline and the price, so
 * changing it after documents have been attached and a questionnaire seeded is
 * not an edit but a different engagement, and the honest way to do that is to
 * create one. Everything here is a label or a currency — a correction to what
 * the deliverable *says*, not to what it *is*.
 *
 * `.strict()` because a partner who sends `{ kind: '409a' }` expecting it to
 * take should be told it did not, rather than have it silently dropped.
 */
const UpdateBody = z
  .object({
    company_name: z.string().min(1).max(300).optional(),
    service_name: z.string().min(1).max(300).nullable().optional(),
    currency: CurrencyCode.optional(),
    service_countries: z.array(z.string().length(2)).max(50).optional(),
    external_id: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict();

const ListQuery = z.object({
  state: z.enum(VALUATION_STATES).optional(),
  /** Exact match on the partner's own id — the point of setting one. */
  external_id: z.string().trim().min(1).max(200).optional(),
  page: pageParam(),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
  cursor: cursorParam(),
});

const DeliveriesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(DELIVERIES_PAGE_MAX).default(DELIVERIES_PAGE_DEFAULT),
  cursor: cursorParam(),
});

const UploadBody = z.object({
  filename: z.string().min(1).max(300),
  kind: z.enum(DOCUMENT_KINDS).default('other'),
  content_type: z.string().max(200).optional(),
  /** Base64-encoded file body — friendlier than multipart for API clients. */
  content_base64: z.string().min(1),
});

/**
 * The registry fragment every idempotency-aware mutation shares.
 *
 * `duplicate` names what a retry would otherwise produce on this endpoint, so
 * the prose is specific without the rest of the paragraph being written five
 * times. `buildOpenApiDocument` keys the `x-idempotent-replay` response header
 * off the presence of the `Idempotency-Key` header, so declaring an endpoint
 * here is also what puts it in the spec — there is no second list.
 *
 * `extra` merges in the endpoint's own 409s. `POST /webhooks` already had one
 * (the ten-endpoint ceiling), and a spec that replaced it with the idempotency
 * text would document a status the route sends for two reasons as if it sent it
 * for one.
 */
function idempotencyDoc(
  duplicate: string,
  extra: Record<string, string> = {},
): { headers: Record<string, string>; errors: Record<string, string> } {
  const conflict =
    'This Idempotency-Key was already used for a different request — a different body, or a ' +
    'different endpoint or resource — or a request holding it is still in flight. Use a fresh key ' +
    'per distinct request; retrying with the same key and the same request replays the original ' +
    'response once it has landed.';
  return {
    headers: {
      'Idempotency-Key':
        `Optional. A retried request with the same key replays the original response instead of ${duplicate}; ` +
        'reusing a key for a different request is refused.',
    },
    errors: { ...extra, '409': extra['409'] ? `${extra['409']} ${conflict}` : conflict },
  };
}

/** The projection API clients see — internal ids/flags stay internal. */
function publicValuation(v: ValuationRow) {
  return {
    id: v.id,
    number: v.number,
    /** The partner's own id, echoed back so a create response is reconcilable. */
    external_id: v.external_id,
    kind: v.kind,
    state: v.state,
    waiting_on_client: v.waiting_on_client,
    company_name: v.company_name,
    service_name: v.service_name,
    currency: v.currency,
    paid_status: v.paid_status,
    created_at: v.created_at,
    due_date: v.due_date,
    published_at: v.published_at,
    /**
     * When the firm withdrew the engagement, or null.
     *
     * A retired valuation leaves the list — `buildValuationWhere` filters it —
     * but stays readable by id, which is the right call (a partner is still
     * entitled to look at what they created) and, without this field, a silent
     * one. An integration polling `state` on a withdrawn engagement sees a
     * state that will never move again and no reason for it, and its next
     * write gets a 409 out of nowhere. This is that reason, on the response it
     * was already reading.
     */
    retired_at: v.archived_at,
  };
}

function actorFor(principal: Principal): EventActor {
  return { actorType: 'human', actorId: principal.id, source: 'partner_api' };
}

/**
 * The deliverable is not visible to a partner until a draft has been shared —
 * `canReadReport` is what the session API gates `report.pdf` on, and scoping a
 * request to the right partner is a different question from whether the report
 * has reached a state that partner is allowed to see. Without this the partner
 * API handed back the rendered PDF of a valuation still in review: ops render
 * to check their own work long before `drafted`, and the same partner asking
 * the browser API for that file correctly got a 404.
 */
function partnerCanReadReport(principal: Principal, v: ValuationRow): boolean {
  return canReadReport(principal, { userId: v.user_id, partnerId: v.partner_id, state: v.state });
}

export function registerPartnerApiRoutes(
  app: FastifyInstance,
  deps: {
    pool: pg.Pool;
    documentsDir: string;
    /**
     * Passed through to `applyValuationState` by `POST /valuations/{id}/submit`.
     * Optional for the same reason it is optional on the workflow routes: the
     * tests that do not assert on mail do not have to build one.
     */
    transport?: EmailTransport;
    limiter?: FixedWindowRateLimiter;
    /** Per-partner ceiling. `null` disables it; undefined takes the default. */
    orgLimiter?: FixedWindowRateLimiter | null;
    scan?: ScanPolicy;
  },
): void {
  const limiter =
    deps.limiter ?? new FixedWindowRateLimiter(PARTNER_API_RATE_LIMIT, PARTNER_API_RATE_WINDOW_MS);
  const orgLimiter =
    deps.orgLimiter === undefined
      ? new FixedWindowRateLimiter(PARTNER_API_RATE_LIMIT_ORG, PARTNER_API_RATE_WINDOW_MS)
      : deps.orgLimiter;

  /** API-key-only gate + per-key rate limit, run after app.authenticate. */
  const apiKeyGuard = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.apiToken) {
      throw problems.forbidden(
        'The partner API requires an API key (Authorization: Bearer n409_pat_…) — session tokens are not accepted',
      );
    }
    // A personal token has no organisation to scope valuations to, and every
    // route below scopes by partner_id — a NULL would silently match every
    // partner-less valuation on the platform.
    if (!req.apiToken.partnerId) {
      throw problems.forbidden(
        'The partner API requires a partner API key — personal tokens are not accepted',
      );
    }
    const result = limiter.check(req.apiToken.tokenId);
    void reply.header('x-ratelimit-limit', result.limit);
    void reply.header('x-ratelimit-remaining', result.remaining);
    void reply.header('x-ratelimit-reset', Math.ceil(result.resetAt / 1000));

    // The organisation's own budget, charged whether or not the key's is spent.
    // Charging it first and unconditionally is what makes it a ceiling: if a
    // request that the key limit has already refused went uncharged, spreading
    // the same flood across enough keys would keep every one of them at its own
    // limit and never reach this one. The headers are reported on every
    // response, including the ones the key limit rejects, so a partner running
    // several integrations can see which of the two budgets is the binding one
    // before either runs out.
    const org = orgLimiter?.check(req.apiToken.partnerId);
    if (org) {
      void reply.header('x-ratelimit-limit-partner', org.limit);
      void reply.header('x-ratelimit-remaining-partner', org.remaining);
      void reply.header('x-ratelimit-reset-partner', Math.ceil(org.resetAt / 1000));
    }

    if (!result.allowed) {
      throw problems.tooManyRequests(
        `Rate limit of ${result.limit} requests per ${PARTNER_API_RATE_WINDOW_MS / 1000}s exceeded for this API key`,
        Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000)),
      );
    }
    if (org && !org.allowed) {
      throw problems.tooManyRequests(
        `Rate limit of ${org.limit} requests per ${PARTNER_API_RATE_WINDOW_MS / 1000}s exceeded for this ` +
          'organization across all of its API keys',
        Math.max(1, Math.ceil((org.resetAt - Date.now()) / 1000)),
      );
    }
  };

  /** apiKeyGuard has already rejected session bearers and personal tokens. */
  const requireToken = (req: FastifyRequest): { principal: Principal; token: PartnerApiToken } => {
    const principal = requirePrincipal(req);
    if (!req.apiToken?.partnerId) throw forbidden('This partner API endpoint', 'partner-token');
    return { principal, token: { tokenId: req.apiToken.tokenId, partnerId: req.apiToken.partnerId } };
  };

  /** Loads a valuation, 404-ing anything outside the key's partner scope. */
  const loadScoped = async (token: PartnerApiToken, id: string): Promise<ValuationRow> => {
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation || valuation.partner_id !== token.partnerId) throw problems.notFound();
    return valuation;
  };

  // Reset the registry if the app is rebuilt in-process (tests build many apps).
  PARTNER_API_ENDPOINTS.length = 0;
  PARTNER_API_SCHEMAS.clear();

  /** Registers the route AND its documentation entry in one step. */
  const define = (
    doc: PartnerEndpointDoc,
    handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
    opts: { bodyLimit?: number; schemas?: OpenApiSchemas } = {},
  ): void => {
    PARTNER_API_ENDPOINTS.push(doc);
    if (opts.schemas) PARTNER_API_SCHEMAS.set(schemaKey(doc.method, doc.path), opts.schemas);
    const url = PARTNER_API_PREFIX + doc.path.replace(/\{(\w+)\}/g, ':$1');
    const routeOpts = {
      ...(doc.auth === 'api_key' ? { preHandler: [app.authenticate, apiKeyGuard] } : {}),
      ...(opts.bodyLimit ? { bodyLimit: opts.bodyLimit } : {}),
    };
    if (doc.method === 'GET') app.get(url, routeOpts, handler);
    else if (doc.method === 'DELETE') app.delete(url, routeOpts, handler);
    else if (doc.method === 'PUT') app.put(url, routeOpts, handler);
    else app.post(url, routeOpts, handler);
  };

  /**
   * Idempotency-Key support (partner API enhancements). A retried POST with
   * the same key replays the stored first response instead of re-executing;
   * the same key on a DIFFERENT body is a client bug and is refused. Keys are
   * scoped per partner, so two organisations cannot collide.
   *
   * The key is claimed before the work runs, not recorded after it (migration
   * 0160). Recording after cannot stop the retry that matters — the one sent
   * while the original is still in flight, because the client timed out or the
   * operator clicked twice — since both requests look the key up before either
   * writes, and both then create. Claiming first makes the primary key decide
   * which of them is the request and which is the duplicate.
   *
   * So a concurrent duplicate is refused rather than executed: 409, because we
   * cannot yet tell it what the original will answer, and a retry once the
   * original lands replays it. That is the same status Stripe returns for the
   * same situation, and the alternative — waiting for the first request inside
   * the second — holds a connection open for an answer the client can ask for
   * again in a second.
   *
   * What the key identifies is the whole request, not its body. The hash used
   * to cover `req.body` alone, which is sound only while exactly one endpoint
   * accepts a key — and stops being sound the moment a second one does, because
   * two of the operations here carry no body at all. `POST /webhooks/{A}/test`
   * and `POST /webhooks/{B}/test` both hash `null`, as do a test ping and a
   * delivery replay: reusing a key across any of those would find a completed
   * row whose hash matched and replay the *other* endpoint's response, reporting
   * success for a request that never ran. Hashing method and path with the body
   * makes every one of those a mismatch — a 409 telling the client to use a
   * fresh key, which is the conservative answer in each case.
   */
  const withIdempotency = async (
    req: FastifyRequest,
    reply: FastifyReply,
    token: PartnerApiToken,
    run: () => Promise<{ status: number; body: Record<string, unknown> }>,
  ): Promise<unknown> => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.trim() === '') {
      const out = await run();
      return reply.status(out.status).send(out.body);
    }
    if (key.length > 200) throw problems.unprocessable('Idempotency-Key must be 200 characters or fewer');
    // `req.url` rather than the route template, so two calls to the same
    // operation on different resources are different requests. The query string
    // rides along with it: no operation that takes a key reads one today, and
    // if one ever does, including it errs towards refusing a replay rather than
    // serving the wrong one.
    const requestHash = createHash('sha256')
      .update(`${req.method} ${req.url}\n${JSON.stringify(req.body ?? null)}`)
      .digest('hex');

    const claim = await claimIdempotencyKey(deps.pool, {
      partnerId: token.partnerId,
      key,
      requestHash,
    });
    if (claim.kind === 'mismatch') {
      // "a different request", not "a different request body": since the hash
      // covers method and path too, the commonest way to land here is now
      // reusing a key on a different endpoint or a different resource, and a
      // message naming only the body sends the client to inspect the one part
      // of the request that may well be identical.
      throw problems.conflict(
        'This Idempotency-Key was already used for a different request — a different body, or a ' +
          'different endpoint or resource. Use a fresh key per distinct request.',
      );
    }
    if (claim.kind === 'in_flight') {
      throw problems.conflict(
        'A request with this Idempotency-Key is still in flight — retry in a moment to receive its response',
      );
    }
    if (claim.kind === 'replay') {
      return reply
        .status(claim.row.response_status ?? 200)
        .header('x-idempotent-replay', 'true')
        .send(claim.row.response_body);
    }

    const out = await run();
    // Only success is worth replaying: a validation failure should be retried
    // with a corrected body under the same key, not replayed forever. Handing
    // the key back is safe precisely because a refusal wrote nothing — a throw
    // is a different question and is left to the takeover window, so this is
    // deliberately not a `finally`.
    if (out.status < 400) {
      await completeIdempotentResponse(deps.pool, {
        partnerId: token.partnerId,
        key,
        status: out.status,
        body: out.body,
      });
    } else {
      await releaseIdempotencyClaim(deps.pool, token.partnerId, key);
    }
    return reply.status(out.status).send(out.body);
  };

  define(
    {
      method: 'GET',
      path: '/docs',
      summary: 'This document — a machine-readable description of every partner API endpoint.',
      auth: 'none',
      response: '{ name, version, base_url, authentication, rate_limit, endpoints[] }',
    },
    async () => ({
      name: 'N409 Partner API',
      version: 'v1',
      base_url: PARTNER_API_PREFIX,
      authentication: {
        scheme: 'bearer',
        header: 'Authorization: Bearer n409_pat_…',
        note: 'Create and revoke API keys in partner settings. Session JWTs are rejected.',
      },
      rate_limit: {
        limit: limiter.limit,
        window_seconds: PARTNER_API_RATE_WINDOW_MS / 1000,
        // Reported from the limiter rather than the constant, so a deployment
        // that has turned the ceiling off does not advertise one, and one that
        // has moved it advertises where it actually is.
        organization_limit: orgLimiter?.limit ?? null,
        headers: [
          'x-ratelimit-limit',
          'x-ratelimit-remaining',
          'x-ratelimit-reset',
          ...(orgLimiter
            ? ['x-ratelimit-limit-partner', 'x-ratelimit-remaining-partner', 'x-ratelimit-reset-partner']
            : []),
        ],
      },
      endpoints: PARTNER_API_ENDPOINTS,
      openapi_url: `${PARTNER_API_PREFIX}/openapi.json`,
    }),
  );

  define(
    {
      method: 'GET',
      path: '/openapi.json',
      summary:
        'OpenAPI 3.1 specification for this API — import it into Postman, generate a typed client, ' +
        'or run it against a mock server.',
      auth: 'none',
      response: 'An OpenAPI 3.1 document describing every endpoint above.',
    },
    async (_req, reply) => {
      // Rebuilt per request rather than memoised: the registry is populated at
      // route-registration time, this endpoint is cold, and a cached document
      // is one more thing that can be stale after a hot reload. It is a pure
      // function of two in-memory structures.
      const document = buildOpenApiDocument({
        endpoints: PARTNER_API_ENDPOINTS,
        schemas: PARTNER_API_SCHEMAS,
        title: 'N409 Partner API',
        version: '1.0.0',
        serverUrl: PARTNER_API_PREFIX,
        rateLimit: {
          limit: limiter.limit,
          windowSeconds: PARTNER_API_RATE_WINDOW_MS / 1000,
          orgLimit: orgLimiter?.limit,
        },
      });
      // The registered media type for an OpenAPI document. Tools content-sniff
      // on it, and `application/json` makes some of them ask the user what the
      // file is.
      return reply.header('content-type', 'application/openapi+json; charset=utf-8').send(document);
    },
  );

  define(
    {
      method: 'GET',
      path: '/me',
      summary:
        'Identify the organization and key behind this request — the first call to make when ' +
        'wiring up an integration, and the one to make when a key stops working.',
      auth: 'api_key',
      response:
        '{ partner: { id, name, key, white_label_enabled, created_at }, token: { id, name, prefix, created_at, last_used_at } }',
      errors: {
        '404': 'The key is valid but its organization has been archived — the key identifies nobody.',
      },
    },
    async (req) => {
      const { token } = requireToken(req);
      // Both reads are by primary key and this endpoint is cold, so they are
      // not worth a join: the two rows answer two different questions, and a
      // join would make the archived-partner case below harder to state than
      // it is.
      const [partner, apiToken] = await Promise.all([
        findPartnerIdentity(deps.pool, token.partnerId),
        findApiTokenById(deps.pool, token.tokenId),
      ]);
      // A live key whose organisation has been archived. `apiKeyGuard` cannot
      // catch this — it resolves the token, and the token is fine. Answering
      // 404 rather than inventing an identity is the same rule the branding
      // reads follow, and it gives the partner the one diagnosis that is
      // actionable: the key is good, the account is not.
      if (!partner) throw problems.notFound();
      return {
        partner: {
          id: partner.id,
          name: partner.name,
          key: partner.key,
          white_label_enabled: partner.white_label_enabled,
          created_at: partner.created_at,
        },
        // The prefix, never the secret — it is the visible half of the key and
        // the only way a partner mid-rotation can tell which of their keys the
        // caller actually used. `last_used_at` is the other half of that
        // question: a key that answers here and has never been used anywhere
        // else is a key wired into the wrong environment.
        token: apiToken && {
          id: apiToken.id,
          name: apiToken.name,
          prefix: apiToken.token_prefix,
          created_at: apiToken.created_at,
          last_used_at: apiToken.last_used_at,
        },
        // Deliberately no rate-limit counters here. Every response on this API
        // already carries them as headers, including this one, and a body that
        // repeated them would be a second source for a number that changes
        // between the two being read. `GET /docs` states the limits.
      };
    },
    { schemas: { response: MeResponse } },
  );

  define(
    {
      method: 'POST',
      path: '/valuations',
      summary: 'Create a valuation of any report type for your partner organization.',
      auth: 'api_key',
      body: {
        kind: `Valuation kind — one of: ${VALUATION_KINDS.join(', ')}`,
        company_name: 'Company being valued (required)',
        service_name: 'Optional service label',
        currency: 'ISO-4217 code, defaults to USD',
        service_countries: 'Optional ISO-3166 alpha-2 country list',
        external_id:
          'Optional. Your own identifier for this engagement — a deal id, a CRM row. Unique within ' +
          'your organization, echoed back on every valuation payload, and accepted as a filter on ' +
          'GET /valuations. Unlike Idempotency-Key it travels in the request and is durable, so an ' +
          'engagement whose create response you never received is still findable by it.',
      },
      ...idempotencyDoc('creating a second valuation', {
        '409':
          'This external_id is already used by another valuation in your organization. Fetch it with ' +
          'GET /valuations?external_id=… rather than creating a second one.',
      }),
      response: '201 { valuation }',
    },
    async (req, reply) => {
      const { principal, token } = requireToken(req);
      const parsed = CreateBody.safeParse(req.body);
      if (!parsed.success) throw invalidBody('Invalid valuation', parsed.error);
      return withIdempotency(req, reply, token, async () => {
        const valuation = await createValuation(
          deps.pool,
          {
            kind: parsed.data.kind,
            companyName: parsed.data.company_name,
            serviceName: parsed.data.service_name,
            userId: principal.id,
            partnerId: token.partnerId,
            source: 'partner',
            currency: parsed.data.currency,
            serviceCountries: parsed.data.service_countries,
            externalId: parsed.data.external_id,
          },
          actorFor(principal),
        ).catch((err: unknown) => {
          // The unique index is what arbitrates, not a SELECT before the
          // INSERT: two concurrent creates carrying the same external_id both
          // see nothing and both proceed, which is the same race
          // `Idempotency-Key` had before 0160 turned its receipt into a claim.
          // Postgres decides; this only renames the decision.
          if (isUniqueViolation(err, 'valuations_partner_external_id_idx')) {
            throw problems.conflict(
              `external_id "${parsed.data.external_id}" is already used by another valuation in your ` +
                'organization. Fetch it with GET /valuations?external_id=… rather than creating a second one.',
            );
          }
          throw err;
        });
        return { status: 201, body: { valuation: publicValuation(valuation) } };
      });
    },
    { schemas: { body: CreateBody, response: CreateValuationResponse } },
  );

  define(
    {
      method: 'GET',
      path: '/valuations',
      summary: "List your partner organization's valuations.",
      auth: 'api_key',
      query: {
        state: 'Optional state filter',
        external_id:
          'Optional. Exact match on your own identifier — returns the one valuation carrying it, or ' +
          'an empty list.',
        page: 'Page number (default 1). Ignored when `cursor` is supplied.',
        per_page: 'Page size (default 25, max 100)',
        cursor:
          'Opaque cursor from a previous response. Prefer this to `page` when walking the whole ' +
          'list: page numbers shift under you as valuations are created, so a walk that pages by ' +
          'number can miss a row entirely, while a cursor walk cannot.',
      },
      response: '{ valuations[], page, per_page, total, next_cursor, has_more }',
    },
    async (req) => {
      const { token } = requireToken(req);
      const parsed = ListQuery.safeParse(req.query);
      if (!parsed.success) throw invalidQuery(parsed.error);
      const cursor = parsed.data.cursor === undefined ? null : decodeCursor(parsed.data.cursor);
      if (parsed.data.cursor !== undefined && !cursor) {
        throw problems.badRequest('Invalid cursor — pass a `next_cursor` from a previous response');
      }
      const { items, total, nextCursor, hasMore } = await listValuations(
        deps.pool,
        { kind: 'partner', partnerId: token.partnerId },
        {
          state: parsed.data.state,
          externalId: parsed.data.external_id,
          page: parsed.data.page,
          perPage: parsed.data.per_page,
          cursor,
        },
      );
      return {
        valuations: items.map(publicValuation),
        // Kept, and kept meaning what they meant, so a client already paging by
        // number is unaffected by cursors existing. On a cursor request `page`
        // echoes the default rather than a position, which is what it is.
        page: parsed.data.page,
        per_page: parsed.data.per_page,
        total,
        next_cursor: nextCursor,
        has_more: hasMore,
      };
    },
    { schemas: { query: ListQuery, response: ListValuationsResponse } },
  );

  define(
    {
      method: 'GET',
      path: '/valuations/{id}',
      summary: 'Check the status of a valuation.',
      auth: 'api_key',
      response:
        '{ valuation } — id, state, waiting_on_client, due_date, published_at, retired_at, …. ' +
        'A non-null `retired_at` means the firm has withdrawn the engagement: it stays readable, ' +
        'its state will not change again, and every write to it answers 409.',
    },
    async (req) => {
      const { token } = requireToken(req);
      const { id } = req.params as { id: string };
      return { valuation: publicValuation(await loadScoped(token, id)) };
    },
    { schemas: { response: GetValuationResponse } },
  );

  /**
   * The client-side states, in order, and where `submit` stops.
   *
   * A valuation created through the web app walks these as the founder fills
   * the questionnaire in. A partner integration collects the same information
   * in its own product, so those steps happen somewhere this service cannot
   * see, and without a way to say so the engagement sits in `pending` forever
   * — created by the API, uploaded to by the API, and never looked at by
   * anybody. That was the shape of the gap: the partner API could start work
   * and could not hand it over.
   *
   * Walked one edge at a time rather than written straight to the last one.
   * `WORKFLOW_TRANSITIONS` is the authority on what is legal, the dashboards
   * and SLA figures are keyed on the sequence — a file that arrives in `review`
   * without passing `completed` sits in the review queue with no `completed_at`
   * and an ageing figure computed from a timestamp nothing set — and each edge
   * has its own audit event and its own hook. Three steps is the whole distance
   * from `pending`, so the cost is three writes on a call that happens once per
   * engagement.
   */
  const SUBMIT_PATH = ['pending', 'started', 'onboarding_completed', 'user_finished'] as const;
  const SUBMIT_TARGET = 'user_finished';

  /**
   * States in which a partner may still correct the engagement's labels.
   *
   * The line is drawn where the deliverable starts being written: once a file
   * is in `review` an analyst is working from these values, and a company name
   * that changes underneath them appears in a report nobody re-read. Before
   * that it is still a submission.
   */
  const EDITABLE_STATES: ReadonlySet<string> = new Set([
    'pending',
    'started',
    'onboarding_completed',
    'user_finished',
    'completed',
    'paid',
  ]);

  define(
    {
      method: 'PUT',
      path: '/valuations/{id}',
      summary:
        "Correct an engagement's details before review begins — company name, service label, " +
        'currency, countries, or your own external_id.',
      auth: 'api_key',
      body: {
        company_name: 'Optional. Company being valued.',
        service_name: 'Optional service label. Send null to clear it.',
        currency: 'Optional ISO-4217 code.',
        service_countries: 'Optional ISO-3166 alpha-2 country list.',
        external_id: 'Optional. Your own identifier. Send null to clear it.',
      },
      errors: {
        '409':
          'This valuation has reached review — its details are being written into the deliverable and ' +
          'are no longer editable through the API — or the engagement has been retired, in which case ' +
          'no write to it will ever be accepted again. Contact your account manager.',
        '422': 'No editable field was supplied, or one of them is invalid.',
      },
      response: '{ valuation }',
    },
    async (req) => {
      const { principal, token } = requireToken(req);
      const { id } = req.params as { id: string };
      const valuation = await loadScoped(token, id);
      refuseIfRetired(valuation, 'accepting edits');

      const parsed = UpdateBody.safeParse(req.body ?? {});
      if (!parsed.success) throw invalidBody('Invalid update', parsed.error);
      if (Object.keys(parsed.data).length === 0) {
        // An empty body is far more likely to be a client that built the patch
        // wrong than a deliberate no-op, and answering 200 to it would report
        // that a correction landed when nothing was written.
        throw problems.unprocessable('No editable fields supplied');
      }
      if (!EDITABLE_STATES.has(valuation.state)) {
        throw problems.conflict(
          `This valuation is '${valuation.state}' — its details are being written into the deliverable ` +
            'and are no longer editable through the API.',
        );
      }

      // Mapped explicitly rather than spread: the body's names are the API's and
      // the row's are the database's, and a spread would make every future
      // column name part of the public contract by accident.
      const fields: Record<string, unknown> = {};
      if (parsed.data.company_name !== undefined) fields.company_name = parsed.data.company_name;
      if (parsed.data.service_name !== undefined) fields.service_name = parsed.data.service_name;
      if (parsed.data.currency !== undefined) fields.currency = parsed.data.currency;
      if (parsed.data.service_countries !== undefined) {
        fields.service_countries = parsed.data.service_countries;
      }
      if (parsed.data.external_id !== undefined) fields.external_id = parsed.data.external_id;

      const updated = await patchValuation(deps.pool, valuation, fields, actorFor(principal)).catch(
        (err: unknown) => {
          // Same index, same reason as the create path: two engagements in one
          // organization cannot share an external_id, and an update is just as
          // able to collide as a create.
          if (isUniqueViolation(err, 'valuations_partner_external_id_idx')) {
            throw problems.conflict(
              `external_id "${parsed.data.external_id}" is already used by another valuation in your ` +
                'organization.',
            );
          }
          throw err;
        },
      );
      return { valuation: publicValuation(updated) };
    },
    { schemas: { body: UpdateBody, response: GetValuationResponse } },
  );

  define(
    {
      method: 'POST',
      path: '/valuations/{id}/submit',
      summary:
        'Hand the engagement over for review — the client-side information is complete. Idempotent: ' +
        'a valuation already at or past this point is returned unchanged.',
      auth: 'api_key',
      ...idempotencyDoc('advancing the valuation a second time', {
        '409':
          'This valuation is cancelled, timed out or ignored — those need a restart rather than a ' +
          'submission — or the engagement has been retired, which nothing restarts. Contact your ' +
          'account manager.',
      }),
      response: '{ valuation }',
    },
    async (req, reply) => {
      const { principal, token } = requireToken(req);
      const { id } = req.params as { id: string };
      // Ahead of the key claim, for the same reason the upload route puts its
      // refusals there: a throw inside `run()` leaves the key in flight until
      // the takeover window expires, so a client retrying a refused submit
      // under the same key would be told its request is still running rather
      // than why it was refused. The reload inside is kept — it is what reads
      // the state after a concurrent claim resolves.
      refuseIfRetired(await loadScoped(token, id), 'accepting submissions');
      return withIdempotency(req, reply, token, async () => {
        let valuation = await loadScoped(token, id);
        const from = SUBMIT_PATH.indexOf(valuation.state as (typeof SUBMIT_PATH)[number]);

        if (from === -1) {
          // Either already submitted — every state past `user_finished` — or in
          // one of the three dead ends. The distinction matters: the first is a
          // retry and must succeed, the second is a request nobody can honour.
          // "Its only way forward is a restart" — which is what `cancelled`,
          // `timeout` and `ignored` have in common and what makes them
          // unsubmittable. Read off the transition table rather than listed
          // here, so a state added to the table with the same shape is covered
          // without this route being edited; `canRestart` is not the same
          // question, since it is true of almost every state.
          const restartOnly =
            WORKFLOW_TRANSITIONS[valuation.state].length === 1 &&
            WORKFLOW_TRANSITIONS[valuation.state][0] === 'started';
          if (restartOnly) {
            throw problems.conflict(
              `This valuation is '${valuation.state}' and cannot be submitted — it needs to be restarted first.`,
            );
          }
          return { status: 200, body: { valuation: publicValuation(valuation) } };
        }

        // Already at the target: a repeated submit, which is a retry rather than
        // an error. Falls out of the loop below doing nothing, and is spelled
        // out here only because "the loop happens not to run" is a fragile way
        // to express an idempotency guarantee.
        for (let i = from; i < SUBMIT_PATH.indexOf(SUBMIT_TARGET); i += 1) {
          valuation = await applyValuationState(
            { pool: deps.pool, transport: deps.transport, log: app.log },
            valuation,
            SUBMIT_PATH[i + 1]!,
            actorFor(principal),
          );
        }
        return { status: 200, body: { valuation: publicValuation(valuation) } };
      });
    },
    { schemas: { response: GetValuationResponse } },
  );

  define(
    {
      method: 'POST',
      path: '/valuations/{id}/documents',
      summary: 'Upload a supporting document (base64 body).',
      auth: 'api_key',
      body: {
        filename: 'Original file name',
        kind: `Document kind — one of: ${DOCUMENT_KINDS.join(', ')} (default other)`,
        content_type: 'MIME type (default application/octet-stream)',
        content_base64: `Base64-encoded file body (decoded max ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB)`,
      },
      ...idempotencyDoc('storing the file a second time', {
        // Two different limits, and a client that only handles one is surprised
        // by the other. The 413 is the transport refusing the request before a
        // handler runs; the 422 is this route rejecting the decoded bytes.
        '413':
          'The JSON envelope exceeded the request body limit — base64 inflates the file by about a third, ' +
          `so a file near the ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB cap can exceed it. Upload a smaller file.`,
        '409': 'The engagement has been retired and no longer accepts documents.',
      }),
      response: '201 { document } — includes the stored sha256 fingerprint',
    },
    async (req, reply) => {
      const { principal, token } = requireToken(req);
      const { id } = req.params as { id: string };
      const valuation = await loadScoped(token, id);
      refuseIfRetired(valuation, 'accepting documents');
      const parsed = UploadBody.safeParse(req.body);
      if (!parsed.success) throw invalidBody('Invalid upload', parsed.error);

      // Validate base64 encoding — Buffer.from silently skips invalid chars
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.data.content_base64)) {
        throw problems.unprocessable('content_base64 is not valid base64');
      }
      const buffer = Buffer.from(parsed.data.content_base64, 'base64');
      if (buffer.length === 0) throw problems.unprocessable('Uploaded file is empty');
      if (buffer.length > MAX_DOCUMENT_BYTES) {
        throw problems.unprocessable(`File exceeds the ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB limit`);
      }

      // File type validation — same as the session upload route (audit B-1 P2)
      const typeCheck = checkUploadType(parsed.data.filename, buffer);
      if (!typeCheck.ok) {
        throw problems.unprocessable(`Rejected upload: ${typeCheck.reason}`, {
          filename: safeFilename(parsed.data.filename),
          sniffed: typeCheck.sniffed,
        });
      }

      // Every refusal above happens before the key is claimed, deliberately:
      // they write nothing, and a client correcting a rejected upload should be
      // able to send it again under the same key. Only the store is inside.
      return withIdempotency(req, reply, token, async () => {
        const document = await storeDocument(
          deps.pool,
          deps.documentsDir,
          valuation,
          {
            kind: parsed.data.kind,
            filename: parsed.data.filename,
            contentType: parsed.data.content_type ?? 'application/octet-stream',
            buffer,
          },
          actorFor(principal),
          principal.id,
          { scan: deps.scan, log: req.log },
        ).catch(rethrowRejectedUpload(parsed.data.filename));
        return {
          status: 201,
          body: {
            document: {
              id: document.id,
              kind: document.kind,
              filename: document.filename,
              content_type: document.content_type,
              size_bytes: document.size_bytes,
              sha256: document.sha256,
              created_at: document.created_at,
            },
          },
        };
      });
    },
    // base64 inflates ~4/3 over the raw 25 MB cap, plus JSON envelope headroom
    {
      bodyLimit: Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 64 * 1024,
      schemas: { body: UploadBody, response: UploadDocumentResponse },
    },
  );

  define(
    {
      method: 'GET',
      path: '/valuations/{id}/results',
      summary: 'Retrieve results: latest calculation summary, documents, report availability.',
      auth: 'api_key',
      response:
        '{ valuation, calculation | null, documents[], report: { available, version } } — report.available stays false until a draft has been shared',
    },
    async (req) => {
      const { principal, token } = requireToken(req);
      const { id } = req.params as { id: string };
      const valuation = await loadScoped(token, id);
      const reportReadable = partnerCanReadReport(principal, valuation);
      const [calculation, documents, report] = await Promise.all([
        // `equity_value` and `fmv_per_share` below are 409A column names every
        // engine writes into, so which run they come off has to be the one this
        // engagement's kind is measured in — see `latestCalculationForKind`.
        // Otherwise an ordinary compute run on an EMI engagement flips the
        // published per-share figure from the restricted AMV to an
        // unrestricted §409A price, and the payload says only that it is newer.
        latestCalculationForKind(deps.pool, valuation.id, valuation.kind),
        listDocuments(deps.pool, valuation.id),
        reportReadable ? findReportByValuation(deps.pool, valuation.id) : null,
      ]);
      const versions = report ? (await listVersions(deps.pool, report.id)).versions : [];
      const rendered = versions.find((v) => v.has_pdf);
      return {
        valuation: publicValuation(valuation),
        calculation: calculation
          ? {
              engine_version: calculation.engine_version,
              equity_value: calculation.equity_value,
              fmv_per_share: calculation.fmv_per_share,
              created_at: calculation.created_at,
            }
          : null,
        documents: documents.documents.map((d) => ({
          id: d.id,
          kind: d.kind,
          filename: d.filename,
          sha256: d.sha256,
          created_at: d.created_at,
        })),
        documents_truncated: documents.truncated,
        report: { available: Boolean(rendered), version: rendered?.version ?? null },
      };
    },
    { schemas: { response: ResultsResponse } },
  );

  define(
    {
      method: 'GET',
      path: '/valuations/{id}/report.pdf',
      summary: 'Download the latest rendered report PDF (404 until a draft has been shared with you).',
      auth: 'api_key',
      response: 'application/pdf',
    },
    async (req, reply) => {
      const { principal, token } = requireToken(req);
      const { id } = req.params as { id: string };
      const valuation = await loadScoped(token, id);
      // Same 404 as "not rendered yet": whether a draft exists internally is
      // not something to disclose before it is shared.
      if (!partnerCanReadReport(principal, valuation)) throw problems.notFound('No rendered report yet');
      const report = await findReportByValuation(deps.pool, valuation.id);
      const versions = report ? (await listVersions(deps.pool, report.id)).versions : [];
      const rendered = versions.find((v) => v.has_pdf);
      if (!report || !rendered) throw problems.notFound('No rendered report yet');
      const full = await getVersionContent(deps.pool, report.id, rendered.version);
      if (!full?.has_pdf) throw problems.notFound('No rendered report yet');
      /*
       * Through the same render-or-reuse decision the session API uses, rather
       * than sending `full.pdf` straight out.
       *
       * This channel is the one that most needs it. A partner's integration
       * pulls the deliverable on the `valuation.published` webhook — that is
       * what the endpoint is for — so the very first read of these bytes is
       * the read that happens seconds after the stamp stopped being true, and
       * it lands in the partner's own document store where nothing will ever
       * revisit it.
       */
      // `actorFor` with this door's own source, rather than a `system` actor
      // carrying a principal id — the file's own convention two hundred lines
      // up is `human`, and the two disagreeing meant one partner's reads were
      // filed under the platform and the rest under the partner.
      const actor: EventActor = { ...actorFor(principal), source: 'partner-api-report.pdf' };
      const pdf = await deliverablePdf(deps.pool, valuation, report, full, actor);
      // The deliverable leaving by the second of its three doors. This is the
      // channel that pulls it automatically on `valuation.published`, so it is
      // also the one whose reads are least likely to be remembered by anybody.
      await withTransaction(deps.pool, (client) =>
        recordEvent(client, {
          valuationId: valuation.id,
          type: 'report_downloaded',
          actor,
          payload: {
            version: full.version,
            size_bytes: pdf.length,
            report_status: reportStatusFor(valuation.state),
            partner_id: token.partnerId,
          },
        }),
      );
      return reply
        .header('content-type', 'application/pdf')
        .header(
          'content-disposition',
          `attachment; filename="report-${valuation.number}-v${full.version}.pdf"`,
        )
        .send(pdf);
    },
  );

  // ── Webhooks ────────────────────────────────────────────────────────────────

  /** The projection the API returns — the signing secret only travels once. */
  const publicWebhook = (w: PartnerWebhookRow, includeSecret = false) => ({
    id: w.id,
    url: w.url,
    events: w.events,
    enabled: w.enabled,
    created_at: w.created_at,
    ...(includeSecret ? { secret: w.secret } : {}),
  });

  const WebhookBody = z.object({
    url: z.string().min(1).max(2000),
    /** Empty or omitted = every event. */
    events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).max(20).default([]),
  });

  define(
    {
      method: 'POST',
      path: '/webhooks',
      summary:
        'Register a webhook endpoint. Events fire for every report type; deliveries are signed ' +
        'HMAC-SHA256 over the raw body (x-n409-signature: sha256=<hex>).',
      auth: 'api_key',
      body: {
        url: 'HTTPS endpoint to deliver events to',
        events: `Optional event whitelist — any of: ${WEBHOOK_EVENT_TYPES.join(', ')} (empty = all)`,
      },
      ...idempotencyDoc('registering a second endpoint', {
        '409': 'The ten-webhook ceiling for this organisation is already reached.',
      }),
      response: '201 { webhook } — includes the signing secret, shown only in this response',
    },
    async (req, reply) => {
      const { principal, token } = requireToken(req);
      const parsed = WebhookBody.safeParse(req.body);
      if (!parsed.success) throw invalidBody('Invalid webhook', parsed.error);
      if (!isValidWebhookUrl(parsed.data.url)) {
        throw problems.unprocessable(
          'Webhook URL must be a public http(s) endpoint — loopback, private and link-local addresses are not delivered to',
        );
      }
      const existing = await listWebhooks(deps.pool, token.partnerId);
      if (existing.length >= 10) {
        throw problems.conflict('A partner may register at most 10 webhooks — delete one first');
      }
      // The one response on this API that cannot be asked for again: the
      // signing secret is shown here and never repeated. A create whose reply
      // was lost to a timeout therefore leaves the partner an endpoint they
      // cannot verify deliveries against and must find and delete by hand, so
      // replaying the stored response is worth more here than anywhere else.
      return withIdempotency(req, reply, token, async () => {
        const webhook = await createWebhook(deps.pool, {
          partnerId: token.partnerId,
          url: parsed.data.url,
          secret: newWebhookSecret(),
          events: parsed.data.events,
          createdBy: principal.id,
        });
        return { status: 201, body: { webhook: publicWebhook(webhook, true) } };
      });
    },
    { schemas: { body: WebhookBody, response: CreateWebhookResponse } },
  );

  define(
    {
      method: 'GET',
      path: '/webhooks',
      summary: "List your organization's webhooks (signing secrets are not repeated).",
      auth: 'api_key',
      response: '{ webhooks[] }',
    },
    async (req) => {
      const { token } = requireToken(req);
      return { webhooks: (await listWebhooks(deps.pool, token.partnerId)).map((w) => publicWebhook(w)) };
    },
    { schemas: { response: ListWebhooksResponse } },
  );

  define(
    {
      method: 'DELETE',
      path: '/webhooks/{id}',
      summary: 'Delete a webhook.',
      auth: 'api_key',
      response: '{ deleted: true }',
    },
    async (req) => {
      const { token } = requireToken(req);
      const { id } = req.params as { id: string };
      if (!isUlid(id) || !(await deleteWebhook(deps.pool, token.partnerId, id))) {
        throw problems.notFound();
      }
      return { deleted: true };
    },
    { schemas: { response: DeleteWebhookResponse } },
  );

  define(
    {
      method: 'GET',
      path: '/webhooks/{id}/deliveries',
      summary: 'Delivery attempts for a webhook, newest first — your audit trail for missed events.',
      auth: 'api_key',
      query: {
        limit: `Page size (default ${DELIVERIES_PAGE_DEFAULT}, max ${DELIVERIES_PAGE_MAX})`,
        cursor:
          'Opaque cursor from a previous response — pass `next_cursor` to fetch the next page, or ' +
          "any row's own `cursor` to resume from just after that delivery. Omit for the newest page.",
      },
      response:
        '{ deliveries[], next_cursor, has_more } — event_type, status (pending = another retry is ' +
        'owed, failed = out of attempts), attempts, max_attempts, next_attempt_at, last_error, ' +
        'created_at. Keyset-paginated: new deliveries land on the first page rather than shifting ' +
        'the ones you have already read, so walking `next_cursor` to `has_more: false` sees every ' +
        'row exactly once even while events are still arriving.',
    },
    async (req) => {
      const { token } = requireToken(req);
      const { id } = req.params as { id: string };
      if (!isUlid(id)) throw problems.notFound();
      const webhook = await findWebhook(deps.pool, token.partnerId, id);
      if (!webhook) throw problems.notFound();
      const parsed = DeliveriesQuery.safeParse(req.query);
      if (!parsed.success) throw invalidQuery(parsed.error);
      // A cursor we did not write is the caller's error, not a 500 from the
      // driver failing to cast it — and saying so by name is the difference
      // between "fix your pagination loop" and "the API is broken".
      const cursor = parsed.data.cursor === undefined ? null : decodeCursor(parsed.data.cursor);
      if (parsed.data.cursor !== undefined && !cursor) {
        throw problems.badRequest('Invalid cursor — pass a `next_cursor` from a previous response');
      }
      const page = await listDeliveries(deps.pool, id, { limit: parsed.data.limit, cursor });
      return {
        next_cursor: page.nextCursor,
        has_more: page.hasMore,
        deliveries: page.items.map((d) => ({
          cursor: d.cursor,
          id: d.id,
          event_type: d.event_type,
          valuation_id: d.valuation_id,
          status: d.status,
          attempts: d.attempts,
          max_attempts: d.max_attempts,
          // Only meaningful while more attempts are owed; on a settled row it
          // is the time of the attempt that settled it, which reads as a lie.
          next_attempt_at: d.status === 'pending' ? d.next_attempt_at : null,
          last_error: d.last_error,
          created_at: d.created_at,
          delivered_at: d.delivered_at,
        })),
      };
    },
    { schemas: { query: DeliveriesQuery, response: ListDeliveriesResponse } },
  );

  define(
    {
      method: 'POST',
      path: '/webhooks/{id}/deliveries/{deliveryId}/retry',
      summary:
        'Replay a delivery that ran out of attempts, once your receiver is back. Resets the ' +
        'backoff ladder; an already-delivered event cannot be replayed from here.',
      auth: 'api_key',
      ...idempotencyDoc('resetting the backoff ladder a second time'),
      response: '{ delivery } — status is pending; the sweep picks it up within the minute',
    },
    async (req, reply) => {
      const { token } = requireToken(req);
      const { id, deliveryId } = req.params as { id: string; deliveryId: string };
      if (!isUlid(id) || !isUlid(deliveryId)) throw problems.notFound();
      const webhook = await findWebhook(deps.pool, token.partnerId, id);
      if (!webhook) throw problems.notFound();
      // Checked before the key is claimed, so a mistyped delivery id costs a
      // 404 rather than five minutes of the key reading as in-flight. The same
      // conditions are re-decided by the UPDATE below, which is what actually
      // arbitrates; this only moves the ordinary refusal in front of the claim.
      const existing = await findDeliveryForPartner(deps.pool, token.partnerId, deliveryId);
      if (!existing || existing.webhook_id !== webhook.id || existing.status === 'delivered') {
        throw problems.notFound('No replayable delivery with that id');
      }
      return withIdempotency(req, reply, token, async () => {
        const delivery = await requeueDelivery(deps.pool, token.partnerId, deliveryId);
        if (!delivery || delivery.webhook_id !== webhook.id) {
          // Only reachable if the row was delivered or removed between the
          // check above and here, which is the one case where holding the key
          // is right: we cannot say whether the replay took.
          throw problems.notFound('No replayable delivery with that id');
        }
        return {
          status: 200,
          body: {
            delivery: {
              id: delivery.id,
              event_type: delivery.event_type,
              status: delivery.status,
              attempts: delivery.attempts,
              max_attempts: delivery.max_attempts,
              next_attempt_at: delivery.next_attempt_at,
            },
          },
        };
      });
    },
    { schemas: { response: RetryDeliveryResponse } },
  );

  define(
    {
      method: 'POST',
      path: '/webhooks/{id}/test',
      summary: 'Send a signed webhook.test ping so you can verify your receiver end-to-end.',
      auth: 'api_key',
      ...idempotencyDoc('sending a second ping'),
      response:
        '{ delivered, delivery_id, error } — on a failure, `error` is the same line the ' +
        'delivery log shows and `delivery_id` is the row it is on',
    },
    async (req, reply) => {
      const { token } = requireToken(req);
      const { id } = req.params as { id: string };
      if (!isUlid(id)) throw problems.notFound();
      const webhook = await findWebhook(deps.pool, token.partnerId, id);
      if (!webhook) throw problems.notFound();
      return withIdempotency(req, reply, token, async () => {
        const payload = buildWebhookPayload('webhook.test', null, { webhook_id: webhook.id });
        // `attemptDelivery` rather than `deliverToWebhook`: this is the one
        // caller whose whole purpose is to report the attempt to a person.
        // `delivered: false` alone named no condition and pointed nowhere — the
        // reason was already written to the delivery row, but finding it meant
        // listing the log and guessing which row was this ping. Both come back
        // here now, and `error` is character-for-character what the log shows.
        const attempt = await attemptDelivery(
          { pool: deps.pool, log: req.log },
          webhook,
          'webhook.test',
          payload,
        );
        return {
          status: 200,
          body: {
            delivered: attempt.outcome === 'delivered',
            delivery_id: attempt.deliveryId,
            error: attempt.error,
          },
        };
      });
    },
    { schemas: { response: TestWebhookResponse } },
  );
}
