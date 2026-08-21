import { z } from 'zod';
import { DOCUMENT_KINDS } from './pipeline.js';
import { PAID_STATUSES, VALUATION_KINDS, VALUATION_STATES } from './valuation.js';
import { WEBHOOK_EVENT_TYPES } from './partnerWebhooks.js';

/**
 * The success bodies of the partner API, as zod schemas over the *serialized*
 * JSON a partner actually receives.
 *
 * Two consumers, and it is the second that makes this worth having:
 *
 *  - `GET /openapi.json` renders these as the response schema of each
 *    operation, so a generated client is typed on the way out as well as in.
 *  - `test/integration/partnerApiContract.test.ts` parses real responses
 *    through them. A response schema has no validator behind it — nothing in
 *    the request path can enforce a shape that is *built* rather than parsed —
 *    so without that test this file is a second, hand-written description of
 *    the payload, which is precisely the kind of documentation that drifts.
 *
 * Every object is `.strict()`. Adding a field to a projection in
 * `routes/partnerApi.ts` and not to the schema here fails the contract test
 * instead of shipping a spec that under-reports the payload. It is deliberately
 * the annoying direction to get wrong: the spec is what partners write code
 * against, so an undocumented field should stop a merge, not a partner.
 *
 * The serialization is the point of several of these types and none of them are
 * guesses:
 *
 *  - `number` is a `bigint` column, so pg hands it back as a string;
 *  - `equity_value` / `fmv_per_share` are `numeric`, likewise strings, and
 *    typing them as JSON numbers is how a client silently rounds a valuation;
 *  - every timestamp is a `Date` in the row and an ISO-8601 string on the wire.
 */

/** ISO-8601, which is what `JSON.stringify` does to a `Date`. */
const Timestamp = z.string().datetime({ offset: true });
/** A `numeric`/`bigint` column: exact decimal, carried as a string. */
const DecimalString = z.string();

export const PublicValuationSchema = z
  .object({
    id: z.string(),
    number: DecimalString,
    kind: z.enum(VALUATION_KINDS),
    state: z.enum(VALUATION_STATES),
    waiting_on_client: z.boolean(),
    company_name: z.string(),
    service_name: z.string().nullable(),
    currency: z.string(),
    paid_status: z.enum(PAID_STATUSES),
    created_at: Timestamp,
    due_date: Timestamp.nullable(),
    published_at: Timestamp.nullable(),
  })
  .strict();

export const PublicDocumentSchema = z
  .object({
    id: z.string(),
    kind: z.enum(DOCUMENT_KINDS),
    filename: z.string(),
    content_type: z.string(),
    /**
     * `bigint`, so a string like every other bigint on this API — the same
     * reason `number` is one. Typing it as a JSON number would be the more
     * natural-looking spec and a wrong one: a client generated from it parses
     * `"24"` into a type it was told is numeric and fails on the first upload.
     */
    size_bytes: DecimalString,
    sha256: z.string(),
    created_at: Timestamp,
  })
  .strict();

/** The results projection carries a narrower document view than the upload. */
export const ResultsDocumentSchema = z
  .object({
    id: z.string(),
    kind: z.enum(DOCUMENT_KINDS),
    filename: z.string(),
    sha256: z.string(),
    created_at: Timestamp,
  })
  .strict();

export const PublicWebhookSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    events: z.array(z.enum(WEBHOOK_EVENT_TYPES)),
    enabled: z.boolean(),
    created_at: Timestamp,
    /** Only ever present on the create response — see `publicWebhook`. */
    secret: z.string().optional(),
  })
  .strict();

export const DeliverySchema = z
  .object({
    id: z.string(),
    event_type: z.string(),
    valuation_id: z.string().nullable(),
    status: z.enum(['pending', 'delivered', 'failed']),
    attempts: z.number().int(),
    max_attempts: z.number().int(),
    next_attempt_at: Timestamp.nullable(),
    last_error: z.string().nullable(),
    created_at: Timestamp,
    delivered_at: Timestamp.nullable(),
  })
  .strict();

