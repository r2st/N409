import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { isDbAvailable, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The cap-table-sync and HRIS OAuth callbacks are unauthenticated entry points —
 * the signed `state` is the authentication, so every query parameter is
 * attacker-controlled until it verifies. Both used to read `req.query` through a
 * bare `as` cast, which is a lie about the runtime shape: Fastify parses a
 * repeated parameter into an array, so `?code=a&code=b` handed an array to code
 * typed for a string. It reached `new URLSearchParams({ code })`, which
 * stringifies it to `a,b`, and `company_id` reached `external_company_id`
 * unbounded. These pin the schema that now bounds them.
 *
 * Both callbacks share a shape, so they share a table.
 */
const CALLBACKS = [
  { name: 'cap-table sync', path: '/api/v1/cap-table-sync/callback' },
  { name: 'HRIS', path: '/api/v1/hris/callback' },
] as const;

describe.skipIf(!dbUp)('sync OAuth callbacks — query validation', () => {
  let ctx: TestApp;
  let app: FastifyInstance;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  for (const { name, path } of CALLBACKS) {
    describe(name, () => {
      const callback = (query: string) => app.inject({ method: 'GET', url: `${path}?${query}` });

      it('refuses a repeated state, which arrives as an array', async () => {
        const res = await callback('state=one&state=two');
        expect(res.statusCode).toBe(400);
        expect(res.json().detail).toBe('Invalid callback parameters');
      });

      it('refuses a repeated code before it is spent at the token endpoint', async () => {
        // The array used to stringify to `a,b` inside URLSearchParams, so the
        // provider saw a code the authorization step never issued.
        const res = await callback('state=not-a-jwt&code=a&code=b');
        expect(res.statusCode).toBe(400);
        expect(res.json().detail).toBe('Invalid callback parameters');
      });

      it('refuses a repeated company_id before it can reach external_company_id', async () => {
        const res = await callback('state=not-a-jwt&code=x&company_id=1&company_id=2');
        expect(res.statusCode).toBe(400);
        expect(res.json().detail).toBe('Invalid callback parameters');
      });

      it('refuses a repeated error', async () => {
        const res = await callback('state=not-a-jwt&error=denied&error=denied');
        expect(res.statusCode).toBe(400);
        expect(res.json().detail).toBe('Invalid callback parameters');
      });

      it('refuses an over-long state instead of handing it to the verifier', async () => {
        const res = await callback(`state=${'a'.repeat(4097)}`);
        expect(res.statusCode).toBe(400);
        expect(res.json().detail).toBe('Invalid callback parameters');
      });

      it('refuses an over-long code', async () => {
        const res = await callback(`state=abc&code=${'c'.repeat(4097)}`);
        expect(res.statusCode).toBe(400);
        expect(res.json().detail).toBe('Invalid callback parameters');
      });

      it('refuses an over-long company_id', async () => {
        const res = await callback(`state=abc&code=x&company_id=${'r'.repeat(129)}`);
        expect(res.statusCode).toBe(400);
        expect(res.json().detail).toBe('Invalid callback parameters');
      });

      it('refuses an over-long error', async () => {
        const res = await callback(`state=abc&error=${'e'.repeat(257)}`);
        expect(res.statusCode).toBe(400);
        expect(res.json().detail).toBe('Invalid callback parameters');
      });

      it('reports the errors that failed validation', async () => {
        const res = await callback('state=one&state=two');
        expect(res.json().errors).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: ['state'] })]),
        );
      });

      it('still reports a missing state as such', async () => {
        const res = await callback('code=abc');
        expect(res.statusCode).toBe(400);
        expect(res.json().detail).toBe('Missing state');
      });

      it('passes well-formed parameters through to state verification', async () => {
        // Within bounds, so the schema lets it by; the state is not a valid JWT,
        // so the handler rejects it on its own terms. That distinction is the
        // point — validation bounds the input, it does not authenticate it.
        const res = await callback('state=not-a-jwt&code=abc&company_id=12345');
        expect(res.statusCode).toBe(422);
        expect(res.json().detail).toBe('Invalid or expired state');
      });

      it('ignores unknown provider-appended parameters rather than failing', async () => {
        // Real callbacks carry provider extras (scope, session_state, ...). A
        // strict schema would break them, so unknown keys are stripped and the
        // request is judged on the fields we actually read.
        const res = await callback('state=not-a-jwt&code=abc&scope=read&session_state=xyz');
        expect(res.statusCode).toBe(422);
        expect(res.json().detail).toBe('Invalid or expired state');
      });

      it('rejects the array before the missing-state check, not after', async () => {
        // `!q.state` is truthy for `[]`-shaped input too, so an unvalidated
        // handler would have answered "Missing state" here. Ordering matters:
        // the schema runs first and names the real problem.
        const res = await callback('state=a&state=b&code=x');
        expect(res.json().detail).toBe('Invalid callback parameters');
      });
    });
  }
});
