import type { z } from 'zod';
import { jsonSchemaFromZod, type JsonSchema } from './jsonSchema.js';

/**
 * OpenAPI 3.1 for the partner API, generated from the route registry.
 *
 * The hand-rolled `/docs` document has always been honest — it is built from
 * the same registry the routes are registered from, so it cannot drift — but it
 * is a shape only this codebase understands. A partner integrating against it
 * gets prose. What they asked for, repeatedly, is the thing every other vendor
 * ships: a spec their toolchain already reads. With one they generate a typed
 * client, import the collection into Postman, run contract tests against a mock,
 * and see the request shape in their editor. Without one they hand-write an
 * HTTP client and discover each constraint by receiving a 422.
 *
 * This is a second *rendering* of the same registry, not a second source. Add
 * an endpoint and it appears in both; there is no list here to forget to update.
 *
 * Error responses are declared once and attached to every operation, because
 * they are genuinely uniform: every failure on this API is an RFC 7807
 * `application/problem+json` body from `@n409/shared`. A spec that documented
 * only the happy path would leave a client to guess at the error shape, and
 * guessing produces integrations that treat a 429 as a permanent failure.
 */

export interface OpenApiEndpoint {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  summary: string;
  auth: 'api_key' | 'none';
  body?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  response: string;
  /**
   * Failures this operation can produce that the uniform set does not cover,
   * as status → what causes it.
   *
   * The uniform errors are the ones every authenticated route shares — a bad
   * key, a missing resource, a failed validator. A 409 from replaying an
   * Idempotency-Key against a different body, or the 413 a route with its own
   * `bodyLimit` answers with, is specific to the endpoint that can throw it,
   * and only the endpoint knows. Declaring it here rather than adding it to
   * the uniform set keeps the spec honest in both directions: a client is told
   * about the failure it can actually hit, and is not told to handle a 409 on
   * the twelve operations that never raise one.
   */
  errors?: Record<string, string>;
}

export interface OpenApiSchemas {
  body?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  /**
   * The shape of the success body, as a zod schema over the *serialized* JSON —
   * so a `Date` column is `z.string()` here, because that is what the partner
   * receives.
   *
   * Request bodies were typed from the validator and responses were not, which
   * left every operation declaring `schema: { type: 'object' }`. That is a
   * well-formed spec and a useless one: a generated client types every call as
   * returning `any`, so the one thing the partner wanted the spec for — knowing
   * that `fmv_per_share` is a decimal *string* and `published_at` may be null
   * before they write code against it — was the one thing it did not say.
   *
   * There is no validator to derive this from, because a response is built, not
   * parsed. So it is written by hand, and `partnerApiContract.test.ts` runs real
   * responses through these schemas to keep the hand-written half honest. The
   * schemas are `.strict()` for exactly that reason: adding a field to a
   * response without documenting it fails that test rather than shipping a spec
   * that quietly under-reports the payload.
   */
  response?: z.ZodTypeAny;
}

export interface OpenApiInput {
  endpoints: readonly OpenApiEndpoint[];
  /** Registry key → the zod schemas the route validates with. See `schemaKey`. */
  schemas?: ReadonlyMap<string, OpenApiSchemas>;
  title: string;
  version: string;
  /** Absolute or root-relative server URL, e.g. `/api/partner/v1`. */
  serverUrl: string;
  /**
   * The two budgets a call is charged against. `orgLimit` is omitted when the
   * deployment has no organisation ceiling configured, and the description then
   * says nothing about one rather than naming a limit that is not enforced.
   */
  rateLimit: { limit: number; windowSeconds: number; orgLimit?: number };
  description?: string;
}

/** How an endpoint is looked up in the schema registry. */
export function schemaKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/** `{id}` and `{deliveryId}` out of a templated path, in the order they appear. */
export function pathParameters(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!);
}

/**
 * A readable summary is one line; `operationId` has to be a unique identifier a
 * generator can turn into a method name. Derived from method + path so it is
 * stable across edits to the prose, which is what stops a regenerated client
 * from renaming every method when someone fixes a typo in a summary.
 */
