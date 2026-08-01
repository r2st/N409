import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDocument } from '../../src/repos/documents.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import type pg from 'pg';

const dbUp = await isDbAvailable();

/**
 * IMPROVEMENTS_RESEARCH Phase 1 features end-to-end: QA gate before publish,
 * plain-English explanation, client progress tracker, methodology decision
 * log, and persisted bull/base/bear scenarios.
 */
describe.skipIf(!dbUp)('improvements phase 1', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engineStub: FastifyInstance;
  let aiStub: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let otherClient: Awaited<ReturnType<typeof seedUser>>;

  let lastAiPayload: Record<string, any> | null = null;
  let aiQaResponse: Record<string, unknown> = { findings: [], assessment: 'Clean.', verdict: 'pass' };

  const BASE_INPUTS = {
    income: { discount_rate: 0.25, terminal_growth: 0.03, free_cash_flows: [100_000, 200_000] },
    market: { metric: 5_000_000, multiples: [4, 6] },
    volatility: 0.6,
    shares_outstanding_common: 10_000_000,
  };

  const createValuation = async (name: string, token = client.token): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(token),
      payload: { kind: '409a', company_name: name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  const runCalculation = async (valuationId: string, inputs: Record<string, unknown> = BASE_INPUTS) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/calculations`,
      headers: authHeader(ops.token),
      payload: { inputs },
    });
    expect(res.statusCode).toBe(201);
    return res.json().calculation;
  };

  const advance = (valuationId: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/workflow/advance`,
      headers: authHeader(ops.token),
    });

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);

    engineStub = Fastify({ logger: false });
    engineStub.post('/engine/v1/compute', async (req) => {
      const body = req.body as Record<string, any>;
      const dr = body.inputs?.income?.discount_rate ?? 0.25;
      const equity = Math.round(20_000_000 * (0.25 / dr));
      return {
        engine_version: 'py-stub',
        results: { equity_value: equity, fmv_per_share: equity / 10_000_000, approaches: {} },
      };
    });
    await engineStub.listen({ port: 0, host: '127.0.0.1' });

    aiStub = Fastify({ logger: false });
    aiStub.post('/ai/v1/pipelines/:pipeline', async (req) => {
      const { pipeline } = req.params as { pipeline: string };
      lastAiPayload = req.body as Record<string, any>;
      const result =
        pipeline === 'qa'
          ? aiQaResponse
          : pipeline === 'explain'
            ? {
                summary: 'Your company was valued at $20M, or $2.00 per common share.',
                methodology: [
                  {
                    approach: 'Income approach',
                    weight: 0.6,
                    explanation: 'Discounts projected cash flows.',
                  },
                ],
                drivers: ['Revenue growth'],
                caveats: 'This explanation is informational only.',
              }
            : {};
      return { model: 'stub/model', result };
    });
    await aiStub.listen({ port: 0, host: '127.0.0.1' });

    const port = (s: FastifyInstance) => {
      const address = s.server.address();
      return typeof address === 'object' && address ? address.port : 0;
    };
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      ENGINE_URL: `http://127.0.0.1:${port(engineStub)}`,
      AI_URL: `http://127.0.0.1:${port(aiStub)}`,
      AUTO_PIPELINE: 'off',
    });
    app = buildApp({ config, pool });
    await app.ready();

    const seedCtx = { app, pool, teardown: async () => {} };
    ops = await seedUser(seedCtx, { roles: ['reviewer'] });
    client = await seedUser(seedCtx, { roles: ['valuation_user'] });
    otherClient = await seedUser(seedCtx, { roles: ['valuation_user'] });
  });

  afterAll(async () => {
    await app?.close();
    await engineStub?.close();
    await aiStub?.close();
    await db?.teardown();
  });

  // ── QA gate (IMPROVEMENTS_RESEARCH §4.3) ───────────────────────────────────

  describe('QA reviews and the publish gate', () => {
    it('refuses to review a valuation with no calculation', async () => {
      const id = await createValuation('NoCalcCo');
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/qa`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(422);
    });

    it('is operations-only', async () => {
      const id = await createValuation('QaRbacCo');
      await runCalculation(id);
      for (const method of ['POST', 'GET'] as const) {
        const res = await app.inject({
          method,
          url: `/api/v1/valuations/${id}/qa`,
          headers: authHeader(client.token),
        });
        expect(res.statusCode).toBe(403);
      }
    });

    it('blocks publish until a QA review exists, then allows it', async () => {
      const id = await createValuation('GateCo');
      await runCalculation(id);

      // Walk the happy path to draft_accepted and sign.
      for (let i = 0; i < 8; i++) {
        const res = await advance(id);
        expect(res.statusCode).toBe(200);
      }
      const sign = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/signatures`,
        headers: authHeader(ops.token),
        payload: { role: 'main', signer_name: 'Alice Analyst', signature_text: 'Alice Analyst' },
      });
      expect(sign.statusCode).toBe(201);

      // Signature alone no longer opens the gate: QA is missing.
      const blocked = await advance(id);
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().detail).toContain('QA review');

      const qa = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/qa`,
        headers: authHeader(ops.token),
      });
      expect(qa.statusCode).toBe(201);
      expect(qa.json().review.status).toBe('pass');
      expect(qa.json().review.checks.map((c: { key: string }) => c.key)).toContain('fmv_positive');

      const published = await advance(id);
      expect(published.statusCode).toBe(200);
      expect(published.json().valuation.state).toBe('published');

      // The review and the gate outcome are on the audit spine.
      const events = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/events`,
        headers: authHeader(ops.token),
      });
      expect(events.json().events.map((e: { type: string }) => e.type)).toContain('qa_review_completed');
    });

    it('a recalculation invalidates the previous QA review', async () => {
      const id = await createValuation('RecalcCo');
      await runCalculation(id);
      await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/qa`,
        headers: authHeader(ops.token),
      });

      let gate = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/qa`,
        headers: authHeader(ops.token),
      });
      expect(gate.json().gate.satisfied).toBe(true);

      await runCalculation(id); // new latest calculation, unreviewed
      gate = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/qa`,
        headers: authHeader(ops.token),
      });
      expect(gate.json().gate.satisfied).toBe(false);
    });

    it('deterministic checks fail an indefensible calculation', async () => {
      const id = await createValuation('BadMathCo');
      await runCalculation(id, {
        ...BASE_INPUTS,
        income: { discount_rate: 0.02, terminal_growth: 0.05, free_cash_flows: [100_000] },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/qa`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(201);
      const review = res.json().review;
      expect(review.status).toBe('fail');
      const failing = review.checks.find((c: { key: string }) => c.key === 'discount_vs_growth');
      expect(failing.status).toBe('fail');

      const gate = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/qa`,
        headers: authHeader(ops.token),
      });
      expect(gate.json().gate.satisfied).toBe(false);
    });

    it('the AI reviewer tightens the verdict and gets the calculation, not documents', async () => {
      const id = await createValuation('AiQaCo');
      await runCalculation(id);
      aiQaResponse = {
        findings: [{ area: 'assumptions', finding: 'Volatility looks low for the sector', severity: 'warn' }],
        assessment: 'Broadly reasonable.',
        verdict: 'warn',
      };
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/qa`,
        headers: authHeader(ops.token),
        payload: { ai: true },
      });
      expect(res.statusCode).toBe(201);
      const review = res.json().review;
      expect(review.status).toBe('warn'); // pass (deterministic) tightened by warn (AI)
      expect(review.ai_model).toBe('stub/model');
      expect(review.ai_findings.verdict).toBe('warn');

      expect(lastAiPayload?.calculation?.fmv_per_share).toBeDefined();
      expect(Array.isArray(lastAiPayload?.qa_checks)).toBe(true);
      expect(lastAiPayload?.documents).toEqual([]);

      // The AI run is recorded as a provenance-bearing ai_job.
      const jobs = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/ai`,
        headers: authHeader(ops.token),
      });
      expect(jobs.json().jobs.some((j: { pipeline: string }) => j.pipeline === 'qa')).toBe(true);
    });

    it("the generic AI route refuses 'qa' so reviews always carry the checks", async () => {
      const id = await createValuation('NoShortcutCo');
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/ai/qa`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain('/qa');
    });
  });

  // ── Plain-English explanation (§4.5) ───────────────────────────────────────

  describe('plain-English explanation', () => {
    it('requires a calculation first', async () => {
      const id = await createValuation('NoCalcExplainCo');
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/ai/explain`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(422);
    });

    it('generates and exposes the explanation with report visibility rules', async () => {
      const id = await createValuation('ExplainCo');
      await runCalculation(id);

      const run = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/ai/explain`,
        headers: authHeader(ops.token),
      });
      expect(run.statusCode).toBe(201);
      expect(lastAiPayload?.calculation?.results).toBeDefined();

      // Ops see it immediately.
      const opsView = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/explanation`,
        headers: authHeader(ops.token),
      });
      expect(opsView.json().explanation.summary).toContain('$20M');

      // The owner does NOT see it before a draft is shared…
      const early = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/explanation`,
        headers: authHeader(client.token),
      });
      expect(early.statusCode).toBe(200);
      expect(early.json().explanation).toBeNull();

      // …but does once the valuation reaches 'drafted'.
      for (let i = 0; i < 7; i++) await advance(id);
      const after = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/explanation`,
        headers: authHeader(client.token),
      });
      expect(after.json().explanation.summary).toContain('per common share');

      // Strangers get a 404, not a 403 leak.
      const stranger = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/explanation`,
        headers: authHeader(otherClient.token),
      });
      expect(stranger.statusCode).toBe(404);
    });
  });

  // ── Client progress tracker (§5.6) ─────────────────────────────────────────

  describe('client progress tracker', () => {
    it('reports stages, checklist and a client-safe timeline', async () => {
      const id = await createValuation('ProgressCo');

      let res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/progress`,
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(200);
      let body = res.json();
      expect(body.stages.map((s: { key: string }) => s.key)).toEqual([
        'setup',
        'documents',
        'analysis',
        'draft',
        'delivered',
      ]);
      expect(body.stages[0].status).toBe('current');
      expect(body.checklist).toHaveLength(6);
      expect(body.checklist.every((c: { uploaded: boolean }) => !c.uploaded)).toBe(true);
      expect(body.report.available).toBe(false);
      expect(body.timeline.map((t: { label: string }) => t.label)).toContain('Valuation created');

      // A cap-table upload ticks the checklist and lands on the timeline.
      await createDocument(
        pool,
        {
          valuationId: id,
          kind: 'cap_table',
          filename: 'cap.csv',
          contentType: 'text/csv',
          sizeBytes: 10,
          sha256: 'x'.repeat(64),
          storagePath: `${id}/cap.csv`,
          uploadedBy: client.id,
        },
        { actorType: 'human', actorId: client.id, source: 'api' },
      );
      // Two workflow steps: setup done, documents current.
      await advance(id);
      await advance(id);

      res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/progress`,
        headers: authHeader(client.token),
      });
      body = res.json();
      expect(body.checklist.find((c: { kind: string }) => c.kind === 'cap_table').uploaded).toBe(true);
      expect(body.stages[0].status).toBe('done');
      expect(body.stages[1].status).toBe('current');
      expect(body.stages[1].entered_at).toBeTruthy();
      const uploaded = body.timeline.find((t: { type: string }) => t.type === 'document_uploaded');
      expect(uploaded.detail).toBe('cap.csv');
      const stateChange = body.timeline.find((t: { type: string }) => t.type === 'state_changed');
      expect(stateChange.detail).toBeTruthy();
    });

    it('marks halted valuations', async () => {
      const id = await createValuation('HaltedCo');
      const cancel = await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${id}`,
        headers: authHeader(ops.token),
        payload: { state: 'cancelled' },
      });
      expect(cancel.statusCode).toBe(200);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/progress`,
        headers: authHeader(client.token),
      });
      expect(res.json().halted).toBe(true);
    });

    it('is scoped to valuation readers', async () => {
      const id = await createValuation('ProgressScopeCo');
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/progress`,
        headers: authHeader(otherClient.token),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── Methodology decision log (§5.3) ────────────────────────────────────────

  describe('methodology decision log', () => {
    it('records decisions with rationale, ops-only, with supersede chains', async () => {
      const id = await createValuation('DecisionCo');

      const forbidden = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/decisions`,
        headers: authHeader(client.token),
        payload: { category: 'dlom', decision: 'x', rationale: 'y' },
      });
      expect(forbidden.statusCode).toBe(403);

      const first = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/decisions`,
        headers: authHeader(ops.token),
        payload: {
          category: 'dlom',
          decision: 'DLOM of 30% via Finnerty',
          rationale: 'Pre-revenue, no secondary market activity.',
        },
      });
      expect(first.statusCode).toBe(201);
      const firstId = first.json().decision.id;

      const second = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/decisions`,
        headers: authHeader(ops.token),
        payload: {
          category: 'dlom',
          decision: 'DLOM revised to 25%',
          rationale: 'Secondary transaction observed in Q2.',
          supersedes: firstId,
        },
      });
      expect(second.statusCode).toBe(201);

      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/decisions`,
        headers: authHeader(ops.token),
      });
      const decisions = list.json().decisions;
      expect(decisions).toHaveLength(2);
      expect(decisions[0].superseded).toBe(true);
      expect(decisions[1].superseded).toBe(false);
      expect(decisions[1].supersedes).toBe(firstId);

      // Supersede must reference a decision of the SAME valuation.
      const otherId = await createValuation('OtherDecisionCo');
      const cross = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${otherId}/decisions`,
        headers: authHeader(ops.token),
        payload: { category: 'dlom', decision: 'x', rationale: 'y', supersedes: firstId },
      });
      expect(cross.statusCode).toBe(422);

      const events = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/events`,
        headers: authHeader(ops.token),
      });
      expect(
        events.json().events.filter((e: { type: string }) => e.type === 'methodology_decision_recorded'),
      ).toHaveLength(2);
    });
  });

  // ── Persisted scenarios (§5.7) ─────────────────────────────────────────────

  describe('persisted bull/base/bear scenarios', () => {
    it('saves, lists and deletes named scenarios computed by the engine', async () => {
      const id = await createValuation('ScenarioCo');
      await runCalculation(id);

      const saved = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/scenarios`,
        headers: authHeader(client.token),
        payload: { name: 'Bear case', label: 'bear', discount_rate: 0.5 },
      });
      expect(saved.statusCode).toBe(201);
      const scenario = saved.json().scenario;
      // 2× discount rate halves the stubbed engine value: 20M → 10M.
      expect(Number(scenario.equity_value)).toBe(10_000_000);
      expect(scenario.label).toBe('bear');
      expect(scenario.inputs).toEqual({ discount_rate: 0.5 });

      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/scenarios`,
        headers: authHeader(client.token),
      });
      const body = list.json();
      expect(body.scenarios).toHaveLength(1);
      expect(body.baseline.equity_value).toBe(20_000_000);
      expect(body.max_scenarios).toBeGreaterThan(0);

      // Strangers can't see or delete; the creator can.
      const strangerDelete = await app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${id}/scenarios/${scenario.id}`,
        headers: authHeader(otherClient.token),
      });
      expect(strangerDelete.statusCode).toBe(404);

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${id}/scenarios/${scenario.id}`,
        headers: authHeader(client.token),
      });
      expect(deleted.statusCode).toBe(204);

      const events = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/events`,
        headers: authHeader(ops.token),
      });
      const types = events.json().events.map((e: { type: string }) => e.type);
      expect(types).toContain('scenario_saved');
      expect(types).toContain('scenario_deleted');
    });

    it('requires a calculation and a valid body', async () => {
      const fresh = await createValuation('FreshScenarioCo');
      const noCalc = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${fresh}/scenarios`,
        headers: authHeader(client.token),
        payload: { name: 'Bull', label: 'bull' },
      });
      expect(noCalc.statusCode).toBe(422);

      const id = await createValuation('BadBodyCo');
      await runCalculation(id);
      const badLabel = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/scenarios`,
        headers: authHeader(client.token),
        payload: { name: 'X', label: 'moon' },
      });
      expect(badLabel.statusCode).toBe(422);
    });

    it('caps the number of saved scenarios', async () => {
      const id = await createValuation('CapCo');
      await runCalculation(id);
      for (let i = 0; i < 12; i++) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${id}/scenarios`,
          headers: authHeader(client.token),
          payload: { name: `Case ${i}` },
        });
        expect(res.statusCode).toBe(201);
      }
      const overflow = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/scenarios`,
        headers: authHeader(client.token),
        payload: { name: 'One too many' },
      });
      expect(overflow.statusCode).toBe(422);
      expect(overflow.json().detail).toContain('at most');
    });
  });
});
