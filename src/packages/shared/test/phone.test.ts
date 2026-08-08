import { describe, expect, it } from 'vitest';
import { E164_MAX_DIGITS, E164_MIN_DIGITS, e164Error, isE164, normalizeE164 } from '../src/phone.js';

/**
 * The table is shared with the frontend's mirror of this module
 * (`src/services/web-frontend/test/phone.test.ts`) — if the two ever disagree,
 * a form will accept a number the API then rejects with a 422.
 */
const ACCEPTED: Array<[input: string, canonical: string]> = [
  ['+15551234567', '+15551234567'],
  ['+1 5551234567', '+15551234567'],
  ['+1 (555) 123-4567', '+15551234567'],
  ['  +1 555.123.4567  ', '+15551234567'],
  ['+44 20 7946 0000', '+442079460000'],
  // The bracketed zero is a trunk prefix, dropped when dialling in.
  ['+44 (0)20 7946 0000', '+442079460000'],
  // `00` is the international access prefix and means the same as `+`.
  ['0044 20 7946 0000', '+442079460000'],
  // Unicode dashes, as a word processor or a PDF copy-paste leaves them.
  ['+1 555‐1234567', '+15551234567'],
  // The floor: Saint Helena issues 4-digit subscriber numbers behind +290.
  ['+290 1234', '+2901234'],
  // The ceiling: 15 digits including the country code.
  ['+491234567890123', '+491234567890123'],
];

const REJECTED: Array<[input: string, because: string]> = [
  ['', 'empty'],
  ['   ', 'blank'],
  ['5551234567', 'no country calling code'],
  ['(555) 123-4567', 'no country calling code'],
  ['+0 5551234567', 'calling code starting with 0'],
  ['0 5551234567', 'a bare national number with a trunk prefix'],
  ['+1 555 CALL', 'letters'],
  ['+1234', 'too short'],
  ['+4912345678901234', 'sixteen digits — one over E.164'],
  ['+', 'nothing but a plus'],
];

describe('E.164 normalization', () => {
  it.each(ACCEPTED)('accepts %j as %j', (input, canonical) => {
    expect(normalizeE164(input)).toBe(canonical);
    expect(e164Error(input)).toBeNull();
    expect(isE164(canonical)).toBe(true);
  });

  it.each(REJECTED)('rejects %j (%s)', (input) => {
    expect(normalizeE164(input)).toBeNull();
    expect(e164Error(input)).toBeTruthy();
  });

  it('is idempotent — normalizing a canonical number is a no-op', () => {
    for (const [, canonical] of ACCEPTED) {
      expect(normalizeE164(canonical)).toBe(canonical);
    }
  });

  it('keeps e164Error and normalizeE164 in lockstep', () => {
    for (const [input] of [...ACCEPTED, ...REJECTED]) {
      expect(e164Error(input) === null).toBe(normalizeE164(input) !== null);
    }
  });

  it('names the reason a number is rejected', () => {
    expect(e164Error('5551234567')).toMatch(/country calling code/i);
    expect(e164Error('+0 5551234567')).toMatch(/leading 0/i);
    expect(e164Error('+1234')).toMatch(/too short/i);
    expect(e164Error('+4912345678901234')).toMatch(/too long/i);
    expect(e164Error('+1 555 CALL')).toMatch(/only contain digits/i);
    expect(e164Error('')).toMatch(/enter a phone number/i);
  });

  it('holds the ITU bounds at exactly the documented digit counts', () => {
    const shortest = `+1${'2'.repeat(E164_MIN_DIGITS - 1)}`;
    const longest = `+1${'2'.repeat(E164_MAX_DIGITS - 1)}`;
    expect(isE164(shortest)).toBe(true);
    expect(isE164(longest)).toBe(true);
    expect(isE164(shortest.slice(0, -1))).toBe(false);
    expect(isE164(`${longest}2`)).toBe(false);
  });
});
