import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './passwordPolicy.js';

/**
 * The credential-shaped string fields, with their ceilings, in one place.
 *
 * Every other free-text field on this service carries a `.max()` — 246
 * `z.string()`s in `src/routes` and all but the ones below are bounded by their
 * own schema. The exceptions were the credentials: passwords, the tokens the
 * platform mints for a link in an email, and the two parameters an identity
 * provider hands back on a redirect. Each was `z.string().min(1)`, so the only
 * ceiling on any of them was the transport's.
 *
 * `routes/bodyLimits.ts` already states what is wrong with that, about three
 * other routes: the 413 is raised by the content-type parser, "so it names no
 * field and quotes no limit". On a credential that is the worst case of it —
 * the caller cannot see what they pasted, and the one field they would look at
 * is the one the refusal does not name. The bound belongs to the schema, which
 * answers 422 naming the field, exactly as every length bound beside it does.
 *
 * The figures are deliberately far above anything legitimate. They exist so the
 * refusal is the schema's, and so the work an unauthenticated request buys —
 * `verifyPassword` feeds the whole string to scrypt, `verifyMfaChallenge` to a
 * JWS verify — is bounded by a number written down rather than by a body limit
 * that knows nothing about either.
 *
 * A helper per shape rather than a constant to inline, for the reason
 * `ulidField()` is one: `credentialFieldCensus.test.ts` asks the whole route
 * table which spelling each credential uses, and a census can only ask about a
 * name.
 */

/**
 * A password being *set* — register, reset, change, accept-invite, and the
 * admin console's create-user.
 *
 * The floor here is the policy's, not the deployment's: `password_min_length`
 * may raise it and only the handler can read that setting, so the schema states
 * the floor and `assertPasswordStrong` states the effective minimum. The
 * ceiling has no such split — no setting moves it — so it is stated once, here,
 * and `passwordPolicyError` restates it for the entry points that reach the
 * policy without going through a schema at all.
 */
export const newPasswordField = () =>
  z
    .string()
    .min(PASSWORD_MIN_LENGTH, `password must be at least ${PASSWORD_MIN_LENGTH} characters`)
    .max(PASSWORD_MAX_LENGTH, `password must be at most ${PASSWORD_MAX_LENGTH} characters`);

/**
 * A password being *presented* — sign-in, and the `current_password` re-auth
 * that guards a privileged change.
 *
 * `min(1)` rather than the policy floor, deliberately: a password set before a
 * deployment raised its minimum is still that account's password, and refusing
 * it at the schema would lock the account out of the very route that changes
 * it. The ceiling is the same one, because the work is the same scrypt.
 */
export const presentedPasswordField = () => z.string().min(1).max(PASSWORD_MAX_LENGTH);

/**
 * The longest token this platform mints. The secrets are 32 random bytes as
 * base64url (43 characters), carried alone or as `id.secret`; 512 is room for
 * several times that and for whatever a future token puts beside them.
 */
export const MAX_TOKEN_CHARS = 512;

/**
 * A single-purpose token the platform minted and emailed: verify-email, reset,
 * invitation, and the auditor / board / client-intake portal links.
 */
export const tokenField = () => z.string().min(1).max(MAX_TOKEN_CHARS);

/**
 * The ceiling for a credential *we* did not mint: an OIDC `code` and `state`
 * off a provider redirect, and the signed MFA challenge from `POST /auth/login`
 * coming back on `POST /auth/mfa/verify`. All three are compact in practice —
 * the challenge is a two-claim JWS — and the figure is generous because their
 * length is the provider's to change, not ours.
 */
export const MAX_ISSUED_CREDENTIAL_CHARS = 4096;

/** A signed credential minted elsewhere and handed back to us. */
export const issuedCredentialField = () => z.string().min(1).max(MAX_ISSUED_CREDENTIAL_CHARS);
