import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

const CSV = [
  'class,shares,price,invested',
  'Common Stock,8000000,0.10,',
  '"Series A Preferred",2000000,1.00,2000000',
  'Option Pool,1000000,,',
].join('\n');

describe.skipIf(!dbUp)('feature 9 — cap-table integration', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let otherClient: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    app = ctx.app;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    otherClient = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'CapCo' },
    });
    valuationId = created.json().valuation.id;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('exposes format presets', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/cap-table/formats',
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().formats.map((f: any) => f.key)).toEqual(['carta', 'pulley', 'generic']);
  });

  it('previews an import without persisting', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/cap-table/preview`,
      headers: authHeader(client.token),
      payload: { format: 'generic', csv: CSV },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toHaveLength(3);
    expect(res.json().validation.valid).toBe(true);
    expect(res.json().validation.summary.fully_diluted_shares).toBe(11_000_000);

    // Not persisted.
    const stored = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/cap-table`,
      headers: authHeader(client.token),
    });
    expect(stored.json().cap_table).toBeNull();
  });

  it('imports and persists a valid cap table (client)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/cap-table`,
      headers: authHeader(client.token),
      payload: { format: 'generic', csv: CSV },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cap_table.entries).toHaveLength(3);
    expect(res.json().cap_table.validation.valid).toBe(true);

    const stored = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/cap-table`,
      headers: authHeader(ops.token),
    });
    expect(stored.json().cap_table.source_format).toBe('generic');
  });

  it('rejects an import with validation errors', async () => {
    const bad = 'class,shares\nCommon,-100\n';
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/cap-table`,
      headers: authHeader(client.token),
      payload: { format: 'generic', csv: bad },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().validation.issues.some((i: any) => i.code === 'bad_shares')).toBe(true);
  });

  it('accepts pre-parsed rows with a custom column mapping', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/cap-table/preview`,
      headers: authHeader(client.token),
      payload: {
        format: 'generic',
        rows: [{ Name: 'Common', Qty: '5000' }],
        mapping: { security_class: 'Name', shares: 'Qty' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries[0]).toMatchObject({ security_class: 'Common', shares: 5000 });
  });

  it('projects waterfall inputs (ops only)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/cap-table/waterfall-inputs`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().inputs.common_shares).toBe(8_000_000);
    expect(res.json().inputs.option_pool_shares).toBe(1_000_000);
    expect(res.json().inputs.preferred).toHaveLength(1);

    // Clients can't reach the engine projection.
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/cap-table/waterfall-inputs`,
      headers: authHeader(client.token),
    });
    expect(denied.statusCode).toBe(403);
  });

  it('hides the cap table from an unrelated client', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/cap-table`,
      headers: authHeader(otherClient.token),
    });
    expect(res.statusCode).toBe(404);
  });
});
