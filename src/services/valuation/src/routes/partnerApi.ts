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
import { deliverToWebhook } from '../hooks/partnerWebhooks.js';
import {
  createWebhook,
  deleteWebhook,
  findIdempotentResponse,
  findWebhook,
  listDeliveries,
  listWebhooks,
  requeueDelivery,
  storeIdempotentResponse,
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
  type ValuationRow,
} from '../repos/valuations.js';
import { listDocuments } from '../repos/documents.js';
import { latestSucceededCalculation } from '../repos/calculations.js';
import { findReportByValuation, getVersion, listVersions } from '../repos/reports.js';
import { MAX_DOCUMENT_BYTES, rethrowRejectedUpload, storeDocument } from './documents.js';
import type { ScanPolicy } from '../documents/virusScan.js';
import { checkUploadType } from '../documents/fileType.js';
import type { EventActor } from '../events/record.js';
import { pageParam } from '../domain/pagination.js';
import { buildOpenApiDocument, schemaKey, type OpenApiSchemas } from '../domain/openapi.js';

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

export interface PartnerEndpointDoc {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  summary: string;
  auth: 'api_key' | 'none';
  body?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  response: string;
}

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
});

const ListQuery = z.object({
  state: z.enum(VALUATION_STATES).optional(),
  page: pageParam(),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

const UploadBody = z.object({
  filename: z.string().min(1).max(300),
  kind: z.enum(DOCUMENT_KINDS).default('other'),
  content_type: z.string().max(200).optional(),
  /** Base64-encoded file body — friendlier than multipart for API clients. */
  content_base64: z.string().min(1),
});

/** The projection API clients see — internal ids/flags stay internal. */
function publicValuation(v: ValuationRow) {
  return {
    id: v.id,
    number: v.number,
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
    limiter?: FixedWindowRateLimiter;
    scan?: ScanPolicy;
  },
): void {
  const limiter =
    deps.limiter ?? new FixedWindowRateLimiter(PARTNER_API_RATE_LIMIT, PARTNER_API_RATE_WINDOW_MS);

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
    if (!result.allowed) {
      throw problems.tooManyRequests(
        `Rate limit of ${result.limit} requests per ${PARTNER_API_RATE_WINDOW_MS / 1000}s exceeded for this API key`,
        Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000)),
      );
    }
  };

  /** apiKeyGuard has already rejected session bearers and personal tokens. */
  const requireToken = (req: FastifyRequest): { principal: Principal; token: PartnerApiToken } => {
    const principal = requirePrincipal(req);
    if (!req.apiToken?.partnerId) throw problems.forbidden();
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
    else app.post(url, routeOpts, handler);
  };

  /**
   * Idempotency-Key support (partner API enhancements). A retried POST with
   * the same key replays the stored first response instead of re-executing;
   * the same key on a DIFFERENT body is a client bug and is refused. Keys are
   * scoped per partner, so two organisations cannot collide.
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
    const requestHash = createHash('sha256')
      .update(JSON.stringify(req.body ?? null))
      .digest('hex');
    const stored = await findIdempotentResponse(deps.pool, token.partnerId, key);
    if (stored) {
      if (stored.request_hash !== requestHash) {
        throw problems.conflict(
          'This Idempotency-Key was already used for a different request body — use a fresh key per request',
        );
      }
      return reply
        .status(stored.response_status)
        .header('x-idempotent-replay', 'true')
        .send(stored.response_body);
    }
    const out = await run();
    // Only success is worth replaying: a validation failure should be retried
    // with a corrected body under the same key, not replayed forever.
    if (out.status < 400) {
      await storeIdempotentResponse(deps.pool, {
        partnerId: token.partnerId,
        key,
        requestHash,
        status: out.status,
        body: out.body,
      });
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
        limit: PARTNER_API_RATE_LIMIT,
        window_seconds: PARTNER_API_RATE_WINDOW_MS / 1000,
        headers: ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'],
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
          limit: PARTNER_API_RATE_LIMIT,
          windowSeconds: PARTNER_API_RATE_WINDOW_MS / 1000,
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
      },
      headers: {
        'Idempotency-Key':
          'Optional. A retried request with the same key replays the original response instead of ' +
          'creating a second valuation; reusing a key with a different body is refused.',
      },
      response: '201 { valuation }',
    },
    async (req, reply) => {
      const { principal, token } = requireToken(req);
      const parsed = CreateBody.safeParse(req.body);
      if (!parsed.success) throw problems.unprocessable('Invalid valuation', { errors: parsed.error.issues });
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
          },
          actorFor(principal),
        );
        return { status: 201, body: { valuation: publicValuation(valuation) } };
      });
    },
    { schemas: { body: CreateBody } },
  );

  define(
    {
      method: 'GET',
      path: '/valuations',
      summary: "List your partner organization's valuations.",
      auth: 'api_key',
      query: {
        state: 'Optional state filter',
        page: 'Page number (default 1)',
        per_page: 'Page size (default 25, max 100)',
      },
      response: '{ valuations[], page, per_page, total }',
    },
    async (req) => {
      const { token } = requireToken(req);
      const parsed = ListQuery.safeParse(req.query);
      if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
      const { items, total } = await listValuations(
        deps.pool,
        { kind: 'partner', partnerId: token.partnerId },
        { state: parsed.data.state, page: parsed.data.page, perPage: parsed.data.per_page },
      );
      return {
        valuations: items.map(publicValuation),
        page: parsed.data.page,
        per_page: parsed.data.per_page,
        total,
      };
    },
    { schemas: { query: ListQuery } },
  );

  define(
    {
      method: 'GET',
      path: '/valuations/{id}',
      summary: 'Check the status of a valuation.',
      auth: 'api_key',
      response: '{ valuation } — id, state, waiting_on_client, due_date, published_at, …',
    },
    async (req) => {
      const { token } = requireToken(req);
      const { id } = req.params as { id: string };
      return { valuation: publicValuation(await loadScoped(token, id)) };
    },
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
      response: '201 { document } — includes the stored sha256 fingerprint',
    },
    async (req, reply) => {
      const { principal, token } = requireToken(req);
      const { id } = req.params as { id: string };
      const valuation = await loadScoped(token, id);
      const parsed = UploadBody.safeParse(req.body);
      if (!parsed.success) throw problems.unprocessable('Invalid upload', { errors: parsed.error.issues });

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
          filename: parsed.data.filename,
          sniffed: typeCheck.sniffed,
        });
      }

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
        { scan: deps.scan },
      ).catch(rethrowRejectedUpload(parsed.data.filename));
      return reply.status(201).send({
        document: {
          id: document.id,
          kind: document.kind,
          filename: document.filename,
          content_type: document.content_type,
          size_bytes: document.size_bytes,
          sha256: document.sha256,
          created_at: document.created_at,
        },
      });
    },
    // base64 inflates ~4/3 over the raw 25 MB cap, plus JSON envelope headroom
    { bodyLimit: Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 64 * 1024, schemas: { body: UploadBody } },
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
        latestSucceededCalculation(deps.pool, valuation.id),
        listDocuments(deps.pool, valuation.id),
        reportReadable ? findReportByValuation(deps.pool, valuation.id) : null,
      ]);
      const versions = report ? await listVersions(deps.pool, report.id) : [];
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
        documents: documents.map((d) => ({
          id: d.id,
          kind: d.kind,
          filename: d.filename,
          sha256: d.sha256,
          created_at: d.created_at,
        })),
        report: { available: Boolean(rendered), version: rendered?.version ?? null },
      };
    },
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
      const versions = report ? await listVersions(deps.pool, report.id) : [];
      const rendered = versions.find((v) => v.has_pdf);
      if (!report || !rendered) throw problems.notFound('No rendered report yet');
      const full = await getVersion(deps.pool, report.id, rendered.version);
      if (!full?.pdf) throw problems.notFound('No rendered report yet');
      return reply
        .header('content-type', 'application/pdf')
        .header(
          'content-disposition',
          `attachment; filename="report-${valuation.number}-v${full.version}.pdf"`,
        )
        .send(full.pdf);
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
      response: '201 { webhook } — includes the signing secret, shown only in this response',
    },
    async (req, reply) => {
      const { principal, token } = requireToken(req);
      const parsed = WebhookBody.safeParse(req.body);
      if (!parsed.success) throw problems.unprocessable('Invalid webhook', { errors: parsed.error.issues });
      if (!isValidWebhookUrl(parsed.data.url)) {
        throw problems.unprocessable(
          'Webhook URL must be a public http(s) endpoint — loopback, private and link-local addresses are not delivered to',
        );
      }
      const existing = await listWebhooks(deps.pool, token.partnerId);
      if (existing.length >= 10) {
        throw problems.conflict('A partner may register at most 10 webhooks — delete one first');
      }
      const webhook = await createWebhook(deps.pool, {
        partnerId: token.partnerId,
        url: parsed.data.url,
        secret: newWebhookSecret(),
        events: parsed.data.events,
        createdBy: principal.id,
      });
      return reply.status(201).send({ webhook: publicWebhook(webhook, true) });
    },
    { schemas: { body: WebhookBody } },
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
  );

  define(
    {
      method: 'GET',
      path: '/webhooks/{id}/deliveries',
      summary: 'Recent delivery attempts for a webhook — your audit trail for missed events.',
      auth: 'api_key',
      response:
        '{ deliveries[] } — event_type, status (pending = another retry is owed, failed = out of ' +
        'attempts), attempts, max_attempts, next_attempt_at, last_error, created_at',
    },
    async (req) => {
      const { token } = requireToken(req);
      const { id } = req.params as { id: string };
      if (!isUlid(id)) throw problems.notFound();
      const webhook = await findWebhook(deps.pool, token.partnerId, id);
      if (!webhook) throw problems.notFound();
      const deliveries = await listDeliveries(deps.pool, id);
      return {
        deliveries: deliveries.map((d) => ({
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
  );

  define(
    {
      method: 'POST',
      path: '/webhooks/{id}/deliveries/{deliveryId}/retry',
      summary:
        'Replay a delivery that ran out of attempts, once your receiver is back. Resets the ' +
        'backoff ladder; an already-delivered event cannot be replayed from here.',
      auth: 'api_key',
      response: '{ delivery } — status is pending; the sweep picks it up within the minute',
    },
    async (req) => {
      const { token } = requireToken(req);
      const { id, deliveryId } = req.params as { id: string; deliveryId: string };
      if (!isUlid(id) || !isUlid(deliveryId)) throw problems.notFound();
      const webhook = await findWebhook(deps.pool, token.partnerId, id);
      if (!webhook) throw problems.notFound();
      const delivery = await requeueDelivery(deps.pool, token.partnerId, deliveryId);
      if (!delivery || delivery.webhook_id !== webhook.id) {
        throw problems.notFound('No replayable delivery with that id');
      }
      return {
        delivery: {
          id: delivery.id,
          event_type: delivery.event_type,
          status: delivery.status,
          attempts: delivery.attempts,
          max_attempts: delivery.max_attempts,
          next_attempt_at: delivery.next_attempt_at,
        },
      };
    },
  );

  define(
    {
      method: 'POST',
      path: '/webhooks/{id}/test',
      summary: 'Send a signed webhook.test ping so you can verify your receiver end-to-end.',
      auth: 'api_key',
      response: '{ delivered: boolean }',
    },
    async (req) => {
      const { token } = requireToken(req);
      const { id } = req.params as { id: string };
      if (!isUlid(id)) throw problems.notFound();
      const webhook = await findWebhook(deps.pool, token.partnerId, id);
      if (!webhook) throw problems.notFound();
      const payload = buildWebhookPayload('webhook.test', null, { webhook_id: webhook.id });
      const outcome = await deliverToWebhook(
        { pool: deps.pool, log: req.log },
        webhook,
        'webhook.test',
        payload,
      );
      return { delivered: outcome === 'delivered' };
    },
  );
}
