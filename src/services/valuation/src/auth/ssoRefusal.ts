import type { FastifyReply, FastifyRequest } from 'fastify';
import { requestErrorContext } from '@n409/shared';
import { recordSsoOutcome, ssoFlowOf } from '../observability/ssoOutcomes.js';

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
  /**
   * Authenticated, but there is no account here and the platform is not
   * creating any. `registration_enabled` is off, so a seat comes by invitation.
   */
  'registration_closed',
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
 *
 * WRITTEN BEFORE THE BRANCH, NOT INSIDE IT (round 273, methodology M11). Until
 * now the line was the redirect's: `if (!browserNavigation(req)) throw problem`
 * came first, so a refusal answered with the problem body left this function
 * without writing anything, and `registerProblemHandler` logs 4xx nowhere —
 * deliberately, because a 4xx "describes the request, the caller was told, and
 * logging them is logging other people's mistakes". These are the exception that
 * argument does not cover: nobody chose them, half of them are a setting inside
 * a firm's own identity provider, and the reason is *ours* rather than the
 * caller's. Twelve of the seventeen call sites have no other record at all — no
 * spine event, no `err` line of their own — so for a caller that did not ask
 * for HTML the refusal existed only as a status code.
 *
 * Which caller is not hypothetical: the ACS is a POST an identity provider's
 * page makes, and an IdP that submits it with `fetch` rather than a form auto-
 * submit sends no `text/html`. The record of why an assertion was turned away
 * should not depend on how the answer happened to be rendered.
 *
 * `requestErrorContext` for the same reason the 5xx arm of the problem handler
 * uses it: the codes are shared between the two flows — `not_configured` is
 * raised by four routes across `auth.ts` and `saml.ts` — so the code alone does
 * not say which door. That context names the route, and it is the estate's one
 * spelling of "which request was this", so a refusal reads like every other
 * failure line beside it.
 */
export function refuseSso(
  req: FastifyRequest,
  reply: FastifyReply,
  code: SsoRefusalCode,
  problem: Error,
): FastifyReply {
  const browser = browserNavigation(req);
  // Counted here rather than at the seventeen call sites, the same way the log
  // line is: a refusal that cannot reach the scrape can only reach the journal,
  // and nothing on this box consumes a log field. See
  // observability/ssoOutcomes.ts for what a 302 costs an alert rule.
  recordSsoOutcome(ssoFlowOf(req), code);
  req.log.warn(
    { ssoRefusal: code, ...requestErrorContext(req), answered: browser ? 'redirect' : 'problem' },
    browser ? 'single sign-on refused — sending the browser back to sign in' : 'single sign-on refused',
  );
  if (!browser) throw problem;
  return reply.redirect(`/login?sso_error=${code}`, 302);
}
