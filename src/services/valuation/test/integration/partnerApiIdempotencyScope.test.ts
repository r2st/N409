import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * What an Idempotency-Key identifies, and which mutations honour one.
 *
 * `partnerApiScoping.test.ts` covers the sequential story on `POST /valuations`
 * and `partnerApiIdempotencyRace.test.ts` covers the concurrent one. Both were
 * written when that endpoint was the only one accepting a key, and the hash the
 * claim is keyed on covered `req.body` alone — which is sound for exactly as
 * long as that stays true.
 *
 * It stopped being true here. Two of the mutations that now accept a key carry
 * no body at all, so `JSON.stringify(null)` was the whole of their identity: a
 * key reused across two webhooks' test pings, or across a ping and a delivery
 * replay, would find a completed row whose hash matched and replay the *other*
 * request's response — reporting success for something that never ran, which is
 * a worse failure than the double-execution the key exists to prevent. The hash
 * now covers method and path as well, so each of those is a mismatch.
 *
 * The receiver here is a real HTTP server because the two ping tests are only
 * meaningful if a delivery actually goes out (or, on the replay, does not).
 */
describe.skipIf(!dbUp)('partner API idempotency scope', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let partnerId: string;
  let apiKey: string;
  let valuationId: string;
  let receiver: FastifyInstance;
  let receiverUrl: string;
  /** Every delivery the receiver has been sent, in order. */
  const received: string[] = [];
  /** What the receiver answers — 500 when a test needs an undelivered row. */
  let receiverStatus = 200;

  const keyHeader = (idempotencyKey?: string) => ({
    authorization: `Bearer ${apiKey}`,
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  });

  let seq = 0;
  const freshKey = () => `scope-${(seq += 1)}-${Date.now()}`;

  const registerWebhook = async (idempotencyKey?: string) =>
    app.inject({
      method: 'POST',
      url: '/api/partner/v1/webhooks',
      headers: keyHeader(idempotencyKey),
      payload: { url: receiverUrl },
    });

  const upload = async (idempotencyKey: string | undefined, filename: string) =>
    app.inject({
      method: 'POST',
      url: `/api/partner/v1/valuations/${valuationId}/documents`,
      headers: keyHeader(idempotencyKey),
      payload: {
        filename,
        kind: 'other',
        content_type: 'text/plain',
        content_base64: Buffer.from(`contents of ${filename}`).toString('base64'),
      },
    });

  beforeAll(async () => {
    ctx = await setupTestApp(
      { WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true' },
      { partnerApiLimiter: new FixedWindowRateLimiter(1000, 60_000), partnerApiOrgLimiter: null },
    );
    app = ctx.app;
    partnerId = await seedPartner(ctx, 'Scope Advisors');
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId });
    const minted = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${partnerId}/tokens`,
      headers: authHeader(admin.token),
      payload: { current_password: SEEDED_PASSWORD, name: 'scope test' },
    });
    expect(minted.statusCode).toBe(201);
    apiKey = minted.json().secret as string;

    receiver = Fastify({ logger: false });
    receiver.post('/hook', async (req, reply) => {
      received.push(String((req.headers['x-n409-delivery'] as string) ?? ''));
      return reply.status(receiverStatus).send({ ok: receiverStatus < 400 });
    });
    await receiver.listen({ port: 0, host: '127.0.0.1' });
    const address = receiver.server.address();
    if (typeof address === 'object' && address) receiverUrl = `http://127.0.0.1:${address.port}/hook`;

    const created = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers: keyHeader(),
      payload: { kind: '409a', company_name: 'Scope Target Inc' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;
  }, 60_000);

  afterAll(async () => {
    await receiver?.close();
    await ctx?.teardown();
  });

  const countDocuments = async (filename: string): Promise<number> => {
    const { rows } = await ctx.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM documents WHERE valuation_id = $1 AND filename = $2',
      [valuationId, filename],
    );
    return Number(rows[0]!.n);
  };

  // ── The hash covers the request, not just the body ─────────────────────────

  it('refuses a key reused on the same operation against a different resource', async () => {
    const a = await registerWebhook();
    const b = await registerWebhook();
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    const [idA, idB] = [a.json().webhook.id as string, b.json().webhook.id as string];

    const key = freshKey();
    const pingA = await app.inject({
      method: 'POST',
      url: `/api/partner/v1/webhooks/${idA}/test`,
      headers: keyHeader(key),
    });
    expect(pingA.statusCode).toBe(200);
    const afterA = received.length;

    // Same key, same (empty) body, different webhook. Under a body-only hash
    // this replayed A's stored 200 and B was never pinged — the endpoint
    // reporting a successful delivery it had not made.
    const pingB = await app.inject({
      method: 'POST',
      url: `/api/partner/v1/webhooks/${idB}/test`,
      headers: keyHeader(key),
    });
    expect(pingB.statusCode).toBe(409);
    expect(pingB.headers['x-idempotent-replay']).toBeUndefined();
    expect(received.length).toBe(afterA);
    expect(pingB.json().detail).toMatch(/different endpoint or resource/);
  });

  it('refuses a key reused across two different operations', async () => {
    const created = await registerWebhook();
    const webhookId = created.json().webhook.id as string;

    // An undelivered delivery to replay: the replay endpoint refuses one that
    // already landed, so the ping that creates it has to fail first.
    receiverStatus = 500;
    await app.inject({
      method: 'POST',
      url: `/api/partner/v1/webhooks/${webhookId}/test`,
      headers: keyHeader(),
    });
    receiverStatus = 200;
    const { rows } = await ctx.pool.query<{ id: string }>(
      "SELECT id FROM partner_webhook_deliveries WHERE webhook_id = $1 AND status <> 'delivered' LIMIT 1",
      [webhookId],
    );
    const deliveryId = rows[0]!.id;

    const key = freshKey();
    const replay = await app.inject({
      method: 'POST',
      url: `/api/partner/v1/webhooks/${webhookId}/deliveries/${deliveryId}/retry`,
      headers: keyHeader(key),
    });
    expect(replay.statusCode).toBe(200);

    // A replay and a ping are both bodyless POSTs under the same webhook, so a
    // body-only hash made them indistinguishable: this used to answer 200 with
    // the replay's stored body, having sent nothing.
    const ping = await app.inject({
      method: 'POST',
      url: `/api/partner/v1/webhooks/${webhookId}/test`,
      headers: keyHeader(key),
    });
    expect(ping.statusCode).toBe(409);
    expect(ping.json().detail).toMatch(/different endpoint or resource/);
  });

  it('still replays the identical request, which is the point of the key', async () => {
    const created = await registerWebhook();
    const webhookId = created.json().webhook.id as string;
    const key = freshKey();
    const url = `/api/partner/v1/webhooks/${webhookId}/test`;

    const first = await app.inject({ method: 'POST', url, headers: keyHeader(key) });
    expect(first.statusCode).toBe(200);
    const sent = received.length;

    const second = await app.inject({ method: 'POST', url, headers: keyHeader(key) });
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-idempotent-replay']).toBe('true');
    expect(second.json()).toEqual(first.json());
    // Replayed from the store, so no second ping reached the receiver.
    expect(received.length).toBe(sent);
  });

  // ── The mutations that now accept a key ───────────────────────────────────

  it('stores an uploaded document once when the upload is retried', async () => {
    const key = freshKey();
    const filename = 'retried-upload.txt';

    const first = await upload(key, filename);
    expect(first.statusCode).toBe(201);
    expect(await countDocuments(filename)).toBe(1);

    const second = await upload(key, filename);
    expect(second.statusCode).toBe(201);
    expect(second.headers['x-idempotent-replay']).toBe('true');
    expect(second.json().document.id).toBe(first.json().document.id);
    // The retry a client sends after a timeout used to store the file twice,
    // against one engagement, with two ids and two sets of bytes on disk.
    expect(await countDocuments(filename)).toBe(1);
  });

  it('registers a webhook once when the create is retried, secret and all', async () => {
    const key = freshKey();
    const before = (
      await app.inject({ method: 'GET', url: '/api/partner/v1/webhooks', headers: keyHeader() })
    ).json().webhooks.length as number;

    const first = await registerWebhook(key);
    expect(first.statusCode).toBe(201);
    const second = await registerWebhook(key);
    expect(second.statusCode).toBe(201);
    expect(second.headers['x-idempotent-replay']).toBe('true');

    const after = (
      await app.inject({ method: 'GET', url: '/api/partner/v1/webhooks', headers: keyHeader() })
    ).json().webhooks.length as number;
    expect(after).toBe(before + 1);
    // The one response on this API that cannot be asked for again: a create
    // whose reply was lost leaves an endpoint whose signing secret the partner
    // never saw. The replay is how they get it.
    expect(second.json().webhook.secret).toBe(first.json().webhook.secret);
    expect(second.json().webhook.secret).toMatch(/^n409_whsec_/);
  });

  it('does not hold the key when a replay is refused for a bad delivery id', async () => {
    const created = await registerWebhook();
    const webhookId = created.json().webhook.id as string;
    const key = freshKey();
    const missing = '01JQZZZZZZZZZZZZZZZZZZZZZZ';

    const bad = await app.inject({
      method: 'POST',
      url: `/api/partner/v1/webhooks/${webhookId}/deliveries/${missing}/retry`,
      headers: keyHeader(key),
    });
    expect(bad.statusCode).toBe(404);

    // The refusal happens before the claim, so the same key is still usable —
    // otherwise a mistyped id would read as "your first attempt is still in
    // flight" for the whole five-minute takeover window.
    const ping = await app.inject({
      method: 'POST',
      url: `/api/partner/v1/webhooks/${webhookId}/test`,
      headers: keyHeader(key),
    });
    expect(ping.statusCode).toBe(200);
  });

  // ── The documentation says all of this ────────────────────────────────────

  it('declares Idempotency-Key on every mutation that honours one, and on no other', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/api/partner/v1/openapi.json' })).json() as Record<
      string,
      Record<string, { parameters?: { name: string; in: string }[] }>
    >;

    const idempotent = new Set<string>();
    for (const [path, operations] of Object.entries(spec.paths as never as Record<string, never>)) {
      for (const [method, operation] of Object.entries(
        operations as Record<string, { parameters?: { name: string; in: string }[] }>,
      )) {
        const declared = (operation.parameters ?? []).some(
          (p) => p.in === 'header' && p.name.toLowerCase() === 'idempotency-key',
        );
        if (declared) idempotent.add(`${method.toUpperCase()} ${path}`);
      }
    }

    // Every POST that writes something, and nothing else. A GET in this set
    // would be a documentation bug; a missing POST is a mutation a client
    // cannot make safely retryable.
    // `PUT /valuations/{id}` is deliberately absent. A PUT that writes the
    // fields it is given is already safe to repeat — the second one computes
    // the same row and `patchValuation` returns early when nothing changed —
    // so a key would buy it nothing and claim a row per correction.
    expect([...idempotent].sort()).toEqual([
      'POST /valuations',
      'POST /valuations/{id}/documents',
      'POST /valuations/{id}/submit',
      'POST /webhooks',
      'POST /webhooks/{id}/deliveries/{deliveryId}/retry',
      'POST /webhooks/{id}/test',
    ]);

    // And each of them declares the header that tells a client its 201 came
    // from the store rather than from a second execution.
    for (const operation of idempotent) {
      const [method, path] = operation.split(' ') as [string, string];
      const responses = (
        spec.paths as never as Record<string, Record<string, { responses: Record<string, unknown> }>>
      )[path]![method.toLowerCase()]!.responses;
      const success = (responses['200'] ?? responses['201']) as { headers: Record<string, unknown> };
      expect(Object.keys(success.headers)).toContain('x-idempotent-replay');
    }
  });

  it('keeps the ten-webhook 409 in the spec alongside the idempotency one', async () => {
    const spec = (
      await app.inject({ method: 'GET', url: '/api/partner/v1/openapi.json' })
    ).json() as never as {
      paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>>;
    };
    const conflict = spec.paths['/webhooks']!.post!.responses['409']!.description;
    // The route sends a 409 for two unrelated reasons and a spec that named
    // only one would send a client looking for a cause that is not theirs.
    expect(conflict).toMatch(/ten-webhook ceiling/);
    expect(conflict).toMatch(/Idempotency-Key/);
  });
});
