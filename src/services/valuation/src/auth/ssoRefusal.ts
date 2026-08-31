import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Every refusal in the two identity-provider flows is answered to a browser
 * that navigated here, and until this existed every one of them was answered
 * with an RFC 9457 body.
 *
 * `/auth/saml/login` is a link on the sign-in page; `/auth/saml/acs` is a form
 * POST the IdP's own page submits; `/auth/google/callback` is Google's 302. A
 * person reaching any of them is looking at a browser window, so a refusal
 * lands as `{"type":"urn:n409:problem:forbidden","title":"Forbidden",…}`
 * rendered as text — no sentence they can act on, no way back to the sign-in
 * page, and on the one door where the answer is most often *not* a fault of
 * theirs to fix. The success path of the Google callback had already worked
 * this out: it branches on `text/html` and hands the browser a page.
 *
 * So a browser is sent to the sign-in page with a code naming the reason, and
 * the SPA owns the sentence. A code rather than the problem's `detail`: the
 * value travels through a URL the browser then displays and the page renders,
 * and a fixed vocabulary is the difference between a message and an echo. The
 * SPA's map is the other half of this — `SSO_ERROR_MESSAGES` in
 * `pages/LoginPage.tsx` — and `ssoRefusalCodes.test.ts` holds the two to the
 * same list.
 *
 * API callers — anything not asking for HTML, which is every test using
 * `inject` and every integration — keep the problem body unchanged.
 */
export const SSO_REFUSAL_CODES = [
  /** The flow is not configured, or was switched off between the link and the click. */
  'not_configured',
  /** The request reached us without the fields the flow is defined in terms of. */
  'invalid_request',
  /** Signature, conditions, or profile: the assertion is not one we can trust. */
  'assertion_rejected',
  /** A replay of an assertion already spent. */
  'assertion_reused',
  /** Authenticated, but the provider sent no address we can key an account on. */
  'no_email',
  /** An address the provider itself has not confirmed belongs to the person. */
  'email_unverified',
  /** Authenticated, but the address is outside the domain SSO is restricted to. */
  'domain_not_allowed',
  /** The account exists and has been deactivated here. */
  'account_deactivated',
  /** The provider itself did not answer, or answered with something unusable. */
  'provider_error',
] as const;

export type SsoRefusalCode = (typeof SSO_REFUSAL_CODES)[number];

/** A top-level navigation, as opposed to an API caller holding this contract. */
export function browserNavigation(req: FastifyRequest): boolean {
  return req.headers.accept?.includes('text/html') ?? false;
}

/**
 * Answer a browser with the sign-in page and a reason; anything else with the
 * problem it would have had.
 *
 * The log line is not decoration. A refusal that becomes a 302 is a 302 in the
 * access log, indistinguishable from the successful hand-off two lines below
 * it, so without this the only record that an identity provider's user was
 * turned away is the one this writes.
 */
export function refuseSso(
  req: FastifyRequest,
  reply: FastifyReply,
  code: SsoRefusalCode,
  problem: Error,
): FastifyReply {
  if (!browserNavigation(req)) throw problem;
  req.log.warn({ ssoRefusal: code }, 'single sign-on refused — sending the browser back to sign in');
  return reply.redirect(`/login?sso_error=${code}`, 302);
}
