import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findParams } from '../../src/repos/params.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Two analysts editing one engagement's financial model at the same time.
 *
 * The panel behind `PATCH /valuations/:id/engine-inputs` posts the *whole*
 * model on every save — income, market and asset together, whether or not the
 * analyst opened all three — and the route merges it with `engine_inputs ||
 * $2::jsonb`, which replaces a top-level block outright. So the second saver
 * does not merely win a field: they restore their own stale copy of every block
 * they did not touch, silently reverting the other analyst (migration 0158).
 *
 * The route is operations-only, which in this product means the analyst
 * preparing the model, the reviewer working the queue and ops — the three roles
 * that share an engagement, which is what makes this an ordinary Tuesday rather
 * than a thought experiment.
 *
 * The race is expressed by handing two writers the same loaded version rather
 * than by racing two requests: the interleaving that matters is "both read
 * before either wrote", and two sequential saves from one snapshot reproduce it
 * every time, which is exactly what those two tabs amount to.
 */
describe.skipIf(!dbUp)('financial model under concurrent edits', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let other: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    other = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  async function newValuation(): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'Acme Robotics, Inc.' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  }

  const read = (id: string, token: string) =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/engine-inputs`,
      headers: authHeader(token),
    });

  const save = (id: string, token: string, payload: Record<string, unknown>, version?: number) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}/engine-inputs`,
      headers: {
        ...authHeader(token),
        ...(version === undefined ? {} : { 'if-match': `"${version}"` }),
      },
      payload,
    });

  const INCOME = { income: { discount_rate: 0.2, terminal_growth: 0.03 } };
  const MARKET = { market: { metric: 1_000_000, multiples: [4, 5] } };

  it('reports the params version on GET, as both an ETag and a body field', async () => {
    const id = await newValuation();
    const res = await read(id, ops.token);
    expect(res.statusCode).toBe(200);

    const version = res.json().version as number;
    expect(Number.isInteger(version)).toBe(true);
    expect(res.headers.etag).toBe(`"${version}"`);
  });

  it('moves the version on every save, so a second reader can tell', async () => {
    const id = await newValuation();
    const before = (await read(id, ops.token)).json().version as number;

    const res = await save(id, ops.token, INCOME, before);
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe(`"${before + 1}"`);
    expect((await read(id, ops.token)).json().version).toBe(before + 1);
  });

  /** The bug, as it happened. */
  it('refuses the second analyst rather than reverting the first', async () => {
    const id = await newValuation();
    const shared = (await read(id, ops.token)).json().version as number;

    // Analyst A edits the income block against the version both of them loaded.
    expect((await save(id, ops.token, { ...INCOME, ...MARKET }, shared)).statusCode).toBe(200);

    // Analyst B saves the market block from that same load. Their body carries
    // their stale income block too — this is the write that used to land.
    const loser = await save(
      id,
      other.token,
      { income: { discount_rate: null, terminal_growth: null }, market: { metric: 2_000_000, multiples: [9] } },
      shared,
    );
    expect(loser.statusCode).toBe(409);
    // Both versions are named so the panel can tell a concurrent save from its
    // own retry without another round trip.
    expect(loser.json().detail).toContain(String(shared));

    // A's income block is intact — the whole point.
    const stored = (await findParams(ctx.pool, id))!;
    const inputs = stored.engine_inputs as { income: { discount_rate: number } };
    expect(inputs.income.discount_rate).toBe(0.2);
  });

  /**
   * The other writer of this row. A `PATCH /params` that left the version alone
   * would be invisible here: the engine-inputs editor would hold a version the
   * row still reported, and its stale blocks would land on top of the
   * methodology change.
   */
  it('sees a methodology save on the sibling route as a conflict', async () => {
    const id = await newValuation();
    const shared = (await read(id, ops.token)).json().version as number;

    const params = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}/params`,
      headers: authHeader(ops.token),
      payload: { allocation_method: 'pwerm' },
    });
    expect(params.statusCode).toBe(200);

    expect((await save(id, other.token, INCOME, shared)).statusCode).toBe(409);
  });

  it('lets the same analyst save twice by taking the version the write returned', async () => {
    const id = await newValuation();
    const first = (await read(id, ops.token)).json().version as number;

    const one = await save(id, ops.token, INCOME, first);
    expect(one.statusCode).toBe(200);

    const next = one.json().params.version as number;
    expect((await save(id, ops.token, MARKET, next)).statusCode).toBe(200);
  });

  /**
   * A client with no opinion keeps the old behaviour rather than being broken
   * by the new column — the same contract PATCH /valuations/:id offers.
   */
  it('still accepts a save that sends no If-Match', async () => {
    const id = await newValuation();
    expect((await save(id, ops.token, INCOME)).statusCode).toBe(200);
  });

  /**
   * A header nobody parses is a lost-update guard that silently is not there,
   * so a malformed one is refused rather than ignored.
   */
  it('refuses a malformed If-Match instead of dropping it', async () => {
    const id = await newValuation();
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}/engine-inputs`,
      headers: { ...authHeader(ops.token), 'if-match': 'not-a-version' },
      payload: INCOME,
    });
    expect(res.statusCode).toBe(422);
  });
});
