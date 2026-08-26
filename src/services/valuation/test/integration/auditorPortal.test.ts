import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { createReport } from '../../src/repos/reports.js';
import { markValuationsArchived } from '../../src/repos/retention.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

describe.skipIf(!dbUp)('external auditor portal (feature 8)', () => {
  let ctx: TestApp;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let other: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
    other = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  async function seedValuation() {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Auditee Inc', userId: owner.id },
      { ...actor, actorId: owner.id },
    );
    await createCalculation(
      ctx.pool,
      {
        valuationId: v.id,
        engineVersion: 'py-1.0.0',
        status: 'succeeded',
        inputs: {},
        results: { fmv_per_share: 3.25, equity_value: 12_000_000 },
        equityValue: 12_000_000,
        fmvPerShare: 3.25,
        createdBy: owner.id,
      },
      { ...actor, actorId: owner.id },
    );
    return v;
  }

  const createLink = (token: string, valuationId: string, payload: object = {}) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/auditor-access`,
      headers: authHeader(token),
      payload,
    });

  const redeem = (token: string) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/auditor/portal', payload: { token } });

  it('mints a link and serves a read-only bundle', async () => {
    const v = await seedValuation();
    const created = await createLink(owner.token, v.id, { label: 'PwC', expires_in_days: 30 });
    expect(created.statusCode).toBe(201);
    const { token, url } = created.json();
    expect(url).toContain('/auditor#token=');

    const bundle = await redeem(token);
    expect(bundle.statusCode).toBe(200);
    const body = bundle.json();
    expect(body.valuation.company_name).toBe('Auditee Inc');
    expect(body.conclusion.fmv_per_share).toBe('3.25');
    expect(body.evidence_summary.has_conclusion).toBe(true);
    // The captions travel with the figures. A 409A takes the default wording;
    // the portal has no other context to give an outside auditor, so what a
    // number is called is the whole of what they are told.
    expect(body.conclusion.fmv_per_share_label).toBe('Concluded FMV per share');
    expect(body.conclusion.equity_label).toBe('Concluded equity value');
  });

  it('captions a specialty conclusion as the figure it actually is', async () => {
    /*
     * An IFRS 2 run writes its total share-based-payment expense into the
     * `equity_value` column, because that is the column the calculation row
     * has (domain/specialty.ts). The portal used to caption it "Equity value",
     * which is off by orders of magnitude from anything a reader would check
     * it against, and there is no per-share figure at all — the fair value per
     * *award* is not one, and would be read as one.
     */
    const v = await createValuation(
      ctx.pool,
      { kind: 'ifrs2', companyName: 'Awards Ltd', userId: owner.id },
      { ...actor, actorId: owner.id },
    );
    await createCalculation(
      ctx.pool,
      {
        valuationId: v.id,
        engineVersion: 'py-1.0.0',
        status: 'succeeded',
        inputs: {},
        results: { kind: 'ifrs2', specialty: { total_expense: 480_000 } },
        equityValue: 480_000,
        fmvPerShare: null,
        createdBy: owner.id,
      },
      { ...actor, actorId: owner.id },
    );
    const { token } = (await createLink(owner.token, v.id)).json();
    const body = (await redeem(token)).json();
    expect(body.conclusion.equity_label).toBe('Total expense');
    expect(body.conclusion.fmv_per_share_label).toBeNull();
  });

  /*
   * The same caption, one ordinary compute later.
   *
   * `headlineLabels` is keyed on the engagement's *kind*, so the caption says
   * "Total expense" for as long as this is an IFRS 2 engagement. The figure
   * beneath it was whichever run happened last — and the Calculations tab
   * offers the 409A compute on every kind, so a run of the other shape landing
   * on top put a §409A equity value under a heading that calls it a
   * share-based-payment expense, in the one bundle an outside auditor reads
   * without anyone in the firm present to correct it.
   *
   * The conclusion an IFRS 2 engagement reports is its own engine's.
   */
  it('keeps the captioned figure the one that engine wrote, after a 409A run lands on top', async () => {
    const v = await createValuation(
      ctx.pool,
      { kind: 'ifrs2', companyName: 'Awards Ltd', userId: owner.id },
      { ...actor, actorId: owner.id },
    );
    await createCalculation(
      ctx.pool,
      {
        valuationId: v.id,
        engineVersion: 'py-1.0.0',
        status: 'succeeded',
        inputs: {},
        results: { kind: 'ifrs2', specialty: { total_expense: 480_000 } },
        equityValue: 480_000,
        fmvPerShare: null,
        createdBy: owner.id,
      },
      { ...actor, actorId: owner.id },
    );
    await createCalculation(
      ctx.pool,
      {
        valuationId: v.id,
        engineVersion: 'py-1.0.0',
        status: 'succeeded',
        inputs: {},
        results: { approaches: { income: { equity_value: 31_000_000, weight: 1 } } },
        equityValue: 31_000_000,
        fmvPerShare: 4.25,
        createdBy: owner.id,
      },
      { ...actor, actorId: owner.id },
    );

    const { token } = (await createLink(owner.token, v.id)).json();
    const body = (await redeem(token)).json();
    expect(body.conclusion.equity_label).toBe('Total expense');
    expect(Number(body.conclusion.equity_value)).toBe(480_000);
    // And above all not a per-share figure on a kind that concludes none.
    expect(body.conclusion.fmv_per_share).toBeNull();
    expect(body.conclusion.fmv_per_share_label).toBeNull();
  });

  it('rejects an expired link', async () => {
    const v = await seedValuation();
    const { token } = (await createLink(owner.token, v.id)).json();
    await ctx.pool.query(
      `UPDATE auditor_access SET expires_at = now() - interval '1 day' WHERE valuation_id = $1`,
      [v.id],
    );
    const bundle = await redeem(token);
    expect(bundle.statusCode).toBe(401);
  });

  it('rejects a revoked link', async () => {
    const v = await seedValuation();
    const created = await createLink(owner.token, v.id);
    const { token } = created.json();
    const accessId = created.json().access.id;

    const revoke = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/valuations/${v.id}/auditor-access/${accessId}`,
      headers: authHeader(owner.token),
    });
    expect(revoke.statusCode).toBe(204);
    expect((await redeem(token)).statusCode).toBe(401);
  });

  it("won't let a non-owner mint links for someone else's valuation", async () => {
    const v = await seedValuation();
    const res = await createLink(other.token, v.id);
    expect(res.statusCode).toBe(404);
  });

  it('rejects a garbage token', async () => {
    expect((await redeem('not-a-real-token')).statusCode).toBe(401);
  });

  /**
   * The portal used to serve `reports.current_version` whenever a report row
   * existed, which is from the moment an analyst instantiates the template —
   * long before the draft is shared. Because the valuation's owner may mint a
   * link, that made the portal a way for a client to read the working draft
   * their own `GET /report` answers 404 for.
   */
  describe('the deliverable is only served once it has been shared', () => {
    async function seedReport(valuationId: string) {
      const { report } = await createReport(ctx.pool, {
        valuationId,
        templateVersion: 'v1',
        content: { title: 'Draft in progress', sections: [] } as never,
        actor: { ...actor, actorId: owner.id },
      });
      return report;
    }

    it('withholds a report the valuation has not reached a shared state for', async () => {
      const v = await seedValuation();
      await seedReport(v.id);
      const { token } = (await createLink(owner.token, v.id)).json();

      const body = (await redeem(token)).json();
      expect(body.report).toBeNull();
      expect(body.evidence_summary.has_report).toBe(false);
      // Everything an auditor is actually here for still arrives.
      expect(body.conclusion.fmv_per_share).toBe('3.25');
      expect(body.valuation.company_name).toBe('Auditee Inc');
    });

    it.each(['drafted', 'draft_accepted', 'published'])('serves it once %s', async (state) => {
      const v = await seedValuation();
      await seedReport(v.id);
      await ctx.pool.query('UPDATE valuations SET state = $2 WHERE id = $1', [v.id, state]);
      const { token } = (await createLink(owner.token, v.id)).json();

      const body = (await redeem(token)).json();
      expect(body.report).not.toBeNull();
      expect(body.report.content.title).toBe('Draft in progress');
      expect(body.evidence_summary.has_report).toBe(true);
    });

    it('agrees with what the owner is served directly', async () => {
      const v = await seedValuation();
      await seedReport(v.id);
      const { token } = (await createLink(owner.token, v.id)).json();

      // The gate the portal now mirrors: the owner cannot read this report.
      const direct = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${v.id}/report`,
        headers: authHeader(owner.token),
      });
      expect(direct.statusCode).toBe(404);
      expect((await redeem(token)).json().report).toBeNull();
    });
  });

  /**
   * `archived_at` is the platform's soft delete — stamped by the retention
   * sweep when a policy period runs out, and by `retireValuations` when a firm
   * withdraws a piece of work. R55/R56 took retired engagements out of every
   * list; R57 found that a list no longer offering something is not a write
   * refusing it. This is the same shape one step further out: the reader holds
   * a link rather than an account, and the link returns the conclusion, the
   * assumptions and the report.
   */
  describe('a retired engagement', () => {
    // Through the retention sweep's own writer rather than raw SQL: it is the
    // path that stamps archived_at in production, and it invalidates the row
    // cache in front of `findValuationById`, which raw SQL does not.
    const archive = (id: string) => markValuationsArchived(ctx.pool, [id]);

    it('stops answering links already in an auditor\u2019s inbox', async () => {
      const v = await seedValuation();
      const { token } = (await createLink(owner.token, v.id)).json();
      // Live before, so the assertion below is about the archive and not about
      // a link that never worked.
      expect((await redeem(token)).statusCode).toBe(200);

      await archive(v.id);

      const after = await redeem(token);
      expect(after.statusCode).toBe(404);
      expect(after.json().detail).toContain('retired');
    });

    it('refuses to mint a new one', async () => {
      // Stopping the read without stopping the write leaves the write.
      const v = await seedValuation();
      await archive(v.id);
      const created = await createLink(owner.token, v.id, { label: 'PwC' });
      expect(created.statusCode).toBe(409);
      expect(created.json().detail).toContain('retired');
    });

    it('still lets ops see and revoke the links that exist', async () => {
      // The point is to close the outstanding links, so the screen that lists
      // them has to keep working after the sweep has run.
      const v = await seedValuation();
      const { access } = (await createLink(owner.token, v.id, { label: 'KPMG' })).json();
      await archive(v.id);

      const listed = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${v.id}/auditor-access`,
        headers: authHeader(owner.token),
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().access).toHaveLength(1);

      const revoked = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${v.id}/auditor-access/${access.id}`,
        headers: authHeader(owner.token),
      });
      expect(revoked.statusCode).toBe(204);
    });
  });
});
