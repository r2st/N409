/**
 * Rate limits on the unauthenticated surface.
 *
 * Every route exercised here faces the open internet with either no credential
 * at all or a single bearer token, and none of them was throttled: registration
 * allowed bulk account creation, verify-email / reset-password / accept-invite
 * allowed unbounded token guessing (each burning a scrypt hash or a DB round
 * trip), and the board / auditor / SCIM routes were free oracles for guessing
 * the one secret that unlocks a whole client valuation.
 *
 * The board, auditor and SCIM limiters are injected so the assertions pin the
 * *behaviour* rather than today's production thresholds.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { isDbAvailable, setupTestApp } from './helpers.js';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';

const dbUp = await isDbAvailable();
const WINDOW_MS = 60_000;

describe.skipIf(!dbUp)('rate limits on unauthenticated endpoints', () => {
  let app: FastifyInstance;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await setupTestApp(
      { AUTO_PIPELINE: 'off' },
      {
        boardPublicLimiter: new FixedWindowRateLimiter(2, WINDOW_MS),
        auditorPortalLimiter: new FixedWindowRateLimiter(2, WINDOW_MS),
        scimLimiter: new FixedWindowRateLimiter(2, WINDOW_MS),
      },
    );
    app = ctx.app;
    teardown = ctx.teardown;
  });

  afterAll(async () => {
    await teardown?.();
  });

  /** Fires `n` identical requests and returns their status codes. */
  const burst = async (n: number, req: Parameters<FastifyInstance['inject']>[0]) => {
    const codes: number[] = [];
    for (let i = 0; i < n; i++) codes.push((await app.inject(req)).statusCode);
    return codes;
  };

  describe('board resolution + sign (token-only, public)', () => {
    it('throttles resolution lookups per IP', async () => {
      const req = {
        method: 'POST' as const,
        url: '/api/v1/board/resolution',
        payload: { token: 'n409_brd_guess' },
      };
      const codes = await burst(3, req);
      // First two miss (404 — unknown token); the third is refused outright.
      expect(codes.slice(0, 2)).toEqual([404, 404]);
      expect(codes[2]).toBe(429);
    });

    it('throttles sign-off attempts per IP and advertises retry-after', async () => {
      const req = {
        method: 'POST' as const,
        url: '/api/v1/board/sign',
        payload: { token: 'n409_brd_guess_again', decision: 'signed' as const },
      };
      await burst(2, req);
      const blocked = await app.inject(req);
      expect(blocked.statusCode).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    });
  });

  describe('auditor portal (token-only, public)', () => {
    it('throttles token redemption per IP', async () => {
      const req = {
        method: 'POST' as const,
        url: '/api/v1/auditor/portal',
        payload: { token: 'audit_guess' },
      };
      const codes = await burst(3, req);
      // An unknown token is a 401; the limiter takes over from there.
      expect(codes.slice(0, 2)).toEqual([401, 401]);
      expect(codes[2]).toBe(429);
    });
  });

  describe('/scim/v2/*', () => {
    it('throttles per IP before the token is even checked', async () => {
      const req = { method: 'GET' as const, url: '/scim/v2/Users' };
      const codes = await burst(3, req);
      expect(codes.slice(0, 2)).toEqual([401, 401]);
      expect(codes[2]).toBe(429);
    });

    it('answers a throttled SCIM request in SCIM error shape', async () => {
      // The window from the previous test is still open.
      const res = await app.inject({ method: 'GET', url: '/scim/v2/Users' });
      expect(res.statusCode).toBe(429);
      expect(res.headers['content-type']).toContain('application/scim+json');
      expect(res.json().schemas).toContain('urn:ietf:params:scim:api:messages:2.0:Error');
      expect(res.json().status).toBe('429');
    });

    it('shares one limit across every SCIM route, including the unauthenticated config route', async () => {
      const res = await app.inject({ method: 'GET', url: '/scim/v2/ServiceProviderConfig' });
      expect(res.statusCode).toBe(429);
    });
  });
});

describe.skipIf(!dbUp)('rate limits on the auth routes', () => {
  let app: FastifyInstance;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    app = ctx.app;
    teardown = ctx.teardown;
  });

  afterAll(async () => {
    await teardown?.();
  });

  it('throttles registration per email before the expensive work', async () => {
    // Three per email per hour: the 4th attempt at the *same* address is refused
    // even though each prior attempt already 409'd on the duplicate.
    const payload = {
      email: 'repeat-signup@test.example.com',
      password: 'a-long-enough-password1',
    };
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload })).statusCode);
    }
    expect(codes[0]).toBe(201);
    expect(codes[1]).toBe(409);
    expect(codes[2]).toBe(409);
    expect(codes[3]).toBe(429);
  });

  it('throttles registration per IP across different addresses', async () => {
    // A fresh address each time, so only the per-IP window can stop this. The
    // exact count left in the window depends on what the test above spent, so
    // assert the behaviour: the flood is cut off, and stays cut off.
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      codes.push(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/register',
            payload: { email: `ip-flood-${i}@test.example.com`, password: 'a-long-enough-password1' },
          })
        ).statusCode,
      );
    }
    const firstRefusal = codes.indexOf(429);
    expect(firstRefusal).toBeGreaterThan(0);
    // Within the per-IP hourly ceiling, and nothing gets through afterwards.
    expect(firstRefusal).toBeLessThanOrEqual(10);
    expect(codes.slice(0, firstRefusal).every((c) => c === 201)).toBe(true);
    expect(codes.slice(firstRefusal).every((c) => c === 429)).toBe(true);
  });

  it('throttles email-verification token guesses', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) {
      codes.push(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/verify-email',
            payload: { token: `guess-${i}` },
          })
        ).statusCode,
      );
    }
    // 20 per IP per hour: the first 20 are honest misses, the 21st is refused.
    expect(codes.slice(0, 20).every((c) => c === 400)).toBe(true);
    expect(codes[20]).toBe(429);
  });

  it('throttles password-reset token guesses', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) {
      codes.push(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/reset-password',
            payload: { token: `guess-${i}`, password: 'a-long-enough-password1' },
          })
        ).statusCode,
      );
    }
    expect(codes.slice(0, 20).every((c) => c === 400)).toBe(true);
    expect(codes[20]).toBe(429);
  });

  it('throttles invitation acceptance and the invite-info oracle separately', async () => {
    const accept = [];
    for (let i = 0; i < 21; i++) {
      accept.push(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/accept-invite',
            payload: { token: `guess-${i}`, password: 'a-long-enough-password1' },
          })
        ).statusCode,
      );
    }
    expect(accept.slice(0, 20).every((c) => c === 400)).toBe(true);
    expect(accept[20]).toBe(429);

    // invite-info reads the same token space, so it carries its own limit —
    // otherwise it stays a free oracle for the route above.
    const info = [];
    for (let i = 0; i < 21; i++) {
      info.push(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/invite-info',
            payload: { token: `guess-${i}` },
          })
        ).statusCode,
      );
    }
    expect(info.slice(0, 20).every((c) => c === 400)).toBe(true);
    expect(info[20]).toBe(429);
  });
});
