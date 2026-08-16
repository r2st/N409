import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isOptionalSchema, jsonSchemaFromZod } from '../../src/domain/jsonSchema.js';
import {
  buildOpenApiDocument,
  operationId,
  pathParameters,
  schemaKey,
  successStatus,
  type OpenApiEndpoint,
} from '../../src/domain/openapi.js';

describe('zod → JSON Schema', () => {
  it('carries string length bounds through', () => {
    expect(jsonSchemaFromZod(z.string().min(1).max(300))).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 300,
    });
  });

  it('reads .length() as both bounds — a 2-letter country code is exactly two', () => {
    expect(jsonSchemaFromZod(z.string().length(2))).toEqual({
      type: 'string',
      minLength: 2,
      maxLength: 2,
    });
  });

  it('distinguishes integer from number, which a client generator must', () => {
    expect(jsonSchemaFromZod(z.number().int().min(1).max(100))).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 100,
    });
    expect(jsonSchemaFromZod(z.number())).toEqual({ type: 'number' });
  });

  it('turns an enum into its legal values', () => {
    expect(jsonSchemaFromZod(z.enum(['409a', 'asc718']))).toEqual({
      type: 'string',
      enum: ['409a', 'asc718'],
    });
  });

  it('describes arrays with their item type and max', () => {
    expect(jsonSchemaFromZod(z.array(z.string().length(2)).max(50))).toEqual({
      type: 'array',
      items: { type: 'string', minLength: 2, maxLength: 2 },
      maxItems: 50,
    });
  });

  it('marks only genuinely-required object keys as required', () => {
    const schema = jsonSchemaFromZod(
      z.object({
        kind: z.enum(['409a']),
        company_name: z.string().min(1),
        service_name: z.string().optional(),
        currency: z.string().default('USD'),
      }),
    );
    expect(schema.required).toEqual(['kind', 'company_name']);
    expect(schema.properties?.currency?.default).toBe('USD');
  });

  it('unwraps optional/default/coerce rather than describing the wrapper', () => {
    expect(jsonSchemaFromZod(z.coerce.number().int().min(1).default(25))).toEqual({
      type: 'integer',
      minimum: 1,
      default: 25,
    });
    expect(isOptionalSchema(z.string().optional())).toBe(true);
    expect(isOptionalSchema(z.string().default('x'))).toBe(true);
    expect(isOptionalSchema(z.string().nullable())).toBe(false);
    expect(isOptionalSchema(z.string().nullish())).toBe(true);
    expect(isOptionalSchema(z.string())).toBe(false);
  });

  it('expresses nullability as a 3.1 type union, not the 3.0 keyword', () => {
    expect(jsonSchemaFromZod(z.string().nullable())).toEqual({ type: ['string', 'null'] });
  });

  it('attaches the hand-written prose to the derived shape', () => {
    const schema = jsonSchemaFromZod(z.object({ kind: z.enum(['409a']) }), {
      kind: 'Valuation kind — one of: 409a',
    });
    expect(schema.properties?.kind).toEqual({
      description: 'Valuation kind — one of: 409a',
      type: 'string',
      enum: ['409a'],
    });
  });

  it('degrades an unsupported type to "anything" rather than throwing', () => {
    expect(() => jsonSchemaFromZod(z.record(z.string()))).not.toThrow();
    expect(jsonSchemaFromZod(z.record(z.string()))).toEqual({});
  });
});

describe('OpenAPI helpers', () => {
  it('extracts path parameters in order', () => {
    expect(pathParameters('/webhooks/{id}/deliveries/{deliveryId}/retry')).toEqual(['id', 'deliveryId']);
    expect(pathParameters('/valuations')).toEqual([]);
  });

  it('derives a stable operationId from method and path, not from the prose', () => {
    expect(operationId('GET', '/valuations/{id}')).toBe('getValuationsById');
    expect(operationId('POST', '/valuations/{id}/documents')).toBe('postValuationsByIdDocuments');
    expect(operationId('GET', '/openapi.json')).toBe('getOpenapiJson');
    expect(operationId('GET', '/valuations/{id}/report.pdf')).toBe('getValuationsByIdReportPdf');
  });

  it('reads the success status out of the response prose, so 201s are not documented as 200', () => {
    expect(successStatus('201 { valuation }')).toBe('201');
    expect(successStatus('{ valuations[], page }')).toBe('200');
  });
});

