import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

const CSV = [
  'class,type,shares,price,invested,liquidation_multiple,seniority,conversion_ratio',
  'Common,common,8000000,,,,,',
  'Series Seed,preferred,2000000,1.00,2000000,1,1,1',
  'Series A,preferred,3000000,3.00,9000000,1,2,1',
  'Option Pool,option,1000000,,,,,',
].join('\n');

/** The cap table drawn as a graph — conversion and seniority as edges. */
describe.skipIf(!dbUp)('cap table graph API', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let outsider: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const graph = async (token: string, id = valuationId) =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/cap-table/graph`,
      headers: authHeader(token),
    });

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
    outsider = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Graph Co' },
    });
    valuationId = created.json().valuation.id;
  });
  afterAll(async () => ctx?.teardown());

  it('404s before a cap table has been imported', async () => {
    const res = await graph(admin.token);
    expect(res.statusCode).toBe(404);
  });

  describe('once imported', () => {
    beforeAll(async () => {
      const imported = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${valuationId}/cap-table`,
        headers: authHeader(admin.token),
        payload: { format: 'generic', csv: CSV },
      });
      expect(imported.statusCode, imported.body).toBeLessThan(300);

      const round = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/rounds`,
        headers: authHeader(admin.token),
        payload: { name: 'Series A', closed_on: '2025-03-04', shares_issued: 3_000_000 },
      });
      expect(round.statusCode, round.body).toBe(201);
    });

    it('draws the stack in payment order with common behind it', async () => {
      const res = await graph(admin.token);
      expect(res.statusCode).toBe(200);
      const { nodes, edges } = res.json().graph as {
        nodes: Array<{
          id: string;
          label: string;
          rank: number;
          class_type: string | null;
          ownership: number | null;
        }>;
        edges: Array<{ from: string; to: string; kind: string }>;
      };

      const byLabel = Object.fromEntries(nodes.map((n) => [n.label, n]));
      expect(byLabel['Series A']!.rank).toBeLessThan(byLabel['Series Seed']!.rank);
      expect(byLabel.Common!.rank).toBeGreaterThan(byLabel['Series Seed']!.rank);
      expect(byLabel['Option Pool']!.rank).toBe(byLabel.Common!.rank);

      expect(edges.filter((e) => e.kind === 'senior_to')).toHaveLength(1);
      expect(edges.filter((e) => e.kind === 'converts_to')).toHaveLength(3);
    });

    it('carries fully-diluted ownership onto every node', async () => {
      const { nodes } = (await graph(admin.token)).json().graph;
      const common = nodes.find((n: { label: string }) => n.label === 'Common');
      expect(common.ownership).toBeCloseTo(8 / 14, 6);
    });

    it('hangs a funding round off the company without inventing a class link', async () => {
      const { nodes, edges } = (await graph(admin.token)).json().graph;
      const round = nodes.find((n: { kind: string }) => n.kind === 'funding_round');
      expect(round.label).toContain('Series A (2025-03-04)');
      expect(edges.filter((e: { from: string }) => e.from === round.id)).toHaveLength(1);
    });

    it('shows the owner their own cap table', async () => {
      // A rearrangement of data they can already see on the table itself, not
      // a new disclosure.
      expect((await graph(owner.token)).statusCode).toBe(200);
    });

    it('404s for someone who cannot see the engagement', async () => {
      expect((await graph(outsider.token)).statusCode).toBe(404);
    });
  });
});
