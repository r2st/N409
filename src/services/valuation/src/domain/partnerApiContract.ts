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
    id: z.string().describe('ULID of the valuation. Use it in every other path on this API.'),
    number: DecimalString.describe(
      'Human-facing engagement number, unique within the platform. A bigint, so a string.',
    ),
    /** The partner's own id (migration 0164). Null for anything they did not create with one. */
    external_id: z
      .string()
      .nullable()
      .describe(
        'Your own identifier for this engagement, echoed back. Null for anything created without one.',
      ),
    kind: z
      .enum(VALUATION_KINDS)
      .describe('Which measurement this is — 409A, ASC 718, a fund NAV, and so on.'),
    state: z
      .enum(VALUATION_STATES)
      .describe('Workflow state. Advances one way; `published` is the terminal success state.'),
    waiting_on_client: z
      .boolean()
      .describe('True while the firm is blocked on something the company has not supplied.'),
    company_name: z.string().describe('The subject company, as it appears on the report.'),
    service_name: z.string().nullable().describe('The service package sold, if the firm records one.'),
    currency: z.string().describe('ISO 4217 code the concluded figures are expressed in.'),
    paid_status: z.enum(PAID_STATUSES).describe('Whether the engagement has been paid for.'),
    created_at: Timestamp.describe('When the engagement was created.'),
    due_date: Timestamp.nullable().describe('When the firm has committed to deliver. Null if unset.'),
    published_at: Timestamp.nullable().describe(
      'When the report was published. Null until then — the field to poll on.',
    ),
    /**
     * Set once the firm withdraws the engagement. Non-null means every write
     * to it now answers 409 — see `publicValuation`.
     */
    retired_at: Timestamp.nullable().describe(
      'Set once the firm withdraws the engagement. Non-null means every write to it now answers 409.',
    ),
  })
  .strict();

export const PublicDocumentSchema = z
  .object({
    id: z.string().describe('ULID of the stored document.'),
    kind: z.enum(DOCUMENT_KINDS).describe('What the document is — the category the firm files it under.'),
    filename: z.string().describe('The name it was uploaded under.'),
    content_type: z.string().describe('MIME type as stored, sniffed rather than trusted from the upload.'),
    /**
     * `bigint`, so a string like every other bigint on this API — the same
     * reason `number` is one. Typing it as a JSON number would be the more
     * natural-looking spec and a wrong one: a client generated from it parses
     * `"24"` into a type it was told is numeric and fails on the first upload.
     */
    size_bytes: DecimalString.describe('Size in bytes. A bigint, so a decimal string rather than a number.'),
    sha256: z.string().describe('Hex SHA-256 of the stored bytes — compare it to what you sent.'),
    created_at: Timestamp.describe('When the upload was accepted.'),
  })
  .strict();

/** The results projection carries a narrower document view than the upload. */
export const ResultsDocumentSchema = z
  .object({
    id: z.string().describe('ULID of the stored document.'),
    kind: z.enum(DOCUMENT_KINDS).describe('What the document is.'),
    filename: z.string().describe('The name it was uploaded under.'),
    sha256: z.string().describe('Hex SHA-256 of the stored bytes.'),
    created_at: Timestamp.describe('When the upload was accepted.'),
  })
  .strict();

export const PublicWebhookSchema = z
  .object({
    id: z.string().describe('ULID of the subscription.'),
    url: z.string().describe('Where deliveries are POSTed. HTTPS, and not a private address.'),
    events: z
      .array(z.enum(WEBHOOK_EVENT_TYPES))
      .describe('Which events this subscription receives. Others are not delivered.'),
    enabled: z.boolean().describe('False suspends delivery without losing the subscription.'),
    created_at: Timestamp.describe('When the subscription was created.'),
    /** Only ever present on the create response — see `publicWebhook`. */
    secret: z
      .string()
      .optional()
      .describe(
        'The HMAC signing secret, returned once on creation and never again. Store it now; verify ' +
          'every delivery against it.',
      ),
  })
  .strict();

export const DeliverySchema = z
  .object({
    id: z.string().describe('ULID of this delivery attempt record.'),
    event_type: z.string().describe('Which event was delivered, e.g. `valuation.published`.'),
    valuation_id: z.string().nullable().describe('The engagement the event was about, when it had one.'),
    status: z
      .enum(['pending', 'delivered', 'failed'])
      .describe('`pending` is still being retried; `failed` has exhausted `max_attempts`.'),
    attempts: z.number().int().describe('How many times delivery has been tried so far.'),
    max_attempts: z.number().int().describe('Attempts after which the delivery is abandoned.'),
    next_attempt_at: Timestamp.nullable().describe(
      'When the next retry is due. Null once the delivery is settled either way.',
    ),
    last_error: z.string().nullable().describe('Why the last attempt failed. Null if none has.'),
    created_at: Timestamp.describe('When the event was queued.'),
    delivered_at: Timestamp.nullable().describe('When your endpoint accepted it. Null until it does.'),
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
  next_cursor: z
    .string()
    .nullable()
    .describe('Pass as `cursor` to fetch the next page. Null exactly when `has_more` is false.'),
  has_more: z.boolean().describe('Whether another page exists. Equivalent to `next_cursor !== null`.'),
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
        id: z.string().describe('ULID of your organisation.'),
        name: z.string().describe('Your organisation as the platform records it.'),
        key: z.string().describe('Stable slug for your organisation, used in white-label URLs.'),
        white_label_enabled: z
          .boolean()
          .describe('Whether reports are branded as yours rather than as the platform’s.'),
        created_at: Timestamp.describe('When your organisation was onboarded.'),
      })
      .strict()
      .describe('The organisation this key belongs to.'),
    token: z
      .object({
        id: z.string().describe('ULID of the key making this request.'),
        name: z.string().describe('The label the key was created with.'),
        /** The visible half of the key — never the secret. */
        prefix: z.string().describe('The visible leading characters of the key. Never the secret.'),
        created_at: Timestamp.describe('When the key was minted.'),
        last_used_at: Timestamp.nullable().describe('When it was last used before this request.'),
      })
      .strict()
      .nullable()
      .describe(
        'The key making this request, or null if its record has since been deleted — the request is ' +
          'still authenticated, so the organisation above is reported either way.',
      ),
  })
  .strict();

