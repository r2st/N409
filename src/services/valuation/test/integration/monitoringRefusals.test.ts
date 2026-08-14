import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createCalculation } from '../../src/repos/calculations.js';

const dbUp = await isDbAvailable();

/**
 * Monitoring's refusals, and the fallback chain that dates a baseline.
 *
 * `monitoring.test.ts` enables a monitor on a completed engagement with a
 * calculation, fires a trigger and scans. That is one path through
 * `routes/monitoring.ts`, which sat at 65.6% branch coverage.
 *
 * The uncovered half is mostly `assembleSnapshot`'s fallbacks. A baseline is a
 * dated set of figures, and every field in it has an "or else": revenue falls
 * from last year to year-to-date, the valuation date falls from the adopted
 * board resolution to the published timestamp to the completed timestamp to
 * today. Those arms decide what a drift alert is measured *against*, so a wrong
 * fallback does not fail loudly — it moves the baseline and changes which
 * engagements look stale.
 */
describe.skipIf(!dbUp)('valuation monitoring — refusals and baseline fallbacks', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  const ULID_ABSENT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  const auth = () => authHeader(ops.token);

  async function seedValuation(company = 'MonitorEdgeCo'): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: company },
    });
    expect(created.statusCode).toBe(201);
    return created.json().valuation.id as string;
  }

  async function withCalc(id: string, fmv: number): Promise<void> {
    await createCalculation(
      ctx.pool,
      {
        valuationId: id,
        engineVersion: 'test',
        status: 'succeeded',
        inputs: {},
        results: { fmv_per_share: fmv },
        equityValue: fmv * 1_000_000,
        fmvPerShare: fmv,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );
  }

  const enable = (id: string) =>
    ctx.app.inject({ method: 'POST', url: `/api/v1/valuations/${id}/monitor`, headers: auth() });

  const baselineOf = async (id: string) => {
    const { rows } = await ctx.pool.query<{ baseline: Record<string, unknown> }>(
      'SELECT baseline FROM valuation_monitors WHERE valuation_id = $1',
      [id],
    );
    return rows[0]!.baseline;
  };

  // ── Enabling ──────────────────────────────────────────────────────────────
  describe('enabling', () => {
    it('409s an engagement that is neither in a monitorable state nor calculated', async () => {
      // Monitoring measures drift away from a concluded figure. An engagement
      // with no conclusion has nothing to drift from, so the baseline would be
      // a row of nulls that never triggers — silently useless rather than
      // refused.
      const id = await seedValuation();
      const res = await enable(id);
      expect(res.statusCode).toBe(409);
      expect(res.json().detail).toMatch(/completed valuation/i);
    });

    it('accepts an early-state engagement once it has a succeeded calculation', async () => {
      // The state check and the calculation check are an OR, not an AND: a
      // conclusion is the thing that matters, and the workflow state is a
      // proxy for it.
      const id = await seedValuation();
      await withCalc(id, 3.5);
      const res = await enable(id);
      expect(res.statusCode).toBe(201);
      expect(Number((await baselineOf(id)).fmv_per_share)).toBe(3.5);
    });

    it('accepts a published engagement that has never calculated', async () => {
      const id = await seedValuation();
      await ctx.pool.query(
        `UPDATE valuations SET state = 'published', published_at = $2 WHERE id = $1`,
        [id, '2026-02-10T00:00:00Z'],
      );
      const res = await enable(id);
      expect(res.statusCode).toBe(201);
      const baseline = await baselineOf(id);
      expect(baseline.fmv_per_share).toBeNull();
      // The other half of the same fallback chain: no resolution, so the
      // published timestamp dates the baseline.
      expect(baseline.valuation_date).toBe('2026-02-10');
    });

    it('404s a malformed or absent engagement', async () => {
      for (const id of ['not-a-ulid', ULID_ABSENT]) {
        const res = await enable(id);
        expect(res.statusCode, id).toBe(404);
      }
    });
  });

  // ── Baseline fallbacks ────────────────────────────────────────────────────
  describe('the date a baseline carries', () => {
    it('prefers the board resolution date over the published timestamp', async () => {
      // The resolution carries the date the board actually acted on the figure,
      // and the safe-harbor clock runs from that — not from whenever the
      // document happened to be published.
      const id = await seedValuation();
      await withCalc(id, 2);
      await ctx.pool.query(
        `UPDATE valuations SET state = 'published', published_at = $2 WHERE id = $1`,
        [id, '2026-03-20T00:00:00Z'],
      );
      await ctx.pool.query(
        `INSERT INTO board_resolutions
           (id, valuation_id, valuation_date, fmv_conclusion, methodology_summary,
            appraiser_qualifications, body_html, status, created_by)
         VALUES ($1, $2, $3, $4, 'OPM backsolve', 'ASA-accredited', '<p>x</p>', 'approved', $5)`,
        ['01ARZ3NDEKTSV4RRFFQ69G5FBR', id, '2026-01-05', 2, ops.id],
      );
      const res = await enable(id);
      expect(res.statusCode).toBe(201);
      expect((await baselineOf(id)).valuation_date).toBe('2026-01-05');
    });

    it('dates it so the staleness clock can actually read it', async () => {
      // The regression this guards is silent by construction. `valuation_date`
      // is fed to `monthsBetween`, which parses `${d.slice(0,10)}T00:00:00Z`
      // and returns 0 on an Invalid Date — so a baseline dated "Mon Jan 05"
      // (what `String(aDate).slice(0, 10)` produces for a pg `date` column)
      // reports zero months elapsed forever, and the 12-month safe-harbor
      // alert never fires for any engagement that has a board resolution.
      // Nothing throws; the alert simply stops existing.
      const id = await seedValuation('StaleCo');
      await withCalc(id, 2);
      await ctx.pool.query(
        `INSERT INTO board_resolutions
           (id, valuation_id, valuation_date, fmv_conclusion, methodology_summary,
            appraiser_qualifications, body_html, status, created_by)
         VALUES ($1, $2, $3, $4, 'OPM backsolve', 'ASA-accredited', '<p>x</p>', 'approved', $5)`,
        ['01ARZ3NDEKTSV4RRFFQ69G5FBS', id, '2020-01-05', 2, ops.id],
      );
      expect((await enable(id)).statusCode).toBe(201);

      const stored = String((await baselineOf(id)).valuation_date);
      expect(stored).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(new Date(`${stored}T00:00:00Z`).getTime())).toBe(false);

      // And the trigger it feeds fires: six years is well past the safe-harbor
      // window, so this is red rather than merely approaching.
      const status = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/monitor`,
        headers: auth(),
      });
      expect(status.statusCode).toBe(200);
      const expiry = status
        .json()
        .triggers.find((t: { type: string }) => t.type === 'expiry') as
        | { level: string; detail: { months: number } }
        | undefined;
      expect(expiry).toBeTruthy();
      expect(expiry!.level).toBe('red');
      // The month count is the thing that read as 0 before the fix.
      expect(expiry!.detail.months).toBeGreaterThan(60);
    });

    it('falls all the way through to today when nothing dates the engagement', async () => {
      const id = await seedValuation();
      await withCalc(id, 1);
      const res = await enable(id);
      expect(res.statusCode).toBe(201);
      expect((await baselineOf(id)).valuation_date).toBe(new Date().toISOString().slice(0, 10));
    });

    it('prefers last year revenue over year-to-date, and reports it in units', async () => {
      // Stored in cents, reported in units — a baseline that mixed the two
      // would make every drift comparison off by a hundred.
      const id = await seedValuation();
      await withCalc(id, 1);
      await ctx.pool.query(
        `UPDATE valuation_params SET last_year_revenue_cents = $2, ytd_revenue_cents = $3
         WHERE valuation_id = $1`,
        [id, 500_000_00, 100_000_00],
      );
      const res = await enable(id);
      expect(res.statusCode).toBe(201);
      expect((await baselineOf(id)).annual_revenue).toBe(500_000);
    });

    it('falls back to year-to-date revenue when last year is absent', async () => {
      const id = await seedValuation();
      await withCalc(id, 1);
      await ctx.pool.query(
        `UPDATE valuation_params SET last_year_revenue_cents = NULL, ytd_revenue_cents = $2
         WHERE valuation_id = $1`,
        [id, 250_000_00],
      );
      const res = await enable(id);
      expect(res.statusCode).toBe(201);
      expect((await baselineOf(id)).annual_revenue).toBe(250_000);
    });

    it('reports a null revenue rather than a zero when neither figure exists', async () => {
      // Zero revenue is a fact about a company; no revenue figure is a fact
      // about the file. Conflating them would fire a growth trigger against a
      // number nobody supplied.
      const id = await seedValuation();
      await withCalc(id, 1);
      await ctx.pool.query(
        `UPDATE valuation_params SET last_year_revenue_cents = NULL, ytd_revenue_cents = NULL
         WHERE valuation_id = $1`,
        [id],
      );
      const res = await enable(id);
      expect(res.statusCode).toBe(201);
      const baseline = await baselineOf(id);
      expect(baseline.annual_revenue).toBeNull();
      expect(baseline.fully_diluted_shares).toBeNull();
      expect(baseline.last_round_date).toBeNull();
    });
  });

  // ── Disabling ─────────────────────────────────────────────────────────────
  describe('disabling', () => {
    it('404s an engagement that was never monitored', async () => {
      const id = await seedValuation();
      await withCalc(id, 1);
      const res = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${id}/monitor`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(404);
    });

    it('is idempotent — the monitor row survives so a second delete still 204s', async () => {
      // Disabling flips the row rather than removing it, so `findMonitor` keeps
      // finding it and the repeat is a 204, not a 404. That is the right shape:
      // the row is the record that this engagement *was* monitored, and the
      // 404 above is reserved for an engagement that never was.
      const id = await seedValuation();
      await withCalc(id, 1);
      expect((await enable(id)).statusCode).toBe(201);
      for (const attempt of [1, 2]) {
        const res = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/valuations/${id}/monitor`,
          headers: auth(),
        });
        expect(res.statusCode, `attempt ${attempt}`).toBe(204);
      }
      // And it is gone from the dashboard, which lists enabled monitors only.
      const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/monitors', headers: auth() });
      expect(list.json().monitors.map((m: { valuation_id: string }) => m.valuation_id)).not.toContain(id);
    });

    it('404s a malformed or absent id', async () => {
      for (const id of ['not-a-ulid', ULID_ABSENT]) {
        const res = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/valuations/${id}/monitor`,
          headers: auth(),
        });
        expect(res.statusCode, id).toBe(404);
      }
    });
  });

  // ── Dashboard query ───────────────────────────────────────────────────────
  describe('the dashboard', () => {
    it('400s a limit outside its range', async () => {
      for (const q of ['limit=0', 'limit=100000', 'limit=notanumber']) {
        const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/monitors?${q}`, headers: auth() });
        expect(res.statusCode, q).toBe(400);
      }
    });

    it('honours a limit and reports whether the page was truncated', async () => {
      const id = await seedValuation('LimitCo');
      await withCalc(id, 1);
      await enable(id);
      const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/monitors?limit=1', headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.json().monitors.length).toBeLessThanOrEqual(1);
      expect(typeof res.json().truncated).toBe('boolean');
    });

    it('scans cleanly when no monitor has anything to report', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/monitors/scan',
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(typeof res.json().scanned).toBe('number');
    });
  });

  // ── Authorisation ─────────────────────────────────────────────────────────
  it('forbids a client on every monitoring route', async () => {
    const id = await seedValuation();
    const routes: [string, string][] = [
      ['GET', '/api/v1/monitors'],
      ['POST', `/api/v1/valuations/${id}/monitor`],
      ['DELETE', `/api/v1/valuations/${id}/monitor`],
      ['POST', '/api/v1/admin/monitors/scan'],
    ];
    for (const [method, url] of routes) {
      const res = await ctx.app.inject({
        method: method as 'GET',
        url,
        headers: authHeader(client.token),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});
