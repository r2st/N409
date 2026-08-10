import type { z } from 'zod';

/**
 * Zod → JSON Schema, for the subset the partner API validates with.
 *
 * The partner API already describes each field in prose, and prose is what a
 * human needs. A client generator needs the other half: is `currency` a string
 * or a number, is `events` an array, which fields may be omitted, what are the
 * legal values of `kind`. Writing that out a second time by hand next to the
 * zod schema is how the two drift — and a published API reference that
 * disagrees with the validator is worse than one that says less, because the
 * caller trusts it and gets a 422.
 *
 * So the description stays hand-written and the *shape* is derived from the
 * schema the route actually parses with. One source, and it is the enforcing
 * one.
 *
 * Deliberately not a general-purpose converter — there is no dependency here
 * and no ambition to grow into one. It covers what the partner API uses, and
 * an unrecognised type degrades to `{}` (JSON Schema for "anything") rather
 * than throwing: an endpoint documented a little loosely is a much better
 * failure than a docs route that 500s because someone added a `z.record`.
 */

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  anyOf?: JsonSchema[];
  nullable?: boolean;
}

/** zod keeps its metadata on `_def`, which is untyped across versions. */
type Def = Record<string, unknown>;

const defOf = (schema: z.ZodTypeAny): Def => (schema as unknown as { _def: Def })._def;
const typeName = (schema: z.ZodTypeAny): string => String(defOf(schema).typeName ?? '');

/**
 * Whether a field may be left out of a request body.
 *
 * `.optional()`, `.default()` and `.nullish()` all mean "not required" to a
 * caller, and they nest — `z.string().default('USD').optional()` is one field,
 * not three. Unwrapping rather than checking the outermost type is what makes
 * that read correctly.
 */
export function isOptionalSchema(schema: z.ZodTypeAny): boolean {
  const name = typeName(schema);
  if (name === 'ZodOptional' || name === 'ZodDefault') return true;
  if (name === 'ZodEffects') return isOptionalSchema(defOf(schema).schema as z.ZodTypeAny);
  if (name === 'ZodNullable') return isOptionalSchema(defOf(schema).innerType as z.ZodTypeAny);
  return false;
}

function stringSchema(def: Def): JsonSchema {
  const out: JsonSchema = { type: 'string' };
  for (const check of (def.checks as Array<Record<string, unknown>>) ?? []) {
    switch (check.kind) {
      case 'min':
        out.minLength = check.value as number;
        break;
      case 'max':
        out.maxLength = check.value as number;
        break;
      case 'length':
        out.minLength = check.value as number;
        out.maxLength = check.value as number;
        break;
      case 'email':
        out.format = 'email';
        break;
      case 'url':
        out.format = 'uri';
        break;
      case 'uuid':
        out.format = 'uuid';
        break;
      case 'datetime':
        out.format = 'date-time';
        break;
    }
  }
  return out;
}

function numberSchema(def: Def): JsonSchema {
  const out: JsonSchema = { type: 'number' };
  for (const check of (def.checks as Array<Record<string, unknown>>) ?? []) {
    // `.int()` is a check, not a type — an integer field documented as `number`
    // lets a generator emit a float and the caller gets a 422 on a round number.
    if (check.kind === 'int') out.type = 'integer';
    if (check.kind === 'min') out.minimum = check.value as number;
    if (check.kind === 'max') out.maximum = check.value as number;
  }
  return out;
}

/**
 * The JSON Schema for one zod schema.
 *
 * `descriptions` maps a top-level property name to the prose already written
 * for the API reference, so the generated schema carries both halves.
 */
export function jsonSchemaFromZod(
  schema: z.ZodTypeAny,
  descriptions: Record<string, string> = {},
): JsonSchema {
  const def = defOf(schema);
  switch (typeName(schema)) {
    case 'ZodString':
      return stringSchema(def);
    case 'ZodNumber':
      return numberSchema(def);
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodLiteral':
      return { const: def.value };
    case 'ZodEnum':
      return { type: 'string', enum: [...(def.values as string[])] };
    case 'ZodNativeEnum':
      return { enum: Object.values(def.values as Record<string, unknown>) };
    case 'ZodArray': {
      const out: JsonSchema = { type: 'array', items: jsonSchemaFromZod(def.type as z.ZodTypeAny) };
      const min = def.minLength as { value: number } | null;
      const max = def.maxLength as { value: number } | null;
      if (min) out.minItems = min.value;
      if (max) out.maxItems = max.value;
      return out;
    }
    case 'ZodObject': {
      const shape = (def.shape as () => Record<string, z.ZodTypeAny>)();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const child = jsonSchemaFromZod(value);
        const description = descriptions[key];
        properties[key] = description ? { description, ...child } : child;
        if (!isOptionalSchema(value)) required.push(key);
      }
      const out: JsonSchema = { type: 'object', properties, additionalProperties: false };
      if (required.length > 0) out.required = required;
      return out;
    }
    case 'ZodOptional':
      return jsonSchemaFromZod(def.innerType as z.ZodTypeAny, descriptions);
    case 'ZodNullable': {
      const inner = jsonSchemaFromZod(def.innerType as z.ZodTypeAny, descriptions);
      // OpenAPI 3.1 is JSON Schema 2020-12, where nullability is a type union
      // rather than the 3.0 `nullable: true` keyword.
      return typeof inner.type === 'string' ? { ...inner, type: [inner.type, 'null'] } : inner;
    }
    case 'ZodDefault': {
      const inner = jsonSchemaFromZod(def.innerType as z.ZodTypeAny, descriptions);
      return { ...inner, default: (def.defaultValue as () => unknown)() };
    }
    case 'ZodEffects':
      // `.transform()` / `.refine()` wrap the schema they run over; the shape a
      // caller must send is the inner one.
      return jsonSchemaFromZod(def.schema as z.ZodTypeAny, descriptions);
    case 'ZodUnion':
      return { anyOf: (def.options as z.ZodTypeAny[]).map((option) => jsonSchemaFromZod(option)) };
    default:
      return {};
  }
}