describe('buildOpenApiDocument', () => {
  const endpoints: OpenApiEndpoint[] = [
    {
      method: 'GET',
      path: '/docs',
      summary: 'Machine-readable description.',
      auth: 'none',
      response: '{ endpoints[] }',
    },
    {
      method: 'POST',
      path: '/valuations',
      summary: 'Create a valuation.',
      auth: 'api_key',
      body: { kind: 'Valuation kind', company_name: 'Company being valued (required)' },
      headers: { 'Idempotency-Key': 'Optional retry key.' },
      errors: { '409': 'The key was reused with a different body.' },
      response: '201 { valuation }',
    },
    {
      method: 'GET',
      path: '/valuations',
      summary: 'List valuations.',
      auth: 'api_key',
      query: { state: 'Optional state filter', per_page: 'Page size' },
      response: '{ valuations[] }',
    },
    {
      method: 'GET',
      path: '/valuations/{id}/report.pdf',
      summary: 'Download the report.',
      auth: 'api_key',
      response: 'The rendered PDF.',
    },
  ];

  const schemas = new Map([
    [
      schemaKey('POST', '/valuations'),
      { body: z.object({ kind: z.enum(['409a']), company_name: z.string().min(1).max(300) }) },
    ],
    [
      schemaKey('GET', '/valuations'),
      {
        query: z.object({
          state: z.enum(['pending', 'published']).optional(),
          per_page: z.coerce.number().int().min(1).max(100).default(25),
        }),
      },
    ],
  ]);

  const doc = buildOpenApiDocument({
    endpoints,
    schemas,
    title: 'N409 Partner API',
    version: '1.0.0',
    serverUrl: '/api/partner/v1',
    rateLimit: { limit: 120, windowSeconds: 60 },
  }) as Record<string, any>;

  it('is a 3.1 document naming the server the routes are mounted under', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('N409 Partner API');
    expect(doc.servers).toEqual([{ url: '/api/partner/v1' }]);
  });

  it('declares bearer API-key auth as the document default', () => {
    expect(doc.components.securitySchemes.apiKey).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(doc.security).toEqual([{ apiKey: [] }]);
  });

  it('clears the requirement on the public docs endpoint rather than omitting it', () => {
    // `security: []` is what says "no auth"; an absent key would inherit the
    // document-level requirement and mislead every generated client.
    expect(doc.paths['/docs'].get.security).toEqual([]);
    expect(doc.paths['/valuations'].post.security).toEqual([{ apiKey: [] }]);
  });

  it('types the request body from the zod schema the route validates with', () => {
    const schema = doc.paths['/valuations'].post.requestBody.content['application/json'].schema;
    expect(schema.required).toEqual(['kind', 'company_name']);
    expect(schema.properties.kind).toMatchObject({ enum: ['409a'], description: 'Valuation kind' });
    expect(schema.properties.company_name).toMatchObject({ type: 'string', maxLength: 300 });
  });

  it('marks a query parameter required only when the validator makes it so', () => {
    const params: Array<Record<string, any>> = doc.paths['/valuations'].get.parameters;
    const state = params.find((p) => p.name === 'state');
    const perPage = params.find((p) => p.name === 'per_page');
    expect(state.required).toBe(false);
    expect(state.schema.enum).toEqual(['pending', 'published']);
    expect(perPage.schema).toMatchObject({ type: 'integer', maximum: 100, default: 25 });
  });

  it('declares path and header parameters', () => {
    const pathParams: Array<Record<string, any>> = doc.paths['/valuations/{id}/report.pdf'].get.parameters;
    expect(pathParams.find((p) => p.name === 'id')).toMatchObject({ in: 'path', required: true });
    const headerParams: Array<Record<string, any>> = doc.paths['/valuations'].post.parameters;
    expect(headerParams.find((p) => p.name === 'Idempotency-Key')).toMatchObject({
      in: 'header',
      required: false,
    });
  });

  it('documents the 201 on create under 201, not 200', () => {
    expect(Object.keys(doc.paths['/valuations'].post.responses)).toContain('201');
    expect(Object.keys(doc.paths['/valuations'].post.responses)).not.toContain('200');
  });

  it('says the PDF endpoint returns a PDF', () => {
    const content = doc.paths['/valuations/{id}/report.pdf'].get.responses['200'].content;
    expect(content['application/pdf']).toEqual({ schema: { type: 'string', format: 'binary' } });
    expect(content['application/json']).toBeUndefined();
  });

  it('attaches the uniform problem+json error responses to every authenticated operation', () => {
    for (const status of ['401', '403', '404', '422', '429']) {
      const response = doc.paths['/valuations'].get.responses[status];
      expect(response.content['application/problem+json'].schema).toEqual({
        $ref: '#/components/schemas/Problem',
      });
    }
    expect(doc.components.schemas.Problem.properties.status.type).toBe('integer');
    // The public endpoint has no auth, so it has no auth failures to document.
    expect(doc.paths['/docs'].get.responses['401']).toBeUndefined();
  });

  it('declares the rate-limit headers on success, where a client can act on them', () => {
    const headers = doc.paths['/valuations'].get.responses['200'].headers;
    expect(Object.keys(headers)).toEqual([
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
      // Both budgets, because a client that reads only the per-key trio sees a
      // healthy `remaining` and is refused anyway when a sibling key spent the
      // organisation's.
      'x-ratelimit-limit-partner',
      'x-ratelimit-remaining-partner',
      'x-ratelimit-reset-partner',
    ]);
  });

  it('names the organisation ceiling in the description only when one is enforced', () => {
    expect(doc.info.description).not.toMatch(/organisation/);

    const withCeiling = buildOpenApiDocument({
      endpoints,
      schemas,
      title: 'N409 Partner API',
      version: '1.0.0',
      serverUrl: '/api/partner/v1',
      rateLimit: { limit: 120, windowSeconds: 60, orgLimit: 600 },
    }) as Record<string, any>;
    expect(withCeiling.info.description).toMatch(/600 per 60s across all of your organisation's keys/);
    // The sentence a partner acts on: the reason not to work around the per-key
    // figure by creating more keys.
    expect(withCeiling.info.description).toMatch(/minting more keys does not raise the second figure/);
  });

  it('declares retry-after on the 429, which is what a backoff is supposed to read', () => {
    // The header is what the shared problem handler actually sets; a spec that
    // documents the 429 without it leaves a generated client retrying blind.
    const rateLimited = doc.paths['/valuations'].get.responses['429'];
    expect(rateLimited.headers['retry-after'].schema).toEqual({ type: 'integer' });
    // …and the same number is in the body, for a client that only parses JSON.
    expect(doc.components.schemas.Problem.properties.retry_after_seconds.type).toBe('integer');
  });

  it('documents the instance field, which every problem document carries', () => {
    expect(doc.components.schemas.Problem.properties.instance.type).toBe('string');
  });

  it('documents an endpoint-specific failure the uniform set does not cover', () => {
    // 409 is real on create — reusing an Idempotency-Key against a different
    // body is refused — and impossible on the operations that take no key.
    const create = doc.paths['/valuations'].post.responses;
    expect(create['409'].description).toBe('The key was reused with a different body.');
    expect(create['409'].content['application/problem+json'].schema).toEqual({
      $ref: '#/components/schemas/Problem',
    });
    expect(doc.paths['/valuations'].get.responses['409']).toBeUndefined();
  });

  it('declares the replay header only where an Idempotency-Key is accepted', () => {
    // A 201 carrying this header means an earlier attempt created the record,
    // so the retry did not create a second one.
    const created = doc.paths['/valuations'].post.responses['201'].headers;
    expect(created['x-idempotent-replay'].schema).toEqual({ type: 'string', enum: ['true'] });
    expect(created['x-ratelimit-limit']).toBeDefined();
    expect(doc.paths['/valuations'].get.responses['200'].headers['x-idempotent-replay']).toBeUndefined();
  });

  it('separates the 400 on unparseable JSON from the 422 on a bad field', () => {
    // They arrive from different layers and mean different fixes; a client that
    // retries a 400 as though it were a validation error retries forever.
    expect(doc.paths['/valuations'].post.responses['400']).toBeDefined();
    expect(doc.paths['/valuations'].post.responses['422']).toBeDefined();
  });

  it('declares the 400 a bad query earns, on the operations that take one', () => {
    /*
     * This was the spec's own copy of the inconsistency the service had: the
     * 422 was described as "the request body or query failed validation" and
     * the 400 was declared only where there was a body. Both halves were
     * wrong for a list operation — `GET /valuations?limit=abc` is a 400, so a
     * generated client had a handler for a status it will never see and none
     * for the one it gets.
     */
    const list = doc.paths['/valuations'].get.responses;
    expect(list['400']).toBeDefined();
    expect(list['400'].description).toMatch(/query parameter/i);
    // …and not the body clause, since a GET has no body to fail parsing.
    expect(list['400'].description).not.toMatch(/valid JSON/i);
    // The create takes both, and says so.
    expect(doc.paths['/valuations'].post.responses['400'].description).toMatch(/valid JSON/i);
  });

  it('leaves the 400 off an operation that takes neither a body nor a query', () => {
    // The uniform errors are uniform because every operation can produce them.
    // A 400 is not one of those, and declaring it everywhere would be the same
    // failure as the 422 it replaces: telling a client to handle what it
    // cannot receive.
    const noInput = doc.paths['/valuations/{id}/report.pdf'].get.responses;
    expect(noInput['400']).toBeUndefined();
    expect(noInput['422']).toBeDefined();
  });

  it('says "body" in the 422, because a query never produces one', () => {
    for (const op of [doc.paths['/valuations'].get, doc.paths['/valuations'].post]) {
      expect(op.responses['422'].description).toMatch(/body/i);
      expect(op.responses['422'].description).not.toMatch(/query/i);
    }
  });

  it('documents the 500 on every operation, public ones included', () => {
    expect(doc.paths['/valuations'].get.responses['500'].content['application/problem+json']).toBeDefined();
    expect(doc.paths['/docs'].get.responses['500']).toBeDefined();
    // …and still no auth failures on the public endpoint.
    expect(doc.paths['/docs'].get.responses['401']).toBeUndefined();
  });

  it('gives every operation a unique operationId', () => {
    const ids = Object.values(doc.paths).flatMap((methods: any) =>
      Object.values(methods).map((op: any) => op.operationId),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(endpoints.length);
  });

  it('documents a body loosely rather than not at all when no zod schema is registered', () => {
    const loose = buildOpenApiDocument({
      endpoints: [
        {
          method: 'POST',
          path: '/thing',
          summary: 's',
          auth: 'api_key',
          body: { field: 'What it means' },
          response: '{ ok }',
        },
      ],
      title: 't',
      version: '1',
      serverUrl: '/x',
      rateLimit: { limit: 1, windowSeconds: 1 },
    }) as Record<string, any>;
    const schema = loose.paths['/thing'].post.requestBody.content['application/json'].schema;
    expect(schema.properties.field).toEqual({ description: 'What it means' });
  });

  it('serializes to JSON without loss — it is served over the wire', () => {
    expect(() => JSON.parse(JSON.stringify(doc))).not.toThrow();
  });
});
