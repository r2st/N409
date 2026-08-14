import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Editing one comparable, field by field, and what the screen writes when the
 * engine's candidate rows are thin.
 *
 * `comparables.test.ts` is thorough about the set — screening it, excluding
 * from it, refreshing it. What it does not do is patch each column on its own,
 * and the patch route is built entirely out of `'field' in body` tests: one
 * conditional per column, so a field left out of the body is left alone rather
 * than nulled. Those conditionals are most of what left the file at 78% branch
 * coverage.
 *
 * The distinction they encode is the provenance rule. Editing a *figure* by hand
 * makes the row an analyst's figure whatever it was before, while editing a
 * label or an inclusion decision does not — a row still reporting "observed
 * market data" after somebody typed over the EV would be the provenance columns
 * actively lying, which is worse than not having them.
 */
async function startEngineStub() {
  const stub = Fastify({ logger: false });
  let screenReply: Record<string, unknown> | null = null;
  stub.post('/engine/v1/comparables', async () => screenReply ?? { selected: [], screened_out: [] });
  stub.post('/engine/v1/market-feed', async () => ({
    source: 'fallback',
    warning: 'yfinance is not installed; returning the caller fallback',
  }));
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => stub.close(),
    setScreen: (next: Record<string, unknown> | null) => {
      screenReply = next;
    },
  };
}