export const CreateValuationResponse = z
  .object({ valuation: PublicValuationSchema.describe('The engagement that was created.') })
  .strict();

export const ListValuationsResponse = z
  .object({
    valuations: z.array(PublicValuationSchema).describe('This page of engagements, newest first.'),
    page: z.number().int().min(1).describe('1-based page number, for offset paging.'),
    per_page: z.number().int().min(1).describe('How many rows this page holds at most.'),
    total: z.number().int().min(0).describe('Total matching engagements across all pages.'),
    ...CursorPage,
  })
  .strict();

export const GetValuationResponse = z
  .object({ valuation: PublicValuationSchema.describe('The engagement.') })
  .strict();

export const UploadDocumentResponse = z
  .object({ document: PublicDocumentSchema.describe('The document as stored.') })
  .strict();

export const ResultsResponse = z
  .object({
    valuation: PublicValuationSchema.describe('The engagement these results belong to.'),
    calculation: z
      .object({
        engine_version: z.string().describe('Which build of the valuation engine produced this run.'),
        equity_value: DecimalString.nullable().describe(
          'Concluded total equity value, as an exact decimal string. Null before the first run.',
        ),
        fmv_per_share: DecimalString.nullable().describe(
          'Concluded fair market value per share, to four decimal places, as an exact decimal string. ' +
            'Parsing it as a float is how a client silently rounds a valuation.',
        ),
        created_at: Timestamp.describe('When this run completed.'),
      })
      .strict()
      .nullable()
      .describe('The latest completed run, or null if none has completed.'),
    documents: z.array(ResultsDocumentSchema).describe('Documents attached to the engagement.'),
    documents_truncated: z
      .boolean()
      .describe(
        'True when the engagement holds more documents than this page carries. ' +
          'A short list is otherwise indistinguishable from a complete one.',
      ),
    report: z
      .object({
        /** False until a draft has been shared — not merely until it renders. */
        available: z
          .boolean()
          .describe('Whether `report.pdf` will answer. False until a draft has been shared with you.'),
        version: z.number().int().nullable().describe('Version of the shared report. Null until one is.'),
      })
      .strict()
      .describe('Whether the report is downloadable yet, and which version it is.'),
  })
  .strict();

export const CreateWebhookResponse = z
  .object({
    webhook: PublicWebhookSchema.describe(
      'The subscription. This is the only response that carries `secret`.',
    ),
  })
  .strict();

export const ListWebhooksResponse = z
  .object({ webhooks: z.array(PublicWebhookSchema).describe('Your subscriptions, without their secrets.') })
  .strict();

export const DeleteWebhookResponse = z
  .object({ deleted: z.literal(true).describe('Always true; the failure case is a status, not a field.') })
  .strict();

export const ListDeliveriesResponse = z
  .object({
    // Each row carries its own `cursor` as well, so a client can resume from a
    // specific delivery rather than only from the end of a page.
    deliveries: z
      .array(
        DeliverySchema.extend({
          cursor: z
            .string()
            .describe('Pass as `cursor` to resume from this delivery rather than from the page end.'),
        }),
      )
      .describe('This page of delivery attempts, newest first.'),
    ...CursorPage,
  })
  .strict();

export const RetryDeliveryResponse = z
  .object({
    delivery: z
      .object({
        id: z.string().describe('ULID of the delivery that was re-queued.'),
        event_type: z.string().describe('Which event it carries.'),
        status: z
          .enum(['pending', 'delivered', 'failed'])
          .describe('`pending` immediately after a retry is accepted.'),
        attempts: z.number().int().describe('Attempts made before this retry.'),
        max_attempts: z.number().int().describe('Attempts after which it is abandoned.'),
        next_attempt_at: Timestamp.nullable().describe('When the retry will be sent.'),
      })
      .strict()
      .describe('The delivery as it now stands.'),
  })
  .strict();

export const TestWebhookResponse = z
  .object({
    delivered: z
      .boolean()
      .describe('Whether your endpoint accepted the test event. False is a failure to reach it, not a 4xx.'),
  })
  .strict();

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
