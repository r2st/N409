/**
 * Per-IP throttles must actually be per-IP.
 *
 * Fourteen limits in this service key on `req.ip`: the contact form, the
 * client-intake / auditor / board portals, SCIM, and eight in the auth routes.
 * None of them ever reaches this service from the client directly — the web BFF
 * proxies /api over loopback — so with Fastify left at its default `req.ip` was
 * `127.0.0.1` on every request, and all fourteen were one shared bucket rather
 * than one bucket per caller.
 *
 * That inverts what a rate limit is for. Five contact submissions per ten
 * minutes stopped being "per spammer" and became "per internet": one caller
 * could spend the platform's entire budget and every real user got the 429.
 * The existing rate-limit tests could not see it, because `inject` sends every
 * request from the same address — a global bucket and a perfect per-IP bucket
 * are indistinguishable if only one client ever calls.
 *
 * So these tests assert the thing that distinguishes them: two clients, and
 * whether one can exhaust the other's budget or forge its own.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { isDbAvailable, setupTestApp } from './helpers.js';

const dbUp = await isDbAvailable();

const VALID = {
  name: 'Ada Lovelace',
  email: 'ada@analytical.example',
  company: 'Analytical Engines',
  message: 'We need a 409A valuation before our next board meeting.',
};

/** The contact form: 5 per IP per 10 minutes, public, no credential at all. */
const CONTACT_LIMIT = 5;

describe.skipIf(!dbUp)('per-IP throttles isolate clients', () => {
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

  /**
   * A submission from `ip`, shaped the way the web BFF sends it: the client
   * address in X-Forwarded-For, arriving over loopback. That is the only signal
   * this service has — its socket peer is always the BFF.
   */
  const contactFrom = (ip: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/contact',
      headers: { 'x-forwarded-for': ip },
      payload: VALID,
    });

  it('does not let one client spend another client is budget', async () => {
    // Exhaust one address completely.
    const noisy = '198.51.100.11';
    const codes: number[] = [];
    for (let i = 0; i < CONTACT_LIMIT + 1; i++) codes.push((await contactFrom(noisy)).statusCode);
    expect(codes.slice(0, CONTACT_LIMIT).every((c) => c === 201)).toBe(true);
    expect(codes[CONTACT_LIMIT]).toBe(429);

    // A different address must be untouched by that. Before trustProxy this was
    // a 429: both requests keyed on 127.0.0.1, so the second client inherited
    // the first one's exhausted window.
    const bystander = await contactFrom('203.0.113.77');
    expect(bystander.statusCode).toBe(201);
  });

  it('keeps counting the noisy client after the bystander gets through', async () => {
    // Guards the opposite error: an isolation fix that resets the window on any
    // new key would let the flood resume by alternating addresses.
    const blocked = await contactFrom('198.51.100.11');
    expect(blocked.statusCode).toBe(429);
  });

  it('resolves the client from the hop it trusts, not from what the client prepended', async () => {
    // Caddy appends, it does not replace, so a caller who sends their own
    // X-Forwarded-For has it preserved to the *left* of their real address.
    // Trusting the leftmost entry — which is what `trustProxy: true` does —
    // would make that forged entry the identity, handing every caller an
    // unlimited supply of fresh buckets and disabling all fourteen limits.
    //
    // The real address here is already exhausted, so if the forged prefix is
    // what got read, this request succeeds and the limit is bypassable.
    const forged = await app.inject({
      method: 'POST',
      url: '/api/v1/contact',
      headers: { 'x-forwarded-for': '10.9.9.9, 198.51.100.11' },
      payload: VALID,
    });
    expect(forged.statusCode).toBe(429);
  });

  it('does not let a forged prefix exhaust an innocent third party', async () => {
    // The same confusion in the other direction: if the leftmost entry were
    // trusted, a caller could burn down any address they chose to name, and the
    // owner of that address would be locked out of a service they never called.
    const victim = '203.0.113.200';
    for (let i = 0; i < CONTACT_LIMIT + 1; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/contact',
        headers: { 'x-forwarded-for': `${victim}, 198.51.100.55` },
        payload: VALID,
      });
    }
    // The victim's own budget is untouched — the requests above were charged to
    // 198.51.100.55, the address the trusted hop actually reported.
    expect((await contactFrom(victim)).statusCode).toBe(201);
  });

  it('falls back to the socket peer when no trusted hop names a client', async () => {
    // Not every caller arrives through the BFF: an on-host health check or a
    // curl on the box has no X-Forwarded-For. It must still be throttled rather
    // than sailing past a limiter that cannot key it.
    const codes: number[] = [];
    for (let i = 0; i < CONTACT_LIMIT + 1; i++) {
      codes.push((await app.inject({ method: 'POST', url: '/api/v1/contact', payload: VALID })).statusCode);
    }
    expect(codes[CONTACT_LIMIT]).toBe(429);
  });
});

describe.skipIf(!dbUp)('the auth throttles isolate clients too', () => {
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

  const guessFrom = (ip: string, token: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      headers: { 'x-forwarded-for': ip },
      payload: { token, password: 'a-long-enough-password1' },
    });

  it('spends one address budget without touching another', async () => {
    // 20 token guesses per IP per hour. Sharing this bucket globally is the
    // more dangerous half of the bug: a single attacker exhausting it locks
    // every legitimate user out of completing a password reset, and the
    // platform has no other way to recover an account.
    const attacker = '198.51.100.99';
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await guessFrom(attacker, `guess-${i}`)).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 400)).toBe(true);
    expect(codes[20]).toBe(429);

    // The user whose reset link is genuinely in their inbox is unaffected.
    const legitimate = await guessFrom('203.0.113.42', 'another-token');
    expect(legitimate.statusCode).toBe(400);
  });
});
