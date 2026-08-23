import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A path parameter cannot be longer than the router will route.
 *
 * Fastify refuses a path parameter longer than `maxParamLength` — 100 by
 * default, and nothing in this service overrides it — with a 414, before any
 * handler runs. So a write path whose ceiling is higher than 100 can mint a
 * value that then has no reachable URL. That is not hypothetical; it has
 * happened twice:
 *
 *  - a blog slug capped at 120, so a post of 101–120 characters was accepted,
 *    stored and listed on the index, and answered 414 at its own link;
 *  - an email suppression addressed by `:address`, where an address is valid
 *    to 320, so a hard bounce on a long address could never be released. That
 *    one is fixed by moving the address into the body, which is why it no
 *    longer appears below — a value that is not a path parameter has no
 *    business being bounded by the router.
 *
 * Both were invisible to every unit test of the routes involved, because each
 * half is correct on its own. Only the pairing is wrong, and the pairing is
 * what this scans for.
 *
 * It reads the source rather than restating the caps, so it cannot pass by
 * agreeing with a stale copy of them: change `.max(...)` on a field that names
 * a path parameter and this reads the new number. It resolves a numeric
 * constant (`.max(SLUG_MAX)`) and a named schema (`slug: Slug`) as well, since
 * both are how the caps are actually written.
 *
 * Its blind spot is the same one every source scan has: a schema assembled
 * somewhere this does not look — built in another module, spread in, or
 * composed at runtime — is a cap it cannot see. The count assertion below is
 * the guard against that becoming silent. It is a floor, not a fixture: adding
 * a bounded path parameter should raise it, and a refactor that drops the
 * matches to zero has to fail rather than report a clean scan of nothing.
 */

/** Fastify's default `maxParamLength`. Overriding it would belong in app.ts. */
const ROUTER_MAX_PARAM_LENGTH = 100;

const ROUTES_DIR = new URL('../../src/routes/', import.meta.url).pathname;

const URL_LITERAL = /'(\/[^']*:[^']*)'/g;
const PARAM = /:([a-zA-Z_]+)/g;
const NUMERIC_CONST = /^const ([A-Za-z][A-Za-z0-9_]*) = (\d+);/gm;
const SCHEMA_CONST = /^const ([A-Za-z][A-Za-z0-9_]*) =\s*(z\b[\s\S]*?);\s*$/gm;
/** `name: <schema>`, bounded by the next field or the object's close. */
const FIELD = /(\w+):\s*([A-Za-z][\w.]*|z\b[\s\S]*?)\s*,?\s*(?=\n\s*\w+:\s|\n\s*\}\))/g;

interface Bound {
  file: string;
  param: string;
  max: number | null;
  raw: string;
}

function scan(): Bound[] {
  const found: Bound[] = [];
  for (const file of readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .sort()) {
    const src = readFileSync(join(ROUTES_DIR, file), 'utf8');

    const params = new Set<string>();
    for (const [, url] of src.matchAll(URL_LITERAL)) {
      for (const [, p] of url.matchAll(PARAM)) params.add(p);
    }
    if (params.size === 0) continue;

    const numbers = new Map<string, number>();
    for (const [, name, value] of src.matchAll(NUMERIC_CONST)) numbers.set(name, Number(value));
    const schemas = new Map<string, string>();
    for (const [, name, chain] of src.matchAll(SCHEMA_CONST)) schemas.set(name, chain);

    for (const [, name, value] of src.matchAll(FIELD)) {
      if (!params.has(name)) continue;
      const chain = value.startsWith('z') ? value : (schemas.get(value.trim()) ?? '');
      // Only a string field has a length to compare; an enum is bounded by its
      // own members and a number never reaches the router as a long path.
      if (!chain.includes('.string()')) continue;
      const capped = /\.max\((\w+)\)/.exec(chain);
      const raw = capped?.[1] ?? '(uncapped)';
      const max = capped ? (/^\d+$/.test(raw) ? Number(raw) : (numbers.get(raw) ?? null)) : null;
      found.push({ file, param: name, max, raw });
    }
  }
  return found;
}

describe('path parameters against the router', () => {
  const bounds = scan();

  it('finds the bounded path parameters, so the checks below are not a scan of nothing', () => {
    expect(bounds.length).toBeGreaterThanOrEqual(5);
    // Named so a rename that quietly stops matching is a failure rather than a
    // smaller number that still clears the floor.
    expect(new Set(bounds.map((b) => `${b.file}:${b.param}`))).toEqual(
      new Set(['adminUsers.ts:key', 'blog.ts:slug', 'help.ts:slug', 'valuationTags.ts:slug']),
    );
  });

  it('resolves every cap it found to a number', () => {
    // An unresolved cap is not a pass. It means the scan saw the field, could
    // not read its ceiling, and would have said nothing either way.
    expect(bounds.filter((b) => b.max === null).map((b) => `${b.file}:${b.param} → ${b.raw}`)).toEqual([]);
  });

  it('caps every one of them at what the router can route', () => {
    const over = bounds
      .filter((b) => b.max !== null && b.max > ROUTER_MAX_PARAM_LENGTH)
      .map((b) => `${b.file} :${b.param} accepts ${b.max}, router routes ${ROUTER_MAX_PARAM_LENGTH}`);
    expect(over).toEqual([]);
  });
});
