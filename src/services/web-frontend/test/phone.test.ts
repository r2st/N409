import { describe, expect, it } from 'vitest';
import { E164_MAX_DIGITS, E164_MIN_DIGITS, e164Error, isE164, normalizeE164 } from '../src/lib/phone';

/**
 * `src/lib/phone.ts` restates the rule that `@n409/shared` enforces at the API
 * (the frontend can't import that package — it pulls in fastify and the OTel
 * SDK). This table is a copy of the one in `src/packages/shared/test/
 * phone.test.ts`: if the two implementations drift, a form starts accepting
 * numbers the API answers with a 422, or refusing ones it would have taken.
 */
const ACCEPTED: Array<[input: string, canonical: string]> = [
  ['+15551234567', '+15551234567'],
  ['+1 5551234567', '+15551234567'],
  ['+1 (555) 123-4567', '+15551234567'],
  ['  +1 555.123.4567  ', '+15551234567'],
  ['+44 20 7946 0000', '+442079460000'],
  ['+44 (0)20 7946 0000', '+442079460000'],
  ['0044 20 7946 0000', '+442079460000'],
  ['+1 555‐1234567', '+15551234567'],
  ['+290 1234', '+2901234'],
  ['+491234567890123', '+491234567890123'],
];

const REJECTED = [
  '',
  '   ',
  '5551234567',
  '(555) 123-4567',
  '+0 5551234567',
  '0 5551234567',
  '+1 555 CALL',
  '+1234',
  '+4912345678901234',
  '+',
];

describe('E.164 validation in the browser', () => {
  it.each(ACCEPTED)('accepts %j as %j', (input, canonical) => {
    expect(normalizeE164(input)).toBe(canonical);
    expect(e164Error(input)).toBeNull();
    expect(isE164(canonical)).toBe(true);
  });

  it.each(REJECTED)('rejects %j', (input) => {
    expect(normalizeE164(input)).toBeNull();
    expect(e164Error(input)).toBeTruthy();
  });

  it('agrees with itself about which values are errors', () => {
    for (const input of [...ACCEPTED.map(([i]) => i), ...REJECTED]) {
      expect(e164Error(input) === null).toBe(normalizeE164(input) !== null);
    }
  });

  it('holds the same ITU bounds as the API', () => {
    expect(E164_MIN_DIGITS).toBe(7);
    expect(E164_MAX_DIGITS).toBe(15);
    expect(isE164(`+1${'2'.repeat(E164_MIN_DIGITS - 1)}`)).toBe(true);
    expect(isE164(`+1${'2'.repeat(E164_MAX_DIGITS - 1)}`)).toBe(true);
    expect(isE164(`+1${'2'.repeat(E164_MAX_DIGITS)}`)).toBe(false);
  });
});
