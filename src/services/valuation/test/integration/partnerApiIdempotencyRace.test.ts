import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';
import {
  authHeader,
  isDbAvailable,
  SEEDED_PASSWORD,
  seedPartner,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The retry an idempotency key is actually for.
 *
 * `partnerApiScoping.test.ts` covers the sequential story — replay, per-firm
 * scoping, a corrected body under a reused key — and all of it passed against
 * the original implementation, which looked the key up, ran the request, and
 * recorded the response afterwards.
 *
 * What that shape cannot do is stop the *concurrent* duplicate, which is the
 * one the feature exists for: a client times out and retries while the original
 * is still running, or an operator clicks submit twice. Both requests look the
 * key up, both miss, both create a valuation — and the second `INSERT … ON
 * CONFLICT DO NOTHING` then swallowed the collision that was the only evidence
 * anything had gone wrong. Two engagements, one key, one ledger row.
 *
 * These race for real. `withIdempotency`'s first await is a query on its own
 * pooled connection, so two overlapping `inject`s genuinely interleave there
 * rather than serialising at an await boundary.
 */
describe.skipIf(!dbUp)('partner API idempotency under concurrency', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let partnerId: string;
  let apiKey: string;

  beforeAll(async () => {
    ctx = await setupTestApp({}, { partnerApiLimiter: new FixedWindowRateLimiter(1000, 60_000) });
    app = ctx.app;
    partnerId = await seedPartner(ctx, 'Concurrent Advisors');
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId });
    const minted = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${partnerId}/tokens`,
      headers: authHeader(admin.token),
      payload: { current_password: SEEDED_PASSWORD, name: 'race test' },
    });
    expect(minted.statusCode).toBe(201);
    apiKey = minted.json().secret as string;
  });
  afterAll(async () => ctx?.teardown());

  let seq = 0;
  const key = () => `race-${(seq += 1)}-${Date.now()}`;

  const create = (idempotencyKey: string, companyName: string) =>
    app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': idempotencyKey },
      payload: { kind: '409a', company_name: companyName },
    });

  const countNamed = async (companyName: string): Promise<number> => {
    const { rows } = await ctx.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM valuations WHERE company_name = $1',
      [companyName],
    );
    return Number(rows[0]!.n);
  };

  it('creates one valuation when the same key arrives twice at once', async () => {
    /*
     * The invariant is "one engagement", not a particular pair of status codes.
     *
     * Whether the two requests interleave *inside* the claim or serialise
     * around it is the scheduler's business, and both orders are correct
     * behaviour with different answers: the duplicate is told 409 while the
     * original is running, and replayed once it has landed. Asserting one of
     * those makes the test a coin flip on a machine that happens to schedule
     * the other. So the two legal shapes are named, and the illegal one — a
     * second creation, which is what the old implementation did on both orders
     * — is what fails.
     *
     * Repeated, because only some interleavings exercise the row lock, and one
     * attempt would usually take whichever path this box is fast at.
     */
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const k = key();
      const company = `Double Submit ${k}`;
      const [a, b] = await Promise.all([create(k, company), create(k, company)]);

      expect(await countNamed(company), `attempt ${attempt}`).toBe(1);

      const created = [a, b].filter((r) => r.statusCode === 201 && !r.headers['x-idempotent-replay']);
      expect(created, `attempt ${attempt}`).toHaveLength(1);

      const other = a === created[0] ? b : a;
      if (other.statusCode === 409) {
        expect(other.json().detail).toMatch(/still in flight/i);
      } else {
        expect(other.statusCode).toBe(201);
        expect(other.headers['x-idempotent-replay']).toBe('true');
        expect(other.json().valuation.id).toBe(created[0]!.json().valuation.id);
      }
    }
  });

  it('replays the original response once the winner has landed', async () => {
    const k = key();
    const company = `Replay After Race ${k}`;
    const [a, b] = await Promise.all([create(k, company), create(k, company)]);
    const winner = [a, b].find((r) => r.statusCode === 201 && !r.headers['x-idempotent-replay'])!;

    // The 409 told the client to come back, so coming back must give it the
    // answer it would have had — not a second engagement, and not a conflict.
    const retry = await create(k, company);
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['x-idempotent-replay']).toBe('true');
    expect(retry.json().valuation.id).toBe(winner.json().valuation.id);
    expect(await countNamed(company)).toBe(1);
  });

  it('still refuses the same key on a different body while the original runs', async () => {
    const k = key();
    const first = await create(k, `Body A ${k}`);
    expect(first.statusCode).toBe(201);
    const second = await create(k, `Body B ${k}`);
    expect(second.statusCode).toBe(409);
    // The body check comes before the completion check, so this reads the same
    // whether the original has answered or not. Matching the mismatch wording
    // rather than merely the status is what keeps the two 409s apart: the
    // in-flight one says "still in flight", and this test would pass against it
    // on the status alone. The hash covers method and path now, so the message
    // no longer names the body specifically.
    expect(second.json().detail).toMatch(/already used for a different request/i);
  });

  it('hands the key back when the request refused without writing anything', async () => {
    // A 4xx wrote nothing, and the client's reason to retry is that it is about
    // to send a corrected body. Preserved from the original behaviour, and now
    // it has to be explicit — the claim exists by this point and something must
    // release it.
    const k = key();
    const bad = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': k },
      payload: { kind: 'not_a_kind', company_name: 'Corrected Later' },
    });
    expect(bad.statusCode).toBe(422);

    const { rows } = await ctx.pool.query(
      'SELECT 1 FROM partner_api_idempotency WHERE partner_id = $1 AND idempotency_key = $2',
      [partnerId, k],
    );
    expect(rows).toHaveLength(0);

    const good = await create(k, `Corrected ${k}`);
    expect(good.statusCode).toBe(201);
    expect(good.headers['x-idempotent-replay']).toBeUndefined();
  });

  it('reclaims a key whose holder died, after the takeover window', async () => {
    // A process that crashes between claiming a key and answering would
    // otherwise hold it forever. Staged directly, because the only honest way
    // to produce one is to kill the process mid-request.
    const k = key();
    await ctx.pool.query(
      `INSERT INTO partner_api_idempotency (partner_id, idempotency_key, request_hash, created_at)
       VALUES ($1, $2, 'abandoned', now() - interval '1 hour')`,
      [partnerId, k],
    );

    const res = await create(k, `After Crash ${k}`);
    expect(res.statusCode, res.body).toBe(201);

    const { rows } = await ctx.pool.query<{ completed_at: Date | null }>(
      'SELECT completed_at FROM partner_api_idempotency WHERE partner_id = $1 AND idempotency_key = $2',
      [partnerId, k],
    );
    expect(rows[0]?.completed_at).not.toBeNull();
  });

  it('does not reclaim a key whose holder is still working', async () => {
    // The same row, young. The window is the only thing separating "crashed"
    // from "busy", so it has to refuse here or the takeover becomes a way to
    // double-create with a stopwatch.
    const k = key();
    await ctx.pool.query(
      `INSERT INTO partner_api_idempotency (partner_id, idempotency_key, request_hash, created_at)
       VALUES ($1, $2, 'in-progress', now())`,
      [partnerId, k],
    );

    const company = `Still Running ${k}`;
    const res = await create(k, company);
    expect(res.statusCode).toBe(409);
    expect(await countNamed(company)).toBe(0);
  });

  it('leaves an unkeyed request alone', async () => {
    // No header, no claim, no row — the mechanism is opt-in and a partner that
    // has never heard of it must not start getting 409s.
    const company = `No Key ${Date.now()}`;
    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/partner/v1/valuations',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { kind: '409a', company_name: company },
      }),
      app.inject({
        method: 'POST',
        url: '/api/partner/v1/valuations',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { kind: '409a', company_name: company },
      }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(await countNamed(company)).toBe(2);
  });
});
