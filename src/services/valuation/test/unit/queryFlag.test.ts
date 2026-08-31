import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { flagParam } from '../../src/domain/queryFlag.js';

/**
 * A query-string boolean means what it says, and there is one spelling of it.
 *
 * Six route schemas wrote `z.coerce.boolean()`, which for a query string is
 * `Boolean('false')` — true. Every deliberate "no" turned the filter on:
 * `?include_deleted=false` listed deactivated accounts, `?unread=false`
 * narrowed the list to unread instead of widening it to everything, and
 * `?overdue=banana` filtered to overdue. All of it with a 200 and a page that
 * looked plausible, so nothing about the response said the filter had been read
 * backwards.
 *
 * The list filters never had the bug — `routes/valuations.ts` wrote the enum
 * form from the start — which is what made this a drift rather than an
 * oversight: two spellings for one wire format, and only one of them correct.
 *
 * The behavioural half is below; the census after it is what keeps the seventh
 * flag from being written the wrong way, since a behavioural test can only
 * drive the flags somebody remembered to list.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = path.resolve(here, '../../src/routes');

describe('a query-string boolean', () => {
  const optional = z.object({ f: flagParam() });
  const defaulted = z.object({ f: flagParam(false) });
  const defaultedOn = z.object({ f: flagParam(true) });

  it('reads "false" as false — the case coercion got backwards', () => {
    expect(optional.parse({ f: 'false' }).f).toBe(false);
    expect(defaulted.parse({ f: 'false' }).f).toBe(false);
    expect(defaultedOn.parse({ f: 'false' }).f).toBe(false);
  });

  it('reads "true" as true', () => {
    expect(optional.parse({ f: 'true' }).f).toBe(true);
    expect(defaulted.parse({ f: 'true' }).f).toBe(true);
  });

  it('leaves an absent flag to the caller, or to the default', () => {
    expect(optional.parse({}).f).toBeUndefined();
    expect(defaulted.parse({}).f).toBe(false);
    expect(defaultedOn.parse({}).f).toBe(true);
  });

  it('refuses anything else rather than guessing at it', () => {
    // Each of these was `true` under coercion. A 400 naming the field is the
    // only answer that cannot be mistaken for the filter having been applied.
    for (const value of ['0', '1', 'no', 'yes', 'on', 'off', 'FALSE', 'banana', '']) {
      expect(optional.safeParse({ f: value }).success, value).toBe(false);
      expect(defaulted.safeParse({ f: value }).success, value).toBe(false);
    }
  });

  it('names the field it refused', () => {
    const parsed = optional.safeParse({ f: 'nope' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]!.path).toEqual(['f']);
  });
});

// ── The census ───────────────────────────────────────────────────────────────

/**
 * Every route file, with its comments stripped.
 *
 * Prose about a spelling is not the spelling — `schemaBoundaryCensus` states
 * the same rule for the same reason. The routes that were fixed explain in a
 * comment what they used to do, and a scan that could not tell a comment from
 * code would fail on its own documentation.
 */
function routeSources(): Array<{ file: string; src: string }> {
  return readdirSync(ROUTES)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({
      file: f,
      src: readFileSync(path.join(ROUTES, f), 'utf8')
        .split('\n')
        .filter((line) => {
          const t = line.trim();
          return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
        })
        .join('\n'),
    }));
}

describe('one spelling of a query-string boolean, service-wide', () => {
  const files = routeSources();

  it('finds the routes at all', () => {
    // The vacuity guard: if the directory moves, every assertion below passes
    // by having nothing to ask.
    expect(files.length).toBeGreaterThanOrEqual(50);
  });

  it('is the spelling the routes actually use', () => {
    // The other half of the vacuity guard. A rule that forbids an idiom nobody
    // uses any more proves nothing about the idiom that replaced it.
    const users = files.filter((f) => /\bflagParam\s*\(/.test(f.src)).map((f) => f.file);
    expect(users.length).toBeGreaterThanOrEqual(8);
    expect(users).toContain('valuations.ts');
  });

  it('has no route left coercing a boolean', () => {
    const coercing = files.filter((f) => /z\.coerce\.boolean\s*\(/.test(f.src)).map((f) => f.file);
    expect(coercing).toEqual([]);
  });

  it('has no route restating the enum inline', () => {
    // Not a style rule. The inline form is correct, and that is the problem:
    // it is correct in six places and wrong in six others, and nothing about
    // reading one of them tells you which kind you are looking at.
    //
    // Matched on the *presence* of `'true'` among the members rather than on
    // the exact pair. `routes/organizations.ts` wrote
    // `z.enum(['true', 'false', '1', '0'])` — a third spelling, admitting two
    // values no other flag in the service takes — and the pair-shaped pattern
    // walked straight past it (R287). A rule a variant escapes by adding a
    // member is a rule about a string, not about the idiom.
    const inline = files.filter((f) => /z\s*\n?\s*\.\s*enum\(\[[^\]]*'true'/.test(f.src)).map((f) => f.file);
    expect(inline).toEqual([]);
  });

  it('has no route deciding a query flag with a comparison of its own', () => {
    /*
     * The fourth spelling, and the one no schema-shaped scan could see:
     * `routes/payments.ts` read the raw query object and asked
     * `q[name] === 'true' || q[name] === '1'`, with everything else silently
     * false. On the route that quotes a price, so `?express=TRUE` — and the
     * `['true','true']` a repeated key arrives as — priced work the caller had
     * asked for as though they had not, and said nothing.
     *
     * `queryFlag.ts` owns the comparison; anywhere else it is a route with its
     * own opinion about what a query string means.
     */
    const comparing = files.filter((f) => /===\s*'true'/.test(f.src)).map((f) => f.file);
    expect(comparing).toEqual([]);
  });
});
