import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLIENT_ROLES, OPS_ROLES, PARTNER_ROLES, USER_ADMIN_ROLES } from '../src/lib/rbac';

/**
 * The browser's copy of the role groupings is the same set as the server's.
 *
 * `src/lib/rbac.ts` says up front that it is a "client-side mirror of the
 * valuation service's RBAC groupings" and that it is "purely cosmetic — the API
 * enforces the real policy". Both halves of that are true, and together they
 * are exactly why the mirror is worth guarding: because nothing *breaks* when
 * it drifts, nothing catches it either.
 *
 * What drift actually looks like, in the two directions:
 *
 *   * **A role the server treats as ops, missing here.** That person signs in,
 *     the API answers every ops request they make, and the navigation has no
 *     link to any of it. The product is simply not there, and the support
 *     ticket is "I can't see the admin menu" — which reads as a permissions
 *     bug and is investigated as one, on the server, where nothing is wrong.
 *
 *   * **A role listed here and not there.** The nav offers the console, every
 *     page inside it renders its 403 state, and the reader is told they are
 *     not allowed to do a thing the product had just invited them to do.
 *
 * Neither shows up in a type error, in either package's tests, or in any
 * request. They show up as a person confused about what the software is.
 *
 * The server's `domain/roles.ts` is read as text rather than imported: the
 * frontend package does not depend on the valuation service, and adding that
 * dependency to gain a test would put the server's whole module graph into the
 * browser build's resolution. The parse is narrow and asserted — a rename that
 * defeats it fails the first test here rather than quietly passing the rest.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROLES = path.resolve(HERE, '../../valuation/src/domain/roles.ts');

const source = readFileSync(SERVER_ROLES, 'utf8');

/**
 * The string members of a `new Set([...])` or a bare array assigned to `name`.
 *
 * Deliberately anchored on the declaration rather than scanning for any array
 * of quoted words: two of these sets differ by one member, and a looser match
 * that picked up the wrong declaration would compare a set to itself and pass.
 */
function serverSet(name: string): string[] {
  const at = source.indexOf(`export const ${name}`);
  if (at < 0) return [];
  const open = source.indexOf('[', at);
  const close = source.indexOf(']', open);
  if (open < 0 || close < 0) return [];
  return [...source.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

const PAIRS: Array<[string, Set<string>]> = [
  ['OPS_ROLES', OPS_ROLES],
  ['PARTNER_ROLES', PARTNER_ROLES],
  ['CLIENT_ROLES', CLIENT_ROLES],
  ['USER_ADMIN_ROLES', USER_ADMIN_ROLES],
];

describe('the browser mirror of the RBAC groupings matches the server', () => {
  it('parses the server module it is comparing against', () => {
    // Guards the guard: a rename, a reformat, or a move of `domain/roles.ts`
    // would otherwise give every set below an empty right-hand side, and four
    // comparisons of "nothing missing from nothing" all pass.
    for (const [name] of PAIRS) {
      expect(serverSet(name).length, `${name} did not parse out of domain/roles.ts`).toBeGreaterThan(1);
    }
    expect(serverSet('ROLE_KEYS').length).toBeGreaterThan(10);
  });

  it.each(PAIRS)('%s holds the same roles on both sides', (name, browser) => {
    expect([...browser].sort()).toEqual(serverSet(name).sort());
  });

  it('names only roles the server actually has', () => {
    // A typo'd role in the browser set is silent in a different way: it is
    // never matched, so the grouping is quietly one role short and every test
    // above still passes if the same typo is on both sides.
    const known = new Set(serverSet('ROLE_KEYS'));
    for (const [name, browser] of PAIRS) {
      const unknown = [...browser].filter((role) => !known.has(role));
      expect(unknown, `${name} names roles that are not in ROLE_KEYS`).toEqual([]);
    }
  });

  it('leaves no role of the server ungrouped without saying so', () => {
    // Every key is in one of the three scopes, or is one of the two the client
    // deliberately has no opinion about: `ignored` (no access at all) and
    // `auditor` (whose access is a scoped portal, not a slice of this app).
    const grouped = new Set([...OPS_ROLES, ...PARTNER_ROLES, ...CLIENT_ROLES]);
    const ungrouped = serverSet('ROLE_KEYS').filter((role) => !grouped.has(role));
    expect(ungrouped.sort()).toEqual(['auditor', 'ignored']);
  });
});
