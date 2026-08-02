import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { SAML, generateServiceProviderMetadata } from '@node-saml/node-saml';
import { problems } from '@n409/shared';
import { signSession, type JwtConfig } from '../auth/jwt.js';
import { setSessionCookie, type SessionCookieConfig } from '../auth/cookies.js';
import { getSamlConfig, type SamlConfigRow } from '../repos/ssoConfig.js';
import { consumeSamlAssertion, type SamlAssertionRef } from '../repos/samlReplay.js';
import { createProvisionedUser, findUserByEmail, type UserWithRoles } from '../repos/users.js';
import type { RoleKey } from '../domain/roles.js';
import { ROLE_KEYS } from '../domain/roles.js';

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

/** Pull an email + names out of a validated SAML profile (attribute names vary). */
export function extractIdentity(profile: Record<string, unknown>): {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
} {
  const attr = (keys: string[]): string | null => {
    for (const k of keys) {
      const v = profile[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  };
  const email =
    attr([
      'email',
      'mail',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
      'urn:oid:0.9.2342.19200300.100.1.3',
    ]) ?? (typeof profile.nameID === 'string' && profile.nameID.includes('@') ? profile.nameID : null);
  return {
    email: email ? email.toLowerCase() : null,
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
  const requireEnabled = async (): Promise<SamlConfigRow> => {
    const config = await getSamlConfig(deps.pool);
    if (!config || !config.enabled || !config.idp_sso_url || !config.idp_cert) {
      throw problems.badRequest('SAML SSO is not configured');
    }
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
    const config = await requireEnabled();
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
      const config = await requireEnabled();
      const body = (req.body ?? {}) as { SAMLResponse?: string; RelayState?: string };
      if (!body.SAMLResponse) throw problems.badRequest('Missing SAMLResponse');

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
        throw problems.unauthorized('SAML assertion could not be validated');
      }
      if (!profile) throw problems.unauthorized('SAML assertion carried no profile');

      // Spend the assertion before anything else looks at it. The signature and
      // Conditions checks above pass just as happily on a replay — they are
      // properties of the document — so this is the only step that can tell the
      // second POST from the first, and it has to run before any of the work
      // that would issue a session.
      const ref = samlAssertionRef(profile);
      if (!ref) throw problems.unauthorized('SAML assertion has no usable ID or expiry');
      if (!(await consumeSamlAssertion(deps.pool, ref))) {
        req.log.warn({ assertionId: ref.assertionId }, 'SAML assertion replayed');
        throw problems.unauthorized('SAML assertion has already been used');
      }

      const identity = extractIdentity(profile);
      if (!identity.email) throw problems.unauthorized('SAML assertion has no email');
      if (config.allowed_domain && !identity.email.endsWith(`@${config.allowed_domain.toLowerCase()}`)) {
        throw problems.forbidden('Your email domain is not permitted for SSO');
      }

      // JIT: reuse an existing account (linking it), else provision one.
      let user: UserWithRoles | null = await findUserByEmail(deps.pool, identity.email);
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
      }
      if (user.deleted_at) throw problems.forbidden('This account is deactivated');

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
