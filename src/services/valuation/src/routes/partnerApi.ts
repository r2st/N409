import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import type { Principal } from '../auth/rbac.js';
import { requirePrincipal } from '../plugins/auth.js';
import { FixedWindowRateLimiter } from '../plugins/rateLimit.js';
import { VALUATION_KINDS, VALUATION_STATES } from '../domain/valuation.js';
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
import { MAX_DOCUMENT_BYTES, storeDocument } from './documents.js';
import { checkUploadType } from '../documents/fileType.js';
import type { EventActor } from '../events/record.js';

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
  method: 'GET' | 'POST';
  path: string;
  summary: string;
  auth: 'api_key' | 'none';
  body?: Record<string, string>;
  query?: Record<string, string>;
  response: string;
}

/** Registry the routes are registered from — GET /docs serializes exactly this. */
export const PARTNER_API_ENDPOINTS: PartnerEndpointDoc[] = [];

const CreateBody = z.object({
  kind: z.enum(VALUATION_KINDS),
  company_name: z.string().min(1).max(300),
  service_name: z.string().min(1).max(300).optional(),
  currency: z.string().length(3).optional(),
  service_countries: z.array(z.string().length(2)).max(50).optional(),
});

const ListQuery = z.object({
  state: z.enum(VALUATION_STATES).optional(),
  page: z.coerce.number().int().min(1).default(1),
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

export function registerPartnerApiRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; documentsDir: string; limiter?: FixedWindowRateLimiter },
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
      void reply.header('retry-after', Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000)));
      throw problems.tooManyRequests(
        `Rate limit of ${result.limit} requests per ${PARTNER_API_RATE_WINDOW_MS / 1000}s exceeded for this API key`,
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

  /** Registers the route AND its documentation entry in one step. */
  const define = (
    doc: PartnerEndpointDoc,
    handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
    opts: { bodyLimit?: number } = {},
  ): void => {
    PARTNER_API_ENDPOINTS.push(doc);
    const url = PARTNER_API_PREFIX + doc.path.replace(/\{(\w+)\}/g, ':$1');
    const routeOpts = {
      ...(doc.auth === 'api_key' ? { preHandler: [app.authenticate, apiKeyGuard] } : {}),
      ...(opts.bodyLimit ? { bodyLimit: opts.bodyLimit } : {}),
    };
    if (doc.method === 'GET') app.get(url, routeOpts, handler);
    else app.post(url, routeOpts, handler);
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
    }),
  );

  define(
    {
      method: 'POST',
      path: '/valuations',
      summary: 'Create a valuation for your partner organization.',
      auth: 'api_key',
      body: {
        kind: `Valuation kind — one of: ${VALUATION_KINDS.join(', ')}`,
        company_name: 'Company being valued (required)',
        service_name: 'Optional service label',
        currency: 'ISO-4217 code, defaults to USD',
        service_countries: 'Optional ISO-3166 alpha-2 country list',
      },
      response: '201 { valuation }',
    },
    async (req, reply) => {
      const { principal, token } = requireToken(req);
      const parsed = CreateBody.safeParse(req.body);
      if (!parsed.success)
        throw problems.unprocessable('Invalid valuation', { errors: parsed.error.issues });
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
      return reply.status(201).send({ valuation: publicValuation(valuation) });
    },
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
      if (!parsed.success)
        throw problems.unprocessable('Invalid upload', { errors: parsed.error.issues });

      // Validate base64 encoding — Buffer.from silently skips invalid chars
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.data.content_base64)) {
        throw problems.unprocessable('content_base64 is not valid base64');
      }
      const buffer = Buffer.from(parsed.data.content_base64, 'base64');
      if (buffer.length === 0) throw problems.unprocessable('Uploaded file is empty');
      if (buffer.length > MAX_DOCUMENT_BYTES) {
        throw problems.unprocessable(
          `File exceeds the ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB limit`,
        );
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
      );
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
    { bodyLimit: Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 64 * 1024 },
  );

  define(
    {
      method: 'GET',
      path: '/valuations/{id}/results',
      summary: 'Retrieve results: latest calculation summary, documents, report availability.',
      auth: 'api_key',
      response: '{ valuation, calculation | null, documents[], report: { available, version } }',
    },
    async (req) => {
      const { token } = requireToken(req);
      const { id } = req.params as { id: string };
      const valuation = await loadScoped(token, id);
      const [calculation, documents, report] = await Promise.all([
        latestSucceededCalculation(deps.pool, valuation.id),
        listDocuments(deps.pool, valuation.id),
        findReportByValuation(deps.pool, valuation.id),
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
      summary: 'Download the latest rendered report PDF (404 until one exists).',
      auth: 'api_key',
      response: 'application/pdf',
    },
    async (req, reply) => {
      const { token } = requireToken(req);
      const { id } = req.params as { id: string };
      const valuation = await loadScoped(token, id);
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
}
