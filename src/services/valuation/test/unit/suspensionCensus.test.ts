import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../support/sourceFiles.js';

const authDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/auth');

/**
 * Every privilege predicate has to subtract the suspension for itself.
 *
 * `ignored` is this platform's suspension and it is deliberately *additive* in
 * the database: the account keeps its `admin` or `partner` row, so lifting the
 * suspension is one DELETE rather than a re-grant of a set nobody wrote down.
 * The cost of that design is that no role set can be read as "what this
 * principal may do" — `roles.some((r) => OPS_ROLES.has(r))` says yes to a
 * suspended administrator, because `admin` is in the set whatever else the row
 * carries.
 *
 * Four predicates got that wrong at once (`isOps`, `canManageUsers`,
 * `canManageBranding`, `canManageTokens`), and they were not four mistakes —
 * they were one shape written four times, in the two files that hold this
 * service's whole policy layer. So the guard is on the shape: a predicate in
 * `src/auth` that reads a principal's roles must either be the suspension
 * check, or reach something that already applied it.
 *
 * Deliberately scoped to `src/auth`. A route asking about *another* user's
 * roles — the last-administrator count, "is this analyst on the ops team" — is
 * a different question with different right answers, and sweeping those here
 * would be noise a reader learns to skip. What this can promise is that the
 * place policy is *defined* has one answer, and the second half asserts that
 * this is still the whole of that place.
 */
describe('the policy layer subtracts the suspension', () => {
  /** Reaching any of these means the suspension has already been applied. */
  const DELEGATES = [
    'isSuspended(',
    'isOps(',
    'canManageUsers(',
    'valuationScope(',
    'canReadValuation(',
    'canReadReport(',
  ];

  /**
   * The definition itself, and the enum the role vocabulary is declared with.
   * `roles.ts` names every key including `ignored`; it decides nothing.
   */
  const EXEMPT = new Set(['isSuspended']);

  /** Exported function bodies, by name — brace-matched from the signature. */
  const predicates = (source: string): Map<string, string> => {
    const found = new Map<string, string>();
    const signature = /export function (\w+)\s*\([^)]*\)[^{]*\{/g;
    for (let m = signature.exec(source); m; m = signature.exec(source)) {
      let depth = 0;
      let i = m.index + m[0].length - 1;
      const start = i;
      do {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') depth -= 1;
        i += 1;
      } while (depth > 0 && i < source.length);
      found.set(m[1]!, source.slice(start, i));
    }
    return found;
  };

  const policyFiles = sourceFiles(authDir).filter((f) => /(rbac|operations)\.ts$/.test(f));

  it('scans the files it says it scans', () => {
    // The sweep is worth exactly as much as this list. Two files today; a third
    // policy file has to be added here deliberately rather than skipped
    // silently, which is how a census stops sweeping without failing.
    expect(policyFiles.map((f) => path.basename(f)).sort()).toEqual(['operations.ts', 'rbac.ts']);
  });

  it('has no predicate that reads roles without consulting the suspension', () => {
    const offenders: string[] = [];
    for (const file of policyFiles) {
      const source = readFileSync(file, 'utf8');
      for (const [name, body] of predicates(source)) {
        if (EXEMPT.has(name)) continue;
        // Comments quote the very idiom this looks for, so read code only.
        const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        if (!/\broles\b/.test(code)) continue;
        if (DELEGATES.some((d) => code.includes(d))) continue;
        offenders.push(`${path.basename(file)}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('fails on a predicate that reads a role key straight off the row', () => {
    // The shape all four had, run through the same matcher, so a refactor that
    // quietly stops matching anything fails here rather than passing above.
    const planted = `export function canManageWidgets(p: Principal): boolean {
      return p.roles.includes('partner');
    }`;
    const body = [...predicates(planted).values()][0]!;
    expect(/\broles\b/.test(body)).toBe(true);
    expect(DELEGATES.some((d) => body.includes(d))).toBe(false);
  });
});
