import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';
import {
  PARTNER_API_ENDPOINTS,
  PARTNER_API_PREFIX,
  PARTNER_API_SCHEMAS,
} from '../../src/routes/partnerApi.js';
import { schemaKey } from '../../src/domain/openapi.js';
import { SELF_DESCRIBING_PATHS } from '../../src/domain/partnerApiContract.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The partner API's published response shapes, checked against what it actually
 * sends.
 *
 * `openapi.json` declares a response schema per operation, and unlike the
 * request half there is no validator behind it — a response is built, not
 * parsed, so nothing in the request path can enforce it. Left alone it would be
 * a hand-written description of the payload sitting next to the code that
 * builds the payload, i.e. the standard way for an API reference to drift until
 * a partner writes to it and gets a field that is not there.
 *
 * So the schemas are exercised here: every endpoint is driven for real and its
 * body parsed through the schema the spec publishes. The schemas are `.strict()`,
 * which makes the failure fire in the useful direction — adding a field to a
 * projection without documenting it fails this file rather than shipping a spec
 * that under-reports the payload.
 */
/**
 * As much of an OpenAPI document as these tests walk.
 *
 * The alternative — reading the parsed JSON through `any` — is what let the
 * assertions below drift: `schema.properties.valuations.items.properties.state`
 * type-checks against `any` whether or not the spec has any of those levels,
 * and when the spec stops publishing one the test fails with "cannot read
 * properties of undefined" and no indication of which level went missing.
 */
interface SchemaNode {
  type?: string;
  enum?: unknown[];
  minimum?: number;
  additionalProperties?: unknown;
  properties?: Record<string, SchemaNode | undefined>;
  items?: SchemaNode;
}

interface MediaType {
  schema: SchemaNode;
}

interface Operation {
  requestBody?: { content: Record<string, MediaType | undefined> };
  responses: Record<string, { content: Record<string, MediaType | undefined> } | undefined>;
}

interface OpenApiDoc {
  paths: Record<string, Record<string, Operation | undefined> | undefined>;
}

const JSON_CT = 'application/json';

function operation(doc: OpenApiDoc, path: string, method: string): Operation {
  const op = doc.paths[path]?.[method];
  if (!op) throw new Error(`openapi.json publishes no ${method.toUpperCase()} ${path}`);
  return op;
}

/** The JSON response schema for one status, or a failure naming what is missing. */
function responseSchema(doc: OpenApiDoc, path: string, method: string, status: string): SchemaNode {
  const schema = operation(doc, path, method).responses[status]?.content[JSON_CT]?.schema;
  if (!schema) throw new Error(`no ${status} JSON response schema for ${method.toUpperCase()} ${path}`);
  return schema;
}

function requestSchema(doc: OpenApiDoc, path: string, method: string): SchemaNode {
  const schema = operation(doc, path, method).requestBody?.content[JSON_CT]?.schema;
  if (!schema) throw new Error(`no JSON request schema for ${method.toUpperCase()} ${path}`);
  return schema;
}

/** A named property, or a failure saying which one the spec stopped publishing. */
function at(node: SchemaNode, key: string): SchemaNode {
  const child = node.properties?.[key];
  if (!child) throw new Error(`the schema publishes no "${key}" property`);
  return child;
}

/** The element schema of an array property. */
function item(node: SchemaNode, label: string): SchemaNode {
  if (!node.items) throw new Error(`"${label}" is published without an item schema`);
  return node.items;
}

