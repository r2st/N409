/**
 * What the platform accepts as a password, as one function.
 *
 * The rule was written inline in `routes/auth.ts` and nowhere else, which made
 * it unreachable from the only other place that needs it: the forms. Every
 * password box in the app validates `minLength(10)` and stops there, so the
 * *complexity* half — a letter and a digit — was invisible until the round trip
 * came back 422. "abcdefghij" passed every check the browser made and was
 * rejected by the server, with the reason rendered as a banner at the top of
 * the form rather than beside the box it is about. That is precisely the shape
 * `lib/useFormValidation.ts` exists to remove, left in place on the one field
 * most likely to trip it.
 *
 * The frontend cannot import this module — it is a Node build that pulls in
 * fastify and the OTel SDK — so `web-frontend/src/lib/passwordPolicy.ts`
 * restates it, exactly as `lib/phone.ts` restates E.164. The two are kept in
 * step by `web-frontend/test/passwordPolicy.test.ts`, which reads this file and
 * fails when a message or a rule here has no counterpart there.
 */

/**
 * The floor no administrator can go below — `password_min_length` in system
 * settings is `min(10)` for this reason, and this is the value used when there
 * is no settings store at all.
 */
export const PASSWORD_MIN_LENGTH = 10;

/**
 * Basic complexity: at least one letter and one digit, so "1234567890" and
 * "aaaaaaaaaa" are rejected. Full entropy scoring is overkill for a B2B SaaS,
 * but this catches the low-hanging fruit.
 */
const HAS_LETTER = /[a-zA-Z]/;
const HAS_DIGIT = /[0-9]/;

/** The message for a password that is too short at the effective minimum. */
export function tooShortMessage(min: number): string {
  return `Password must be at least ${min} characters`;
}

/** The message for a password that is long enough but has no letter or no digit. */
export const NOT_COMPLEX_MESSAGE = 'Password must contain at least one letter and one number';

/**
 * Why `password` is not acceptable, or null when it is.
 *
 * `min` is the effective floor — `password_min_length` from system settings,
 * which an administrator may raise but not lower past `PASSWORD_MIN_LENGTH`.
 * Length is checked before complexity so a short password is told the shorter
 * truth first.
 */
export function passwordPolicyError(password: string, min: number = PASSWORD_MIN_LENGTH): string | null {
  if (password.length < min) return tooShortMessage(min);
  if (!HAS_LETTER.test(password) || !HAS_DIGIT.test(password)) return NOT_COMPLEX_MESSAGE;
  return null;
}
