import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SSO_REFUSAL_CODES } from '../../src/auth/ssoRefusal.js';

/**
 * R270 — the two halves of an SSO refusal, held to each other.
 *
 * `refuseSso` sends a browser to `/login?sso_error=<code>` and the sentence
 * lives in the SPA, which has no `@n409/shared` dependency: the vocabulary is
 * therefore two copies of one fact, and the failure mode of a drifted copy is
 * silent. A code the SPA does not know renders the general sentence, which is
 * *correct* rather than broken, so nothing ever goes red — the reader simply
 * stops being told the one thing that would have helped, on the screen where
 * they can least work it out for themselves.
 *
 * The route sources are read too. A refusal that reaches for a code no module
 * declares is the same drift from the other end, and it would compile if the
 * argument were ever widened to `string`.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOGIN_PAGE = path.resolve(HERE, '../../../web-frontend/src/pages/LoginPage.tsx');
const ROUTES = ['../../src/routes/saml.ts', '../../src/routes/auth.ts'].map((rel) => path.resolve(HERE, rel));

/** The keys of the browser's `SSO_ERROR_MESSAGES` literal, read as text. */
function browserCodes(): string[] {
  const source = readFileSync(LOGIN_PAGE, 'utf8');
  const start = source.indexOf('const SSO_ERROR_MESSAGES');
  expect(start, 'SSO_ERROR_MESSAGES in web-frontend/src/pages/LoginPage.tsx').toBeGreaterThan(-1);
  const open = source.indexOf('{', start);
  const close = source.indexOf('};', open);
  return [...source.slice(open + 1, close).matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]!);
}

/** Every code any route hands `refuseSso`. */
function routeCodes(): string[] {
  const out = new Set<string>();
  for (const file of ROUTES) {
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/refuseSso\(\s*req,\s*reply,\s*'([a-z_]+)'/g)) out.add(m[1]!);
  }
  return [...out].sort();
}

describe('SSO refusal vocabulary', () => {
  it('gives every declared code a sentence in the browser', () => {
    expect(browserCodes().sort()).toEqual([...SSO_REFUSAL_CODES].sort());
  });

  it('is still reading both files rather than passing on an empty census', () => {
    expect(SSO_REFUSAL_CODES.length).toBeGreaterThan(5);
    expect(browserCodes().length).toBe(SSO_REFUSAL_CODES.length);
    expect(routeCodes().length).toBeGreaterThan(4);
  });

  it('uses only declared codes at the refusal sites', () => {
    const declared = new Set<string>(SSO_REFUSAL_CODES);
    expect(routeCodes().filter((code) => !declared.has(code))).toEqual([]);
  });

  it('never renders the code itself — an unknown one gets the general sentence', () => {
    const source = readFileSync(LOGIN_PAGE, 'utf8');
    expect(source).toContain('SSO_ERROR_FALLBACK');
    /*
     * The guard, not the coalesce (round 272, methodology M3).
     *
     * R270 pinned the spelling it had written, `SSO_ERROR_MESSAGES[code] ??
     * SSO_ERROR_FALLBACK`, and R271 replaced it — because that spelling is the
     * bug: `??` only reaches the fallback for `undefined`, and every object
     * answers to `__proto__`, `constructor` and `toString`, so
     * `/login?sso_error=__proto__` handed React an object and took the sign-in
     * page down. The census was left asserting the vulnerable form and has been
     * red on main since; asserting `Object.hasOwn` states the rule the page
     * actually has to follow, and refusing the bare coalesce keeps R271's fix
     * from being spelled back out.
     */
    expect(source).toMatch(/Object\.hasOwn\(SSO_ERROR_MESSAGES,\s*\w+\)/);
    expect(source).not.toMatch(/SSO_ERROR_MESSAGES\[\w+\]\s*\?\?/);
    expect(source).not.toMatch(/\{\s*ssoErrorCode\s*\}/);
  });

  it('says what to do next in every sentence', () => {
    const source = readFileSync(LOGIN_PAGE, 'utf8');
    const open = source.indexOf('{', source.indexOf('const SSO_ERROR_MESSAGES'));
    const body = source.slice(open, source.indexOf('};', open));
    for (const code of SSO_REFUSAL_CODES) {
      const sentence = body
        .slice(body.indexOf(`${code}:`))
        .split('\n')
        .slice(0, 3)
        .join(' ');
      expect(sentence, `${code} names no next step`).toMatch(
        /Sign in|Start again|Try again|administrator|support|Verify/,
      );
    }
  });
});
