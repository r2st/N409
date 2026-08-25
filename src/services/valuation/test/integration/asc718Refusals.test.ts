import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createCalculation } from '../../src/repos/calculations.js';

const dbUp = await isDbAvailable();

/**
 * What the ASC 718 route refuses, and what it falls back to.
 *
 * `asc718.test.ts` prices awards where every assumption is supplied or
 * derivable. The route's real job is deciding what to do when one is not, and
 * that half was untested — 66% branch coverage, the gap sitting entirely in the
 * "no underlying / no volatility / no term" arms.
 *
 * Those arms matter more than the arithmetic around them. An expense schedule
 * built on a silently-defaulted volatility is a number nobody chose, carried
 * into a filing. The route refuses instead, and names the field and the award
 * it is refusing for — an error that says only "missing input" against a
 * fifty-grant batch is not actionable.
 */
describe.runIf(dbUp)('ASC 718 — refusals and fallbacks', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  const ULID_ABSENT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(() => ctx?.teardown());

  const auth = () => authHeader(ops.token);

  async function seedValuation(company = 'RefuseCo'): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '718', company_name: company },
    });
    expect(created.statusCode).toBe(201);
    return created.json().valuation.id as string;
  }

  async function withFmv(id: string, fmv: number): Promise<void> {
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

  const price = (id: string, payload: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: `/api/v1/valuations/${id}/asc718`, headers: auth(), payload });

  const GRANT = {
    label: 'ISO-1',
    options_granted: 10_000,
    grant_date: '2026-01-01',
    vesting_months: 48,
    exercise_price: 1,
    risk_free_rate: 0.04,
  };

  // ── Missing underlying ────────────────────────────────────────────────────
  describe('no underlying', () => {
    it('refuses a private batch with no calculation and no supplied fair value', async () => {
      // The concluded 409A FMV is the private default. Without one there is
      // nothing to price against, and guessing would put an unowned number into
      // an expense schedule.
      const id = await seedValuation();
      const res = await price(id, {
        company_type: 'private',
        default_volatility: 0.5,
        grants: [GRANT],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/run a calculation first or supply grant_date_fair_value/);
    });

    it('refuses a private batch whose only calculation concluded a non-positive FMV', async () => {
      // `fmv != null && fmv > 0` — a zero FMV is a result, not an underlying.
      const id = await seedValuation();
      await withFmv(id, 0);
      const res = await price(id, {
        company_type: 'private',
        default_volatility: 0.5,
        grants: [GRANT],
      });
      expect(res.statusCode).toBe(422);
    });

    it('refuses to price a private batch off an EMI run’s restricted AMV', async () => {
      /*
       * The same 409A-named column, read by a second surface. Every engine
       * writes its headline into `calculations.fmv_per_share`, and an EMI run
       * leaves the AMV there — the *restricted* value, below the unrestricted
       * market value by the whole restriction discount. Inherited as the
       * private default underlying, it understates the option expense by about
       * that discount, in a figure that goes into the financial statements.
       *
       * The bug is that this path never fails: 0.40 is a perfectly good
       * Black-Scholes underlying, so the batch prices and the note balances.
       */
      const id = await seedValuation('RestrictedCo');
      await createCalculation(
        ctx.pool,
        {
          valuationId: id,
          engineVersion: 'test',
          status: 'succeeded',
          inputs: {},
          results: { kind: 'emi', specialty: { amv_per_share: 0.4, umv_per_share: 1.0 } },
          equityValue: 4_000_000,
          fmvPerShare: 0.4,
          createdBy: ops.id,
        },
        { actorType: 'human', actorId: ops.id },
      );

      const res = await price(id, {
        company_type: 'private',
        default_volatility: 0.5,
        grants: [GRANT],
      });
      expect(res.statusCode).toBe(422);
      const detail = String(res.json().detail ?? '');
      expect(detail).toContain('EMI scheme valuation (UK)');
      expect(detail.toLowerCase()).toContain('actual market value');
      // And not the instruction the analyst already followed.
      expect(detail).not.toMatch(/run a calculation first/);
    });

    it('names the public remedy rather than the private one for a public batch', async () => {
      // Same missing input, different instruction: a public issuer supplies a
      // ticker, and telling them to "run a calculation" would be wrong advice.
      const id = await seedValuation();
      const res = await price(id, {
        company_type: 'public',
        default_volatility: 0.5,
        grants: [GRANT],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/supply a ticker with live prices/);
    });

    it('lets a per-grant fair value stand in where the batch has no default', async () => {
      const id = await seedValuation();
      const res = await price(id, {
        company_type: 'private',
        default_volatility: 0.5,
        grants: [{ ...GRANT, grant_date_fair_value: 4 }],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().asc718.options.grants[0].fairValuePerOption).toBeGreaterThan(0);
    });

    it('prefers the batch default over the concluded FMV when both exist', async () => {
      const id = await seedValuation();
      await withFmv(id, 2);
      const cheap = await price(id, {
        company_type: 'private',
        default_volatility: 0.5,
        grants: [GRANT],
      });
      const dear = await price(id, {
        company_type: 'private',
        default_grant_date_fair_value: 20,
        default_volatility: 0.5,
        grants: [GRANT],
      });
      expect(cheap.statusCode).toBe(200);
      expect(dear.statusCode).toBe(200);
      expect(dear.json().asc718.options.grants[0].fairValuePerOption).toBeGreaterThan(
        cheap.json().asc718.options.grants[0].fairValuePerOption,
      );
    });
  });

  // ── Missing volatility ────────────────────────────────────────────────────
  describe('no volatility', () => {
    it('names the grant it is refusing for, not just the batch', async () => {
      // Against a fifty-grant batch, "missing volatility" is not actionable.
      const id = await seedValuation();
      await withFmv(id, 5);
      const res = await price(id, {
        company_type: 'private',
        grants: [{ ...GRANT, label: 'ISO-17' }],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain('ISO-17');
      expect(res.json().detail).toMatch(/no volatility/);
    });

    it('falls back to "unnamed" for an award with no label', async () => {
      const id = await seedValuation();
      await withFmv(id, 5);
      const { label: _label, ...unlabelled } = GRANT;
      const res = await price(id, { company_type: 'private', grants: [unlabelled] });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain('unnamed');
    });

    it('refuses an ESPP, a market RSU and a TSR award for the same reason', async () => {
      const id = await seedValuation();
      await withFmv(id, 5);

      const espp = await price(id, {
        company_type: 'private',
        grants: [],
        espp: [
          {
            label: 'ESPP-A',
            grant_date_price: 10,
            discount_pct: 0.15,
            lookback_months: 6,
            risk_free_rate: 0.04,
            shares_enrolled: 100,
          },
        ],
      });
      expect(espp.statusCode).toBe(422);
      expect(espp.json().detail).toContain('ESPP-A');

      const rsu = await price(id, {
        company_type: 'private',
        grants: [],
        rsu: [{ label: 'RSU-M', condition: 'market', units: 100, hurdle_price: 20, vesting_years: 3 }],
      });
      expect(rsu.statusCode).toBe(422);
      expect(rsu.json().detail).toContain('RSU-M');

      const tsr = await price(id, {
        company_type: 'private',
        grants: [],
        tsr: [
          {
            label: 'TSR-1',
            target_units: 100,
            peers: [{ name: 'A', volatility: 0.4 }],
            performance_period_years: 3,
            risk_free_rate: 0.04,
            payout_schedule: [{ percentile: 50, payout_ratio: 1 }],
          },
        ],
      });
      expect(tsr.statusCode).toBe(422);
      expect(tsr.json().detail).toContain('TSR-1');
    });
  });

  // ── Expected-term methods ─────────────────────────────────────────────────
  describe('expected term', () => {
    it('refuses the historical method with no exercise history', async () => {
      // The method *is* the history — electing it without one is not a
      // recoverable default, it is a different method.
      const id = await seedValuation();
      await withFmv(id, 5);
      for (const history of [undefined, []]) {
        const res = await price(id, {
          company_type: 'private',
          default_volatility: 0.5,
          grants: [{ ...GRANT, expected_term_method: 'historical', exercise_history: history }],
        });
        expect(res.statusCode).toBe(422);
        expect(res.json().detail).toMatch(/historical term method but has no exercise_history/);
      }
    });

    it('derives the term from a supplied exercise history', async () => {
      const id = await seedValuation();
      await withFmv(id, 5);
      const res = await price(id, {
        company_type: 'private',
        default_volatility: 0.5,
        grants: [
          {
            ...GRANT,
            expected_term_method: 'historical',
            exercise_history: [
              { years: 3, options: 1000 },
              { years: 7, options: 1000 },
            ],
          },
        ],
      });
      expect(res.statusCode).toBe(200);
      // Options-weighted mean of 3 and 7.
      expect(res.json().asc718.options.grants[0].assumptions.expectedTermYears).toBeCloseTo(5, 3);
    });

    it('prices the lattice method, and derives a contractual term when none is given', async () => {
      const id = await seedValuation();
      await withFmv(id, 5);
      const supplied = await price(id, {
        company_type: 'private',
        default_volatility: 0.5,
        grants: [{ ...GRANT, expected_term_method: 'lattice', contractual_term_years: 10 }],
      });
      expect(supplied.statusCode).toBe(200);

      const derived = await price(id, {
        company_type: 'private',
        default_volatility: 0.5,
        grants: [{ ...GRANT, expected_term_method: 'lattice' }],
      });
      expect(derived.statusCode).toBe(200);
      const term = (r: typeof derived) => r.json().asc718.options.grants[0].assumptions.expectedTermYears;
      expect(term(derived)).toBeGreaterThan(0);

      // The fallback is `vesting_months / 12 + 6`, which for a 48-month vest is
      // exactly the 10 years supplied above — so the two agree, and that
      // equality is the assertion rather than a coincidence to work around.
      expect(term(derived)).toBeCloseTo(term(supplied), 6);

      // A longer contractual life leaves more room before expiry, so the
      // employee's expected holding period lengthens.
      const longer = await price(id, {
        company_type: 'private',
        default_volatility: 0.5,
        grants: [{ ...GRANT, expected_term_method: 'lattice', contractual_term_years: 20 }],
      });
      expect(longer.statusCode).toBe(200);
      expect(term(longer)).toBeGreaterThan(term(derived));
    });

    it('uses a supplied expected term verbatim under the simplified method', async () => {
      const id = await seedValuation();
      await withFmv(id, 5);
      const res = await price(id, {
        company_type: 'private',
        default_volatility: 0.5,
        grants: [{ ...GRANT, expected_term_years: 6.25 }],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().asc718.options.grants[0].assumptions.expectedTermYears).toBeCloseTo(6.25, 6);
    });

    it('derives the simplified term from vesting and contractual life otherwise', async () => {
      const id = await seedValuation();
      await withFmv(id, 5);
      const res = await price(id, {
        company_type: 'private',
        default_volatility: 0.5,
        grants: [{ ...GRANT, contractual_term_years: 10 }],
      });
      expect(res.statusCode).toBe(200);
      // SAB 107 midpoint of vesting (4y) and contractual (10y).
      expect(res.json().asc718.options.grants[0].assumptions.expectedTermYears).toBeCloseTo(7, 3);
    });
  });

  // ── Market-condition RSU completeness ─────────────────────────────────────
  it('refuses a market-condition RSU missing any of its three required inputs', async () => {
    // Named together on purpose: all three are required, and a partial set
    // would otherwise be silently completed with defaults that nobody chose.
    const id = await seedValuation();
    await withFmv(id, 5);
    const partials: Record<string, unknown>[] = [
      { hurdle_price: 20, vesting_years: 3 },
      { hurdle_price: 20, volatility: 0.5 },
      { vesting_years: 3, volatility: 0.5 },
    ];
    for (const over of partials) {
      const res = await price(id, {
        company_type: 'private',
        grants: [],
        rsu: [{ label: 'RSU-P', condition: 'market', units: 100, ...over }],
      });
      expect(res.statusCode, JSON.stringify(over)).toBe(422);
      expect(res.json().detail).toMatch(/needs hurdle_price, vesting_years and volatility/);
    }
  });

  // ── Settings and scope ────────────────────────────────────────────────────
  describe('settings and scope', () => {
    it('reads back null settings before any are stored', async () => {
      const id = await seedValuation();
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/asc718/settings`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().settings).toBeNull();
    });

    it('422s settings it cannot parse', async () => {
      const id = await seedValuation();
      const res = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${id}/asc718/settings`,
        headers: auth(),
        payload: { company_type: 'listed-somewhere' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().errors).toBeTruthy();
    });

    it('404s a malformed or absent engagement on every route', async () => {
      for (const id of ['not-a-ulid', ULID_ABSENT]) {
        const get = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/valuations/${id}/asc718/settings`,
          headers: auth(),
        });
        expect(get.statusCode, `get ${id}`).toBe(404);

        const put = await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/valuations/${id}/asc718/settings`,
          headers: auth(),
          payload: { company_type: 'private' },
        });
        expect(put.statusCode, `put ${id}`).toBe(404);

        const post = await price(id, { company_type: 'private', grants: [GRANT] });
        expect(post.statusCode, `post ${id}`).toBe(404);
      }
    });

    it('forbids a client on the settings routes as well as the pricing one', async () => {
      const id = await seedValuation();
      const routes: [string, string, unknown][] = [
        ['GET', `/api/v1/valuations/${id}/asc718/settings`, undefined],
        ['PUT', `/api/v1/valuations/${id}/asc718/settings`, { company_type: 'private' }],
        ['POST', `/api/v1/valuations/${id}/asc718`, { company_type: 'private', grants: [GRANT] }],
      ];
      for (const [method, url, payload] of routes) {
        const res = await ctx.app.inject({
          method: method as 'GET',
          url,
          headers: authHeader(client.token),
          payload,
        });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
      }
    });
  });
});
