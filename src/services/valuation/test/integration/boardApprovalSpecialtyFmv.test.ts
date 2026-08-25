import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCalculation } from '../../src/repos/calculations.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Which per-share figure a board resolution is allowed to adopt.
 *
 * `POST /valuations/:id/board` defaults `fmv_conclusion` to the latest
 * succeeded calculation's `fmv_per_share`. That column is a 409A column by name
 * and every engine writes into it (`domain/specialty.ts`), so the default was
 * only ever right for a 409A run.
 *
 * The document it produces is a §409A safe-harbor adoption verbatim: it cites
 * Treasury Regulation §1.409A-1(b)(5)(iv)(B) and authorises the officers to
 * grant awards "with an exercise price no less than the fair market value
 * adopted herein". `routes/grants.ts` then snapshots that figure as the
 * exercise price of every option issued against the resolution.
 *
 * On an EMI or CSOP run the figure sitting in that column is the **AMV** — the
 * restricted value, below the unrestricted market value by the whole
 * restriction discount. So the board adopted a below-FMV price and the options
 * were struck at it: precisely the §409A failure the resolution exists to
 * prevent, reached without a single visible symptom. The number is positive,
 * the document renders, and nothing on the page distinguishes two per-share
 * values that differ by a discount.
 */
describe.skipIf(!dbUp)('board resolution — the FMV a specialty run may not supply', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  /**
   * An engagement whose newest succeeded calculation was written by a specialty
   * engine — the `{ kind, specialty }` results shape `routes/specialty.ts`
   * persists, with the headline in the typed columns.
   */
  async function engagementWithSpecialtyRun(
    kind: string,
    company: string,
    headline: { equityValue: number | null; fmvPerShare: number | null },
    specialty: Record<string, unknown>,
  ): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind, company_name: company },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().valuation.id as string;

    await createCalculation(
      ctx.pool,
      {
        valuationId: id,
        engineVersion: 'test',
        status: 'succeeded',
        inputs: {},
        results: { kind, specialty },
        equityValue: headline.equityValue,
        fmvPerShare: headline.fmvPerShare,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );
    return id;
  }

  const generate = (id: string, payload: unknown = {}) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/board`,
      headers: authHeader(ops.token),
      payload,
    });

  it('refuses to adopt an EMI run’s AMV as the 409A price', async () => {
    // AMV 0.40 against a UMV of 1.00 — a 60% restriction discount, which is the
    // margin by which every option struck at the adopted figure would have been
    // underpriced.
    const id = await engagementWithSpecialtyRun(
      'emi',
      'RestrictedCo',
      { equityValue: 4_000_000, fmvPerShare: 0.4 },
      { amv_per_share: 0.4, umv_per_share: 1.0 },
    );

    const res = await generate(id, { valuation_date: '2026-05-01' });
    expect(res.statusCode).toBe(422);
    const detail = String(res.json().detail ?? res.json().title ?? '');
    // Named as the picker names it, and it says which figure was actually
    // there rather than only that this one is unavailable.
    expect(detail).toContain('EMI scheme valuation (UK)');
    expect(detail.toLowerCase()).toContain('actual market value');
    // And it does not tell the analyst to do the thing they already did.
    expect(detail).not.toContain('run a calculation');

    // Nothing was written: no resolution exists to be sent for signature.
    const after = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/board`,
      headers: authHeader(ops.token),
    });
    expect(after.json().resolution).toBeNull();
  });

  it('refuses a CSOP run and an ESOP run for the same reason', async () => {
    const csop = await engagementWithSpecialtyRun(
      'csop',
      'SchemeCo',
      { equityValue: 9_000_000, fmvPerShare: 0.9 },
      { amv_per_share: 0.9, umv_per_share: 1.2 },
    );
    expect((await generate(csop)).statusCode).toBe(422);

    // ESOP is the one whose per-share figure is a real, unrestricted fair
    // market value — of employer securities on shares outstanding, under ERISA
    // adequate consideration, off an equity value supplied for the engagement.
    // §409A asks for the common stock fully diluted, so it is still not this
    // number, and "it looks like an FMV" is the trap.
    const esop = await engagementWithSpecialtyRun(
      'esop',
      'TrusteeCo',
      { equityValue: 20_000_000, fmvPerShare: 4.25 },
      { per_share_value: 4.25, value_basis: 'control' },
    );
    const res = await generate(esop);
    expect(res.statusCode).toBe(422);
    expect(String(res.json().detail ?? '')).toContain('ESOP valuation');
  });

  it('says a calculation ran, for a kind whose column is empty on purpose', async () => {
    // An IFRS 2 run writes a total expense into `equity_value` and nothing into
    // `fmv_per_share`, so the old message fired here too — and "run a
    // calculation" was a false instruction: one ran, and it succeeded.
    const id = await engagementWithSpecialtyRun(
      'ifrs2',
      'AwardCo',
      { equityValue: 750_000, fmvPerShare: null },
      { total_expense: 750_000 },
    );
    const res = await generate(id);
    expect(res.statusCode).toBe(422);
    const detail = String(res.json().detail ?? '');
    expect(detail).toContain('IFRS 2 share-based payment');
    expect(detail).not.toContain('run a calculation');
  });

  it('still honours an explicitly supplied figure on a specialty engagement', async () => {
    // The escape hatch the API has always had. An analyst naming the figure has
    // made the judgement themselves; what is refused is the platform making it
    // for them by reading a column whose name it trusted.
    const id = await engagementWithSpecialtyRun(
      'emi',
      'OverrideCo',
      { equityValue: 4_000_000, fmvPerShare: 0.4 },
      { amv_per_share: 0.4, umv_per_share: 1.0 },
    );
    const res = await generate(id, { valuation_date: '2026-05-01', fmv_conclusion: 1.0 });
    expect(res.statusCode).toBe(201);
    expect(Number(res.json().resolution.fmv_conclusion)).toBe(1.0);
    expect(res.json().resolution.body_html).toContain('USD 1 per share');
  });

  it('leaves a 409A run adopting its own conclusion', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'CommonCo' },
    });
    const id = created.json().valuation.id as string;
    await createCalculation(
      ctx.pool,
      {
        valuationId: id,
        engineVersion: 'test',
        status: 'succeeded',
        inputs: {},
        results: { fmv_per_share: 3.5 },
        equityValue: 35_000_000,
        fmvPerShare: 3.5,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );

    const res = await generate(id, { valuation_date: '2026-05-01' });
    expect(res.statusCode).toBe(201);
    expect(Number(res.json().resolution.fmv_conclusion)).toBe(3.5);
  });

  it('keeps the original message when nothing has been calculated at all', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'UncalculatedCo' },
    });
    const res = await generate(created.json().valuation.id as string);
    expect(res.statusCode).toBe(422);
    expect(String(res.json().detail ?? '')).toContain('run a calculation');
  });
});
