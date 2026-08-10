import { inflateSync } from 'node:zlib';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import type { IntakeField, IntakeSection } from '../../src/domain/intake.js';

/**
 * One engagement, start to finish, through the HTTP API.
 *
 * Every stage of this already has coverage on its own — intake validates, the
 * engine payload assembles, the exhibits render, the board resolution derives
 * its number, the publish gate refuses without a signature. What has never
 * been asserted is that the stages are *connected*: that the figure a client
 * types into the questionnaire is the figure the engine is asked about, that
 * the value the engine returns is the value that reaches the PDF, and that the
 * same value is what a board member is shown before they sign a resolution
 * adopting it.
 *
 * That chain is the product. A break anywhere in it is a report stating a
 * number nobody computed, which is the one defect this system cannot ship —
 * and every per-stage test would still pass.
 *
 * The engine is stubbed (no Python service runs in this suite), but it is
 * stubbed by recording the payload it receives and answering from it, so the
 * assertions about what reached the engine are assertions about the real
 * request the real engine would have got.
 */

const dbUp = await isDbAvailable();

const FMV_PER_SHARE = 2.7431;
const EQUITY_VALUE = 41_146_500;
const COMPANY = 'Lifecycle Robotics, Inc.';
const VALUATION_DATE = '2026-03-31';
const COMMON_SHARES = 8_000_000;

/**
 * An answer that satisfies a field's declared rules.
 *
 * Derived from the schema rather than hardcoded so the test keeps working when
 * a field is added — a lifecycle test that has to be edited every time intake
 * gains a question is a lifecycle test that gets deleted.
 */
function answerFor(field: IntakeField): unknown {
  switch (field.type) {
    case 'number': {
      const min = field.rules?.min ?? 1;
      const max = field.rules?.max ?? min + 1_000;
      const value = Math.min(Math.max(min === 0 ? 1 : min, 12), max);
      return field.rules?.integer ? Math.round(value) : value;
    }
    case 'date': {
      // Comfortably in the past (so `notFuture` holds) and after any `minDate`.
      const floor = field.rules?.minDate ?? '2020-06-15';
      return floor > '2020-06-15' ? floor : '2020-06-15';
    }
    case 'boolean':
      return true;
    case 'select':
      return field.options?.[0] ?? null;
    default:
      return 'Recorded during intake.'.slice(0, field.rules?.maxLength ?? 200);
  }
}

function answersFrom(sections: IntakeSection[]): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const section of sections) {
    for (const field of section.fields) answers[field.key] = answerFor(field);
  }
  return answers;
}

/** Readable text out of a PDF, with compression off — how this repo asserts PDFs. */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const streams = raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g);
  let text = raw;
  for (const [, body] of streams) {
    try {
      text += inflateSync(Buffer.from(body!, 'latin1')).toString('latin1');
    } catch {
      /* not a deflate stream — already covered by `raw` */
    }
  }
  return text;
}

interface EngineState {
  computePayloads: Array<Record<string, unknown>>;
  validatePayloads: Array<Record<string, unknown>>;
}

/**
 * Stands in for engine-wrapper. Answers /compute from a fixed conclusion so the
 * downstream assertions have a known number to chase, and records every payload
 * so the upstream assertions can check what the engine was actually asked.
 */
