import { describe, expect, it } from 'vitest';
import {
  NOT_COMPLEX_MESSAGE,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordPolicyError,
  tooLongMessage,
  tooShortMessage,
} from '../../src/domain/passwordPolicy.js';

/**
 * The password rule, where it is enforced.
 *
 * The table below is the one `web-frontend/test/passwordPolicy.test.ts`
 * asserts against its own restatement of this module — the same arrangement
 * `phone.ts` and `web-frontend/src/lib/phone.ts` are under. Two implementations
 * of one rule is one of them being wrong eventually; the pair of tables is what
 * says so at the moment it happens rather than the moment a user is refused.
 */

const CASES: ReadonlyArray<{ password: string; why: 'short' | 'long' | 'complexity' | null }> = [
  { password: '', why: 'short' },
  { password: 'aA1', why: 'short' },
  { password: 'abc123def', why: 'short' },
  { password: 'abc123defg', why: null },
  { password: 'abcdefghij', why: 'complexity' },
  { password: '1234567890', why: 'complexity' },
  { password: 'aaaaaaaaaa', why: 'complexity' },
  { password: '!!!!!!!!!!', why: 'complexity' },
  { password: 'a1        ', why: null },
  { password: '          ', why: 'complexity' },
  { password: 'Correct-Horse-Battery-Staple-7', why: null },
  // The ceiling (R426). Refused for its length rather than passed to scrypt,
  // and refused by the schema beside this so the caller is told which field —
  // the transport's 413 names none.
  { password: `a1${'x'.repeat(PASSWORD_MAX_LENGTH - 2)}`, why: null },
  { password: `a1${'x'.repeat(PASSWORD_MAX_LENGTH - 1)}`, why: 'long' },
];

describe('passwordPolicyError', () => {
  it('answers the shared table', () => {
    for (const { password, why } of CASES) {
      const message = passwordPolicyError(password);
      if (why === null) expect(message, JSON.stringify(password)).toBeNull();
      if (why === 'short')
        expect(message, JSON.stringify(password)).toBe(tooShortMessage(PASSWORD_MIN_LENGTH));
      if (why === 'long')
        expect(message, `${password.length} characters`).toBe(tooLongMessage(PASSWORD_MAX_LENGTH));
      if (why === 'complexity') expect(message, JSON.stringify(password)).toBe(NOT_COMPLEX_MESSAGE);
    }
  });

  it('checks length before complexity', () => {
    // 'abc' fails both rules; the shorter truth is the useful one.
    expect(passwordPolicyError('abc')).toBe(tooShortMessage(PASSWORD_MIN_LENGTH));
  });

  it('names the effective minimum an administrator raised it to', () => {
    // The message has to carry the real figure: "must be at least 10" against a
    // deployment configured to 16 is a form telling the user to do the thing
    // that just failed.
    expect(passwordPolicyError('abc123defg', 16)).toBe('Password must be at least 16 characters');
    expect(passwordPolicyError('abc123defghijklm', 16)).toBeNull();
  });

  it('defaults to the floor when no setting is supplied', () => {
    expect(passwordPolicyError('abc123defg')).toBeNull();
    expect(passwordPolicyError('abc123def')).toBe(tooShortMessage(10));
    expect(PASSWORD_MIN_LENGTH).toBe(10);
  });

  it('counts characters, not bytes', () => {
    // 10 astral-plane characters is 20 UTF-16 code units; the digit and letter
    // requirement is what refuses this, not the length.
    expect(passwordPolicyError('a1🔐🔐🔐🔐')).toBeNull();
  });
});
