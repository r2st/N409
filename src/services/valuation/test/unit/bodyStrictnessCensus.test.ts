import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every write-body Zod schema in `src/routes` must call `.strict()`.
 *
 * Without `.strict()`, `z.object({...})` silently strips unknown keys: a
 * caller who misspells a field or sends an extra one gets a 200 and a row
 * that differs from what they asked for. `.strict()` rejects the request
 * with a 422 that names the unrecognised field.
 *
 * This census enforces the invariant the body-validation census already
 * states in prose — "every body schema here is `.strict()`" — by scanning
 * the source for named `*Body` constants that are `z.object(...)` without
 * `.strict()` in their definition chain.
 *
 * Exemptions:
 * - Query schemas (`*Query`, `*Params`) are NOT strict because frameworks
 *   and proxies may add keys the handler does not know about.
 * - Schemas that use `.partial().strict()` (patch bodies) already have it
 *   from the `.partial()` chain.
 * - Discriminated unions — `.strict()` goes on each variant, not the union.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = path.resolve(HERE, '../../src/routes');

/**
 * Schemas that are intentionally not strict, with a documented reason.
 *
 * Every entry here is a route whose body is not a JSON object this
 * service's schemas describe, or whose schema structure makes `.strict()`
 * the wrong call (e.g. a `z.record()` keyed by a provider's own keys).
 */
const NOT_STRICT: Record<string, string> = {
  'hris.ts:CallbackQuery':
    'OAuth callback query — providers append their own keys (scope, session_state, etc.) and a strict parse would reject every provider that adds one.',
};

interface BodySchema {
  file: string;
  name: string;
  line: number;
  hasStrict: boolean;
}

function scanBodySchemas(): BodySchema[] {
  const results: BodySchema[] = [];

  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(path.join(ROUTES, file), 'utf8');
    const lines = source.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Match named Body schemas: `const FooBody = z.object({` or `const FooBody = z\n  .object({`
      const namedMatch = /\bconst\s+(\w*Body)\s*=\s*z[\s.]/.exec(line);
      if (!namedMatch) continue;

      const name = namedMatch[1]!;
      // Skip if it's a Query or Params schema that happens to end in Body
      if (/Query$|Params$/.test(name)) continue;

      // Read forward to find the end of the schema definition
      // Look for .strict() in the chain, up to 40 lines ahead
      let chunk = '';
      let depth = 0;
      let foundEnd = false;
      for (let j = i; j < Math.min(lines.length, i + 40); j++) {
        chunk += lines[j] + '\n';
        for (const ch of lines[j]!) {
          if (ch === '(' || ch === '{') depth++;
          if (ch === ')' || ch === '}') depth--;
        }
        // The schema definition ends when we return to depth 0 after going in,
        // or when we hit a blank line / next const after the definition
        if (j > i && depth <= 0) {
          foundEnd = true;
          break;
        }
      }

      if (!foundEnd) chunk = lines.slice(i, i + 40).join('\n');

      // Check if .strict() appears in the schema definition chain
      // It may appear as `.strict()` directly or via `.partial().strict()`
      const hasStrict = /\.strict\(\)/.test(chunk);

      // Skip schemas that derive from another Body via .extend/.partial/.omit
      // where the parent is already strict — those inherit strictness
      if (/\.\b(?:extend|partial|omit)\b/.test(chunk) && hasStrict) continue;

      results.push({ file, name, line: i + 1, hasStrict });
    }
  }

  return results;
}

describe('every write-body zod schema is strict', () => {
  const schemas = scanBodySchemas();

  it('is reading a route table of the size this service has', () => {
    expect(schemas.length).toBeGreaterThan(40);
  });

  it('has .strict() on every named Body schema', () => {
    const missing = schemas
      .filter((s) => !s.hasStrict)
      .filter((s) => !(`${s.file}:${s.name}` in NOT_STRICT))
      .map((s) => `${s.file}:${s.line} ${s.name}`);

    expect(missing).toEqual([]);
  });

  it('accounts for nothing that has started using .strict()', () => {
    const exempted = new Set(Object.keys(NOT_STRICT));
    const found = new Set(schemas.filter((s) => !s.hasStrict).map((s) => `${s.file}:${s.name}`));
    const stale = [...exempted].filter((k) => !found.has(k));
    expect(stale).toEqual([]);
  });
});
