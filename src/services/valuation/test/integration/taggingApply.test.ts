import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import { upsertValuationTag } from '../../src/repos/valuationTags.js';
import { TAG_CATALOGUE } from '../../src/domain/valuationTags.js';

const dbUp = await isDbAvailable();

/**
 * The `tagging` agent applied to an engagement — 409.ai parity gap #23, closed.
 *
 * The wiring this covers is the half R34 left open on purpose: the vocabulary,
 * the table and the filter existed, and nothing could write a row with
 * `source = 'ai'`, so every guard in the repo concerning an AI-sourced tag was
 * untested in practice. All of them are exercised here.
 *
 * Two properties are the reason the file exists.
 *
 * The first is that the agent is *given* the vocabulary. The AI service holds no
 * copy of it, deliberately — two copies drift and the drift is silent — so the
 * assertion that `tag_catalogue` actually leaves this service, with definitions
 * attached, is load-bearing. Without it the model would be choosing from nothing
 * and every tag it proposed would be dropped downstream, which presents as "the
 * documents did not classify this engagement" rather than as the wiring fault it
 * would be.
 *
 * The second is that applying twice is safe. An analyst's decision survives a
 * re-run: a tag they accepted stays accepted, and one they rejected stays
 * rejected rather than returning as a suggestion every month. That is the
 * failure that makes people stop re-running agents, and stopping is worse than
 * the drift.
 */

interface StubState {
  result: Record<string, unknown>;
  payloads: Array<Record<string, unknown>>;
  /** What a *different* agent was sent, to prove the catalogue is not global. */
  otherPayloads: Array<Record<string, unknown>>;
}