describe.skipIf(!dbUp)('partner API response contract', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let apiKey: string;
  let receiver: FastifyInstance;
  let receiverUrl: string;
  /** Flipped per test to make the receiver fail, so a delivery reaches 'failed'. */
  let receiverStatus = 200;

  const keyHeader = () => ({ authorization: `Bearer ${apiKey}` });

  /** Parse a response body through its published schema, reporting readably. */
  const conforms = <T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        `response does not match its published schema:\n${JSON.stringify(parsed.error.issues, null, 2)}\n` +
          `body was:\n${JSON.stringify(body, null, 2)}`,
      );
    }
    return parsed.data;
  };

  beforeAll(async () => {
    // The receiver is on 127.0.0.1, which the SSRF guard refuses by default.
    ctx = await setupTestApp(
      { WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true' },
      { partnerApiLimiter: new FixedWindowRateLimiter(1000, 60_000) },
    );
    app = ctx.app;
    const partnerId = await seedPartner(ctx, 'Contract Partners');
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId });
    const minted = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${partnerId}/tokens`,
      headers: authHeader(admin.token),
      payload: { name: 'contract' },
    });
    expect(minted.statusCode).toBe(201);
    apiKey = minted.json().secret as string;

    receiver = Fastify({ logger: false });
    receiver.post('/hook', async (_req, reply) => reply.status(receiverStatus).send({ ok: true }));
    await receiver.listen({ port: 0, host: '127.0.0.1' });
    const address = receiver.server.address();
    if (typeof address === 'object' && address) receiverUrl = `http://127.0.0.1:${address.port}/hook`;
  }, 60_000);

  afterAll(async () => {
    await receiver?.close();
    await ctx?.teardown();
  });

  /**
   * The coverage guard. Everything below exercises the endpoints that exist
   * today; this is what fails when someone adds a fourteenth and forgets.
   *
   * Without it the contract is only as complete as the list of tests someone
   * remembered to write, which is the failure mode the whole registry was built
   * to avoid — a new endpoint would ship with `schema: { type: 'object' }` and
   * nothing would say so.
   */
  it('publishes a response schema for every JSON endpoint', () => {
    const undocumented = PARTNER_API_ENDPOINTS.filter(
      (e) => !e.path.endsWith('.pdf') && !SELF_DESCRIBING_PATHS.includes(e.path),
    )
      .filter((e) => !PARTNER_API_SCHEMAS.get(schemaKey(e.method, e.path))?.response)
      .map((e) => `${e.method} ${e.path}`);
    expect(undocumented).toEqual([]);
  });

  it('renders those schemas into openapi.json rather than a bare object', async () => {
    const res = await app.inject({ method: 'GET', url: `${PARTNER_API_PREFIX}/openapi.json` });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as OpenApiDoc;

    const schema = responseSchema(doc, '/valuations', 'get', '200');
    expect(schema.properties?.total).toEqual({ type: 'integer', minimum: 0 });
    const valuations = at(schema, 'valuations');
    expect(valuations.type).toBe('array');
    expect(item(valuations, 'valuations').properties?.state?.enum).toContain('published');
    // A decimal column is a string on the wire; a spec that says `number` is
    // how a client silently rounds a valuation.
    expect(item(valuations, 'valuations').properties?.number?.type).toBe('string');

    // Responses must stay additive-safe: closing them would break every
    // strictly-generated client the day a field is added.
    const walk = (node: SchemaNode): void => {
      expect(node.additionalProperties).toBeUndefined();
      for (const child of Object.values(node.properties ?? {})) walk(child);
      if (node.items) walk(node.items);
    };
    walk(schema);

    // The request half is still closed — that direction catches a caller's typo.
    expect(responseSchema(doc, '/valuations', 'post', '201').properties?.valuation).toBeDefined();
    expect(requestSchema(doc, '/valuations', 'post').additionalProperties).toBe(false);
  });

  it('matches the published schema on the valuation lifecycle endpoints', async () => {
    const contract = await import('../../src/domain/partnerApiContract.js');

    const created = await app.inject({
      method: 'POST',
      url: `${PARTNER_API_PREFIX}/valuations`,
      headers: keyHeader(),
      payload: { kind: '409a', company_name: 'Contract Co', currency: 'USD' },
    });
    expect(created.statusCode).toBe(201);
    const { valuation } = conforms(contract.CreateValuationResponse, created.json());

    const fetched = await app.inject({
      method: 'GET',
      url: `${PARTNER_API_PREFIX}/valuations/${valuation.id}`,
      headers: keyHeader(),
    });
    expect(fetched.statusCode).toBe(200);
    conforms(contract.GetValuationResponse, fetched.json());

    const listed = await app.inject({
      method: 'GET',
      url: `${PARTNER_API_PREFIX}/valuations?per_page=10`,
      headers: keyHeader(),
    });
    expect(listed.statusCode).toBe(200);
    const list = conforms(contract.ListValuationsResponse, listed.json());
    expect(list.valuations.some((v) => v.id === valuation.id)).toBe(true);

    const uploaded = await app.inject({
      method: 'POST',
      url: `${PARTNER_API_PREFIX}/valuations/${valuation.id}/documents`,
      headers: keyHeader(),
      payload: {
        filename: 'cap-table.csv',
        kind: 'other',
        content_type: 'text/csv',
        content_base64: Buffer.from('class,shares\nCommon,100\n').toString('base64'),
      },
    });
    expect(uploaded.statusCode).toBe(201);
    conforms(contract.UploadDocumentResponse, uploaded.json());

    const results = await app.inject({
      method: 'GET',
      url: `${PARTNER_API_PREFIX}/valuations/${valuation.id}/results`,
      headers: keyHeader(),
    });
    expect(results.statusCode).toBe(200);
    const parsed = conforms(contract.ResultsResponse, results.json());
    // No calculation has run and no draft has been shared: both nulls are the
    // documented state, not an absence the schema had to be loosened for.
    expect(parsed.calculation).toBeNull();
    expect(parsed.report).toEqual({ available: false, version: null });
    expect(parsed.documents).toHaveLength(1);
  });

  it('matches the published schema on the webhook endpoints', async () => {
    const contract = await import('../../src/domain/partnerApiContract.js');

    const registered = await app.inject({
      method: 'POST',
      url: `${PARTNER_API_PREFIX}/webhooks`,
      headers: keyHeader(),
      payload: { url: receiverUrl, events: ['valuation.state_changed'] },
    });
    expect(registered.statusCode).toBe(201);
    const { webhook } = conforms(contract.CreateWebhookResponse, registered.json());
    // The secret travels exactly once, and the schema has to permit that
    // without permitting it everywhere.
    expect(webhook.secret).toMatch(/^n409_whsec_/);

    const listed = await app.inject({
      method: 'GET',
      url: `${PARTNER_API_PREFIX}/webhooks`,
      headers: keyHeader(),
    });
    expect(listed.statusCode).toBe(200);
    const list = conforms(contract.ListWebhooksResponse, listed.json());
    expect(list.webhooks.find((w) => w.id === webhook.id)?.secret).toBeUndefined();

    const pinged = await app.inject({
      method: 'POST',
      url: `${PARTNER_API_PREFIX}/webhooks/${webhook.id}/test`,
      headers: keyHeader(),
    });
    expect(pinged.statusCode).toBe(200);
    expect(conforms(contract.TestWebhookResponse, pinged.json()).delivered).toBe(true);

    const deliveries = await app.inject({
      method: 'GET',
      url: `${PARTNER_API_PREFIX}/webhooks/${webhook.id}/deliveries`,
      headers: keyHeader(),
    });
    expect(deliveries.statusCode).toBe(200);
    const log = conforms(contract.ListDeliveriesResponse, deliveries.json());
    expect(log.deliveries).toHaveLength(1);
    expect(log.deliveries[0]!.status).toBe('delivered');

    const removed = await app.inject({
      method: 'DELETE',
      url: `${PARTNER_API_PREFIX}/webhooks/${webhook.id}`,
      headers: keyHeader(),
    });
    expect(removed.statusCode).toBe(200);
    conforms(contract.DeleteWebhookResponse, removed.json());
  });

  it('matches the published schema when a delivery is replayed', async () => {
    const contract = await import('../../src/domain/partnerApiContract.js');

    const registered = await app.inject({
      method: 'POST',
      url: `${PARTNER_API_PREFIX}/webhooks`,
      headers: keyHeader(),
      payload: { url: receiverUrl },
    });
    const webhookId = registered.json().webhook.id as string;

    // 404 is permanent, so the ping settles straight to 'failed' and is
    // replayable — which is the only state the retry endpoint accepts.
    receiverStatus = 404;
    await app.inject({
      method: 'POST',
      url: `${PARTNER_API_PREFIX}/webhooks/${webhookId}/test`,
      headers: keyHeader(),
    });
    receiverStatus = 200;

    const deliveries = await app.inject({
      method: 'GET',
      url: `${PARTNER_API_PREFIX}/webhooks/${webhookId}/deliveries`,
      headers: keyHeader(),
    });
    const log = conforms(contract.ListDeliveriesResponse, deliveries.json());
    const failed = log.deliveries.find((d) => d.status === 'failed');
    expect(failed).toBeDefined();
    // A settled row reports no next attempt — the field is only meaningful
    // while one is still owed.
    expect(failed!.next_attempt_at).toBeNull();
    expect(failed!.last_error).toContain('404');

    const replayed = await app.inject({
      method: 'POST',
      url: `${PARTNER_API_PREFIX}/webhooks/${webhookId}/deliveries/${failed!.id}/retry`,
      headers: keyHeader(),
    });
    expect(replayed.statusCode).toBe(200);
    const { delivery } = conforms(contract.RetryDeliveryResponse, replayed.json());
    expect(delivery.status).toBe('pending');
    expect(delivery.next_attempt_at).not.toBeNull();
  });
});
