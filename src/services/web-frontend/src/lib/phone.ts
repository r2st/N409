/**
 * E.164 validation for the browser.
 *
 * `@n409/shared` owns the canonical implementation (`src/packages/shared/src/
 * phone.ts`) and the API enforces it — this is the same rule restated so a form
 * can say what is wrong before a round trip, not a second opinion. The two are
 * kept in step by `test/phone.test.ts`, which asserts this module's answers on
 * the same table of cases the shared test uses. The frontend can't import the
 * package directly: it is a Node build that pulls in fastify and the OTel SDK.
 */

/** ITU-T E.164 caps a number at 15 digits after the `+`. */
export const E164_MAX_DIGITS = 15;

/** Saint Helena (+290), Niue (+683) and Tokelau (+690) bottom out at 7. */
export const E164_MIN_DIGITS = 7;

const SEPARATORS = /[\s().\-/‐-―]/g;

const E164 = new RegExp(`^\\+[1-9]\\d{${E164_MIN_DIGITS - 1},${E164_MAX_DIGITS - 1}}$`);

/** "+44 (0)20 7946 0000" — the bracketed zero is a national trunk prefix. */
const TRUNK_IN_PARENS = /\(\s*0\s*\)/g;

function canonicalize(value: string): string {
  const stripped = value.replace(TRUNK_IN_PARENS, '').replace(SEPARATORS, '');
  return stripped.startsWith('00') ? `+${stripped.slice(2)}` : stripped;
}

/** True when `value` is already in canonical E.164 form. */
export function isE164(value: string): boolean {
  return E164.test(value);
}

/** The canonical E.164 form of a typed number, or null when it is not one. */
export function normalizeE164(value: string): string | null {
  const canonical = canonicalize(value);
  return isE164(canonical) ? canonical : null;
}

/** Why `value` is not a phone number, or null when it is. */
export function e164Error(value: string): string | null {
  const canonical = canonicalize(value);
  if (!canonical) return 'Enter a phone number';
  if (!canonical.startsWith('+')) {
    return 'Include the country calling code, e.g. +1 (555) 123-4567';
  }
  const digits = canonical.slice(1);
  if (!digits) return 'Enter a phone number';
  if (!/^\d+$/.test(digits)) {
    return 'A phone number can only contain digits, spaces and ( ) - .';
  }
  if (digits.startsWith('0')) {
    return 'Drop the leading 0 — it is a national prefix, not part of the country code';
  }
  if (digits.length < E164_MIN_DIGITS) {
    return `Too short — a full number has at least ${E164_MIN_DIGITS} digits including the country code`;
  }
  if (digits.length > E164_MAX_DIGITS) {
    return `Too long — a phone number has at most ${E164_MAX_DIGITS} digits including the country code`;
  }
  return null;
}
