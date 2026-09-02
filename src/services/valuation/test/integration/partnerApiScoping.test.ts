import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';
import { PARTNER_API_ENDPOINTS, PARTNER_API_PREFIX } from '../../src/routes/partnerApi.js';
import { recordDelivery } from '../../src/repos/partnerWebhooks.js';
import { MAX_DOCUMENT_BYTES } from '../../src/routes/documents.js';
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
 * The Partner API's two remaining promises, neither of which the main suite
 * pins: that *every* route scoped by `{id}` answers 404 for another firm's
 * row rather than serving it, and that the paging contract holds.
 *
 * The scoping one is worth a sweep rather than a case, because `loadScoped` and
 * `findWebhook` are helpers each handler has to remember to call. A new route
 * that reads `req.params.id` and goes straight to a repo is not a compile error
 * and not a test failure anywhere else — it is one partner reading another's
 * cap table.
 *
 * R157: the sweep used to be four hand-written lines under a docstring that
 * said "every". The API had grown to ten `{id}`-scoped operations by then — the
 * two valuation *writes* and all five webhook routes had never been asked the
 * question, and the list could not notice an eleventh. It is now driven off
 * `PARTNER_API_ENDPOINTS`, the same registry the routes are registered from, so
 * an operation added tomorrow is swept the day it is declared or fails here for
 * want of a fixture. A list of endpoints maintained by hand is maintained by
 * the same person who forgot the scope check.
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
  let rivalWebhookId: string;
  let rivalDeliveryId: string;

  const keyHeader = (key: string) => ({ authorization: `Bearer ${key}` });

  const mintKey = async (forPartnerId: string, name: string): Promise<string> => {
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId: forPartnerId });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${forPartnerId}/tokens`,
      headers: authHeader(admin.token),
      payload: { current_password: SEEDED_PASSWORD, name },
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

  /**
   * A webhook and one delivery under it.
   *
   * The delivery is inserted through the repo rather than produced by
   * `POST /webhooks/{id}/test`, which would attempt a real HTTP request. What
   * the sweep needs from it is an id another firm can name, and the row is the
   * same row either way.
   */
  const createWebhookWithDelivery = async (
    key: string,
    url: string,
  ): Promise<{ webhookId: string; deliveryId: string }> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/webhooks',
      headers: keyHeader(key),
      payload: { url, events: ['valuation.state_changed'] },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    const webhookId = res.json().webhook.id as string;
    const delivery = await recordDelivery(ctx.pool, {
      webhookId,
      eventType: 'valuation.state_changed',
      payload: { probe: true },
    });
    return { webhookId, deliveryId: delivery.id };
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

    const rivalHook = await createWebhookWithDelivery(rivalKey, 'https://rival-sink.invalid/hook');
    rivalWebhookId = rivalHook.webhookId;
    rivalDeliveryId = rivalHook.deliveryId;
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  /**
   * A body for each operation good enough to reach its handler.
   *
   * Keyed by `METHOD /path` from the registry, so an operation that gains a
   * required field and stops reaching its handler shows up as the own-side
   * probe failing rather than as a rival-side 404 nobody earned — that is the
   * R89 lesson, restated for this API: a one-sided probe is satisfied by a 422.
   */
  const PAYLOADS: Record<string, unknown> = {
    'PUT /valuations/{id}': { company_name: 'Renamed By Sweep' },
    'POST /valuations/{id}/submit': {},
    'POST /valuations/{id}/documents': {
      filename: 'cap-table.csv',
      kind: 'cap_table',
      content_type: 'text/csv',
      content_base64: Buffer.from('holder,shares\nFounder,1000\n').toString('base64'),
    },
    'POST /webhooks/{id}/deliveries/{deliveryId}/retry': {},
    'POST /webhooks/{id}/test': {},
  };

  /**
   * Operations whose own-side probe legitimately answers 404, and why.
   *
   * Same contract as `PUBLIC_ROUTES` and the privileged sweep's exemptions: an
   * entry has to say what makes the 404 correct, so a reviewer can check the
   * claim rather than trust the list. These are still swept on the rival side —
   * only the anti-vacuity probe skips them.
   */
  const OWN_SIDE_404_BY_DESIGN = new Map<string, string>([
    [
      'GET /valuations/{id}/report.pdf',
      'a freshly created engagement has no report yet, so 404 is the right answer for the owner too; ' +
        'partnerApi.test.ts drives this route against a published engagement',
    ],
  ]);

  /** Every `{…}`-scoped operation the partner API declares, from its registry. */
  const idScoped = () => PARTNER_API_ENDPOINTS.filter((e) => e.auth === 'api_key' && e.path.includes('{'));

  const fill = (endpointPath: string, ids: Record<string, string>): string =>
    PARTNER_API_PREFIX +
    endpointPath.replace(/\{(\w+)\}/g, (_, name: string) => {
      const value = ids[name];
      // A parameter the sweep has no fixture for is a coverage hole, not a
      // route to skip: without this, adding `{investorId}` to the registry
      // would quietly stop asking the scoping question for that operation.
      if (!value) throw new Error(`No fixture for {${name}} — add one to the scoping sweep`);
      return value;
    });

  it('404s every id-scoped partner operation for another firm’s row', async () => {
    const endpoints = idScoped();
    // Vacuity guard. "Nothing left over" is satisfied by having found nothing,
    // and the registry is populated as a side effect of building the app.
    expect(endpoints.length).toBeGreaterThanOrEqual(10);
    expect(endpoints.map((e) => `${e.method} ${e.path}`)).toEqual(
      expect.arrayContaining([
        'PUT /valuations/{id}',
        'POST /valuations/{id}/submit',
        'DELETE /webhooks/{id}',
        'POST /webhooks/{id}/deliveries/{deliveryId}/retry',
      ]),
    );

    // Not 403: whether that id exists at all is not something to disclose to a
    // firm with no claim on it.
    const rivalIds = {
      id: '',
      deliveryId: rivalDeliveryId,
    };
    const served: string[] = [];
    for (const endpoint of endpoints) {
      rivalIds.id = endpoint.path.startsWith('/webhooks/') ? rivalWebhookId : rivalValuationId;
      const url = fill(endpoint.path, rivalIds);
      const res = await app.inject({
        method: endpoint.method,
        url,
        headers: keyHeader(apiKey),
        payload: PAYLOADS[`${endpoint.method} ${endpoint.path}`] ?? {},
      });
      if (res.statusCode !== 404) {
        served.push(`${endpoint.method} ${endpoint.path} -> ${res.statusCode}`);
      }
    }
    expect(served).toEqual([]);
  }, 120_000);

  /**
   * The other half, without which the 404s above are worth nothing: the same
   * request aimed at the caller's *own* row must not 404. A route that is
   * simply broken, or a fixture that never existed, answers 404 for both firms
   * and passes the sweep above while asking no question at all.
   *
   * Own fixtures are minted per operation, because two of these are
   * destructive — `DELETE /webhooks/{id}` and `POST /valuations/{id}/submit`
   * both change what the next probe would find.
   *
   * And they are minted under a *third* firm, not under `apiKey`: the paging
   * case below counts firm A's whole book, and a sweep that grows with the
   * registry would silently rewrite that arithmetic every time an operation is
   * added. A probe that changes what another test measures is a probe that will
   * eventually be deleted for being flaky.
   */
  it('serves the caller’s own row on every one of them', async () => {
    const probeKey = await mintKey(await seedPartner(ctx, 'Scoping Probes'), 'scope-probe');
    const notFound: string[] = [];
    for (const endpoint of idScoped()) {
      if (OWN_SIDE_404_BY_DESIGN.has(`${endpoint.method} ${endpoint.path}`)) continue;
      const ids = endpoint.path.startsWith('/webhooks/')
        ? await (async () => {
            const hook = await createWebhookWithDelivery(probeKey, 'https://own-sink.invalid/hook');
            return { id: hook.webhookId, deliveryId: hook.deliveryId };
          })()
        : {
            id: await createValuation(probeKey, `Probe ${endpoint.method} ${endpoint.path}`),
            deliveryId: '',
          };

      const res = await app.inject({
        method: endpoint.method,
        url: fill(endpoint.path, ids),
        headers: keyHeader(probeKey),
        payload: PAYLOADS[`${endpoint.method} ${endpoint.path}`] ?? {},
      });
      if (res.statusCode === 404) {
        notFound.push(`${endpoint.method} ${endpoint.path} -> ${JSON.stringify(res.json()).slice(0, 120)}`);
      }
    }
    expect(notFound).toEqual([]);
  }, 180_000);

  it('serves the owner its own valuation by id', async () => {
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
    // R350: all three of this route's upload refusals name the file. Its reader
    // is a script partway through a batch, whose whole record of the failure is
    // one line in its own log.
    expect(res.json().detail).toContain('notes.pdf');
    expect(res.json().filename).toBe('notes.pdf');
  });

  it('names the file, its size and the cap when the upload is over the limit', async () => {
    // The one thing the session route's twin cannot say. `bufferUpload` is fed
    // a stream busboy cut at the limit, so the size that was refused is
    // unknowable there; here the body is decoded and in hand.
    const res = await app.inject({
      method: 'POST',
      url: `/api/partner/v1/valuations/${ownValuationId}/documents`,
      headers: keyHeader(apiKey),
      payload: {
        filename: 'huge.pdf',
        content_base64: Buffer.alloc(MAX_DOCUMENT_BYTES + 1024, 0x41).toString('base64'),
      },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.detail).toContain('huge.pdf');
    expect(body.detail).toContain('25 MB limit');
    expect(body.detail).toMatch(/none of it was stored/i);
    expect(body.size_bytes).toBe(MAX_DOCUMENT_BYTES + 1024);
    expect(body.limit_bytes).toBe(MAX_DOCUMENT_BYTES);
  });

  it('does not invite a retry of a file that decoded to nothing', async () => {
    // Zero bytes that arrived intact is a failed export, not a lost transfer,
    // and "Uploaded file is empty" said neither.
    const res = await app.inject({
      method: 'POST',
      url: `/api/partner/v1/valuations/${ownValuationId}/documents`,
      headers: keyHeader(apiKey),
      // `'='` is padding and nothing else — well-formed, and decodes to no
      // bytes. An empty string never reaches here; the schema's own min(1)
      // refuses it first, naming the field.
      payload: { filename: 'blank.pdf', content_base64: '=' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain('blank.pdf');
    expect(res.json().detail).toMatch(/will not help/i);
  });

  it('does not let an uploaded name reorder the sentence it is quoted in', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/partner/v1/valuations/${ownValuationId}/documents`,
      headers: keyHeader(apiKey),
      payload: { filename: 'memo\u202egnp.pdf', content_base64: 'not base64!!! @@@' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).not.toContain('\u202e');
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
