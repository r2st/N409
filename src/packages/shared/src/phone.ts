/**
 * E.164 phone numbers — the one format this platform stores and the only one
 * an SMS gateway will dial.
 *
 * `users.phone` and `contact_submissions.phone` were `text` columns validated
 * only by length, so anything fit: `(555) 123-4567` with no country at all,
 * `+44 (0)20 7946 0000` with a national trunk prefix that must not be dialled
 * internationally, or a typo'd `+1 5551234567890123`. None of those are
 * dialable, and the failure is invisible until an SMS campaign runs and the
 * gateway rejects the destination — by which point the message is late and the
 * outbox row says `failed` with a provider error nobody reads.
 *
 * So: parse on the way in, store one shape. `normalizeE164` is forgiving about
 * how a human types a number (spaces, dashes, parens, a `00` international
 * prefix) and unforgiving about what comes out — `+` then 7 to 15 digits, the
 * first of which is not a zero. `e164Error` explains a rejection in words a
 * form can show.
 */

/** ITU-T E.164 caps a number at 15 digits after the `+`. */
export const E164_MAX_DIGITS = 15;

/**
 * The shortest numbers actually in service are 7 digits including the country
 * code — Saint Helena (+290), Niue (+683) and Tokelau (+690) all issue 4-digit
 * subscriber numbers. Anything shorter is a truncated entry, not a number.
 */
export const E164_MIN_DIGITS = 7;

/**
 * Separators a person types and a gateway ignores: spaces (\s already covers
 * the non-breaking space that survives a copy-paste out of a PDF), the ASCII
 * hyphen, and the Unicode dashes a word processor substitutes for it.
 */
const SEPARATORS = /[\s().\-/‐-―]/g;

const E164 = new RegExp(`^\\+[1-9]\\d{${E164_MIN_DIGITS - 1},${E164_MAX_DIGITS - 1}}$`);

/**
 * `(0)` written between the calling code and the national number — "+44 (0)20
 * 7946 0000" is how most of Europe prints a number. The zero is the national
 * trunk prefix: dialled domestically, dropped internationally. Removing it
 * before the separators are stripped is what keeps it from being folded into
 * the digits as "+4402079460000", which no gateway can dial.
 */
const TRUNK_IN_PARENS = /\(\s*0\s*\)/g;

/** Drops a bracketed trunk prefix, strips separators, folds `00` to `+`. */
function canonicalize(value: string): string {
  const stripped = value.replace(TRUNK_IN_PARENS, '').replace(SEPARATORS, '');
  // `00` is the ITU international access prefix across most of the world and
  // means exactly what a leading `+` means. No national number begins with it,
  // so the rewrite is unambiguous.
  return stripped.startsWith('00') ? `+${stripped.slice(2)}` : stripped;
}

/** True when `value` is already in canonical E.164 form. */
export function isE164(value: string): boolean {
  return E164.test(value);
}

/**
 * The canonical E.164 form of a number a human typed, or null when it is not a
 * phone number at all. `normalizeE164('+1 (555) 123-4567') === '+15551234567'`.
 */
export function normalizeE164(value: string): string | null {
  const canonical = canonicalize(value);
  return isE164(canonical) ? canonical : null;
}

/**
 * Why `value` is not a phone number, or null when it is. Kept in step with
 * `normalizeE164` by construction: this returns null exactly when that returns
 * a string (asserted in the tests).
 */
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
  // A national trunk prefix ('0' in the UK, most of Europe) is dropped when
  // dialling internationally, and no calling code starts with one.
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
