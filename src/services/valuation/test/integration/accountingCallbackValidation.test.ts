import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { isDbAvailable, setupTestApp, type TestApp } from './helpers.js';
import { integrationCallbackRefusal } from '../../src/domain/oauthCallbackRefusal.js';

const dbUp = await isDbAvailable();

/**
 * The accounting OAuth callback is the one unauthenticated entry point in the
 * integration surface — the signed `state` is the authentication, so every
 * query parameter is attacker-controlled until it verifies. These pin the
 * schema that now bounds them: oversized input is refused before any of it
 * reaches the JWT verifier, the token exchange, or `external_org_id`.
 *
 * The status splits where the query stops being the subject. A parameter that
 * is too long, repeated, or absent is a malformed request — 400, the same
 * answer every other query string in the service gets. A `state` that is
 * well-formed and does not verify is not malformed: the request was understood
 * and refused, which is the 422 the last two cases keep.
 */
describe.skipIf(!dbUp)('accounting OAuth callback — query validation', () => {
  let ctx: TestApp;
  let app: FastifyInstance;

  const callback = (query: string) =>
    app.inject({ method: 'GET', url: `/api/v1/accounting/callback?${query}` });

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('refuses an over-long state instead of handing it to the verifier', async () => {
    const res = await callback(`state=${'a'.repeat(4097)}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/^Invalid callback parameters — state: /);
  });

  it('refuses an over-long code', async () => {
    const res = await callback(`state=abc&code=${'c'.repeat(4097)}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/^Invalid callback parameters — code: /);
  });

  it('refuses an over-long realmId before it can reach external_org_id', async () => {
    const res = await callback(`state=abc&code=x&realmId=${'r'.repeat(129)}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/^Invalid callback parameters — realmId: /);
  });

  it('refuses an over-long error', async () => {
    const res = await callback(`state=abc&error=${'e'.repeat(257)}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/^Invalid callback parameters — error: /);
  });

  it('refuses a repeated parameter, which arrives as an array', async () => {
    const res = await callback('state=one&state=two');
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/^Invalid callback parameters — state: /);
  });

  it('still reports a missing state as such', async () => {
    const res = await callback('code=abc');
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toBe(integrationCallbackRefusal('accounting'));
  });

  it('passes well-formed parameters through to state verification', async () => {
    // Within bounds, so the schema lets it by; the state is not a valid JWT, so
    // the handler rejects it on its own terms. That distinction is the point —
    // validation bounds the input, it does not authenticate it.
    const res = await callback('state=not-a-jwt&code=abc&realmId=12345');
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toBe(integrationCallbackRefusal('accounting'));
  });

  it('ignores unknown provider-appended parameters rather than failing', async () => {
    // Real callbacks carry provider extras (scope, session_state, ...). A strict
    // schema would break them, so unknown keys are stripped and the request is
    // judged on the fields we actually read.
    const res = await callback('state=not-a-jwt&code=abc&scope=accounting&session_state=xyz');
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toBe(integrationCallbackRefusal('accounting'));
  });
});