async function startEngineStub(state: EngineState) {
  const stub = Fastify({ logger: false });
  stub.post('/engine/v1/validate', async (req) => {
    state.validatePayloads.push(req.body as Record<string, unknown>);
    return { engine_version: 'py-stub', ok: true, errors: [], warnings: [] };
  });
  stub.post('/engine/v1/compute', async (req) => {
    state.computePayloads.push(req.body as Record<string, unknown>);
    return {
      engine_version: 'py-stub-1.0',
      results: {
        equity_value: EQUITY_VALUE,
        fmv_per_share: FMV_PER_SHARE,
        common_equity_value: 21_944_800,
        fully_diluted_common: COMMON_SHARES,
        allocation_method: 'opm',
        approaches: {
          income: { weight: 0.5, equity_value: 40_000_000 },
          market: { weight: 0.5, equity_value: 42_293_000, selected_multiple: 6.5 },
        },
        allocation: {
          method: 'opm_waterfall',
          common_per_share: FMV_PER_SHARE,
          common_shares: COMMON_SHARES,
          common_value: 21_944_800,
        },
      },
      warnings: [],
      trace: { steps: [{ name: 'weighted_equity', value: EQUITY_VALUE }] },
    };
  });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

describe.skipIf(!dbUp)('the valuation lifecycle, end to end', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engine: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const engineState: EngineState = { computePayloads: [], validatePayloads: [] };

  const asOps = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: authHeader(ops.token), ...(payload ? { payload } : {}) });
  const asClient = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: authHeader(client.token), ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    engine = await startEngineStub(engineState);

    app = buildApp({
      config: loadConfig({
        ...process.env,
        NODE_ENV: 'test',
        JWT_SECRET: 'integration-test-secret-0123456789abcdef',
        LOG_LEVEL: 'silent',
        ENGINE_URL: engine.url,
        // The orchestrator would race this test for the same valuation.
        AUTO_PIPELINE: 'off',
      }),
      pool,
    });
    await app.ready();

    const ctx = { app, pool, teardown: async () => {} };
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });

  afterAll(async () => {
    await app?.close();
    await engine?.close();
    await db?.teardown();
  });

  // ── 1. Intake ─────────────────────────────────────────────────────────────

  it('opens an engagement the client owns', async () => {
    const res = await asClient('POST', '/api/v1/valuations', {
      kind: '409a',
      company_name: COMPANY,
      currency: 'USD',
    });
    expect(res.statusCode).toBe(201);
    valuationId = res.json().valuation.id as string;
    expect(res.json().valuation.state).toBe('pending');
  });

  it('refuses to submit a questionnaire that is not complete', async () => {
    const res = await asClient('POST', `/api/v1/valuations/${valuationId}/questionnaire/submit`);
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/Complete all required fields/i);
  });

  it('accepts the client’s answers and reports the engagement complete', async () => {
    const schema = await asClient('GET', `/api/v1/valuations/${valuationId}/questionnaire`);
    expect(schema.statusCode).toBe(200);
    const sections = schema.json().sections as IntakeSection[];
    expect(sections.length).toBeGreaterThan(0);

    const saved = await asClient('PUT', `/api/v1/valuations/${valuationId}/questionnaire`, {
      answers: answersFrom(sections),
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().completion.ready).toBe(true);
    // Warnings are the client's call; errors would have to be sent back.
    expect(
      (saved.json().issues as Array<{ severity: string }>).filter((i) => i.severity === 'error'),
    ).toEqual([]);

    const submitted = await asClient('POST', `/api/v1/valuations/${valuationId}/questionnaire/submit`);
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().submitted_at).toBeTruthy();
  });

  // ── 2. Data collection ────────────────────────────────────────────────────

  it('records the methodology and the engine inputs an analyst assembled', async () => {
    const params = await asOps('PATCH', `/api/v1/valuations/${valuationId}/params`, {
      weight_income: 0.5,
      weight_market: 0.5,
      weight_asset: 0,
      weight_opm: 0,
      dlom: 0.25,
    });
    expect(params.statusCode).toBe(200);

    const inputs = await asOps('PATCH', `/api/v1/valuations/${valuationId}/engine-inputs`, {
      valuation_date: VALUATION_DATE,
      cash: 3_000_000,
      debt: 1_000_000,
      shares_outstanding_common: COMMON_SHARES,
      income: { free_cash_flows: [1_000_000, 1_500_000], discount_rate: 0.25, terminal_growth: 0.03 },
      market: { metric: 4_000_000, multiples: [5.0, 6.5, 7.1] },
    });
    expect(inputs.statusCode).toBe(200);
  });

  // ── 3. Calculation ────────────────────────────────────────────────────────

  it('asks the engine to pre-flight the very payload it would compute', async () => {
    const res = await asOps('POST', `/api/v1/valuations/${valuationId}/calculations/preflight`);
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    const sent = engineState.validatePayloads.at(-1)!;
    expect((sent.inputs as Record<string, unknown>).valuation_date).toBe(VALUATION_DATE);
  });

  it('computes, and sends the analyst’s inputs and weights to the engine', async () => {
    const res = await asOps('POST', `/api/v1/valuations/${valuationId}/calculations`);
    expect(res.statusCode).toBe(201);

    const calculation = res.json().calculation;
    expect(calculation.status).toBe('succeeded');
    expect(Number(calculation.fmv_per_share)).toBe(FMV_PER_SHARE);
    expect(calculation.engine_version).toBe('py-stub-1.0');

    // The seam: what the analyst entered is what the engine was asked about.
    const sent = engineState.computePayloads.at(-1)!;
    const sentInputs = sent.inputs as Record<string, unknown>;
    expect(sentInputs.valuation_date).toBe(VALUATION_DATE);
    expect(sentInputs.shares_outstanding_common).toBe(COMMON_SHARES);
    expect((sentInputs.market as { multiples: number[] }).multiples).toEqual([5.0, 6.5, 7.1]);
    const sentParams = sent.params as Record<string, unknown>;
    expect(Number(sentParams.dlom)).toBe(0.25);
    expect(Number(sentParams.weight_income)).toBe(0.5);
    expect(Number(sentParams.weight_market)).toBe(0.5);
  });

  it('refuses a calculation to anyone but operations', async () => {
    const res = await asClient('POST', `/api/v1/valuations/${valuationId}/calculations`);
    expect(res.statusCode).toBe(403);
  });

  // ── 4. Review ─────────────────────────────────────────────────────────────

  it('walks the engagement to review and approves it', async () => {
    // pending → started → onboarding_completed → user_finished → completed → review
    for (let i = 0; i < 5; i += 1) {
      const res = await asOps('POST', `/api/v1/valuations/${valuationId}/workflow/advance`);
      expect(res.statusCode).toBe(200);
    }
    const atReview = await asOps('GET', `/api/v1/valuations/${valuationId}`);
    expect(atReview.json().valuation.state).toBe('review');

    const decision = await asOps('POST', `/api/v1/valuations/${valuationId}/review/decision`, {
      decision: 'approve',
    });
    expect(decision.statusCode).toBe(200);
    expect(decision.json().valuation.state).toBe('reviewed');
  });

  // ── 5. Report generation ──────────────────────────────────────────────────

  it('opens a draft from the kind’s skeleton', async () => {
    const draft = await asOps('GET', `/api/v1/valuations/${valuationId}/report`);
    expect(draft.statusCode).toBe(200);
    expect(draft.json().version.version).toBe(1);
    expect(draft.json().report.template_version).toMatch(/^409a\.v/);
  });

  it('records the analyst’s authored body, placeholders and all', async () => {
    // The skeleton ships fill-me markers; an analyst replaces them. `{{...}}`
    // figure markers are left in deliberately — they are resolved at render
    // time from the calculation, never written back, so this body is also the
    // assertion that the resolution happens on the way out.
    const saved = await asOps('PUT', `/api/v1/valuations/${valuationId}/report`, {
      content: {
        title: `Valuation of the Common Stock of ${COMPANY}`,
        sections: [
          {
            key: 'purpose',
            heading: 'Purpose and Scope',
            html: `<p>This report states the fair market value of the common stock of ${COMPANY} as of ${VALUATION_DATE}.</p>`,
          },
          {
            key: 'conclusion',
            heading: 'Conclusion of Value',
            html: '<p>The fair market value of a share of common stock is {{fmv_per_share}}, on a total equity value of {{equity_value}}.</p>',
          },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().version.version).toBe(2);
    // Stored with its placeholders intact — a recalculation must restate the
    // prose, not leave a stale number frozen into the version.
    const stored = saved.json().version.content.sections[1].html as string;
    expect(stored).toContain('{{fmv_per_share}}');
  });

  it('renders a deliverable carrying the value the engine returned', async () => {
    const rendered = await asOps('POST', `/api/v1/valuations/${valuationId}/report/render`);
    expect(rendered.statusCode).toBe(200);
    expect(rendered.json().size_bytes).toBeGreaterThan(1000);

    const pdf = await asOps('GET', `/api/v1/valuations/${valuationId}/report.pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');

    const text = pdfText(pdf.rawPayload);
    expect(text).toContain(COMPANY);
    // The number the client will read is the number the engine computed. This
    // is the assertion the whole test exists for.
    expect(text).toContain('2.74');
    expect(text).toContain(VALUATION_DATE);
    // And the authored prose states it too — the marker resolved rather than
    // reaching the deliverable as literal braces.
    expect(text).not.toContain('{{fmv_per_share}}');
  });

  // ── 6. Board sign-off ─────────────────────────────────────────────────────

  it('derives the board resolution from the same conclusion', async () => {
    const res = await asOps('POST', `/api/v1/valuations/${valuationId}/board`, {
      valuation_date: VALUATION_DATE,
    });
    expect(res.statusCode).toBe(201);
    const { resolution } = res.json();
    expect(resolution.status).toBe('pending');
    // Not "a" number — the one that is in the PDF.
    expect(Number(resolution.fmv_conclusion)).toBe(FMV_PER_SHARE);
    expect(resolution.body_html).toContain(COMPANY);
  });

  let danaToken: string;
  let robinToken: string;

  it('mints a distinct signing token per board member', async () => {
    const dana = await asOps('POST', `/api/v1/valuations/${valuationId}/board/members`, {
      name: 'Dana Director',
      email: 'dana@board.example',
      title: 'Chair',
    });
    expect(dana.statusCode).toBe(201);
    danaToken = dana.json().sign_token as string;

    const robin = await asOps('POST', `/api/v1/valuations/${valuationId}/board/members`, {
      name: 'Robin Rep',
      email: 'robin@board.example',
    });
    expect(robin.statusCode).toBe(201);
    robinToken = robin.json().sign_token as string;

    expect(danaToken).toBeTruthy();
    expect(robinToken).toBeTruthy();
    // A shared token would let one director record the other's decision.
    expect(danaToken).not.toBe(robinToken);
  });

  it('refuses to add the same board member twice', async () => {
    const dupe = await asOps('POST', `/api/v1/valuations/${valuationId}/board/members`, {
      name: 'Dana Director',
      email: 'dana@board.example',
    });
    expect(dupe.statusCode).toBe(409);
  });

  it('lets a board member read and sign the resolution with their token alone', async () => {
    const signToken = danaToken;

    // No Authorization header anywhere below: a board member is not a user of
    // this system, and the token is the whole of their authority.
    const view = await app.inject({
      method: 'POST',
      url: '/api/v1/board/resolution',
      payload: { token: signToken },
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().member.name).toBe('Dana Director');
    expect(Number(view.json().resolution.fmv_conclusion)).toBe(FMV_PER_SHARE);

    const signed = await app.inject({
      method: 'POST',
      url: '/api/v1/board/sign',
      payload: { token: signToken, decision: 'signed', comment: 'Adopted as presented.' },
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.json().signoff.status).toBe('signed');
    expect(signed.json().resolution_status).toBe('approved');
  });

  it('refuses a second decision on the same token', async () => {
    const added = await asOps('POST', `/api/v1/valuations/${valuationId}/board/members`, {
      name: 'Robin Rep',
      email: 'robin@board.example',
    });
    const token = added.json().sign_token as string;

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/board/sign',
      payload: { token, decision: 'signed' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/board/sign',
      payload: { token, decision: 'rejected' },
    });
    expect(second.statusCode).toBe(409);
  });

  // ── 7. Publish ────────────────────────────────────────────────────────────

  it('will not publish without a main signature, however far along it is', async () => {
    // reviewed → drafted → draft_accepted, then the gate.
    for (let i = 0; i < 2; i += 1) {
      expect((await asOps('POST', `/api/v1/valuations/${valuationId}/workflow/advance`)).statusCode).toBe(
        200,
      );
    }
    const blocked = await asOps('POST', `/api/v1/valuations/${valuationId}/workflow/advance`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().detail).toMatch(/main signature is required/i);
  });

  it('will not publish a calculation that QA has not passed', async () => {
    const signed = await asOps('POST', `/api/v1/valuations/${valuationId}/signatures`, {
      role: 'main',
      signer_name: 'Avery Analyst',
      signer_title: 'Managing Director',
      signature_text: 'Avery Analyst',
    });
    expect(signed.statusCode).toBe(201);

    const blocked = await asOps('POST', `/api/v1/valuations/${valuationId}/workflow/advance`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().detail).toMatch(/QA review/i);
  });

  it('publishes once signed and QA-reviewed, and the client can then download it', async () => {
    const qa = await asOps('POST', `/api/v1/valuations/${valuationId}/qa`, { ai: false });
    expect(qa.statusCode).toBe(201);
    expect(qa.json().review.status).not.toBe('fail');

    const published = await asOps('POST', `/api/v1/valuations/${valuationId}/workflow/advance`);
    expect(published.statusCode).toBe(200);
    expect(published.json().valuation.state).toBe('published');

    const pdf = await asClient('GET', `/api/v1/valuations/${valuationId}/report.pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdfText(pdf.rawPayload)).toContain('2.74');
  });

  it('leaves the whole engagement on the audit spine', async () => {
    const res = await asOps('GET', `/api/v1/valuations/${valuationId}/events`);
    expect(res.statusCode).toBe(200);
    const types = new Set((res.json().events as Array<{ type: string }>).map((e) => e.type));
    // A 409A that cannot show its own history is not defensible, whatever the
    // number on the cover says.
    for (const required of ['intake_submitted', 'calculation_created', 'state_changed']) {
      expect(types).toContain(required);
    }
  });
});
