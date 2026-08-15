import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { patchValuation } from '../../src/repos/valuations.js';
import type { ValuationRow } from '../../src/repos/valuations.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

/**
 * Drafting the report's prose, and putting it in.
 *
 * Everything upstream of this route already worked. `report_narrative` has
 * drafted these chapters from a finished calculation for as long as the agent
 * has existed, and the research topics behind it retrieve and synthesise the
 * public record. What did not exist was any path from `ai_jobs.result` into
 * `report_versions.content` — so an analyst read the draft in one tab and
 * retyped it into another, and when nobody did, the 409A went out with the
 * skeleton's "Describe the business of …" where its Company Overview belonged.
 */

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

const PROSE = (topic: string) =>
  `${topic} is set out at length here, in the professional register a reviewing auditor expects, ` +
  `with the figures the calculation produced and nothing invented beside them.`;

/**
 * Replays a canned narrative and records how many times it was asked for one.
 *
 * `duringRun` is the only way to stage the thing this route actually races: an
 * analyst saving a chapter while the agent is working. The window is the round
 * trip to the AI service, so running the save inside the stub's handler puts it
 * exactly there — after the route's first read of the body, before it applies
 * anything — rather than approximating it with a hand-ordered pair of calls.
 */
async function startAiStub(state: {
  calls: number;
  sections: Array<Record<string, unknown>>;
  duringRun?: (() => Promise<void>) | null;
}) {
  const stub = Fastify({ logger: false });
  stub.post('/ai/v1/pipelines/report_narrative', async (_req, reply) => {
    state.calls += 1;
    if (state.duringRun) await state.duringRun();
    return reply.status(200).send({ model: 'stub-model', result: { sections: state.sections } });
  });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

describe.skipIf(!dbUp)('drafting the report narrative', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let aiStub: Awaited<ReturnType<typeof startAiStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  const state: {
    calls: number;
    duringRun: (() => Promise<void>) | null;
    sections: Array<Record<string, unknown>>;
  } = {
    calls: 0,
    duringRun: null,
    sections: [
      { key: 'company_overview', title: 'Company Overview', body: PROSE('Northwind Robotics') },
      { key: 'valuation_methodology', title: 'Methodology', body: PROSE('The methodology') },
      { key: 'dlom_analysis', title: 'DLOM', body: PROSE('The marketability discount') },
      // Nothing to say about an approach that carried no weight.
      { key: 'asset_approach', title: 'Asset', body: 'N/A.' },
      // A chapter this report has no home for.
      { key: 'repurchase_obligation', title: 'Repurchase', body: PROSE('The repurchase obligation') },
    ] as Array<Record<string, unknown>>,
  };

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    aiStub = await startAiStub(state);
    app = buildApp({
      config: loadConfig({
        ...process.env,
        NODE_ENV: 'test',
        JWT_SECRET: 'integration-test-secret-0123456789abcdef',
        LOG_LEVEL: 'silent',
        AI_URL: aiStub.url,
        AUTO_PIPELINE: 'off',
        EMAIL_MODE: 'off',
      }),
      pool,
    });
    await app.ready();
    ops = await seedUser({ app, pool, teardown: async () => {} }, { roles: ['reviewer'] });
    client = await seedUser({ app, pool, teardown: async () => {} }, { roles: ['valuation_user'] });
  });

  afterAll(async () => {
    await app?.close();
    await aiStub?.close();
    await db?.teardown();
  });

  /** A valuation with a finished calculation and a freshly drafted report. */
  async function engagement(company: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: company },
    });
    const id = created.json().valuation.id as string;
    await createCalculation(
      pool,
      {
        valuationId: id,
        engineVersion: '1.4.0',
        status: 'succeeded',
        inputs: { params: {}, inputs: {} },
        results: { equity_value: 42_000_000, fmv_per_share: 1.2345 },
        equityValue: 42_000_000,
        fmvPerShare: 1.2345,
        createdBy: client.id,
      },
      { ...actor, actorId: client.id },
    );
    // First GET instantiates the template — this is the v1 skeleton the
    // overwrite rule compares against.
    await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/report`,
      headers: authHeader(ops.token),
    });
    return id;
  }

  const draft = (id: string, body: Record<string, unknown> = {}, token = ops.token) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/report/narrative`,
      headers: authHeader(token),
      payload: body,
    });

  const sectionsOf = async (id: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/report`,
      headers: authHeader(ops.token),
    });
    return (res.json().version.content.sections as Array<{ key: string; html: string }>).reduce(
      (map, s) => map.set(s.key, s.html),
      new Map<string, string>(),
    );
  };

  it('writes the drafted chapters into the report', async () => {
    const id = await engagement('Narrative One, Inc.');
    const res = await draft(id, { reuse: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().changed).toBe(true);

    const sections = await sectionsOf(id);
    expect(sections.get('company_overview')).toContain('Northwind Robotics is set out at length');
    // And the key that had to be translated on the way in.
    expect(sections.get('methodology')).toContain('The methodology is set out');
    expect(sections.get('dlom')).toContain('The marketability discount');
  });

  it('replaces the skeleton, so no instruction survives into the deliverable', async () => {
    const id = await engagement('Narrative Two, Inc.');
    const before = await sectionsOf(id);
    expect(before.get('company_overview')).toContain('Describe the business');

    await draft(id, { reuse: false });
    const after = await sectionsOf(id);
    expect(after.get('company_overview')).not.toContain('Describe the business');
  });

  it('reports what it did with each drafted chapter', async () => {
    const id = await engagement('Narrative Three, Inc.');
    const applied = (await draft(id, { reuse: false })).json().applied as Array<{
      source_key: string;
      section_key: string | null;
      outcome: string;
    }>;
    const by = new Map(applied.map((a) => [a.source_key, a]));
    expect(by.get('company_overview')!.outcome).toBe('written');
    // "N/A." is not a chapter of a 409A.
    expect(by.get('asset_approach')!.outcome).toBe('empty');
    // And a chapter belonging to some other report type says so rather than
    // vanishing.
    expect(by.get('repurchase_obligation')).toMatchObject({ section_key: null, outcome: 'unmatched' });
  });

  it('does not overwrite a chapter the analyst has written', async () => {
    // The property the whole feature rests on: a re-run must not discard an
    // afternoon's editing in a document a named appraiser signs.
    const id = await engagement('Narrative Four, Inc.');
    const current = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/report`,
        headers: authHeader(ops.token),
      })
    ).json().version.content;
    const overview = current.sections.find((s: { key: string }) => s.key === 'company_overview');
    overview.html = '<p>Written by the analyst, at some length and with care.</p>';
    await app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${id}/report`,
      headers: authHeader(ops.token),
      payload: { content: current },
    });

    const applied = (await draft(id, { reuse: false })).json().applied as Array<{
      source_key: string;
      outcome: string;
    }>;
    expect(applied.find((a) => a.source_key === 'company_overview')!.outcome).toBe('kept');
    expect((await sectionsOf(id)).get('company_overview')).toContain('Written by the analyst');
  });

  /**
   * The same overwrite rule, against a save that lands *during* the run.
   *
   * "Does not overwrite a chapter the analyst has written" above stages the
   * save before the run, which is the easy half — the route reads the body once
   * at the top, so it sees that edit. The hard half is the edit that arrives
   * after that read: the agent takes minutes, the button that starts it sits in
   * the tab the analyst is typing in, and waiting for a draft is exactly the
   * time somebody uses to write. Applying to the body as first read would carry
   * the pre-edit text back over their chapter, in a document a named appraiser
   * signs, while reporting the outcome as if the rule had been honoured.
   */
  it('applies the draft to the body as it stands when the agent returns', async () => {
    const id = await engagement('Narrative Eleven, Inc.');
    state.duringRun = async () => {
      const current = (
        await app.inject({
          method: 'GET',
          url: `/api/v1/valuations/${id}/report`,
          headers: authHeader(ops.token),
        })
      ).json().version.content;
      current.sections.find((s: { key: string }) => s.key === 'company_overview').html =
        '<p>Written by the analyst while the agent was still running.</p>';
      await app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${id}/report`,
        headers: authHeader(ops.token),
        payload: { content: current },
      });
    };
    try {
      const res = await draft(id, { reuse: false });
      expect(res.statusCode, res.body).toBe(200);
      const applied = res.json().applied as Array<{ source_key: string; outcome: string }>;
      expect(applied.find((a) => a.source_key === 'company_overview')!.outcome).toBe('kept');
    } finally {
      state.duringRun = null;
    }

    const sections = await sectionsOf(id);
    expect(sections.get('company_overview')).toContain('while the agent was still running');
    // And the chapters nobody had written are still drafted: rebasing onto the
    // current body is not the same as abandoning the run.
    expect(sections.get('dlom')).toContain('The marketability discount');
  });

  it('overwrites when explicitly told to', async () => {
    const id = await engagement('Narrative Five, Inc.');
    const current = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/report`,
        headers: authHeader(ops.token),
      })
    ).json().version.content;
    current.sections.find((s: { key: string }) => s.key === 'company_overview').html =
      '<p>Written by the analyst.</p>';
    await app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${id}/report`,
      headers: authHeader(ops.token),
      payload: { content: current },
    });

    await draft(id, { reuse: false, overwrite: true });
    expect((await sectionsOf(id)).get('company_overview')).toContain('Northwind Robotics is set out');
  });

  it('appends a version rather than rewriting one', async () => {
    // The history has to show that a machine wrote this, and what the document
    // said before it did.
    const id = await engagement('Narrative Six, Inc.');
    const res = await draft(id, { reuse: false });
    expect(res.json().version).toBe(2);

    const versions = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/report/versions`,
      headers: authHeader(ops.token),
    });
    expect((versions.json().versions as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it('leaves no version behind when it wrote nothing', async () => {
    // A run that changed nothing must not leave a version claiming it did.
    const id = await engagement('Narrative Seven, Inc.');
    await draft(id, { reuse: false });
    const second = await draft(id, { reuse: false });
    expect(second.json().changed).toBe(false);
    expect(second.json().version).toBe(2);
  });

  it('reuses the last draft rather than paying for another', async () => {
    const id = await engagement('Narrative Eight, Inc.');
    const before = state.calls;
    await draft(id, { reuse: false });
    expect(state.calls).toBe(before + 1);
    // The second call finds the job and does not go back to the agent.
    await draft(id, { reuse: true, overwrite: true });
    expect(state.calls).toBe(before + 1);
  });

  it('refuses to draft into a published engagement', async () => {
    // Same reason a published report is not re-rendered: the client holds it.
    const id = await engagement('Narrative Nine, Inc.');
    const { rows } = await pool.query<ValuationRow>('SELECT * FROM valuations WHERE id = $1', [id]);
    await patchValuation(pool, rows[0]!, { state: 'published' }, { ...actor, actorId: ops.id });
    const res = await draft(id, { reuse: false });
    expect(res.statusCode).toBe(409);
  });

  it('is operations-only', async () => {
    const id = await engagement('Narrative Ten, Inc.');
    expect((await draft(id, { reuse: false }, client.token)).statusCode).toBe(403);
  });

  it('sanitizes what the model returned', async () => {
    // These bodies land in stored report HTML that the auditor portal renders
    // directly.
    const id = await engagement('Narrative Eleven, Inc.');
    const saved = state.sections;
    state.sections = [
      {
        key: 'company_overview',
        body: `${PROSE('Northwind')}\n\n<script>alert(1)</script>`,
      },
    ];
    await draft(id, { reuse: false });
    const html = (await sectionsOf(id)).get('company_overview')!;
    expect(html).not.toContain('<script>');
    state.sections = saved;
  });
});