/** Replays a canned `tagging` result and records what it was asked. */
async function startAiStub(state: StubState) {
  const stub = Fastify({ logger: false });
  stub.post('/ai/v1/pipelines/tagging', async (req) => {
    state.payloads.push(req.body as Record<string, unknown>);
    return { model: 'stub-model', result: state.result };
  });
  stub.post('/ai/v1/pipelines/comp_selection', async (req) => {
    state.otherPayloads.push(req.body as Record<string, unknown>);
    return { model: 'stub-model', result: { selected: [], excluded: [] } };
  });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

interface PresentedTag {
  slug: string;
  source: string;
  status: string;
  confidence: number | null;
  rationale: string | null;
  evidence: string[];
}

describe.skipIf(!dbUp)('the tagging agent applied to an engagement', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ai: Awaited<ReturnType<typeof startAiStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const state: StubState = {
    result: {
      tags: [
        {
          slug: 'series_a',
          confidence: 0.91,
          rationale: 'The deck reports a Series A closed in March 2025.',
          evidence: ['deck.pdf'],
        },
        {
          slug: 'saas',
          confidence: 0.84,
          rationale: 'Revenue is annual software subscriptions.',
          evidence: ['deck.pdf', 'financials.csv'],
        },
        { slug: 'ai_infrastructure', confidence: 0.7, rationale: 'Sells GPU tooling.', evidence: [] },
      ],
      unknown_slugs: ['ai_infrastructure'],
      notes: 'The financials do not separate services revenue.',
    },
    payloads: [],
    otherPayloads: [],
  };

  const runAgent = (id = valuationId) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/ai/tagging`,
      headers: authHeader(ops.token),
      payload: {},
    });

  const apply = (token = ops.token, id = valuationId) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/ai/tagging/apply`,
      headers: authHeader(token),
      payload: {},
    });

  const tagsOf = async (id = valuationId): Promise<PresentedTag[]> =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/tags`,
        headers: authHeader(ops.token),
      })
    ).json().tags;

  const tagOf = async (slug: string, id = valuationId) => (await tagsOf(id)).find((t) => t.slug === slug);

  const newValuation = async (name: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: name },
    });
    return res.json().valuation.id as string;
  };

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    ai = await startAiStub(state);
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      AI_URL: ai.url,
      AUTO_PIPELINE: 'off',
    });
    app = buildApp({ config, pool });
    await app.ready();

    ops = await seedUser({ app, pool, teardown: async () => {} }, { roles: ['admin'] });
    client = await seedUser({ app, pool, teardown: async () => {} }, { roles: ['valuation_user'] });
    valuationId = await newValuation('TaggedCo');
  });

  afterAll(async () => {
    await app?.close();
    await ai?.close();
    await db?.teardown();
  });

  // ── Running the agent ──────────────────────────────────────────────────────

  describe('running the agent', () => {
    it('is a runnable pipeline', async () => {
      const res = await runAgent();
      expect(res.statusCode).toBe(201);
    });

    /**
     * The assertion the whole design rests on. The AI service holds no
     * vocabulary of its own, so if this payload ever went out without one the
     * model would answer in free text and every tag would be dropped
     * downstream — presenting as an engagement nothing could be said about.
     */
    it('ships the tag catalogue, with the definitions attached', async () => {
      const payload = state.payloads.at(-1)!;
      const catalogue = payload.tag_catalogue as Array<{
        category: string;
        exclusive: boolean;
        tags: Array<{ slug: string; definition: string }>;
      }>;

      expect(Array.isArray(catalogue)).toBe(true);
      const shipped = catalogue.flatMap((g) => g.tags);
      expect(shipped).toHaveLength(TAG_CATALOGUE.length);
      for (const tag of shipped) expect(tag.definition.trim()).not.toBe('');

      const stage = catalogue.find((g) => g.category === 'stage')!;
      expect(stage.exclusive).toBe(true);
    });

    /**
     * The catalogue is this agent's, not a field every payload now carries.
     * Forty tags and their definitions on every extraction and every narrative
     * draft is prompt budget spent on a vocabulary those agents cannot use.
     */
    it('ships it to no other pipeline', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/ai/comp_selection`,
        headers: authHeader(ops.token),
        payload: {},
      });

      expect(res.statusCode).toBe(201);
      expect(state.otherPayloads).not.toHaveLength(0);
      expect(state.otherPayloads.at(-1)!.tag_catalogue).toBeUndefined();
    });

    it('is operations-only', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/ai/tagging`,
        headers: authHeader(client.token),
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ── Applying ───────────────────────────────────────────────────────────────

  describe('applying the run', () => {
    it('refuses before the agent has ever run', async () => {
      const fresh = await newValuation('NeverRunCo');
      const res = await apply(ops.token, fresh);

      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/run the tagging agent first/i);
    });

    it('is operations-only — a client cannot classify their own engagement', async () => {
      expect((await apply(client.token)).statusCode).toBe(403);
    });

    /**
     * Suggested, never accepted. A tag is a claim the filter reads and the
     * precedent query reasons from; a model's classification entering the
     * firm's records unreviewed is a claim nobody made.
     */
    it('writes the catalogue tags as AI suggestions, with their evidence', async () => {
      const res = await apply();
      expect(res.statusCode).toBe(200);
      expect(res.json().applied).toEqual(['series_a', 'saas']);

      expect(await tagOf('series_a')).toMatchObject({
        source: 'ai',
        status: 'suggested',
        confidence: 0.91,
        rationale: 'The deck reports a Series A closed in March 2025.',
        evidence: ['deck.pdf'],
      });
      expect((await tagOf('saas'))!.evidence).toEqual(['deck.pdf', 'financials.csv']);
    });

    it('accepts nothing on the engagement’s behalf', async () => {
      const accepted = (await tagsOf()).filter((t) => t.status === 'accepted');
      expect(accepted).toEqual([]);
    });

    /**
     * A slug the catalogue does not carry is a request to extend the
     * vocabulary, and the operator holding the response is who can act on it.
     * Logged instead, the only signal is that the tags feel thin.
     */
    it('returns the slugs it could not use rather than dropping them silently', async () => {
      const res = await apply();
      expect(res.json().unknown).toEqual(['ai_infrastructure']);
      expect(await tagOf('ai_infrastructure')).toBeUndefined();
    });

    it('reports the job it applied, so the tags trace back to a run', async () => {
      const res = await apply();
      expect(res.json().source_job_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    it('returns the engagement’s whole tag list, not just what it wrote', async () => {
      const res = await apply();
      const slugs = res.json().tags.map((t: PresentedTag) => t.slug);
      expect(slugs).toEqual(expect.arrayContaining(['series_a', 'saas']));
    });

    it('records who applied it, and what the model proposed', async () => {
      const { rows } = await pool.query<{ payload: Record<string, unknown>; actor_id: string }>(
        `SELECT payload, actor_id FROM admin_events
          WHERE subject_id = $1 AND type = 'valuation_tags_ai_applied'
          ORDER BY occurred_at DESC LIMIT 1`,
        [valuationId],
      );

      expect(rows[0]!.actor_id).toBe(ops.id);
      expect(rows[0]!.payload.slugs).toEqual(['series_a', 'saas']);
      expect(rows[0]!.payload.unknown).toEqual(['ai_infrastructure']);
    });
  });

  // ── Re-running over an analyst's decisions ─────────────────────────────────

  describe('re-applying over decisions an analyst already made', () => {
    let reRunId: string;

    const decide = (slug: string, status: string) =>
      app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${reRunId}/tags/${slug}`,
        headers: authHeader(ops.token),
        payload: { status },
      });

    beforeAll(async () => {
      reRunId = await newValuation('ReRunCo');
      await runAgent(reRunId);
      await apply(ops.token, reRunId);
      await decide('series_a', 'accepted');
      await decide('saas', 'rejected');
    });

    it('leaves an accepted tag accepted', async () => {
      await runAgent(reRunId);
      await apply(ops.token, reRunId);

      expect((await tagOf('series_a', reRunId))!.status).toBe('accepted');
    });

    /**
     * The rule that makes the agent worth re-running at all. A tag declined in
     * March that returns as a suggestion in April is one an analyst declines
     * forever.
     */
    it('does not resurrect a rejected tag', async () => {
      expect((await tagOf('saas', reRunId))!.status).toBe('rejected');
    });

    it('still refreshes the model’s reasoning underneath the decision', async () => {
      const previous = state.result;
      state.result = {
        tags: [
          { slug: 'series_a', confidence: 0.99, rationale: 'Reconfirmed by the term sheet.', evidence: ['ts.pdf'] },
        ],
      };
      try {
        await runAgent(reRunId);
        await apply(ops.token, reRunId);
      } finally {
        state.result = previous;
      }

      const row = await tagOf('series_a', reRunId);
      // Reasoning refreshed, decision untouched — the asymmetry the upsert's
      // conflict clause exists for.
      expect(row).toMatchObject({
        status: 'accepted',
        confidence: 0.99,
        rationale: 'Reconfirmed by the term sheet.',
      });
    });

    it('does not disturb a tag the analyst added themselves', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${reRunId}/tags`,
        headers: authHeader(ops.token),
        payload: { slug: 'customer_concentration', rationale: 'Two customers are 71% of revenue.' },
      });

      await runAgent(reRunId);
      await apply(ops.token, reRunId);

      expect(await tagOf('customer_concentration', reRunId)).toMatchObject({
        source: 'manual',
        status: 'accepted',
        rationale: 'Two customers are 71% of revenue.',
      });
    });
  });

  // ── Runs that cannot be applied ────────────────────────────────────────────

  describe('a run with nothing usable in it', () => {
    const withResult = async (result: Record<string, unknown>, name: string) => {
      const id = await newValuation(name);
      const previous = state.result;
      state.result = result;
      try {
        await runAgent(id);
        return { id, res: await apply(ops.token, id) };
      } finally {
        state.result = previous;
      }
    };

    it('refuses a run that proposed no tags', async () => {
      const { res } = await withResult({ tags: [] }, 'EmptyCo');
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/proposed no tags/i);
    });

    it('names the off-vocabulary slugs when none of them are real', async () => {
      const { res, id } = await withResult(
        { tags: [{ slug: 'vertical_ai' }, { slug: 'agentic' }] },
        'InventedCo',
      );

      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/vertical_ai, agentic/);
      // Nothing was written, so a failed apply leaves no half-classification.
      expect(await tagsOf(id)).toEqual([]);
    });

    it('refuses a result that is not the shape the agent returns', async () => {
      const { res } = await withResult({ notes: 'I could not classify this.' }, 'ProseCo');
      expect(res.statusCode).toBe(422);
    });
  });

  // ── The whole point: the filter can now find it ────────────────────────────

  it('an accepted AI tag reaches the engagement filter', async () => {
    const id = await newValuation('FilterableCo');
    await runAgent(id);
    await apply(ops.token, id);

    // Unreviewed, the suggestion must not move the list.
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/valuations?tags=saas',
      headers: authHeader(ops.token),
    });
    expect(before.json().valuations.map((v: { id: string }) => v.id)).not.toContain(id);

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}/tags/saas`,
      headers: authHeader(ops.token),
      payload: { status: 'accepted' },
    });

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/valuations?tags=saas',
      headers: authHeader(ops.token),
    });
    expect(after.json().valuations.map((v: { id: string }) => v.id)).toContain(id);
  });

  it('an AI tag cannot be deleted, only rejected', async () => {
    await upsertValuationTag(
      pool,
      valuationId,
      { slug: 'going_concern_doubt', source: 'ai', status: 'suggested' },
      null,
    );

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/valuations/${valuationId}/tags/going_concern_doubt`,
      headers: authHeader(ops.token),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/rejected rather than deleted/);
  });
});
