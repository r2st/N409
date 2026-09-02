import type { UserWithRoles } from '../repos/users.js';

/**
 * The account as every client sees it — one projection, in one place.
 *
 * It was two. `routes/auth.ts` built this for register, login, the SSO
 * callbacks and accept-invite; `routes/account.ts` built it again, by hand, for
 * `GET /api/v1/me` and `PATCH /api/v1/me`. Two copies of a field list is one
 * field list that drifts, and it had: the auth copy gained `totp_enabled` when
 * MFA shipped and the account copy did not, so the SPA learned whether a second
 * factor was live *at sign-in* and forgot it on every reload — `/me` is the
 * bootstrap read, so a refreshed tab carried an account object the sign-in
 * response would not have recognised.
 *
 * Nothing caught it because both shapes are inferred, so neither compiler nor
 * schema had an opinion about the difference; the only reader of `totp_enabled`
 * so far writes it back optimistically after enrolment, which is exactly the
 * kind of near-miss that makes a drift like this surface as a bug months later.
 *
 * `has_password` is stated rather than inferred for the same reason the client
 * cannot compute it: `sso_provider` is only ever `'google'` or null, and
 * migration 0082 added a third kind of account — SAML- or SCIM-provisioned —
 * with neither an `sso_provider` nor a password digest. Five controls on the
 * settings page ask "is there a password to confirm?" and were answering it
 * with `sso_provider !== 'google'`, which calls that third kind a password
 * account and offers it forms it can never submit.
 *
 * The digest itself never leaves this function.
 */
export function toPublicUser(u: UserWithRoles) {
  return {
    id: u.id,
    email: u.email,
    first_name: u.first_name,
    last_name: u.last_name,
    phone: u.phone,
    job_title: u.job_title,
    company_name: u.company_name,
    timezone: u.timezone,
    verified: u.verified,
    sso_provider: u.sso_provider,
    /** Whether this account signs in with a password at all — see above. */
    has_password: u.password_digest !== null,
    partner_id: u.partner_id,
    roles: u.roles,
    totp_enabled: u.totp_enabled,
  };
}
