import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { SAML, generateServiceProviderMetadata } from '@node-saml/node-saml';
import { problems } from '@n409/shared';
import { signSession, type JwtConfig } from '../auth/jwt.js';
import { setSessionCookie, type SessionCookieConfig } from '../auth/cookies.js';
import { getSamlConfig, type SamlConfigRow } from '../repos/ssoConfig.js';
import { consumeSamlAssertion, type SamlAssertionRef } from '../repos/samlReplay.js';
import { createProvisionedUser, findUserByEmail, type UserWithRoles } from '../repos/users.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { EmailAddress, MAX_EMAIL_LENGTH } from '../domain/email.js';
import type { RoleKey } from '../domain/roles.js';
import { ROLE_KEYS } from '../domain/roles.js';
import { refuseSso } from '../auth/ssoRefusal.js';
import { recordSsoOutcome } from '../observability/ssoOutcomes.js';

/**
 * SAML 2.0 Service Provider (feature 9). The IdP is configured in admin
 * settings (saml_config, singleton). Flow: GET /auth/saml/login redirects to
 * the IdP with an AuthnRequest; the IdP POSTs a signed assertion to
 * /auth/saml/acs, which node-saml validates (XML-dsig), then a matching user is
 * found or JIT-provisioned and a session is issued. Metadata is served for IdP
 * setup.
 */

export interface SamlDeps {
  pool: pg.Pool;
  jwt: JwtConfig;
  publicBaseUrl: string;
  cookie?: SessionCookieConfig;
}

function acsUrl(base: string): string {
  return `${base.replace(/\/$/, '')}/api/v1/auth/saml/acs`;
}

function spEntityId(config: SamlConfigRow, base: string): string {
  return config.sp_entity_id || `${base.replace(/\/$/, '')}/api/v1/auth/saml/metadata`;
}

function buildSaml(config: SamlConfigRow, base: string): SAML {
  return new SAML({
    entryPoint: config.idp_sso_url ?? undefined,
    issuer: spEntityId(config, base),
    callbackUrl: acsUrl(base),
    idpCert: config.idp_cert ?? '',
    audience: spEntityId(config, base),
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    disableRequestedAuthnContext: true,
  });
}

/** Bound on a display-name claim; matches `first_name`/`last_name` everywhere else. */
const MAX_SSO_NAME = 100;