export function operationId(method: string, path: string): string {
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith('{')
        ? `By${segment.slice(1, -1).replace(/^./, (c) => c.toUpperCase())}`
        : segment.replace(/[^A-Za-z0-9]+(.)?/g, (_, next: string | undefined) =>
            next ? next.toUpperCase() : '',
          ),
    );
  const [first, ...rest] = segments;
  const tail = [first ?? 'root', ...rest.map((s) => s.replace(/^./, (c) => c.toUpperCase()))].join('');
  return method.toLowerCase() + tail.replace(/^./, (c) => c.toUpperCase());
}

/** The first path segment, so operations group sensibly in a docs viewer. */
function tagFor(path: string): string {
  return path.split('/').filter(Boolean)[0] ?? 'general';
}

const PROBLEM_SCHEMA: JsonSchema = {
  type: 'object',
  description:
    'RFC 7807 problem document. Every failure on this API uses this shape, served as application/problem+json.',
  properties: {
    type: { type: 'string', description: 'Stable URN identifying the problem class.' },
    title: { type: 'string', description: 'Short, human-readable summary.' },
    status: { type: 'integer', description: 'HTTP status code, repeated in the body.' },
    detail: { type: 'string', description: 'Explanation specific to this occurrence.' },
    errors: {
      type: 'array',
      description: 'Field-level validation issues, present on 422 responses.',
      items: { type: 'object' },
    },
    // Both of these are emitted by the shared problem handler, so a client
    // parsing a problem document receives them and a spec that omits them
    // under-reports the body. `retry_after_seconds` in particular is the one
    // field a 429 handler actually needs, and it is the same number the
    // `retry-after` header carries — a client that reads either is correct.
    instance: {
      type: 'string',
      description: 'The request path this failure occurred on.',
    },
    retry_after_seconds: {
      type: 'integer',
      description:
        'Seconds to wait before retrying. Present on 429; mirrors the retry-after response header.',
    },
  },
  required: ['title', 'status'],
};

function problemResponse(description: string, headers?: Record<string, unknown>) {
  return {
    description,
    ...(headers ? { headers } : {}),
    content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
  };
}

/**
 * `retry-after` is the header a well-behaved client backs off on, and the
 * partner API sets it on every 429 (the shared problem handler emits it from
 * `ApiProblem.retryAfterSeconds`). Undeclared, a generated client has to reach
 * past its own types to find it — which in practice means it retries on a
 * fixed timer and gets rejected again.
 */
const RETRY_AFTER_HEADER = {
  'retry-after': {
    schema: { type: 'integer' },
    description: 'Seconds to wait before retrying this request.',
  },
};

/**
 * Rate-limit headers, declared on every authenticated response.
 *
 * These are returned on success as well as on the 429 — that is the whole point
 * of them, and a client that only reads them off the rejection has already been
 * rejected. Declaring them makes a generated client surface the budget before
 * it is spent.
 */
const RATE_LIMIT_HEADERS = {
  'x-ratelimit-limit': { schema: { type: 'integer' }, description: 'Requests allowed per window.' },
  'x-ratelimit-remaining': { schema: { type: 'integer' }, description: 'Requests left in this window.' },
  'x-ratelimit-reset': { schema: { type: 'integer' }, description: 'Unix seconds when the window resets.' },
  // The second budget. A client that reads only the unsuffixed trio sees a
  // healthy `remaining` and is then refused anyway, because the request that
  // exhausted the organisation's budget was one its sibling key sent.
  'x-ratelimit-limit-partner': {
    schema: { type: 'integer' },
    description: "Requests allowed per window across all of your organisation's API keys.",
  },
  'x-ratelimit-remaining-partner': {
    schema: { type: 'integer' },
    description: "Requests left in this window across all of your organisation's API keys.",
  },
  'x-ratelimit-reset-partner': {
    schema: { type: 'integer' },
    description: 'Unix seconds when the organisation window resets.',
  },
};

/**
 * Set on a success that was served from the idempotency store rather than
 * re-executed. Declared only on the operations that accept an
 * `Idempotency-Key`, because it is the reply to sending one.
 *
 * It matters to a caller: a 201 carrying this header means the valuation was
 * created by an *earlier* attempt, so the retry did not double-charge and the
 * id in the body is the one already in flight. Without it, the only way to
 * tell a replay from a fresh create is to have recorded the first response.
 */
