import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanRoutes } from '../support/routeSource.js';

/**
 * Every route that issues a credential asks for a password, and refuses a key.
 *
 * This platform has five doors that hand out a way in, and until round 359 the
 * two guards in front of them were applied to exactly one:
 *
 *   * `POST /api/v1/me/tokens` — a personal API key. **Both guards**, since
 *     R262.
 *   * `POST /api/v1/partners/:partnerId/tokens` — a firm key: handed to an
 *     integration, reads the whole firm's book, and unaffected by anything that
 *     ends a browser session. Had the API-token refusal and *no password*.
 *   * `POST /api/v1/admin/sso/scim-tokens` — a standing bearer grant to create
 *     and deactivate users, outside every route sweep in this estate because it
 *     carries no session and no principal. Had **neither**.
 *   * `PUT /api/v1/admin/sso/saml` — not spelled like a mint, but it decides
 *     which identity provider every future sign-in is delegated to, which is
 *     the issuing of a credential over every account in the tenant at once.
 *     Had **neither**.
 *
 * The two guards are:
 *
 *   * *Re-authentication* — `verifyReauthPassword` against the caller's own
 *     digest, skipped only when there is no digest to check. `auth/reauth.ts`
 *     states the reason: on an already signed-in session the password is the
 *     only thing still in the way of a session that is not the owner's, and a
 *     credential minted from a borrowed cookie **outlives the password change
 *     made on noticing** — `bumpSessionEpoch` deliberately does not touch API
 *     or SCIM tokens.
 *   * *No key mints its successor* — a refusal when `req.apiToken` is set,
 *     because revoking a leaked credential has to be the end of it, and it is
 *     not if that credential's last act can be to issue a replacement with its
 *     own separate revocation.
 *
 * The second half of this file is what keeps the list above from going stale:
 * the route that *calls a credential-issuing repo function* has to appear in
 * it. A hand-written list of routes is the shape that quietly stops covering
 * the surface it names (see `partnerApiScoping`'s four lines over ten
 * operations, R157); driving the membership off the writes themselves means a
 * sixth door is a failure here rather than a silence.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = path.resolve(HERE, '../../src/routes');

/** The routes that hand out a way in, and what each one hands out. */
const CREDENTIAL_ROUTES: Record<string, string> = {
  'POST /api/v1/me/tokens': 'a personal API key, acting as its owner',
  'POST /api/v1/partners/:partnerId/tokens': "a firm key, reading that firm's whole book",
  'POST /api/v1/admin/sso/scim-tokens': 'a SCIM bearer that creates and deactivates users',
  'PUT /api/v1/admin/sso/saml': 'the identity provider every future sign-in is delegated to',
  'POST /api/v1/users': 'an account on any role, with a password the caller chooses',
  'POST /api/v1/users/invite': 'a seven-day link that creates an account on any role',
};

/**
 * The repo calls that write a credential.
 *
 * `createApiToken` and `createScimToken` return a secret; `upsertSamlConfig`
 * writes the row that decides who may assert an identity here. A route that
 * makes one of these calls is issuing a way in, whatever its URL looks like.
 *
 * `createUser` and `createInvitation` joined in R362, and their absence is what
 * this list being hand-written costs. The three above are the calls that *look*
 * like a mint — they return a secret or name an identity provider — and the
 * two that create the account itself were audited by nobody, though they are
 * the strongest grant of the six: an account with its own password, on any
 * role including `god`, that neither `bumpSessionEpoch` nor a password change
 * nor an API-key revocation nor the caller's own deactivation touches. The
 * invitation is the same grant posted rather than created, redeemable for seven
 * days by whoever holds the link at an address the caller chose.
 */
const CREDENTIAL_WRITES = [
  'createApiToken',
  'createScimToken',
  'upsertSamlConfig',
  'createUser',
  'createInvitation',
];

const routes = scanRoutes(ROUTES);
const key = (r: { method: string; url: string }) => `${r.method} ${r.url}`;

/**
 * Only the doors an already-authenticated caller opens.
 *
 * `createUser` has three other callers and every one of them is correct
 * without a prompt, because none of them is a signed-in session issuing a
 * credential to somebody else: `POST /auth/register` is a stranger creating
 * their own account, `POST /auth/accept-invite` redeems the link this file is
 * about, and the SSO paths provision on an assertion an identity provider
 * signed. What they have in common is the thing to test on — no
 * `app.authenticate` — rather than a second hand-written list of exemptions,
 * which would go stale in exactly the way `CREDENTIAL_WRITES` just did.
 */
const authenticated = (r: { body: string }) => r.body.includes('app.authenticate');

describe('credential-issuing routes', () => {
  it('names every authenticated route that writes a credential — no more, no less', () => {
    const writing = routes
      .filter(authenticated)
      .filter((r) => CREDENTIAL_WRITES.some((fn) => r.body.includes(`${fn}(`)));
    expect(writing.length).toBeGreaterThan(0);
    expect([...new Set(writing.map(key))].sort()).toEqual(Object.keys(CREDENTIAL_ROUTES).sort());
  });

  /**
   * The unauthenticated writers are a real set, and it is a short one. Pinned
   * so that a *new* public route calling `createUser` — a second JIT
   * provisioning path, an "accept invitation" variant — is a failure here
   * rather than a silent exemption from the sweep above.
   */
  it('pins the public routes that create an account without a session', () => {
    const writing = routes
      .filter((r) => !authenticated(r))
      .filter((r) => CREDENTIAL_WRITES.some((fn) => r.body.includes(`${fn}(`)));
    expect([...new Set(writing.map(key))].sort()).toEqual(['POST /api/v1/auth/register']);
  });

  it.each(Object.entries(CREDENTIAL_ROUTES))('%s re-authenticates the caller', (k, issues) => {
    const route = routes.find((r) => key(r) === k);
    expect(route, `${k} is no longer registered — it issues ${issues}`).toBeDefined();
    // The prompt itself, and the field it is read from. Both, because a route
    // that reads `current_password` and never checks it would pass on either
    // half alone.
    expect(route!.body, `${k} must check the caller's password`).toContain('verifyReauthPassword');
    expect(route!.body).toContain('current_password');
    // Skipped only for an account with no digest — an SSO-only account has no
    // password to demand, and asking would be a box nobody can fill.
    expect(route!.body).toContain('password_digest');
  });

  it.each(Object.entries(CREDENTIAL_ROUTES))('%s refuses an API token minting one', (k, issues) => {
    const route = routes.find((r) => key(r) === k);
    expect(route, `${k} is no longer registered — it issues ${issues}`).toBeDefined();
    expect(route!.body, `${k} must refuse a caller holding an API token`).toMatch(
      /if\s*\(req\.apiToken\)[\s\S]{0,200}forbidden/,
    );
  });

  /**
   * The refusal has to say what to do instead.
   *
   * An integration author who reads "Forbidden" retries; one who is told the
   * console mints it goes to the console. `errorMessageQuality` states the rule
   * over the estate — this pins it for the four sentences a key holder meets.
   */
  it.each(Object.keys(CREDENTIAL_ROUTES))('%s tells the key holder where to do it instead', (k) => {
    const route = routes.find((r) => key(r) === k)!;
    const refusal = /forbidden\(\s*['"`]([^'"`]+)/.exec(route.body.slice(route.body.indexOf('req.apiToken')));
    expect(refusal?.[1], `${k}'s API-token refusal should name the screen to use`).toMatch(
      /console|settings page/,
    );
  });
});