/** Pull an email + names out of a validated SAML profile (attribute names vary). */
export function extractIdentity(profile: Record<string, unknown>): {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
} {
  /**
   * The first of `keys` this profile carries, if it is short enough to store.
   *
   * The assertion is signed, which makes the IdP trusted — not its attribute
   * *mapping*. A directory that maps a photo, a DN or a group blob onto
   * `givenName` sends kilobytes here, and every one of them went into the INSERT
   * unmeasured; `users` is `text`, but migration 0149's trigram index builds
   * over `first_name || ' ' || last_name` and indexes whatever that comes to.
   *
   * Over the bound the claim is dropped rather than truncated, and what that
   * costs depends on which claim it is. A display name is cosmetic — the account
   * is identified by its address — so dropping one still signs the user in,
   * where refusing would lock a whole org out of SSO over one bad mapping. The
   * address is not: dropping it makes `email` null, and the caller answers 401.
   * Truncating either would be worse than both, since half an identity presented
   * as whole is the silent corruption this codebase avoids elsewhere.
   *
   * ## A claim may arrive as a list
   *
   * node-saml collapses an attribute with one `AttributeValue` to a string and
   * leaves one with several as an array — and several is the normal case for a
   * directory-backed IdP, because `mail`, `givenName` and `sn` are all
   * multi-valued in the LDAP schema Active Directory and every OpenLDAP
   * deployment build their assertions from. An employee with a second address
   * on their record, or a maiden name still on `sn`, sends
   *
   *     { "mail": ["ada@acme.com", "ada.lovelace@acme.com"] }
   *
   * `typeof v === 'string'` is false for that, so the loop walked past a claim
   * that was there, fell through every remaining key, and — for the address —
   * reached `nameID`, which is a persistent opaque identifier in most Entra and
   * Okta configurations rather than an address. The caller then answered 401
   * "SAML assertion has no email" for an assertion that carried one.
   *
   * That is not a login this platform can retry into. It is every user in that
   * directory, permanently, with a message blaming the IdP for omitting the one
   * thing it sent — which is the worst possible sentence to hand the admin who
   * has to fix the mapping.
   *
   * The first usable value wins, which is what an SP is expected to do with a
   * multi-valued claim: the assertion offers alternatives, not a set.
   */
  const attr = (keys: string[], max = MAX_SSO_NAME): string | null => {
    for (const k of keys) {
      const raw: unknown = profile[k];
      const values = Array.isArray(raw) ? raw : [raw];
      for (const v of values) {
        if (typeof v !== 'string' || !v.trim()) continue;
        const trimmed = v.trim();
        return trimmed.length <= max ? trimmed : null;
      }
    }
    return null;
  };
  const claimed =
    attr(
      [
        'email',
        'mail',
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
        'urn:oid:0.9.2342.19200300.100.1.3',
      ],
      MAX_EMAIL_LENGTH,
    ) ?? (typeof profile.nameID === 'string' && profile.nameID.includes('@') ? profile.nameID : null);
  // A claim that is not a storable address is no address: the caller answers
  // 401 "SAML assertion has no email", which is the truth — nothing here can be
  // signed in as. Letting it through provisioned an account with a login
  // identity that cannot receive its own password reset, and, past ~2.7 KB,
  // failed `users_email_key`'s b-tree with a 500 instead.
  const email = EmailAddress.safeParse(claimed);
  return {
    email: email.success ? email.data.toLowerCase() : null,
    firstName: attr([
      'firstName',
      'givenName',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
      'urn:oid:2.5.4.42',
    ]),
    lastName: attr([
      'lastName',
      'surname',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
      'urn:oid:2.5.4.4',
    ]),
  };
}

/**
 * A named child of an xml2js node, as an object.
 *
 * Elements come back wrapped in arrays, but the document root does not — xml2js
 * applies `explicitArray` to children only — so `getAssertion()` yields
 * `{ Assertion: {...} }` while everything inside it is `[{...}]`. Accepting
 * both shapes lets one accessor walk the whole path.
 */
function first(node: unknown, child: string): Record<string, unknown> | null {
  const value: unknown = (node as Record<string, unknown> | null)?.[child];
  const head: unknown = Array.isArray(value) ? value[0] : value;
  return typeof head === 'object' && head !== null ? (head as Record<string, unknown>) : null;
}