const IDEMPOTENT_REPLAY_HEADER = {
  'x-idempotent-replay': {
    schema: { type: 'string', enum: ['true'] },
    description:
      'Present and "true" when this response was replayed from a previous request with the same Idempotency-Key.',
  },
};

/** The header name whose presence means an operation is idempotency-aware. */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * The status a successful call answers with.
 *
 * The registry records the response as prose, and two of these endpoints answer
 * 201 rather than 200. Reading the leading status out of that prose keeps the
 * spec correct without a second field to keep in step — a client generated
 * against a spec claiming 200 treats the 201 from `POST /valuations` as an
 * unexpected status and throws on the happy path.
 */
export function successStatus(response: string): string {
  const match = /^\s*(\d{3})\b/.exec(response);
  return match ? match[1]! : '200';
}

/**
 * A response schema with every `additionalProperties: false` dropped.
 *
 * The converter closes objects because that is right for a *request*: the
 * validator rejects unknown fields, and saying so lets a generator catch a typo
 * at compile time instead of at the 422. A response is the opposite contract.
 * Closing it publishes "these fields and never any others", which makes the day
 * this API adds a field to `publicValuation` the day every strictly-generated
 * client starts rejecting valid payloads — the API would be unable to grow
 * without a breaking release.
 *
 * The strictness is not lost, only moved to where it belongs: the zod schemas
 * are `.strict()`, so the contract test still fails on an undocumented field.
 * The spec stays additive-safe; the test stays exact.
 */
export function responseSchema(schema: z.ZodTypeAny): JsonSchema {
  return openObjects(jsonSchemaFromZod(schema));
}

function openObjects(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...schema };
  delete out.additionalProperties;
  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([key, value]) => [key, openObjects(value)]),
    );
  }
  if (out.items) out.items = openObjects(out.items);
  if (out.anyOf) out.anyOf = out.anyOf.map(openObjects);
  return out;
}

