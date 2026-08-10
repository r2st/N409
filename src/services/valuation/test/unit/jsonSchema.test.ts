import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isOptionalSchema, jsonSchemaFromZod } from '../../src/domain/jsonSchema.js';

/**
 * The zod → JSON Schema converter behind the partner API reference.
 *
 * This is the half of the published documentation nobody reads in review: the
 * prose is hand-written and obviously wrong when it is wrong, and the *shape* is
 * derived here. A converter that quietly drops a constraint produces a reference
 * a client generator believes — so the failure lands on a partner's integration
 * as a 422 on a body their own generated client told them was valid.
 *
 * Exercised through the public converter rather than through the route, because
 * the whole point of the module is that it is pure: given a schema, the mapping
 * is a fact, and every branch of it can be asserted without an HTTP layer.
 */

describe('jsonSchemaFromZod — scalars', () => {
  it('carries every string check the partner schemas actually use', () => {
    expect(jsonSchemaFromZod(z.string().min(1).max(300))).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 300,
    });
    expect(jsonSchemaFromZod(z.string().length(3))).toEqual({
      type: 'string',
      minLength: 3,
      maxLength: 3,
    });
    expect(jsonSchemaFromZod(z.string().email()).format).toBe('email');
    expect(jsonSchemaFromZod(z.string().url()).format).toBe('uri');
    expect(jsonSchemaFromZod(z.string().uuid()).format).toBe('uuid');
    expect(jsonSchemaFromZod(z.string().datetime()).format).toBe('date-time');
  });

  it('leaves a check it has no JSON Schema keyword for out rather than guessing', () => {
    // `.regex()` has a JSON Schema equivalent this converter deliberately does
    // not emit. The type still has to be right.
    expect(jsonSchemaFromZod(z.string().regex(/^x/))).toEqual({ type: 'string' });
  });

  it('promotes an integer field out of `number`', () => {
    expect(jsonSchemaFromZod(z.number().int().min(0).max(10))).toEqual({
      type: 'integer',
      minimum: 0,
      maximum: 10,
    });
    expect(jsonSchemaFromZod(z.number())).toEqual({ type: 'number' });
  });

  it('maps booleans, literals and enums', () => {
    expect(jsonSchemaFromZod(z.boolean())).toEqual({ type: 'boolean' });
    expect(jsonSchemaFromZod(z.literal('409a'))).toEqual({ const: '409a' });
    expect(jsonSchemaFromZod(z.enum(['409a', 'esop']))).toEqual({
      type: 'string',
      enum: ['409a', 'esop'],
    });
  });

  it('maps a native enum to its values', () => {
    enum Kind {
      A = 'a',
      B = 'b',
    }
    expect(jsonSchemaFromZod(z.nativeEnum(Kind))).toEqual({ enum: ['a', 'b'] });
  });

  it('degrades an unsupported type to "anything" rather than throwing', () => {
    // The documented contract: a docs route must not 500 because somebody
    // reached for a zod type this converter predates.
    expect(jsonSchemaFromZod(z.record(z.string()))).toEqual({});
    expect(jsonSchemaFromZod(z.any())).toEqual({});
  });
});

describe('jsonSchemaFromZod — composites', () => {
  it('carries array bounds and the item schema', () => {
    expect(jsonSchemaFromZod(z.array(z.string()).min(1).max(50))).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 50,
    });
    expect(jsonSchemaFromZod(z.array(z.number()))).toEqual({
      type: 'array',
      items: { type: 'number' },
    });
  });

  it('lists only the properties a caller must actually send as required', () => {
    const schema = z.object({
      company_name: z.string(),
      currency: z.string().default('USD'),
      note: z.string().optional(),
      reviewer: z.string().nullish(),
    });
    const out = jsonSchemaFromZod(schema, { company_name: 'The legal name of the company.' });
    expect(out.required).toEqual(['company_name']);
    expect(out.additionalProperties).toBe(false);
    expect(out.properties!.company_name!.description).toBe('The legal name of the company.');
    expect(out.properties!.currency!.default).toBe('USD');
  });

  it('omits `required` entirely when every property is optional', () => {
    const out = jsonSchemaFromZod(z.object({ note: z.string().optional() }));
    expect(out.required).toBeUndefined();
  });

  it('states nullability as a type union, per OpenAPI 3.1', () => {
    expect(jsonSchemaFromZod(z.string().nullable())).toEqual({ type: ['string', 'null'] });
  });

  it('leaves a nullable whose inner schema has no single type alone', () => {
    // A nullable union has no `type` to widen; emitting `type: [undefined,
    // 'null']` would be invalid JSON Schema, so the inner schema passes
    // through unchanged.
    expect(jsonSchemaFromZod(z.union([z.string(), z.number()]).nullable())).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('describes a union as anyOf', () => {
    expect(jsonSchemaFromZod(z.union([z.literal('a'), z.number()]))).toEqual({
      anyOf: [{ const: 'a' }, { type: 'number' }],
    });
  });

  it('documents the shape a caller sends, not the one a transform produces', () => {
    // `.transform()` and `.refine()` both wrap; the request body is the inner
    // schema, and documenting the output type would describe a body no caller
    // can send.
    expect(jsonSchemaFromZod(z.string().transform((s) => s.length))).toEqual({ type: 'string' });
    expect(jsonSchemaFromZod(z.number().refine((n) => n > 0))).toEqual({ type: 'number' });
  });
});

describe('isOptionalSchema', () => {
  it('reads through the wrappers that nest', () => {
    expect(isOptionalSchema(z.string())).toBe(false);
    expect(isOptionalSchema(z.string().optional())).toBe(true);
    expect(isOptionalSchema(z.string().default('USD'))).toBe(true);
    // `.nullish()` is `.nullable().optional()`; nullable alone is not optional,
    // because the caller still has to send the key.
    expect(isOptionalSchema(z.string().nullish())).toBe(true);
    expect(isOptionalSchema(z.string().nullable())).toBe(false);
    expect(isOptionalSchema(z.string().nullable().default('x'))).toBe(true);
  });

  it('reads through a refinement to the wrapper underneath it', () => {
    expect(isOptionalSchema(z.string().optional().refine(() => true))).toBe(true);
    expect(isOptionalSchema(z.string().refine(() => true))).toBe(false);
  });
});
