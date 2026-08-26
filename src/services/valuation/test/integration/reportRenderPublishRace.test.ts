import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { invalidateValuation } from '../../src/repos/valuations.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * A render still running when the engagement is published.
 *
 * `POST /report/render` refuses to re-render a delivered version, and the
 * comment over that refusal says why in the strongest terms the codebase uses:
 * the exhibits are computed at render time from the latest calculation, so
 * re-rendering v3 after publication puts *a different document with a different
 * concluded value* under a version number the client is already holding in
 * board minutes and an auditor's file, and nobody outside this system can tell.
 *
 * The check reads `valuation.state` at the top of the request. The write is
 * `storeRenderedPdf`, and between them sits the render itself — the summary and
 * exhibit queries, a branding lookup that fetches a white-label logo over the
 * network, and a delegated call to the report unit whose own budget is measured
 * in seconds (`clients/reportRender.ts`). Publication is one PATCH by a
 * reviewer in another tab. So the guard is not wrong, it is just early: the
 * request that passed it is the request that overwrites the delivered bytes.
 *
 * The window is staged inside the report unit's stub, which is honestly inside
 * it — the render is held there while the engagement publishes, exactly as a
 * slow render would be. The stub then declines, so the bytes that land come
 * from the in-process renderer the fallback exists to reach.
 */
async function startRenderStub(state: { gate: (() => Promise<void>) | null }) {
  const stub = Fastify({ logger: false });
  stub.post('/render/v1/pdf', async (_req, reply) => {
    await state.gate?.();
    // Decline, so the valuation service falls back to rendering in process and
    // a genuine PDF still reaches the store. The window is what this stub is
    // for; producing the bytes is not.
    return reply.status(503).send({ detail: 'stub declines' });
  });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

/** A gate the test can open by hand, and see somebody arrive at. */
function latch() {
  let open!: () => void;
  let arrive!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const arrived = new Promise<void>((r) => (arrive = r));
  return {
    arrived,
    open,
    hold: async () => {
      arrive();
      await opened;
    },
  };
}

describe.skipIf(!dbUp)('rendering a report that publishes mid-render', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let stub: Awaited<ReturnType<typeof startRenderStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const state = { gate: null as (() => Promise<void>) | null };

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    stub = await startRenderStub(state);

    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      REPORT_URL: stub.url,
    });
    app = buildApp({ config, pool });
    await app.ready();

    const seedCtx = { app, pool, teardown: async () => {} };
    ops = await seedUser(seedCtx, { roles: ['reviewer'] });
    const client = await seedUser(seedCtx, { roles: ['valuation_user'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'RenderRaceCo' },
    });
    valuationId = created.json().valuation.id;
    // Instantiates the report from the skeleton, which is what render needs.
    await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/report`,
      headers: authHeader(ops.token),
    });
  });

  afterAll(async () => {
    await app?.close();
    await stub?.close();
    await db?.teardown();
  });

  const render = () =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/report/render`,
      headers: authHeader(ops.token),
    });

  const storedPdf = async (): Promise<Buffer | null> => {
    const { rows } = await pool.query<{ pdf: Buffer | null }>(
      `SELECT v.pdf FROM report_versions v
         JOIN reports r ON r.id = v.report_id
        WHERE r.valuation_id = $1 ORDER BY v.version DESC LIMIT 1`,
      [valuationId],
    );
    return rows[0]?.pdf ?? null;
  };

  it('stores the deliverable on an ordinary render', async () => {
    state.gate = null;
    const res = await render();
    expect(res.statusCode).toBe(200);
    expect((await storedPdf())?.length).toBeGreaterThan(0);
  });

  it('never replaces the bytes of a version that published while it rendered', async () => {
    const delivered = await storedPdf();
    expect(delivered).not.toBeNull();

    // The second render must be able to produce a *different* document, or the
    // overwrite is invisible and the test proves nothing: the cover states the
    // company name, so moving it is enough to tell the two renders apart.
    await pool.query(`UPDATE valuations SET company_name = 'RenamedCo' WHERE id = $1`, [valuationId]);
    invalidateValuation(valuationId);

    const gate = latch();
    state.gate = gate.hold;
    const inFlight = render();
    await gate.arrived;

    /*
     * The engagement publishes while the render is held. Set directly rather
     * than through the workflow route: what is under test is the render's
     * window, and reproducing the publish gate's own preconditions here would
     * be re-testing `publishGateRace.test.ts` in order to arrive at one column.
     */
    await pool.query(`UPDATE valuations SET state = 'published' WHERE id = $1`, [valuationId]);
    // `findValuationById` memoises for five seconds, and the publish route
    // clears that entry as it commits (`invalidateValuationAfter`). Writing the
    // column behind it and leaving the cache warm would be staging a *second*
    // bug rather than this one — the in-flight render is stale because it read
    // the row before the publish, not because a cache told it something old.
    invalidateValuation(valuationId);
    gate.open();
    const res = await inFlight;
    state.gate = null;

    // Either answer is defensible — the render may finish and be turned away,
    // or be turned away before it starts. What may not happen is the delivered
    // document quietly becoming a different document under the same version.
    const after = await storedPdf();
    expect(after, 'the delivered bytes were replaced by a later render').toEqual(delivered);
    expect(res.statusCode).not.toBe(200);
  });

  it('still renders a published version that has no deliverable stored yet', async () => {
    // The refusal is about replacing bytes somebody is holding, not about the
    // state: an engagement published before anything was rendered still has to
    // be able to produce its deliverable.
    await pool.query(
      `UPDATE report_versions v SET pdf = NULL, rendered_at = NULL
         FROM reports r WHERE r.id = v.report_id AND r.valuation_id = $1`,
      [valuationId],
    );
    invalidateValuation(valuationId);
    state.gate = null;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/report.pdf`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect((await storedPdf())?.length).toBeGreaterThan(0);
  });
});
