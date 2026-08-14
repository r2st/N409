import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createCalculation } from '../../src/repos/calculations.js';

const dbUp = await isDbAvailable();

/**
 * The four "apply the agent's answer" routes when there is no answer to apply,
 * and the methodology explanation's visibility rule.
 *
 * Each agent has a paired route: one runs it, one writes its result onto the
 * engagement. `aiComparablesApply.test.ts` covers one of those pairs properly;
 * the other three had their refusal arm untested, which is most of what left
 * `routes/ai.ts` at 84% branch coverage.
 *
 * The refusal is the same in every case and it is not incidental. Applying an
 * agent result writes to the engagement — params, comparables, the company
 * profile, the tag set — so "there is nothing to apply" has to be a refusal
 * naming the agent to run, not an empty write that looks like it worked.
 */
describe.skipIf(!dbUp)('AI apply routes — nothing to apply', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let stranger: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const ULID_ABSENT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    stranger = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'AgentCo' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;
  });
  afterAll(async () => ctx?.teardown());

  const APPLY_ROUTES = [
    ['extract', 'ai/extract/apply', /run data extraction first/i],
    ['comp_selection', 'ai/comp_selection/apply', /run the comp_selection agent first/i],
    ['company_profile', 'ai/company_profile/apply', /run the company_profile agent first/i],
    ['tagging', 'ai/tagging/apply', /tagging/i],
  ] as const;

  const post = (path: string, token: string, payload: unknown = {}) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/${path}`,
      headers: authHeader(token),
      payload,
    });

  // ── Nothing to apply ──────────────────────────────────────────────────────
  describe('before the agent has ever run', () => {
    it('422s each apply route, naming the agent to run', async () => {
      // A message that says only "nothing to apply" leaves an operator hunting
      // for which of four agents they are missing.
      for (const [agent, path, message] of APPLY_ROUTES) {
        const res = await post(path, ops.token);
        expect(res.statusCode, agent).toBe(422);
        expect(res.json().detail, agent).toMatch(message);
      }
    });

    it('writes nothing to the engagement while refusing', async () => {
      // The point of the refusal: an empty write would look like it worked.
      for (const [, path] of APPLY_ROUTES) await post(path, ops.token);

      const comparables = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/comparables`,
        headers: authHeader(ops.token),
      });
      expect(comparables.json().comparables).toEqual([]);

      const { rows: profiles } = await ctx.pool.query(
        'SELECT 1 FROM company_profiles WHERE valuation_id = $1',
        [valuationId],
      );
      expect(profiles).toEqual([]);
    });
  });

  // ── An extraction that stored nothing usable ──────────────────────────────
  describe('an extraction with nothing applicable in it', () => {
    async function seedExtractJob(engineInputs: unknown): Promise<void> {
      await ctx.pool.query('DELETE FROM ai_jobs WHERE valuation_id = $1', [valuationId]);
      await ctx.pool.query(
        `INSERT INTO ai_jobs (id, valuation_id, pipeline, status, result, created_by, completed_at)
         VALUES ($1, $2, 'extract', 'succeeded', $3::jsonb, $4, now())`,
        [
          newUlid(),
          valuationId,
          JSON.stringify({ engine_inputs: engineInputs }),
          ops.id,
        ],
      );
    }

    it('422s a run whose engine inputs are absent or empty', async () => {
      for (const engineInputs of [undefined, null, {}, 'not an object']) {
        await seedExtractJob(engineInputs);
        const res = await post('ai/extract/apply', ops.token);
        expect(res.statusCode, JSON.stringify(engineInputs)).toBe(422);
        expect(res.json().detail).toMatch(/run data extraction first/i);
      }
    });

    it('422s a run whose every extracted figure is out of range, and says which', async () => {
      // A stored job can predate the bounds check, so the bounds are applied on
      // read rather than trusted — and the rejected list is what tells an
      // analyst the extraction is wrong rather than the route.
      // `discount_rate` is not a field this pipeline may set at all, and the
      // volatility is out of its band — two different rejection reasons.
      await seedExtractJob({ discount_rate: 0.24, volatility: -5 });
      const res = await post('ai/extract/apply', ops.token);
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/outside the accepted range/i);
      expect(res.json().rejected).toBeTruthy();
    });

    it('applies the figures that are in range and reports the ones that are not', async () => {
      // A partially-usable extraction is applied in part rather than refused
      // whole: the analyst gets the figures that survived and a named list of
      // the ones that did not.
      await seedExtractJob({ volatility: 0.55, shares_outstanding_common: 10_000_000, risk_free_rate: 9 });
      const res = await post('ai/extract/apply', ops.token);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.applied_inputs).toMatchObject({
        volatility: 0.55,
        shares_outstanding_common: 10_000_000,
      });
      expect(body.rejected_inputs.map((r: { field: string }) => r.field)).toContain('risk_free_rate');
      // The route names the run it applied, so the audit trail can be followed
      // back from the params to the extraction that set them.
      expect(body.source_job_id).toBeTruthy();
    });
  });

  // ── Bodies and scope ──────────────────────────────────────────────────────
  describe('bodies and scope', () => {
    it('422s a company-profile apply whose options do not parse', async () => {
      const res = await post('ai/company_profile/apply', ops.token, { overwrite: 'yes please' });
      expect(res.statusCode).toBe(422);
    });

    it('is operations-only on every apply route and on the job list', async () => {
      for (const [, path] of APPLY_ROUTES) {
        const res = await post(path, client.token);
        expect(res.statusCode, path).toBe(403);
      }
      const jobs = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/ai`,
        headers: authHeader(client.token),
      });
      expect(jobs.statusCode).toBe(403);
    });

    it('404s a malformed or absent engagement before it looks for a job', async () => {
      for (const id of ['not-a-ulid', ULID_ABSENT]) {
        for (const [, path] of APPLY_ROUTES) {
          const res = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/valuations/${id}/${path}`,
            headers: authHeader(ops.token),
            payload: {},
          });
          expect(res.statusCode, `${path} ${id}`).toBe(404);
        }
      }
    });
  });

  // ── The methodology explanation ───────────────────────────────────────────
  describe('the plain-English explanation', () => {
    const explanation = (token: string, id = valuationId) =>
      ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/explanation`,
        headers: authHeader(token),
      });

    it('404s a malformed id, an absent one, and a stranger’s engagement', async () => {
      expect((await explanation(ops.token, 'not-a-ulid')).statusCode).toBe(404);
      expect((await explanation(ops.token, ULID_ABSENT)).statusCode).toBe(404);
      expect((await explanation(stranger.token)).statusCode).toBe(404);
    });

    it('answers a client with nulls until a draft has been shared', async () => {
      // Readable by anyone who can see the engagement, but the *content*
      // follows the report's visibility. A client reading the methodology
      // before the draft exists would be reading a conclusion nobody has
      // released to them.
      const res = await explanation(client.token);
      expect(res.statusCode).toBe(200);
      expect(res.json().explanation).toBeNull();
      expect(res.json().model).toBeNull();
      expect(res.json().generated_at).toBeNull();
    });

    it('answers ops with nulls too when the agent has never run', async () => {
      // Same shape, different reason — and the tab renders one empty state for
      // both rather than erroring on the absence.
      const res = await explanation(ops.token);
      expect(res.statusCode).toBe(200);
      expect(res.json().explanation).toBeNull();
    });

    it('serves the stored explanation to ops once the agent has run', async () => {
      await ctx.pool.query(
        `INSERT INTO ai_jobs (id, valuation_id, pipeline, status, result, model, created_by, completed_at)
         VALUES ($1, $2, 'explain', 'succeeded', $3::jsonb, 'stub/model-a', $4, now())`,
        [
          newUlid(),
          valuationId,
          JSON.stringify({ summary: 'The concluded value rests on the income approach.' }),
          ops.id,
        ],
      );
      const res = await explanation(ops.token);
      expect(res.statusCode).toBe(200);
      expect(JSON.stringify(res.json().explanation)).toContain('income approach');
      expect(res.json().model).toBe('stub/model-a');
      expect(res.json().generated_at).toBeTruthy();
    });
  });

  // ── Running a pipeline ────────────────────────────────────────────────────
  describe('running a pipeline', () => {
    it('refuses a pipeline name the vocabulary does not contain', async () => {
      const res = await post('ai/astrology', ops.token);
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    });

    it('refuses the research topics and the QA gate through the generic route', async () => {
      // Each has a dedicated route that adds something this one cannot — the
      // QA gate's deterministic checks, research's containment rules — and a
      // second entry point would own none of it.
      for (const pipeline of ['qa', 'market_research', 'industry_overview']) {
        const res = await post(`ai/${pipeline}`, ops.token);
        expect(res.statusCode, pipeline).toBeGreaterThanOrEqual(400);
        expect(res.statusCode, pipeline).toBeLessThan(500);
      }
    });

    it('refuses a calculation-dependent agent before any calculation exists', async () => {
      for (const pipeline of ['explain', 'report_narrative', 'audit_defense']) {
        const res = await post(`ai/${pipeline}`, ops.token);
        expect(res.statusCode, pipeline).toBe(422);
      }
    });

    it('gets past that gate once a calculation exists', async () => {
      const id = (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/valuations',
          headers: authHeader(client.token),
          payload: { kind: '409a', company_name: 'CalculatedCo' },
        })
      ).json().valuation.id as string;
      await createCalculation(
        ctx.pool,
        {
          valuationId: id,
          engineVersion: 'test',
          status: 'succeeded',
          inputs: {},
          results: { fmv_per_share: 1 },
          equityValue: 1_000_000,
          fmvPerShare: 1,
          createdBy: ops.id,
        },
        { actorType: 'human', actorId: ops.id },
      );
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/ai/explain`,
        headers: authHeader(ops.token),
        payload: {},
      });
      // The AI service is not stubbed here, so this fails upstream rather than
      // at the gate — which is the distinction being asserted: a 422 naming the
      // missing calculation would mean the gate was still closed.
      expect(res.statusCode).not.toBe(422);
    });
  });
});
