/**
 * What the platform accepts as a password, for the browser.
 *
 * `src/services/valuation/src/domain/passwordPolicy.ts` owns the canonical
 * implementation and the API enforces it — this is the same rule restated so a
 * form can say what is wrong before a round trip, not a second opinion. The
 * frontend can't import the service directly: it is a Node build that pulls in
 * fastify and the OTel SDK. Same arrangement, and same reason, as
 * `lib/phone.ts` and E.164.
 *
 * The two are kept in step by `test/passwordPolicy.test.ts`, which reads the
 * service's module and fails when a message or a rule there has no counterpart
 * here.
 *
 * What this half cannot know is the *effective* minimum. `password_min_length`
 * is a system setting an administrator may raise, and it is deliberately not in
 * `publicSubset` — the browser is not told how long a password has to be, which
 * is one fewer thing an unauthenticated visitor learns about the deployment. So
 * this checks the floor, the server checks the real figure, and a password
 * between the two is still rejected server-side with the exact length named.
 * That is a round trip the form cannot save, and it is the rare case; the
 * complexity rule below is the common one, and it was equally invisible.
 */

/** The floor no administrator can go below — see the service module. */
export const PASSWORD_MIN_LENGTH = 10;

/**
 * The ceiling, which every password box here also has to apply.
 *
 * Unlike the floor there is nothing deployment-specific about it — no system
 * setting raises or lowers it — so this half knows the real figure and can
 * refuse without a round trip. See the service module for why it exists.
 */
export const PASSWORD_MAX_LENGTH = 1024;

const HAS_LETTER = /[a-zA-Z]/;
const HAS_DIGIT = /[0-9]/;

/** The message for a password that is long enough but has no letter or no digit. */
export const NOT_COMPLEX_MESSAGE = 'Password must contain at least one letter and one number';

/** What every password box says under it, so the rules are readable before typing. */
export const PASSWORD_HINT = 'At least 10 characters, including a letter and a number.';

/**
 * Why `password` is not acceptable, or null when it is.
 *
 * `label` names the field, because two of the five boxes are "New password"
 * and a message that says "Password" beside one of them is answering about
 * something else. Only the length message takes it: the complexity message is
 * the server's own string, reused verbatim so the two halves cannot drift into
 * telling the user different things about the same rule.
 */
export function passwordPolicyError(password: string, label = 'Password'): string | null {
  if (!password) return `${label} is required.`;
  if (password.length < PASSWORD_MIN_LENGTH)
    return `${label} must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH)
    return `${label} must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  if (!HAS_LETTER.test(password) || !HAS_DIGIT.test(password)) return `${NOT_COMPLEX_MESSAGE}.`;
  return null;
}