describe.skipIf(!dbUp)('comparables — editing one row, and thin screen candidates', () => {
  let ctx: TestApp;
  let engine: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    engine = await startEngineStub();
    ctx = await setupTestApp({ ENGINE_URL: engine.url });
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'PatchCo' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;
  });

  afterAll(async () => {
    await ctx?.teardown();
    await engine?.close();
  });

  let seq = 0;
  const uniqueTicker = () => `T${(seq += 1).toString().padStart(3, '0')}`;

  const add = (payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comparables`,
      headers: authHeader(ops.token),
      payload,
    });

  const patch = (itemId: string, payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/comparables/${itemId}`,
      headers: authHeader(ops.token),
      payload,
    });

  const list = () =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/comparables`,
      headers: authHeader(ops.token),
    });

  async function seedRow(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const res = await add({
      ticker: uniqueTicker(),
      name: 'Alpha Analytics',
      sic: '7372',
      revenue_ltm: 100,
      revenue_ntm: 120,
      ebitda_ltm: 50,
      ebitda_ntm: 60,
      ev: 1_000,
      ...over,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().comparable as Record<string, unknown>;
  }

  // ── Field-by-field ────────────────────────────────────────────────────────
  describe('one field at a time', () => {
    it('changes only the column named, leaving every other one where it was', async () => {
      // Each column is its own `'field' in body` conditional. Patching one and
      // asserting the rest are unmoved is the only way those arms are told
      // apart from a route that rewrites the whole row every time.
      const fields: Array<[string, unknown]> = [
        ['name', 'Alpha Analytics Ltd'],
        ['sic', '7379'],
        ['revenue_ltm', 111],
        ['revenue_ntm', 222],
        ['ebitda_ltm', 33],
        ['ebitda_ntm', 44],
        ['ev', 5_555],
      ];
      for (const [field, value] of fields) {
        const before = await seedRow();
        const res = await patch(before.id as string, { [field]: value });
        expect(res.statusCode, field).toBe(200);
        const after = res.json().comparable as Record<string, unknown>;
        // The named column moved to what was asked for...
        expect(String(after[field]), field).toBe(String(value));
        // ...and every column the body did not name stayed where it was.
        for (const [other] of fields) {
          if (other === field) continue;
          expect(String(after[other]), `${field} disturbed ${other}`).toBe(String(before[other]));
        }
      }
    });

    it('clears a column when the patch names it as null', async () => {
      // `'field' in body ? body.field ?? null : {}` — naming a field as null is
      // an instruction to clear it, which is different from omitting it.
      const row = await seedRow();
      const res = await patch(row.id as string, {
        sic: null,
        revenue_ltm: null,
        revenue_ntm: null,
        ebitda_ltm: null,
        ebitda_ntm: null,
        ev: null,
      });
      expect(res.statusCode).toBe(200);
      const after = res.json().comparable as Record<string, unknown>;
      for (const field of ['sic', 'revenue_ltm', 'revenue_ntm', 'ebitda_ltm', 'ebitda_ntm', 'ev']) {
        expect(after[field], field).toBeNull();
      }
      // The name is untouched, because it was not in the body.
      expect(after.name).toBe('Alpha Analytics');
    });

    it('clears the ticker when named as null, and refuses a duplicate one', async () => {
      const first = await seedRow();
      const second = await seedRow();

      const collide = await patch(second.id as string, { ticker: first.ticker });
      expect(collide.statusCode).toBe(409);
      expect(collide.json().detail).toContain(String(first.ticker));

      // Re-sending a row's own ticker is not a collision — the guard excludes
      // the row being patched.
      const same = await patch(second.id as string, { ticker: second.ticker });
      expect(same.statusCode).toBe(200);

      const cleared = await patch(second.id as string, { ticker: null });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().comparable.ticker).toBeNull();
    });

    it('422s a field name it does not know, rather than ignoring it', async () => {
      // `.strict()` — a typo'd field is a 422 rather than a silent no-op that
      // leaves an analyst believing they edited a figure they did not.
      const row = await seedRow();
      for (const payload of [{ revenu_ltm: 5 }, { EV: 10 }, { included: 'yes' }]) {
        const res = await patch(row.id as string, payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(422);
      }
    });

    it('404s a malformed item id, and one belonging to another engagement', async () => {
      const res = await patch('not-a-ulid', { name: 'X' });
      expect(res.statusCode).toBe(404);

      const absent = await patch('01ARZ3NDEKTSV4RRFFQ69G5FAV', { name: 'X' });
      expect(absent.statusCode).toBe(404);
    });
  });

  // ── Provenance ────────────────────────────────────────────────────────────
  describe('what an edit does to provenance', () => {
    it('restamps the row as an analyst figure when a figure is edited', async () => {
      const row = await seedRow();
      for (const field of ['revenue_ltm', 'revenue_ntm', 'ebitda_ltm', 'ebitda_ntm', 'ev']) {
        const fresh = await seedRow();
        const res = await patch(fresh.id as string, { [field]: 999 });
        expect(res.statusCode, field).toBe(200);
        expect(res.json().comparable.figures_source, field).toBe('analyst');
        expect(res.json().comparable.figures_as_of, field).toBeTruthy();
      }
      expect(row).toBeTruthy();
    });

    it('leaves provenance alone when only judgement or labels move', async () => {
      // include/exclude and the labelling fields are judgement, not figures.
      // Restamping on those would make the provenance column mean "somebody
      // touched this row", which is not what it says.
      const row = await seedRow();
      const before = (await list()).json().comparables.find(
        (c: { id: string }) => c.id === row.id,
      ) as { figures_source: string; figures_as_of: string | null };

      for (const payload of [
        { name: 'Renamed Co' },
        { sic: '7371' },
        { included: false, exclude_reason: 'Different business model' },
        { included: true },
      ]) {
        const res = await patch(row.id as string, payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(200);
        expect(res.json().comparable.figures_source, JSON.stringify(payload)).toBe(
          before.figures_source,
        );
      }
    });
  });

  // ── Exclusion reasons ─────────────────────────────────────────────────────
  describe('excluding a comparable', () => {
    it('422s an exclusion with no reason, on create and on patch alike', async () => {
      const create = await add({ name: 'Reasonless', included: false });
      expect(create.statusCode).toBe(422);

      const row = await seedRow();
      const patched = await patch(row.id as string, { included: false });
      expect(patched.statusCode).toBe(422);
    });

    it('422s blanking the reason on a row that is already excluded', async () => {
      // Validated against the *resulting* inclusion rather than the requested
      // one, so this has to fail even though the patch does not mention
      // `included` at all.
      const row = await seedRow();
      expect(
        (await patch(row.id as string, { included: false, exclude_reason: 'Too large' })).statusCode,
      ).toBe(200);

      const blanked = await patch(row.id as string, { exclude_reason: '' });
      expect(blanked.statusCode).toBe(422);
    });

    it('clears the reason when the row is put back in', async () => {
      const row = await seedRow();
      await patch(row.id as string, { included: false, exclude_reason: 'Too large' });
      const back = await patch(row.id as string, { included: true });
      expect(back.statusCode).toBe(200);
      expect(back.json().comparable.exclude_reason).toBeNull();
    });
  });

  // ── Thin screen candidates ────────────────────────────────────────────────
  describe('what the screen writes for a thin candidate', () => {
    const screen = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/comparables/screen`,
        headers: authHeader(ops.token),
        payload: {},
      });

    beforeAll(async () => {
      // The screen needs at least one target attribute to screen on.
      await ctx.pool.query(
        `INSERT INTO overwrites (id, valuation_id, category, field_key, class, value, created_by)
         VALUES ($1, $2, 'company_info', 'industry_id', 'numeric', '7372'::jsonb, $3)
         ON CONFLICT (valuation_id, field_key) DO UPDATE SET value = EXCLUDED.value`,
        ['01ARZ3NDEKTSV4RRFFQ69G5FCA', valuationId, ops.id],
      );
    });

    it('names a candidate by its ticker, then by a placeholder, when it has no name', async () => {
      // A blank cell in a peer-set exhibit is worse than a placeholder: the
      // reader cannot tell whether the row is a company or a rendering fault.
      engine.setScreen({
        selected: [
          { ticker: 'BBB', revenue: 100, ebitda_margin: 0.4, market_cap: 900, score: 0.8 },
          { revenue: 50, market_cap: 400, score: 0.7 },
        ],
        screened_out: [],
      });
      const res = await screen();
      expect(res.statusCode, res.body).toBe(201);
      const names = (await list()).json().comparables.map((c: { name: string }) => c.name);
      expect(names).toContain('BBB');
      expect(names).toContain('Unnamed comparable');
    });

    it('stamps a snapshot candidate as snapshot and a live one as live', async () => {
      // The two are stamped differently and the difference reaches the exhibit,
      // so a fallback estimate must never be written as observed market data.
      engine.setScreen({
        selected: [
          {
            ticker: 'CCC',
            name: 'Live Co',
            revenue: 200,
            market_cap: 2_000,
            figures_source: 'live',
            figures_as_of: '2026-05-01T00:00:00Z',
          },
          { ticker: 'DDD', name: 'Snapshot Co', revenue: 100, market_cap: 1_000 },
        ],
        screened_out: [],
      });
      expect((await screen()).statusCode).toBe(201);
      const rows = (await list()).json().comparables as Array<{
        ticker: string;
        figures_source: string;
        figures_as_of: string | null;
      }>;
      const live = rows.find((r) => r.ticker === 'CCC')!;
      const snap = rows.find((r) => r.ticker === 'DDD')!;
      expect(live.figures_source).toBe('live');
      expect(String(live.figures_as_of)).toContain('2026-05-01');
      expect(snap.figures_source).toBe('snapshot');
    });

    it('falls back to the screen’s own clock when a live stamp is unusable', async () => {
      // A live figure is only live at the moment it was observed, so the
      // engine's stamp is the one that counts — but an unparseable stamp must
      // not become an Invalid Date in a dated column.
      engine.setScreen({
        selected: [
          {
            ticker: 'EEE',
            name: 'Bad Stamp Co',
            revenue: 100,
            market_cap: 1_000,
            figures_source: 'live',
            figures_as_of: 'not-a-date',
          },
        ],
        screened_out: [],
      });
      expect((await screen()).statusCode).toBe(201);
      const row = (await list()).json().comparables.find(
        (c: { ticker: string }) => c.ticker === 'EEE',
      ) as { figures_as_of: string };
      expect(Number.isNaN(new Date(row.figures_as_of).getTime())).toBe(false);
    });

    it('gives a screened-out row a reason even when the engine states none', async () => {
      engine.setScreen({
        selected: [],
        screened_out: [{ ticker: 'FFF', name: 'Rejected Co' }, { ticker: 'GGG' }],
      });
      expect((await screen()).statusCode).toBe(201);
      const rows = (await list()).json().comparables as Array<{
        ticker: string;
        included: boolean;
        exclude_reason: string | null;
      }>;
      const rejected = rows.find((r) => r.ticker === 'FFF')!;
      expect(rejected.included).toBe(false);
      expect(rejected.exclude_reason).toMatch(/score threshold/);
    });

    it('computes EBITDA from the margin, and falls back to market cap for EV', async () => {
      engine.setScreen({
        selected: [
          { ticker: 'HHH', name: 'Margin Co', revenue: 200, ebitda_margin: 0.25, market_cap: 3_000 },
          { ticker: 'III', name: 'No Margin Co', revenue: 200, enterprise_value: 4_000 },
        ],
        screened_out: [],
      });
      expect((await screen()).statusCode).toBe(201);
      const rows = (await list()).json().comparables as Array<{
        ticker: string;
        ebitda_ltm: string | null;
        ev: string | null;
      }>;
      const withMargin = rows.find((r) => r.ticker === 'HHH')!;
      expect(Number(withMargin.ebitda_ltm)).toBe(50);
      // No enterprise value stated, so market cap stands in.
      expect(Number(withMargin.ev)).toBe(3_000);

      const noMargin = rows.find((r) => r.ticker === 'III')!;
      expect(noMargin.ebitda_ltm).toBeNull();
      expect(Number(noMargin.ev)).toBe(4_000);
    });
  });
});