export function buildOpenApiDocument(input: OpenApiInput): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const endpoint of input.endpoints) {
    const schemas = input.schemas?.get(schemaKey(endpoint.method, endpoint.path));
    const parameters: Array<Record<string, unknown>> = [];

    for (const name of pathParameters(endpoint.path)) {
      parameters.push({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: `Identifier from a previous response (${name}).`,
      });
    }

    // The zod schema knows the types and which are optional; the registry knows
    // what each one means. Neither alone is a usable parameter declaration.
    const querySchema = schemas?.query ? jsonSchemaFromZod(schemas.query, endpoint.query ?? {}) : undefined;
    for (const [name, description] of Object.entries(endpoint.query ?? {})) {
      const property = querySchema?.properties?.[name];
      parameters.push({
        name,
        in: 'query',
        required: querySchema?.required?.includes(name) ?? false,
        description,
        schema: property ? { ...property, description: undefined } : { type: 'string' },
      });
    }

    for (const [name, description] of Object.entries(endpoint.headers ?? {})) {
      parameters.push({
        name,
        in: 'header',
        required: false,
        description,
        schema: { type: 'string' },
      });
    }

    const status = successStatus(endpoint.response);
    const authenticated = endpoint.auth === 'api_key';
    const idempotent = Object.keys(endpoint.headers ?? {}).some(
      (name) => name.toLowerCase() === IDEMPOTENCY_KEY_HEADER,
    );
    const successHeaders = {
      ...(authenticated ? RATE_LIMIT_HEADERS : {}),
      ...(idempotent ? IDEMPOTENT_REPLAY_HEADER : {}),
    };
    const operation: Record<string, unknown> = {
      operationId: operationId(endpoint.method, endpoint.path),
      summary: endpoint.summary,
      tags: [tagFor(endpoint.path)],
      ...(parameters.length > 0 ? { parameters } : {}),
      responses: {
        [status]: {
          description: endpoint.response,
          ...(Object.keys(successHeaders).length > 0 ? { headers: successHeaders } : {}),
          content: {
            // `report.pdf` is the one endpoint that does not answer JSON, and a
            // spec that says it does makes every generated client try to parse
            // a PDF as an object.
            ...(endpoint.path.endsWith('.pdf')
              ? { 'application/pdf': { schema: { type: 'string', format: 'binary' } } }
              : {
                  'application/json': {
                    // An endpoint with no declared response schema degrades to
                    // the open object rather than blocking registration — same
                    // rule the request half already follows.
                    schema: schemas?.response ? responseSchema(schemas.response) : { type: 'object' },
                  },
                }),
          },
        },
        ...(authenticated
          ? {
              '401': problemResponse('Missing or invalid API key.'),
              '403': problemResponse(
                'The key is valid but not a partner key, or the resource is outside its organisation.',
              ),
              '404': problemResponse('No such resource, or it belongs to another organisation.'),
              '422': problemResponse('The request body failed validation.'),
              '429': problemResponse(
                'Per-key rate limit exceeded. Retry after the window resets.',
                RETRY_AFTER_HEADER,
              ),
            }
          : {}),
        // 400 covers the two failures that are not "a field in the body is
        // wrong", and it is declared only on the operations that can produce
        // one — a client should not be told to handle a query error on an
        // operation that takes no query.
        //
        // A body that is not parseable JSON never reaches the validator, so it
        // fails as a 400 rather than the 422 the validator produces. Both are
        // real and a client has to tell them apart: the 400 means "fix the
        // request framing", the 422 means "fix a field".
        //
        // A query string is the other one. It used to be folded into the 422
        // here — the description read "body or query" — which was wrong in both
        // directions once the service settled on 400 for it: a generated client
        // handled a status the API does not send and did not handle the one it
        // does. `?limit=abc` is not a well-formed request the server declined to
        // act on; it is a request that did not parse.
        ...(endpoint.body || endpoint.query
          ? {
              '400': problemResponse(
                [
                  endpoint.body ? 'The request body was not valid JSON' : null,
                  endpoint.query ? 'a query parameter was missing or malformed' : null,
                ]
                  .filter(Boolean)
                  .join(', or ') + '.',
              ),
            }
          : {}),
        // Declared last so an endpoint-specific description of a status wins
        // over the uniform one — a 409 has no uniform meaning to override, but
        // a route that narrows what its 422 means should be able to say so.
        ...Object.fromEntries(
          Object.entries(endpoint.errors ?? {}).map(([status, description]) => [
            status,
            problemResponse(description, status === '429' ? RETRY_AFTER_HEADER : undefined),
          ]),
        ),
        // Every operation can fail this way, and the shape is the same problem
        // document — a client that treats a 500 as an unparseable response
        // loses the one field that tells it whether retrying is worth trying.
        '500': problemResponse('Unexpected server error. The body carries no detail on a 5xx.'),
      },
      // `security: []` is not the same as omitting the key: it explicitly clears
      // the document-level requirement, which is how `/docs` is marked public.
      security: authenticated ? [{ apiKey: [] }] : [],
    };

    if (endpoint.body) {
      const bodySchema = schemas?.body
        ? jsonSchemaFromZod(schemas.body, endpoint.body)
        : {
            type: 'object',
            properties: Object.fromEntries(
              Object.entries(endpoint.body).map(([name, description]) => [name, { description }]),
            ),
          };
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: bodySchema } },
      };
    }

    const key = endpoint.path === '' ? '/' : endpoint.path;
    paths[key] ??= {};
    paths[key]![endpoint.method.toLowerCase()] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: input.title,
      version: input.version,
      description:
        input.description ??
        `Programmatic valuation submission. Authenticate with a partner API key; ` +
          `every request is rate limited to ${input.rateLimit.limit} per ${input.rateLimit.windowSeconds}s per key` +
          (input.rateLimit.orgLimit
            ? `, and to ${input.rateLimit.orgLimit} per ${input.rateLimit.windowSeconds}s across all of your ` +
              `organisation's keys together — minting more keys does not raise the second figure.`
            : '.'),
    },
    servers: [{ url: input.serverUrl }],
    tags: [...new Set(input.endpoints.map((endpoint) => tagFor(endpoint.path)))].map((name) => ({ name })),
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'n409_pat',
          description:
            'Partner API key, created in partner settings. Session JWTs and personal tokens are rejected.',
        },
      },
      schemas: { Problem: PROBLEM_SCHEMA },
    },
    security: [{ apiKey: [] }],
    paths,
  };
}
