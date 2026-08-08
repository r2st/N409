import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The Partner API's two remaining promises, neither of which the main suite
 * pins: that *every* route scoped by `{id}` answers 404 for another firm's
 * valuation rather than serving it, and that the paging contract holds.
 *
 * The scoping one is worth a sweep rather than a case, because `loadScoped` is
 * a helper each handler has to remember to call. A new route that reads
 * `req.params.id` and goes straight to a repo is not a compile error and not a
 * test failure anywhere else — it is one partner reading another's cap table.
 */
describe.skipIf(!dbUp)('partner API scoping and paging', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let partnerId: string;
  let rivalPartnerId: string;
  let apiKey: string;
  let rivalKey: string;
  let ownValuationId: string;
  let rivalValuationId: string;

  const keyHeader = (key: string) => ({ authorization: `Bearer ${key}` });

  const mintKey = async (forPartnerId: string, name: string): Promise<string> => {
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId: forPartnerId });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${forPartnerId}/tokens`,
      headers: authHeader(admin.token),
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().secret as string;
  };

  const createValuation = async (key: string, companyName: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers: keyHeader(key),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  beforeAll(async () => {
    const docsDir = await mkdtemp(path.join(tmpdir(), 'n409-partner-scope-'));
    ctx = await setupTestApp(
      { DOCUMENTS_DIR: docsDir },
      { partnerApiLimiter: new FixedWindowRateLimiter(1000, 60_000) },
    );
    app = ctx.app;
    partnerId = await seedPartner(ctx, 'Scoping Advisors');
    rivalPartnerId = await seedPartner(ctx, 'Scoping Rivals');
    apiKey = await mintKey(partnerId, 'scope-own');
    rivalKey = await mintKey(rivalPartnerId, 'scope-rival');

    ownValuationId = await createValuation(apiKey, 'Own Co');
    rivalValuationId = await createValuation(rivalKey, 'Rival Co');
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('404s every id-scoped route for another firm’s valuation', async () => {
    // Not 403: whether that id exists at all is not something to disclose to a
    // firm with no claim on it.
    const reads: Array<[string, string]> = [
      ['GET', `/api/partner/v1/valuations/${rivalValuationId}`],
      ['GET', `/api/partner/v1/valuations/${rivalValuationId}/results`],
      ['GET', `/api/partner/v1/valuations/${rivalValuationId}/report.pdf`],
    ];
    for (const [method, url] of reads) {
      const res = await app.inject({ method: method as 'GET', url, headers: keyHeader(apiKey) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }

    const upload = await app.inject({
      method: 'POST',
      url: `/api/partner/v1/valuations/${rivalValuationId}/documents`,
      headers: keyHeader(apiKey),
      payload: { filename: 'x.pdf', content_base64: Buffer.from('%PDF-1.4 x').toString('base64') },
    });
    expect(upload.statusCode).toBe(404);

    // …and the owner still reaches its own, so the 404s above are scoping and
    // not the routes being broken.
    const own = await app.inject({
      method: 'GET',
      url: `/api/partner/v1/valuations/${ownValuationId}`,
      headers: keyHeader(apiKey),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().valuation.company_name).toBe('Own Co');
  });

  it('404s a malformed id without reaching the database', async () => {
    for (const id of ['not-a-ulid', '../../etc/passwd', '00000000000000000000000000']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/partner/v1/valuations/${encodeURIComponent(id)}`,
        headers: keyHeader(apiKey),
      });
      expect(res.statusCode, id).toBe(404);
    }
  });

  it('lists only the key’s own firm, paginated, with an honest total', async () => {
    for (let i = 0; i < 4; i += 1) await createValuation(apiKey, `Paged Co ${i}`);

    const first = await app.inject({
      method: 'GET',
      url: '/api/partner/v1/valuations?page=1&per_page=2',
      headers: keyHeader(apiKey),
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.valuations).toHaveLength(2);
    expect(firstBody.per_page).toBe(2);
    // 1 from beforeAll + 4 here. The total is the count of the whole filtered
    // set, not of the page — a client paging on it would otherwise stop early.
    expect(firstBody.total).toBe(5);

    const second = await app.inject({
      method: 'GET',
      url: '/api/partner/v1/valuations?page=2&per_page=2',
      headers: keyHeader(apiKey),
    });
    const secondIds = second.json().valuations.map((v: { id: string }) => v.id);
    const firstIds = firstBody.valuations.map((v: { id: string }) => v.id);
    expect(secondIds).toHaveLength(2);
    expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);

    // The rival's valuation is in the table and in none of these pages.
    const allIds = [...firstIds, ...secondIds];
    expect(allIds).not.toContain(rivalValuationId);

    const rivalList = await app.inject({
      method: 'GET',
      url: '/api/partner/v1/valuations',
      headers: keyHeader(rivalKey),
    });
    expect(rivalList.json().total).toBe(1);
    expect(rivalList.json().valuations[0].id).toBe(rivalValuationId);
  });

  it('refuses a page size beyond the cap rather than serving it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/partner/v1/valuations?per_page=5000',
      headers: keyHeader(apiKey),
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an unknown state filter instead of ignoring it', async () => {
    // Silently dropping the filter would hand back the whole book to a client
    // that asked for one slice of it.
    const res = await app.inject({
      method: 'GET',
      url: '/api/partner/v1/valuations?state=not_a_state',
      headers: keyHeader(apiKey),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a body that is not valid base64 rather than storing the truncation', async () => {
    // Buffer.from(.., 'base64') skips invalid characters silently, so without
    // the check a corrupted upload is stored as a shorter file whose sha256
    // matches nothing the client sent.
    const res = await app.inject({
      method: 'POST',
      url: `/api/partner/v1/valuations/${ownValuationId}/documents`,
      headers: keyHeader(apiKey),
      payload: { filename: 'notes.pdf', content_base64: 'not base64!!! @@@' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain('base64');
  });

  it('rejects a file whose bytes disagree with its name', async () => {
    // The extension says PDF; the bytes are a Windows executable.
    const res = await app.inject({
      method: 'POST',
      url: `/api/partner/v1/valuations/${ownValuationId}/documents`,
      headers: keyHeader(apiKey),
      payload: {
        filename: 'financials.pdf',
        content_base64: Buffer.from('MZ\x90\x00\x03\x00\x00\x00payload').toString('base64'),
      },
    });
    expect(res.statusCode).toBe(422);
  });

  describe('idempotency', () => {
    it('refuses an over-long Idempotency-Key instead of storing it', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/partner/v1/valuations',
        headers: { ...keyHeader(apiKey), 'idempotency-key': 'k'.repeat(201) },
        payload: { kind: '409a', company_name: 'Long Key Co' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain('200 characters');
    });

    it('does not replay a failure — the same key retries with a corrected body', async () => {
      const key = 'retry-after-fixing-the-body';
      const bad = await app.inject({
        method: 'POST',
        url: '/api/partner/v1/valuations',
        headers: { ...keyHeader(apiKey), 'idempotency-key': key },
        payload: { kind: 'not_a_kind', company_name: 'Fixup Co' },
      });
      expect(bad.statusCode).toBe(422);

      // Storing the 422 would pin this key to a validation error forever, and
      // the client's whole reason to retry is that it changed the body.
      const good = await app.inject({
        method: 'POST',
        url: '/api/partner/v1/valuations',
        headers: { ...keyHeader(apiKey), 'idempotency-key': key },
        payload: { kind: '409a', company_name: 'Fixup Co' },
      });
      expect(good.statusCode).toBe(201);
      expect(good.headers['x-idempotent-replay']).toBeUndefined();
    });

    it('scopes keys per firm, so two organizations cannot collide', async () => {
      const key = 'both-firms-use-this-key';
      const mine = await app.inject({
        method: 'POST',
        url: '/api/partner/v1/valuations',
        headers: { ...keyHeader(apiKey), 'idempotency-key': key },
        payload: { kind: '409a', company_name: 'Mine' },
      });
      const theirs = await app.inject({
        method: 'POST',
        url: '/api/partner/v1/valuations',
        headers: { ...keyHeader(rivalKey), 'idempotency-key': key },
        payload: { kind: '409a', company_name: 'Theirs' },
      });
      expect(mine.statusCode).toBe(201);
      expect(theirs.statusCode).toBe(201);
      // Not a replay of the first, and not a conflict on the differing body.
      expect(theirs.json().valuation.company_name).toBe('Theirs');
      expect(theirs.json().valuation.id).not.toBe(mine.json().valuation.id);
    });
  });
});
