import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignedXml } from 'xml-crypto';
import { upsertSamlConfig } from '../../src/repos/ssoConfig.js';
import { findUserByEmail, setUserActive } from '../../src/repos/users.js';
import { extractIdentity } from '../../src/routes/saml.js';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * SAML 2.0 SP (feature 9).
 *
 * This is an authentication path that accepts a document from outside and turns
 * it into a session, and it had no tests at all. The property that matters is
 * not that a valid login works — it is that everything else does *not*: the
 * whole security of SAML rests on the assertion signature, and a bug that
 * accepts an unsigned or wrongly-signed assertion hands out sessions to anyone
 * who can POST to the ACS endpoint.
 *
 * The IdP keypair is generated per run rather than committed. A checked-in
 * private key would be flagged by the gitleaks job (and would eventually
 * expire); generating one keeps the fixture honest and the scanner quiet.
 */

const dbUp = await isDbAvailable();

/** True when openssl is usable — it ships on CI and macOS, but don't assume. */
function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

interface Keypair {
  cert: string;
  key: string;
}

/** A throwaway self-signed keypair standing in for an IdP's signing key. */
function generateKeypair(cn: string): Keypair {
  const out = execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      '/dev/stdout',
      '-out',
      '/dev/stdout',
      '-days',
      '2',
      '-nodes',
      '-subj',
      `/CN=${cn}`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const key = /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/.exec(out)?.[0];
  const cert = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(out)?.[0];
  if (!key || !cert) throw new Error('could not parse openssl output into a keypair');
  return { cert, key };
}

const BASE = 'http://localhost:3000';
const ACS = `${BASE}/api/v1/auth/saml/acs`;
/** The SP entity id the route derives when sp_entity_id is unset — the audience. */
const AUDIENCE = `${BASE}/api/v1/auth/saml/metadata`;

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

function assertionXml(email: string, id = '_assertion1'): string {
  return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${iso(0)}">
  <saml:Issuer>http://idp.test/entity</saml:Issuer>
  <saml:Subject>
    <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>
    <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
      <saml:SubjectConfirmationData NotOnOrAfter="${iso(5 * 60_000)}" Recipient="${ACS}"/>
    </saml:SubjectConfirmation>
  </saml:Subject>
  <saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${iso(5 * 60_000)}">
    <saml:AudienceRestriction><saml:Audience>${AUDIENCE}</saml:Audience></saml:AudienceRestriction>
  </saml:Conditions>
  <saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="${id}">
    <saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>
  </saml:AuthnStatement>
  <saml:AttributeStatement>
    <saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>
    <saml:Attribute Name="firstName"><saml:AttributeValue>Ada</saml:AttributeValue></saml:Attribute>
    <saml:Attribute Name="lastName"><saml:AttributeValue>Lovelace</saml:AttributeValue></saml:Attribute>
  </saml:AttributeStatement>
</saml:Assertion>`;
}

/**
 * A base64 SAMLResponse carrying one assertion, optionally signed by `signWith`.
 * Omitting `signWith` produces the unsigned forgery an attacker would send.
 */
function samlResponse(email: string, signWith?: Keypair): string {
  const assertion = assertionXml(email);
  let body = assertion;
  if (signWith) {
    const sig = new SignedXml({
      privateKey: signWith.key,
      publicCert: signWith.cert,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    });
    sig.addReference({
      xpath: "//*[local-name(.)='Assertion']",
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        'http://www.w3.org/2001/10/xml-exc-c14n#',
      ],
    });
    sig.computeSignature(assertion, {
      location: { reference: "//*[local-name(.)='Issuer']", action: 'after' },
    });
    body = sig.getSignedXml();
  }
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response1" Version="2.0" IssueInstant="${iso(0)}" Destination="${ACS}">
  <saml:Issuer>http://idp.test/entity</saml:Issuer>
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
  ${body}
</samlp:Response>`;
  return Buffer.from(xml, 'utf8').toString('base64');
}

