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
  rateLimit: { limit: number; windowSeconds: number };
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
  },
  required: ['title', 'status'],
};

function problemResponse(description: string) {
  return {
    description,
    content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
  };
}

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
};

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
    const operation: Record<string, unknown> = {
      operationId: operationId(endpoint.method, endpoint.path),
      summary: endpoint.summary,
      tags: [tagFor(endpoint.path)],
      ...(parameters.length > 0 ? { parameters } : {}),
      responses: {
        [status]: {
          description: endpoint.response,
          ...(authenticated ? { headers: RATE_LIMIT_HEADERS } : {}),
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
              '422': problemResponse('The request body or query failed validation.'),
              '429': problemResponse('Per-key rate limit exceeded. Retry after the window resets.'),
            }
          : {}),
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
          `every request is rate limited to ${input.rateLimit.limit} per ${input.rateLimit.windowSeconds}s per key.`,
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
