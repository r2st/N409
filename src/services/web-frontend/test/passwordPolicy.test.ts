import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NOT_COMPLEX_MESSAGE,
  PASSWORD_HINT,
  PASSWORD_MIN_LENGTH,
  passwordPolicyError,
} from '../src/lib/passwordPolicy';

/**
 * The password rule, and the two halves that have to agree about it.
 *
 * Every password box on the platform validated `minLength(10)` and stopped
 * there. The server also requires a letter and a digit — so "abcdefghij"
 * passed every check the browser made, went over the wire, and came back 422
 * with the reason rendered as a banner at the top of the form rather than
 * beside the box it is about. `lib/useFormValidation.ts` exists to remove
 * exactly that shape, and it had been left in place on the one field most
 * likely to trip it.
 *
 * The service owns the rule; this module restates it, the way `lib/phone.ts`
 * restates E.164, because the frontend cannot import a Node build that pulls in
 * fastify and the OTel SDK. Restating means the two can drift, so the last
 * describe below reads the service's source and fails when they have.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_POLICY = path.resolve(here, '../../valuation/src/domain/passwordPolicy.ts');

/** One table, asserted here and mirrored in the service's own unit test. */
const CASES: ReadonlyArray<{ password: string; why: string | null }> = [
  { password: '', why: 'required' },
  { password: 'aA1', why: 'short' },
  { password: 'abc123def', why: 'short' }, // 9
  { password: 'abc123defg', why: null }, // 10, letter + digit
  { password: 'abcdefghij', why: 'complexity' }, // long enough, no digit
  { password: '1234567890', why: 'complexity' }, // long enough, no letter
  { password: 'aaaaaaaaaa', why: 'complexity' },
  { password: '!!!!!!!!!!', why: 'complexity' }, // symbols are neither
  { password: 'a1        ', why: null }, // spaces count toward length…
  { password: '          ', why: 'complexity' }, // …but are neither a letter nor a digit
  { password: 'Correct-Horse-Battery-Staple-7', why: null },
];

describe('the password rule, in the browser', () => {
  it('answers every case the same way the service does', () => {
    for (const { password, why } of CASES) {
      const message = passwordPolicyError(password);
      if (why === null) expect(message, JSON.stringify(password)).toBeNull();
      else expect(message, JSON.stringify(password)).not.toBeNull();
      if (why === 'required') expect(message).toBe('Password is required.');
      if (why === 'short') expect(message).toContain(`at least ${PASSWORD_MIN_LENGTH} characters`);
      if (why === 'complexity') expect(message).toBe(`${NOT_COMPLEX_MESSAGE}.`);
    }
  });

  it('checks length before complexity, so a short password hears the shorter truth', () => {
    // "abc" fails both. Telling somebody three characters in that they need a
    // digit is answering a question they have not reached yet.
    expect(passwordPolicyError('abc')).toContain('at least');
  });

  it('names the field, because two of the five boxes are called something else', () => {
    expect(passwordPolicyError('', 'New password')).toBe('New password is required.');
    expect(passwordPolicyError('short', 'New password')).toContain('New password must be');
  });

  it('states both halves of the rule in the hint, not just the length', () => {
    // The hint said "At least 10 characters." — which is true, and half. The
    // complexity requirement was not written down anywhere the user could read
    // it before being refused by it.
    expect(PASSWORD_HINT).toContain(String(PASSWORD_MIN_LENGTH));
    expect(PASSWORD_HINT).toMatch(/letter/i);
    expect(PASSWORD_HINT).toMatch(/number|digit/i);
  });
});

describe('the two halves have not drifted', () => {
  const service = readFileSync(SERVICE_POLICY, 'utf8');

  it('finds the service module at all', () => {
    // The vacuity guard: a moved or renamed file must fail loudly here rather
    // than turn this whole describe into an assertion about an empty string.
    expect(service).toContain('export function passwordPolicyError');
  });

  it('shares the floor', () => {
    expect(service).toContain(`export const PASSWORD_MIN_LENGTH = ${PASSWORD_MIN_LENGTH};`);
  });

  it('shares the complexity message verbatim', () => {
    // Reused rather than re-worded on purpose: two spellings of one rule is two
    // answers to "why was my password refused", and the user gets whichever
    // half happened to run.
    expect(service).toContain(`'${NOT_COMPLEX_MESSAGE}'`);
  });

  it('shares the character classes that define complexity', () => {
    expect(service).toContain('/[a-zA-Z]/');
    expect(service).toContain('/[0-9]/');
  });

  it('has no rule the browser does not also apply', () => {
    // A crude but load-bearing check: the service's error function returns
    // exactly three things — too short, not complex, and null. A fourth return
    // is a rule this file knows nothing about, and the form would go on
    // accepting what the server refuses.
    const body = service.slice(service.indexOf('export function passwordPolicyError'));
    expect(body.match(/\breturn\b/g)?.length).toBe(3);
  });
});