describe('extractIdentity', () => {
  it('reads the plain attribute names an IdP most often sends', () => {
    expect(extractIdentity({ email: 'Ada@Example.com', firstName: 'Ada', lastName: 'Lovelace' })).toEqual({
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
  });

  it('reads the SAML claim URIs and OIDs other IdPs send instead', () => {
    expect(
      extractIdentity({
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'grace@example.com',
        'urn:oid:2.5.4.42': 'Grace',
        'urn:oid:2.5.4.4': 'Hopper',
      }),
    ).toEqual({ email: 'grace@example.com', firstName: 'Grace', lastName: 'Hopper' });
  });

  it('falls back to nameID only when it looks like an address', () => {
    expect(extractIdentity({ nameID: 'alan@example.com' }).email).toBe('alan@example.com');
    // A bare/opaque nameID is an identifier, not an address — treating it as one
    // would provision an account under an unusable email.
    expect(extractIdentity({ nameID: 'S-1-5-21-1004336348' }).email).toBeNull();
  });

  it('ignores blank and non-string attribute values', () => {
    expect(extractIdentity({ email: '   ', mail: 'real@example.com' }).email).toBe('real@example.com');
    expect(extractIdentity({ email: 42, firstName: null }).email).toBeNull();
  });
});

describe.skipIf(!dbUp || !opensslAvailable())('SAML assertion consumer', () => {
  let ctx: TestApp;
  let idp: Keypair;
  let attacker: Keypair;
  // saml_config.updated_by is a real FK into users.
  let adminId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    adminId = (await seedUser(ctx, { roles: ['admin'] })).id;
    idp = generateKeypair('test-idp');
    attacker = generateKeypair('attacker');
    await upsertSamlConfig(ctx.pool, {
      enabled: true,
      idpSsoUrl: 'http://idp.test/sso',
      idpCert: idp.cert,
      defaultRole: 'valuation_user',
      updatedBy: adminId,
    });
  });
  afterAll(async () => ctx?.teardown());

  const post = (SAMLResponse: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/saml/acs',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ SAMLResponse }).toString(),
    });

  it('refuses an unsigned assertion', async () => {
    // The whole security of the flow. An unsigned assertion is a document the
    // attacker wrote; accepting it is a full authentication bypass.
    const res = await post(samlResponse('mallory@example.com'));
    expect(res.statusCode).toBe(401);
    expect(await findUserByEmail(ctx.pool, 'mallory@example.com')).toBeNull();
  });

  it('refuses an assertion signed by a key that is not the configured IdP', async () => {
    // Correct XML-dsig, wrong signer: an attacker who can generate a keypair
    // must not be able to mint sessions.
    const res = await post(samlResponse('eve@example.com', attacker));
    expect(res.statusCode).toBe(401);
    expect(await findUserByEmail(ctx.pool, 'eve@example.com')).toBeNull();
  });

  it('refuses an assertion whose content was altered after signing', async () => {
    // Signature-stripping/substitution: swap the subject after the digest was
    // computed and the reference no longer matches.
    const signed = Buffer.from(samlResponse('ada@example.com', idp), 'base64').toString('utf8');
    const tampered = signed.replace(/ada@example\.com/g, 'root@example.com');
    const res = await post(Buffer.from(tampered, 'utf8').toString('base64'));
    expect(res.statusCode).toBe(401);
    expect(await findUserByEmail(ctx.pool, 'root@example.com')).toBeNull();
  });

  it('rejects a request with no SAMLResponse at all', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/saml/acs',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a properly signed assertion and provisions the user', async () => {
    const res = await post(samlResponse('ada@example.com', idp));
    expect(res.statusCode).toBe(302);
    // The session is handed over in the fragment, as with Google SSO.
    expect(res.headers.location).toMatch(/^\/auth\/google\/complete#token=/);

    const user = await findUserByEmail(ctx.pool, 'ada@example.com');
    expect(user).not.toBeNull();
    expect(user!.roles).toEqual(['valuation_user']);
    expect(user!.first_name).toBe('Ada');
  });

  it('links a second login to the same account instead of duplicating it', async () => {
    const before = await findUserByEmail(ctx.pool, 'ada@example.com');
    const res = await post(samlResponse('ada@example.com', idp));
    expect(res.statusCode).toBe(302);
    const after = await findUserByEmail(ctx.pool, 'ada@example.com');
    expect(after!.id).toBe(before!.id);
  });

  it('refuses a deactivated account even with a valid assertion', async () => {
    // Deactivation has to survive SSO, or removing someone's access does
    // nothing as long as the IdP still knows them.
    const user = await findUserByEmail(ctx.pool, 'ada@example.com');
    await setUserActive(ctx.pool, user!.id, false);
    try {
      const res = await post(samlResponse('ada@example.com', idp));
      expect(res.statusCode).toBe(403);
    } finally {
      await setUserActive(ctx.pool, user!.id, true);
    }
  });

  it('enforces the allowed email domain', async () => {
    await upsertSamlConfig(ctx.pool, {
      enabled: true,
      idpSsoUrl: 'http://idp.test/sso',
      idpCert: idp.cert,
      allowedDomain: 'example.com',
      defaultRole: 'valuation_user',
      updatedBy: adminId,
    });
    try {
      const denied = await post(samlResponse('outsider@other.com', idp));
      expect(denied.statusCode).toBe(403);
      expect(await findUserByEmail(ctx.pool, 'outsider@other.com')).toBeNull();

      // A lookalike domain must not satisfy the check by suffix alone.
      const lookalike = await post(samlResponse('outsider@evil-example.com', idp));
      expect(lookalike.statusCode).toBe(403);
      expect(await findUserByEmail(ctx.pool, 'outsider@evil-example.com')).toBeNull();

      const allowed = await post(samlResponse('insider@example.com', idp));
      expect(allowed.statusCode).toBe(302);
    } finally {
      await upsertSamlConfig(ctx.pool, {
        enabled: true,
        idpSsoUrl: 'http://idp.test/sso',
        idpCert: idp.cert,
        allowedDomain: null,
        defaultRole: 'valuation_user',
        updatedBy: adminId,
      });
    }
  });

  it('refuses to run the flow at all when SSO is disabled', async () => {
    await upsertSamlConfig(ctx.pool, {
      enabled: false,
      idpSsoUrl: 'http://idp.test/sso',
      idpCert: idp.cert,
      updatedBy: adminId,
    });
    try {
      // Disabled means disabled: a still-valid assertion must not be honoured.
      expect((await post(samlResponse('ada@example.com', idp))).statusCode).toBe(400);
      expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/saml/login' })).statusCode).toBe(400);
    } finally {
      await upsertSamlConfig(ctx.pool, {
        enabled: true,
        idpSsoUrl: 'http://idp.test/sso',
        idpCert: idp.cert,
        defaultRole: 'valuation_user',
        updatedBy: adminId,
      });
    }
  });

  it('redirects to the IdP to start login, and serves SP metadata', async () => {
    const login = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/saml/login' });
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toContain('http://idp.test/sso');

    const meta = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/saml/metadata' });
    expect(meta.statusCode).toBe(200);
    expect(meta.headers['content-type']).toContain('application/xml');
    expect(meta.body).toContain('AssertionConsumerService');
  });
});