/** An xml2js attribute (`$`) as a string, or null. */
function attrOf(node: Record<string, unknown> | null, name: string): string | null {
  const attrs = node?.$;
  if (typeof attrs !== 'object' || attrs === null) return null;
  const v = (attrs as Record<string, unknown>)[name];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * The identity of a validated assertion, for the replay guard: which document
 * this is, and how long it stays usable.
 *
 * Returns null when the assertion carries no ID or no expiry, and the caller
 * refuses it. Both are refusals on principle rather than parser defensiveness.
 * An assertion with no ID cannot be told apart from its own replay, and one
 * with no NotOnOrAfter never expires by its own terms — an unbounded bearer
 * credential, which is not a thing to accept from a form POST whatever the
 * signature says. Every IdP sends both: SAML core §2.3.3 makes ID required, and
 * the Web SSO profile requires NotOnOrAfter on the bearer confirmation.
 *
 * The Conditions window is preferred over the subject confirmation's because it
 * is the one node-saml enforces, so it is the deadline that actually decides
 * when a replay would start failing on its own.
 */
export function samlAssertionRef(profile: Record<string, unknown>): SamlAssertionRef | null {
  const getAssertion = profile.getAssertion;
  if (typeof getAssertion !== 'function') return null;
  const assertion = first(getAssertion.call(profile) as unknown, 'Assertion');
  if (!assertion) return null;

  const assertionId = attrOf(assertion, 'ID');
  if (!assertionId) return null;

  const confirmationData = first(
    first(first(assertion, 'Subject'), 'SubjectConfirmation'),
    'SubjectConfirmationData',
  );
  const notOnOrAfter =
    attrOf(first(assertion, 'Conditions'), 'NotOnOrAfter') ?? attrOf(confirmationData, 'NotOnOrAfter');
  if (!notOnOrAfter) return null;
  const expiresAt = new Date(notOnOrAfter);
  if (Number.isNaN(expiresAt.getTime())) return null;

  return {
    issuer: typeof profile.issuer === 'string' ? profile.issuer : '',
    assertionId,
    expiresAt,
  };
}

export function registerSamlRoutes(app: FastifyInstance, deps: SamlDeps): void {
  const notConfigured = () => problems.badRequest('SAML SSO is not configured');

  /** The configuration, or null — the caller decides how to say no. */
  const enabledConfig = async (): Promise<SamlConfigRow | null> => {
    const config = await getSamlConfig(deps.pool);
    if (!config || !config.enabled || !config.idp_sso_url || !config.idp_cert) return null;
    return config;
  };

  // SP metadata for IdP setup (public XML).
  app.get('/api/v1/auth/saml/metadata', async (req, reply) => {
    const config = (await getSamlConfig(deps.pool)) ?? ({} as SamlConfigRow);
    const xml = generateServiceProviderMetadata({
      issuer: spEntityId(config, deps.publicBaseUrl),
      callbackUrl: acsUrl(deps.publicBaseUrl),
      wantAssertionsSigned: true,
    });
    return reply.header('content-type', 'application/xml').send(xml);
  });

  // Begin SSO — redirect the browser to the IdP.
  app.get('/api/v1/auth/saml/login', async (req, reply) => {
    const config = await enabledConfig();
    if (!config) return refuseSso(req, reply, 'not_configured', notConfigured());
    const saml = buildSaml(config, deps.publicBaseUrl);
    const url = await saml.getAuthorizeUrlAsync('', undefined, {});
    return reply.redirect(url, 302);
  });

  // Assertion Consumer Service — the IdP POSTs the signed assertion here.
  // Scoped urlencoded parser so the SAMLResponse form field is available.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        const params = new URLSearchParams(body as string);
        done(null, Object.fromEntries(params.entries()));
      },
    );

    scope.post('/api/v1/auth/saml/acs', async (req, reply) => {
      const config = await enabledConfig();
      if (!config) return refuseSso(req, reply, 'not_configured', notConfigured());
      const body = (req.body ?? {}) as { SAMLResponse?: string; RelayState?: string };
      if (!body.SAMLResponse) {
        return refuseSso(req, reply, 'invalid_request', problems.badRequest('Missing SAMLResponse'));
      }

      const saml = buildSaml(config, deps.publicBaseUrl);
      let profile: Record<string, unknown> | null;
      try {
        const result = await saml.validatePostResponseAsync({
          SAMLResponse: body.SAMLResponse,
          RelayState: body.RelayState ?? '',
        });
        profile = result.profile as Record<string, unknown> | null;
      } catch (err) {
        req.log.warn({ err }, 'SAML assertion validation failed');
        return refuseSso(
          req,
          reply,
          'assertion_rejected',
          problems.unauthorized('SAML assertion could not be validated'),
        );
      }
      if (!profile) {
        return refuseSso(
          req,
          reply,
          'assertion_rejected',
          problems.unauthorized('SAML assertion carried no profile'),
        );
      }

      // Spend the assertion before anything else looks at it. The signature and
      // Conditions checks above pass just as happily on a replay — they are
      // properties of the document — so this is the only step that can tell the
      // second POST from the first, and it has to run before any of the work
      // that would issue a session.
      const ref = samlAssertionRef(profile);
      if (!ref) {
        return refuseSso(
          req,
          reply,
          'assertion_rejected',
          problems.unauthorized('SAML assertion has no usable ID or expiry'),
        );
      }
      if (!(await consumeSamlAssertion(deps.pool, ref))) {
        req.log.warn({ assertionId: ref.assertionId }, 'SAML assertion replayed');
        return refuseSso(
          req,
          reply,
          'assertion_reused',
          problems.unauthorized('SAML assertion has already been used'),
        );
      }

      const identity = extractIdentity(profile);
      if (!identity.email) {
        return refuseSso(req, reply, 'no_email', problems.unauthorized('SAML assertion has no email'));
      }
      if (config.allowed_domain && !identity.email.endsWith(`@${config.allowed_domain.toLowerCase()}`)) {
        return refuseSso(
          req,
          reply,
          'domain_not_allowed',
          problems.forbidden('Your email domain is not permitted for SSO'),
        );
      }

      // JIT: reuse an existing account (linking it), else provision one.
      let user: UserWithRoles | null = await findUserByEmail(deps.pool, identity.email);
      const provisioned = !user;
      if (!user) {
        const role = (ROLE_KEYS as readonly string[]).includes(config.default_role)
          ? (config.default_role as RoleKey)
          : 'valuation_user';
        user = await createProvisionedUser(deps.pool, {
          email: identity.email,
          firstName: identity.firstName,
          lastName: identity.lastName,
          provisionedBy: 'saml',
          roles: [role],
        });
        // An account that appeared because an IdP asserted an address. It is
        // the only door on this platform that mints a seat with no request
        // from inside the firm, and it recorded nothing — so "where did this
        // account come from" had no answer for exactly the accounts whose
        // origin is furthest from anybody here.
        await recordAdminEvent(deps.pool, {
          type: 'user_created',
          actor: { actorType: 'system', actorId: null, source: 'saml' },
          subjectType: 'user',
          subjectId: user.id,
          subjectLabel: user.email,
          payload: { method: 'saml_jit', roles: user.roles },
        });
      }
      if (user.deleted_at) {
        // On the spine, with the `reason` the password door uses (round 272,
        // methodology M3). A closed account is the one refusal here that is
        // about *this platform's* state rather than the IdP's, so it is the one
        // an operator asks about — and it wrote nothing, while the same account
        // tried at the password door wrote `closed_account`.
        //
        // `ip` for the same reason the other three failed-auth writes carry it
        // (round 273, methodology M11): password, MFA and Google each stamp
        // `req.ip` on the failure, and this one did not. A failed sign-in is
        // read to answer "who has been trying, and from where", and the address
        // is the only field on it that says where — the account is closed, so
        // there is no session, no principal and no later request to join to.
        // This is the door the largest firms use, and it was the one that could
        // not answer.
        await recordAdminEvent(deps.pool, {
          type: 'user_login_failed',
          actor: { actorType: 'human', actorId: user.id },
          subjectType: 'user',
          subjectId: user.id,
          subjectLabel: user.email,
          payload: { method: 'saml', reason: 'closed_account', provisioned, ip: req.ip },
        });
        return refuseSso(
          req,
          reply,
          'account_deactivated',
          problems.forbidden('This account is deactivated'),
        );
      }

      // The third sign-in door. Password and Google both wrote `user_login`
      // from the day the spine existed; this one did not, so a firm that had
      // moved to SSO — which is every firm large enough to have an auditor
      // asking — had a trail with no sign-ins in it at all.
      await recordAdminEvent(deps.pool, {
        type: 'user_login',
        actor: { actorType: 'human', actorId: user.id },
        subjectType: 'user',
        subjectId: user.id,
        subjectLabel: user.email,
        payload: { method: 'saml', provisioned },
      });

      // The denominator. Without it a refusal count cannot separate one person
      // with the wrong address from a signing certificate that expired an hour
      // ago — and every refusal on this path is answered as a 302, so nothing
      // in the HTTP metrics can tell the two apart either.
      recordSsoOutcome('saml', 'signed_in');
      const token = await signSession(
        { sub: user.id, roles: user.roles, partner_id: user.partner_id, session_epoch: user.session_epoch },
        deps.jwt,
      );
      if (deps.cookie) setSessionCookie(reply, token, deps.cookie);
      // Hand the SPA the token via the same fragment convention as Google SSO.
      return reply.redirect(`/auth/google/complete#token=${encodeURIComponent(token)}`, 302);
    });
  });
}
