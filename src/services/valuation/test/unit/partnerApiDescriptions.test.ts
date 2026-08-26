/**
 * Every field a partner receives is explained, and the explanation reaches the
 * spec.
 *
 * The response schemas in `partnerApiContract.ts` have been the source of the
 * generated OpenAPI's *types* since they were written, and they carried prose
 * the whole time — in `/** … *\/` comments beside each field. None of it was
 * published. JSDoc is for whoever opens the file; zod records `.describe()` and
 * the converter is what turns it into a schema, and until R163 the converter
 * dropped `_def.description` on the floor. So a partner generating a client got
 * `fmv_per_share: string` with no hint that it is an exact decimal that must not
 * be parsed as a float, and `secret: string | undefined` with no hint that it is
 * returned exactly once.
 *
 * Two checks, and the second is the one that would have caught the original
 * bug: the schemas describe every field, *and* the description survives the
 * conversion into the document that is actually served. Either alone passes
 * while the published spec says nothing.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CreateValuationResponse,
  CreateWebhookResponse,
  DeleteWebhookResponse,
  GetValuationResponse,
  ListDeliveriesResponse,
  ListValuationsResponse,
  ListWebhooksResponse,
  MeResponse,
  ResultsResponse,
  RetryDeliveryResponse,
  TestWebhookResponse,
  UploadDocumentResponse,
} from '../../src/domain/partnerApiContract.js';
import { jsonSchemaFromZod, type JsonSchema } from '../../src/domain/jsonSchema.js';
import { responseSchema } from '../../src/domain/openapi.js';

const RESPONSES: Record<string, z.ZodTypeAny> = {
  MeResponse,
  CreateValuationResponse,
  ListValuationsResponse,
  GetValuationResponse,
  UploadDocumentResponse,
  ResultsResponse,
  CreateWebhookResponse,
  ListWebhooksResponse,
  DeleteWebhookResponse,
  ListDeliveriesResponse,
  RetryDeliveryResponse,
  TestWebhookResponse,
};

/**
 * Every `a.b.c` path in a converted schema whose property has no description.
 *
 * Recurses through `properties` and into `items`, because a list of objects is
 * where most of the payload lives on this API and is the one place the old
 * JSDoc could not have been published from even in principle.
 */
function undescribed(schema: JsonSchema, trail: string[] = [], out: string[] = []): string[] {
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const path = [...trail, name];
    if (!property.description) out.push(path.join('.'));
    undescribed(property, path, out);
  }
  if (schema.items) undescribed(schema.items, [...trail, '[]'], out);
  return out;
}

describe('the partner API response schemas describe what they return', () => {
  it('leaves no field undescribed, at any depth', () => {
    const gaps = Object.entries(RESPONSES).flatMap(([name, schema]) =>
      undescribed(jsonSchemaFromZod(schema)).map((path) => `${name}.${path}`),
    );
    expect(gaps, 'response fields with no description in the published spec').toEqual([]);
  });

  it('is looking at fields, so an empty walk cannot pass it', () => {
    // The check above is a "no gaps" assertion, which is exactly the shape that
    // passes when the walker stops finding anything to inspect. Two ways it
    // could: the walker never descends, or it descends and finds nothing.
    const gapsIn = (schema: z.ZodTypeAny) => undescribed(jsonSchemaFromZod(schema));
    expect(
      gapsIn(z.object({ outer: z.object({ inner: z.string() }) })).sort(),
      'the walker must report a nested field with no description',
    ).toEqual(['outer', 'outer.inner']);
    expect(gapsIn(z.object({ rows: z.array(z.object({ id: z.string() })) })).sort()).toEqual([
      'rows',
      'rows.[].id',
    ]);
    // And the real schemas are deep enough for that to matter.
    const results = jsonSchemaFromZod(ResultsResponse);
    expect(results.properties?.calculation?.properties?.fmv_per_share?.description).toContain('decimal');
    expect(results.properties?.documents?.items?.properties?.sha256?.description).toBeTruthy();
  });

  it('carries the description through into the served response schema', () => {
    // `responseSchema` re-opens every object so the API can add a field without
    // breaking strictly-generated clients. That transform rebuilds each node,
    // and a rebuild that forgot to copy `description` would leave this passing
    // everywhere except in the document a partner reads.
    const served = responseSchema(ResultsResponse);
    expect(served.properties?.calculation?.properties?.fmv_per_share?.description).toContain('decimal');
    expect(served.properties?.documents?.items?.properties?.sha256?.description).toBeTruthy();
    expect(served.additionalProperties).toBeUndefined();
  });
});

describe('the converter reads prose off the schema', () => {
  it('reads `.describe()`, whichever side of a wrapper it is on', () => {
    expect(jsonSchemaFromZod(z.string().describe('inside')).description).toBe('inside');
    expect(jsonSchemaFromZod(z.string().describe('inner').optional()).description).toBe('inner');
    expect(jsonSchemaFromZod(z.string().optional().describe('outer')).description).toBe('outer');
    expect(jsonSchemaFromZod(z.string().nullable().describe('outer')).description).toBe('outer');
    expect(jsonSchemaFromZod(z.string().default('x').describe('outer')).description).toBe('outer');
  });

  it('lets the per-operation registry override a shared schema’s own sentence', () => {
    // The registry prose is written against one endpoint; a shared schema's is
    // the more general of the two, so the specific one wins.
    const schema = z.object({ kind: z.string().describe('general') });
    expect(jsonSchemaFromZod(schema, { kind: 'specific' }).properties?.kind?.description).toBe('specific');
    expect(jsonSchemaFromZod(schema).properties?.kind?.description).toBe('general');
  });

  it('describes array elements, which is where a JSDoc comment could not reach', () => {
    const schema = z.object({ rows: z.array(z.object({ id: z.string().describe('the id') })) });
    expect(jsonSchemaFromZod(schema).properties?.rows?.items?.properties?.id?.description).toBe('the id');
  });

  it('leaves a schema with no prose alone rather than inventing an empty key', () => {
    expect(jsonSchemaFromZod(z.string())).toEqual({ type: 'string' });
    expect('description' in jsonSchemaFromZod(z.number())).toBe(false);
  });
});
