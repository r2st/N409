import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MetricsRegistry } from '@n409/shared';
import {
  recordSignInOutcome,
  registerSignInMetrics,
  resetSignInMetrics,
} from '../../src/observability/signInOutcomes.js';

/**
 * The front door, counted (R353, methodology M11).
 *
 * Every *machine* door onto this platform has an outcome counter and a rule
 * written against it — the inbound webhooks and the two SSO flows in R329, the
 * directory connector in R337, the partner API keys in R345 — and each of those
 * rounds gave the same argument: the refusal is answered in a status class
 * nothing on this box watches, so an outage that stops everybody getting in
 * reads green on every other instrument.
 *
 * The door people use was the one left, and it is the plainest case of it.
 * `POST /auth/login` answers a refusal with 401 and a lockout with 429, and
 * `scimRequests.ts` states the standing fact that makes both invisible: there
 * is no 4xx rule on this deployment at all. A password verifier that stopped
 * verifying, a `users` table restored with the digests where nothing reads
 * them, or a TOTP secret encrypted under a key that has since been rotated
 * refuses every sign-in on the estate — with no 5xx, no slow request and no
 * open circuit, because the identity store is our own Postgres and it is
 * answering perfectly well.
 *
 * The audit spine has carried the rows since R215. It is the record an
 * investigator reads afterwards, on the same database the incident may be
 * about; it is not a channel anybody is woken by.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUTH = readFileSync(path.resolve(HERE, '../../src/routes/auth.ts'), 'utf8');

/** One route handler's body, brace-matched from its `app.post(` to the close. */
function handlerBody(url: string): string {
  const start = AUTH.indexOf(`app.post('${url}'`);
  expect(start, `${url} is not registered in routes/auth.ts`).toBeGreaterThan(-1);
  const open = AUTH.indexOf('{', AUTH.indexOf('async (', start));
  let depth = 0;
  for (let i = open; i < AUTH.length; i++) {
    if (AUTH[i] === '{') depth++;
    else if (AUTH[i] === '}' && --depth === 0) return AUTH.slice(open, i);
  }
  throw new Error(`unbalanced handler for ${url}`);
}

describe('the sign-in outcome counter', () => {
  afterEach(() => resetSignInMetrics());

  it('keeps the two doors and the nine outcomes apart', () => {
    const registry = new MetricsRegistry();
    registerSignInMetrics(registry);

    recordSignInOutcome('password', 'signed_in');
    recordSignInOutcome('password', 'mfa_challenged');
    recordSignInOutcome('password', 'bad_password');
    recordSignInOutcome('mfa', 'bad_code');

    const text = registry.render();
    expect(text).toContain('sign_in_outcomes_total{door="password",outcome="signed_in"} 1');
    expect(text).toContain('sign_in_outcomes_total{door="password",outcome="mfa_challenged"} 1');
    expect(text).toContain('sign_in_outcomes_total{door="password",outcome="bad_password"} 1');
    expect(text).toContain('sign_in_outcomes_total{door="mfa",outcome="bad_code"} 1');
  });

  it('is inert before registration rather than throwing', () => {
    // The instrument is module-level and a route can be built without one — the
    // suites that exercise auth against a bare Fastify do exactly that. A door
    // that throws because nobody registered its counter is a worse outage than
    // the one the counter exists to report.
    expect(() => recordSignInOutcome('password', 'signed_in')).not.toThrow();
  });

  it('is registered on the app, or nothing above reaches a scrape', () => {
    const app = readFileSync(path.resolve(HERE, '../../src/app.ts'), 'utf8');
    expect(app).toContain('registerSignInMetrics(metricsRegistry)');
  });
});

describe('every refusal at either sign-in door', () => {
  /*
   * Derived from the source rather than listed, for the reason every census in
   * this repository is: a tenth outcome added to `POST /auth/login` next year is
   * exactly the one a hand-written list does not have, and a refusal that is not
   * counted does not make the ratio rule wrong — it makes it quieter, which is
   * indistinguishable from the platform being healthy.
   *
   * `problems.*` only. The body-parse failure at the top of each handler throws
   * `invalidBody`, which is a 400 about the request's shape rather than an
   * outcome of an attempt to sign in, and counting it would put a malformed
   * client into the numerator of a rule about whether people can get in.
   */
  for (const url of ['/api/v1/auth/login', '/api/v1/auth/mfa/verify']) {
    it(`${url} counts before it refuses`, () => {
      const body = handlerBody(url);
      const throws = [...body.matchAll(/throw problems\.\w+\(/g)];
      // Non-vacuity: a scan that matched nothing would pass this for the wrong
      // reason, and both handlers refuse in at least two ways.
      expect(throws.length).toBeGreaterThanOrEqual(2);
      for (const t of throws) {
        const before = body.slice(Math.max(0, t.index! - 500), t.index!);
        expect(
          before,
          `a refusal at ${url} that reaches no counter — it is a 401 or a 429, and this box has no rule on either class`,
        ).toMatch(/recordSignInOutcome\(/);
      }
    });
  }

  it('counts the two endings that are not refusals', () => {
    // `signed_in` is the denominator — without it the ratio rule cannot be
    // written at all — and `mfa_challenged` is the outcome that is neither: an
    // account with 2FA on is answered by the password door with a challenge
    // rather than a session, and it is excluded from both halves of the rule.
    const login = handlerBody('/api/v1/auth/login');
    expect(login).toContain("recordSignInOutcome('password', 'signed_in')");
    expect(login).toContain("recordSignInOutcome('password', 'mfa_challenged')");
    expect(handlerBody('/api/v1/auth/mfa/verify')).toContain("recordSignInOutcome('mfa', 'signed_in')");
  });

  it('gives the spine row and the counter one vocabulary', () => {
    // The three password refusals are the `reason` the audit row already
    // records, computed once and handed to both. Two spellings of one word is
    // how a runbook that says "group the spine by reason" stops agreeing with
    // the rule that woke somebody.
    const login = handlerBody('/api/v1/auth/login');
    expect(login).toMatch(
      /const reason = !user \? 'unknown_account' : user\.deleted_at \? 'closed_account' : 'bad_password';/,
    );
    expect(login).toContain("recordSignInOutcome('password', reason)");
    expect(login).toMatch(/payload: \{\s*method: 'password',\s*reason,/);
  });
});
