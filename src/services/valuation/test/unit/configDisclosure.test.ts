import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A client-facing problem body may not name this deployment's configuration.
 *
 * The checkout route refused an unconfigured deployment with
 * `Payments are not configured (STRIPE_SECRET_KEY unset)`, and the one below
 * it with `(Stripe is in test mode)`. Both went to the person who had just
 * pressed Pay, and the parenthesis is wrong in both directions at once:
 *
 *   - it is not theirs to know. An environment variable's name and a
 *     deployment's Stripe mode are facts about our infrastructure, handed to
 *     whoever asked — including the unauthenticated webhook endpoint, which
 *     answered a stranger's POST with the name of an unset secret.
 *   - it is not theirs to fix. There is no key for a client to set, so the
 *     half of the sentence carrying all the information carries none of the
 *     remedy, and what is left — "not configured" — is the reader being told
 *     their payment failed for reasons.
 *
 * The reason still has a reader; it is the operator, and the log line is where
 * they are looking. This census is the rule that keeps the two apart.
 *
 * Bounded, and worth saying where: it reads the *literal* text a route writes
 * into a body. A configuration name assembled at runtime — interpolated from a
 * variable, or read back off an error — is invisible to it, and the general
 * guard against echoing a caught error's wording is errorBodyDisclosure's job,
 * not this one's.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../../..');
const ROUTES = path.resolve(HERE, '../../src/routes');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.ts$/.test(full) ? [full] : [];
  });
}

/**
 * Every variable `.env.example` declares — the contract, and so the vocabulary
 * a body must not speak. Read from the file rather than listed here so a
 * variable added to the contract is covered by this the day it is added.
 *
 * Commented-out lines count. An optional variable is still a name that says
 * something about the deployment, and `# STRIPE_SECRET_KEY=` is exactly how an
 * unset one appears.
 */
export function envNames(envExample: string): string[] {
  const names = new Set<string>();
  for (const line of envExample.split('\n')) {
    const m = /^\s*#?\s*([A-Z][A-Z0-9_]{5,})\s*=/.exec(line);
    if (m) names.add(m[1]!);
  }
  return [...names];
}

/**
 * The string a route hands the client, wherever it is spelled.
 *
 * Three shapes reach a body in this tree and all three had to be covered,
 * because the two offending strings were in the third: `problems.x('…')`, an
 * `ApiProblem` literal's `detail:`, and the file-local helpers
 * (`paymentsUnavailable`, `billingUnavailable`, `stripeUpstream`) that wrap one
 * of the two. A census that read only `problems.*` would have reported this
 * area clean while it was the area with the bug.
 *
 * Comments are stripped first: every one of these strings is discussed in prose
 * directly above the line that throws it, and a census that could not tell the
 * discussion from the throw would be unkeepable.
 */
export function clientMessages(text: string): string[] {
  const src = stripComments(text);
  const out: string[] = [];
  const callers =
    /(?:\bproblems\.[a-zA-Z]+\(|\bdetail\s*:|\b[a-z][A-Za-z0-9]*(?:Unavailable|Upstream|Problem)\s*\()/g;
  let m: RegExpExecArray | null;
  while ((m = callers.exec(src))) {
    /*
     * The argument list, or the property value — and no further.
     *
     * Bounded by the next `;` rather than by a character count, which is not a
     * refinement: an unbounded forward window swept over the *log* line beside
     * a refusal and reported it, and that line is the whole point of the fix
     * this census guards. The reason belongs in the log; a census that cannot
     * tell a log call from a body would forbid it there too.
     */
    const semi = src.indexOf(';', m.index);
    const end = Math.min(m.index + 800, semi === -1 ? src.length : semi + 1);
    const window = src.slice(m.index, end);
    for (const lit of window.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) {
      out.push(lit[1] ?? lit[2] ?? '');
    }
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1 ');
}

describe('no configuration in a client-facing problem body', () => {
  const names = envNames(readFileSync(path.join(ROOT, '.env.example'), 'utf8'));

  it('reads a real contract', () => {
    // A census over an empty vocabulary passes by having nothing to ask.
    expect(names.length).toBeGreaterThan(50);
    expect(names).toContain('STRIPE_SECRET_KEY');
    expect(names).toContain('STRIPE_WEBHOOK_SECRET');
  });

  it('catches the wording this census was written for', () => {
    const offender = `throw paymentsUnavailable('Payments are not configured (STRIPE_SECRET_KEY unset)');`;
    const hits = clientMessages(offender).filter((msg) => names.some((n) => msg.includes(n)));
    expect(hits).toHaveLength(1);
  });

  it('leaves the log line alone, which is where the reason belongs', () => {
    const both = [
      `req.log.warn({ id }, 'checkout refused: STRIPE_SECRET_KEY is unset');`,
      `throw paymentsUnavailable('We cannot take a card payment right now.');`,
    ].join('\n');
    expect(clientMessages(both).filter((msg) => names.some((n) => msg.includes(n)))).toEqual([]);
  });

  it('does not mistake the prose above a throw for the throw', () => {
    const commented = [
      '// STRIPE_SECRET_KEY is unset on this deployment, which is why this refuses.',
      `/* Was: paymentsUnavailable('… (STRIPE_SECRET_KEY unset)') — see R247. */`,
      `throw paymentsUnavailable('We cannot take a card payment right now.');`,
    ].join('\n');
    expect(clientMessages(commented).filter((msg) => names.some((n) => msg.includes(n)))).toEqual([]);
  });

  /**
   * The one body that may name a variable, and why it is the only one.
   *
   * `POST /valuations/:id/pipeline/runs` refuses non-ops two lines above this
   * throw, so its only possible reader is an operator — the person for whom
   * `AUTO_PIPELINE=off` is not a disclosure but the remedy, stated exactly. The
   * rule this census keeps is that a body must not tell a *client* about our
   * configuration; a body that can only reach an operator is telling the person
   * whose configuration it is.
   *
   * Written as one entry with its reason rather than as a pattern, because the
   * next message that wants this exemption should have to argue for it here.
   */
  const OPS_ONLY_BODIES = ['The pipeline is disabled on this deployment (AUTO_PIPELINE=off)'];

  describe.each(OPS_ONLY_BODIES)('the ops-only allowance', (body) => {
    it('is still guarded by an ops check in its handler', () => {
      const src = readFileSync(path.join(ROUTES, 'pipeline.ts'), 'utf8');
      const at = src.indexOf(body);
      expect(at).toBeGreaterThan(-1);
      // The refusal that makes this body ops-only, in the same handler above it.
      expect(src.slice(Math.max(0, at - 1200), at)).toContain('isOps(principal)');
    });
  });

  describe('no configuration in a client-facing problem body (route sweep)', () => {
    const names = envNames(readFileSync(path.join(ROOT, '.env.example'), 'utf8'));

    it('names no environment variable in any route body', () => {
      const offenders: string[] = [];
      for (const file of sourceFiles(ROUTES)) {
        const text = readFileSync(file, 'utf8');
        for (const msg of clientMessages(text)) {
          if (OPS_ONLY_BODIES.includes(msg)) continue;
          const named = names.filter((n) => msg.includes(n));
          if (named.length > 0) offenders.push(`${path.basename(file)}: ${named.join(',')} in ${msg}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  });
});