// ── One schema per operation, keyed the way the registry keys them ───────────

/**
 * The envelope every cursor-paged list on this API answers with.
 *
 * One shape rather than one per endpoint, so a client writes the "walk it to
 * the end" loop once. `next_cursor` is null exactly when `has_more` is false —
 * see `pageFrom` — so neither field is the authoritative one and a client may
 * loop on whichever reads better.
 */
export const CursorPage = {
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
} as const;

/**
 * `GET /me` — who this key is, and which key it is.
 *
 * `token` is nullable, which is not a hedge: `apiKeyGuard` resolves the token
 * on the way in, so a row that has since been deleted outright leaves a request
 * authenticated by a key with no record. Reporting the organisation and saying
 * so about the key is a better answer than a 500, and a partner reading `null`
 * there learns something true.
 */
export const MeResponse = z
  .object({
    partner: z
      .object({
        id: z.string(),
        name: z.string(),
        key: z.string(),
        white_label_enabled: z.boolean(),
        created_at: Timestamp,
      })
      .strict(),
    token: z
      .object({
        id: z.string(),
        name: z.string(),
        /** The visible half of the key — never the secret. */
        prefix: z.string(),
        created_at: Timestamp,
        last_used_at: Timestamp.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const CreateValuationResponse = z.object({ valuation: PublicValuationSchema }).strict();

export const ListValuationsResponse = z
  .object({
    valuations: z.array(PublicValuationSchema),
    page: z.number().int().min(1),
    per_page: z.number().int().min(1),
    total: z.number().int().min(0),
    ...CursorPage,
  })
  .strict();

export const GetValuationResponse = z.object({ valuation: PublicValuationSchema }).strict();

export const UploadDocumentResponse = z.object({ document: PublicDocumentSchema }).strict();

export const ResultsResponse = z
  .object({
    valuation: PublicValuationSchema,
    calculation: z
      .object({
        engine_version: z.string(),
        equity_value: DecimalString.nullable(),
        fmv_per_share: DecimalString.nullable(),
        created_at: Timestamp,
      })
      .strict()
      .nullable(),
    documents: z.array(ResultsDocumentSchema),
    report: z
      .object({
        /** False until a draft has been shared — not merely until it renders. */
        available: z.boolean(),
        version: z.number().int().nullable(),
      })
      .strict(),
  })
  .strict();

export const CreateWebhookResponse = z.object({ webhook: PublicWebhookSchema }).strict();

export const ListWebhooksResponse = z.object({ webhooks: z.array(PublicWebhookSchema) }).strict();

export const DeleteWebhookResponse = z.object({ deleted: z.literal(true) }).strict();

export const ListDeliveriesResponse = z
  .object({
    // Each row carries its own `cursor` as well, so a client can resume from a
    // specific delivery rather than only from the end of a page.
    deliveries: z.array(DeliverySchema.extend({ cursor: z.string() })),
    ...CursorPage,
  })
  .strict();

export const RetryDeliveryResponse = z
  .object({
    delivery: z
      .object({
        id: z.string(),
        event_type: z.string(),
        status: z.enum(['pending', 'delivered', 'failed']),
        attempts: z.number().int(),
        max_attempts: z.number().int(),
        next_attempt_at: Timestamp.nullable(),
      })
      .strict(),
  })
  .strict();

export const TestWebhookResponse = z.object({ delivered: z.boolean() }).strict();

/**
 * `GET /docs` and `GET /openapi.json` describe themselves loosely on purpose.
 *
 * Both serialize a document whose shape is the registry / the OpenAPI meta-
 * schema, neither of which is usefully restated as a zod object — pinning them
 * would mean maintaining a copy of OpenAPI 3.1 in this file to gain nothing a
 * partner reads. They keep the open `{ type: 'object' }` the generator falls
 * back to, which is honest about being a document rather than a record.
 */
export const SELF_DESCRIBING_PATHS: readonly string[] = ['/docs', '/openapi.json'];
