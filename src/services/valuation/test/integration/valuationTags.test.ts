import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import {
  acceptedTagSlugs,
  acceptedTagsFor,
  deleteValuationTag,
  findValuationTag,
  listValuationTags,
  lockTagCategories,
  tagUsageCounts,
  upsertValuationTag,
  upsertValuationTags,
} from '../../src/repos/valuationTags.js';

const dbUp = await isDbAvailable();

/**
 * Engagement tags end to end — the table, the repo, the CRUD routes and the
 * filter that reads them (migration 0153, 409.ai parity gap #23).
 *
 * The feature's whole shape is "do not silently undo a human", and every rule
 * that implements it lives in a place a unit test cannot reach: the conflict
 * clause on the upsert, the exclusivity demotion, and the delete the route
 * refuses for an AI-sourced row. So this file is where those are pinned.
 *
 * The two worth reading are the re-run tests. A tag an analyst rejected in
 * March must not come back as a suggestion in April, and one they accepted with
 * a note must not revert to the model's wording. That is the failure that makes
 * people stop re-running agents, and stopping is worse than the drift.
 */

describe.skipIf(!dbUp)('engagement tags', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  /** A fresh engagement, owned by the client, so tests do not share tag state. */
  const newEngagement = async (companyName: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  const getTags = (id: string, token = ops.token) =>
    ctx.app.inject({ method: 'GET', url: `/api/v1/valuations/${id}/tags`, headers: authHeader(token) });

  const addTag = (id: string, payload: unknown, token = ops.token) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/tags`,
      headers: authHeader(token),
      payload,
    });

  const decide = (id: string, slug: string, status: string, token = ops.token) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}/tags/${slug}`,
      headers: authHeader(token),
      payload: { status },
    });

  const removeTag = (id: string, slug: string, token = ops.token) =>
    ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/valuations/${id}/tags/${slug}`,
      headers: authHeader(token),
    });

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  // ── The catalogue endpoint ─────────────────────────────────────────────────

  describe('GET /api/v1/tag-catalogue', () => {
    it('serves the grouped vocabulary with its definitions', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/tag-catalogue',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const { categories } = res.json();
      expect(categories.map((c: { category: string }) => c.category)).toEqual([
        'stage',
        'revenue',
        'business_model',
        'capital_structure',
        'valuation_context',
        'risk',
      ]);
      const stage = categories.find((c: { category: string }) => c.category === 'stage');
      expect(stage.exclusive).toBe(true);
      expect(stage.tags[0]).toMatchObject({ slug: 'pre_seed', label: 'Pre-seed' });
      expect(stage.tags[0].definition).toContain('institutional');
    });

    it('is readable by a client, who has to see the tooltip too', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/tag-catalogue',
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(200);
    });

    it('needs authentication', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/tag-catalogue' });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── The repo ───────────────────────────────────────────────────────────────

  describe('the repo', () => {
    it('hands back confidence as a number, not the numeric string pg returns', async () => {
      // `numeric` round-trips as a string, and a confidence compared as
      // '0.9' > 0.8 is a bug that only shows up on some values. Converted once,
      // at this boundary.
      const id = await newEngagement('Numeric Co');
      const row = await upsertValuationTag(
        ctx.pool,
        id,
        { slug: 'saas', source: 'ai', status: 'suggested', confidence: 0.9 },
        null,
      );
      expect(row.confidence).toBe(0.9);
      expect(typeof row.confidence).toBe('number');
    });

    it('rounds confidence to the column scale rather than refusing it', async () => {
      const id = await newEngagement('Scale Co');
      const row = await upsertValuationTag(
        ctx.pool,
        id,
        { slug: 'saas', source: 'ai', status: 'suggested', confidence: 0.98765 },
        null,
      );
      expect(row.confidence).toBe(0.988); // numeric(4,3)
    });

    it('leaves confidence null on a manual tag', async () => {
      // An analyst who tags an engagement is not 70% sure; the concept does not
      // apply, and a zero would sort them below every model suggestion.
      const id = await newEngagement('Manual Co');
      const row = await upsertValuationTag(
        ctx.pool,
        id,
        { slug: 'saas', source: 'manual', status: 'accepted' },
        ops.id,
      );
      expect(row.confidence).toBeNull();
      expect(row.decided_by).toBe(ops.id);
      expect(row.decided_at).toBeInstanceOf(Date);
    });

    it('records no decision on a suggestion', async () => {
      const id = await newEngagement('Undecided Co');
      const row = await upsertValuationTag(
        ctx.pool,
        id,
        { slug: 'saas', source: 'ai', status: 'suggested' },
        ops.id,
      );
      expect(row.decided_by).toBeNull();
      expect(row.decided_at).toBeNull();
      expect(row.created_by).toBe(ops.id);
    });

    it('round-trips the evidence array', async () => {
      const id = await newEngagement('Evidence Co');
      const row = await upsertValuationTag(
        ctx.pool,
        id,
        { slug: 'saas', source: 'ai', status: 'suggested', evidence: ['deck.pdf', 'arr.xlsx'] },
        null,
      );
      expect(row.evidence).toEqual(['deck.pdf', 'arr.xlsx']);
      expect((await findValuationTag(ctx.pool, id, 'saas'))!.evidence).toEqual(['deck.pdf', 'arr.xlsx']);
    });

    it('does not hand a caller a non-array to map over', async () => {
      // jsonb stores whatever was written. A row written by hand, or before a
      // bound existed, must not reach the presenter as an object.
      const id = await newEngagement('Bad Evidence Co');
      await upsertValuationTag(ctx.pool, id, { slug: 'saas', source: 'ai', status: 'suggested' }, null);
      await ctx.pool.query(
        `UPDATE valuation_tags SET evidence = '{"file":"deck.pdf"}'::jsonb WHERE valuation_id = $1`,
        [id],
      );
      expect((await findValuationTag(ctx.pool, id, 'saas'))!.evidence).toEqual([]);
    });

    it('drops a non-string element from a stored evidence array', async () => {
      const id = await newEngagement('Mixed Evidence Co');
      await upsertValuationTag(ctx.pool, id, { slug: 'saas', source: 'ai', status: 'suggested' }, null);
      await ctx.pool.query(
        `UPDATE valuation_tags SET evidence = '["deck.pdf", 42, null]'::jsonb WHERE valuation_id = $1`,
        [id],
      );
      expect((await findValuationTag(ctx.pool, id, 'saas'))!.evidence).toEqual(['deck.pdf']);
    });

    it('lists decided tags first, then the strongest suggestion', async () => {
      // The order an analyst works the list in. A null confidence — every
      // manual tag — belongs below a model's 0.9 rather than above it.
      const id = await newEngagement('Ordering Co');
      await upsertValuationTags(
        ctx.pool,
        id,
        [
          { slug: 'fintech', source: 'ai', status: 'suggested', confidence: 0.4 },
          { slug: 'marketplace', source: 'ai', status: 'rejected', confidence: 0.9 },
          { slug: 'saas', source: 'ai', status: 'suggested', confidence: 0.95 },
          { slug: 'hardware', source: 'manual', status: 'suggested' },
          { slug: 'pre_revenue', source: 'manual', status: 'accepted' },
        ],
        ops.id,
      );
      const rows = await listValuationTags(ctx.pool, id);
      expect(rows.map((r) => r.slug)).toEqual([
        'pre_revenue', // accepted
        'saas', // suggested, 0.95
        'fintech', // suggested, 0.4
        'hardware', // suggested, no confidence
        'marketplace', // rejected
      ]);
    });

    it('reads back only the accepted slugs', async () => {
      const id = await newEngagement('Accepted Co');
      await upsertValuationTags(
        ctx.pool,
        id,
        [
          { slug: 'saas', source: 'manual', status: 'accepted' },
          { slug: 'fintech', source: 'ai', status: 'suggested', confidence: 0.9 },
          { slug: 'marketplace', source: 'ai', status: 'rejected' },
        ],
        ops.id,
      );
      expect(await acceptedTagSlugs(ctx.pool, id)).toEqual(['saas']);
    });

    it('reads a whole page of engagements in one query', async () => {
      const a = await newEngagement('Page A');
      const b = await newEngagement('Page B');
      const empty = await newEngagement('Page C');
      await upsertValuationTags(
        ctx.pool,
        a,
        [
          { slug: 'saas', source: 'manual', status: 'accepted' },
          { slug: 'fintech', source: 'manual', status: 'accepted' },
        ],
        ops.id,
      );
      await upsertValuationTags(
        ctx.pool,
        b,
        [{ slug: 'saas', source: 'manual', status: 'accepted' }],
        ops.id,
      );

      const map = await acceptedTagsFor(ctx.pool, [a, b, empty]);
      expect(map.get(a)).toEqual(['fintech', 'saas']);
      expect(map.get(b)).toEqual(['saas']);
      // Absent rather than an empty array: an engagement with no tags has no
      // row to group, and the caller defaults it.
      expect(map.has(empty)).toBe(false);
    });

    it('does not issue a query for an empty id list', async () => {
      expect((await acceptedTagsFor(ctx.pool, [])).size).toBe(0);
      expect((await tagUsageCounts(ctx.pool, [])).size).toBe(0);
    });

    it('counts accepted usage across the ids the caller may read', async () => {
      // Scoped by the caller passing the ids — this repo does not know the RBAC
      // rules and must not appear to.
      const a = await newEngagement('Usage A');
      const b = await newEngagement('Usage B');
      const unreadable = await newEngagement('Usage C');
      await upsertValuationTags(
        ctx.pool,
        a,
        [{ slug: 'biotech', source: 'manual', status: 'accepted' }],
        ops.id,
      );
      await upsertValuationTags(
        ctx.pool,
        b,
        [{ slug: 'biotech', source: 'manual', status: 'accepted' }],
        ops.id,
      );
      await upsertValuationTags(
        ctx.pool,
        unreadable,
        [{ slug: 'biotech', source: 'manual', status: 'accepted' }],
        ops.id,
      );

      const counts = await tagUsageCounts(ctx.pool, [a, b]);
      expect(counts.get('biotech')).toBe(2); // not 3 — the third was out of scope
    });

    it('does not count a suggestion toward usage', async () => {
      const id = await newEngagement('Suggestion Usage Co');
      await upsertValuationTags(
        ctx.pool,
        id,
        [{ slug: 'deeptech', source: 'ai', status: 'suggested', confidence: 0.9 }],
        null,
      );
      expect((await tagUsageCounts(ctx.pool, [id])).get('deeptech')).toBeUndefined();
    });

    it('writes nothing for an empty upsert batch', async () => {
      const id = await newEngagement('Empty Batch Co');
      expect(await upsertValuationTags(ctx.pool, id, [], ops.id)).toEqual([]);
      expect(await listValuationTags(ctx.pool, id)).toEqual([]);
    });

    it('applies a batch all or nothing', async () => {
      // A partly-applied tagging run leaves an engagement classified by the
      // first half of a list, which is worse than the unclassified state it
      // started in because it looks finished.
      const id = await newEngagement('Atomic Co');
      await expect(
        upsertValuationTags(
          ctx.pool,
          id,
          [
            { slug: 'saas', source: 'ai', status: 'suggested', confidence: 0.9 },
            // 99 does not fit numeric(4,3) — the write fails mid-batch.
            { slug: 'fintech', source: 'ai', status: 'suggested', confidence: 99 },
          ],
          null,
        ),
      ).rejects.toThrow();
      expect(await listValuationTags(ctx.pool, id)).toEqual([]);
    });

    it('updates the row it already wrote rather than stacking a second one', async () => {
      const id = await newEngagement('Rerun Co');
      await upsertValuationTag(
        ctx.pool,
        id,
        { slug: 'saas', source: 'ai', status: 'suggested', confidence: 0.5, rationale: 'first read' },
        null,
      );
      await upsertValuationTag(
        ctx.pool,
        id,
        { slug: 'saas', source: 'ai', status: 'suggested', confidence: 0.8, rationale: 'second read' },
        null,
      );
      const rows = await listValuationTags(ctx.pool, id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ confidence: 0.8, rationale: 'second read' });
    });

    it('never lets a machine re-run overwrite a human decision', async () => {
      // The whole design of the conflict clause. An analyst rejected this in
      // March; April's run refreshes the model's reasoning and leaves the
      // status, the decider and the decision time exactly as they were.
      const id = await newEngagement('Human Decision Co');
      await upsertValuationTag(ctx.pool, id, { slug: 'saas', source: 'ai', status: 'suggested' }, null);
      const rejected = await upsertValuationTag(
        ctx.pool,
        id,
        { slug: 'saas', source: 'manual', status: 'rejected' },
        ops.id,
      );

      const rerun = await upsertValuationTag(
        ctx.pool,
        id,
        { slug: 'saas', source: 'ai', status: 'suggested', confidence: 0.99, rationale: 'April read' },
        null,
      );
      expect(rerun.status).toBe('rejected');
      expect(rerun.decided_by).toBe(ops.id);
      expect(rerun.decided_at?.getTime()).toBe(rejected.decided_at?.getTime());
      // The reasoning is still refreshed — that half is not a decision.
      expect(rerun.confidence).toBe(0.99);
      expect(rerun.rationale).toBe('April read');
    });

    it('does not relabel an analyst\u2019s own tag as the model\u2019s', async () => {
      /*
       * The other direction of the same rule, and the one that was open.
       *
       * `source` records who *originated* the tag — `TAG_SOURCES` says only a
       * manual one is evidence of independent judgement, and the PATCH route
       * carries the existing source through an acceptance for exactly that
       * reason. The conflict clause set `source = EXCLUDED.source`
       * unconditionally, so an analyst who tagged an engagement by hand and
       * then ran the tagging agent — which reaches the same conclusion, that
       * being the common case — had their judgement rewritten as the model's.
       */
      const id = await newEngagement('Analyst Origin Co');
      expect((await addTag(id, { slug: 'series_a' })).statusCode).toBe(200);

      const rerun = await upsertValuationTag(
        ctx.pool,
        id,
        { slug: 'series_a', source: 'ai', status: 'suggested', confidence: 0.9, rationale: 'model read' },
        null,
      );
      expect(rerun.source).toBe('manual');
      expect(rerun.status).toBe('accepted');
      // The model's reasoning still lands; that half is not a claim about origin.
      expect(rerun.confidence).toBe(0.9);

      // And the tag is still the analyst's to remove. The delete route refuses
      // an `ai`-sourced row, so the relabelling also made a manually added tag
      // undeletable, with a message telling the analyst to reject their own.
      expect((await removeTag(id, 'series_a')).statusCode).toBe(204);
    });

    it('does not relabel a model suggestion as the analyst\u2019s own conclusion', async () => {
      // `POST /tags` on a tag the model already proposed is an acceptance, not
      // an independent conclusion — the same fact the PATCH route preserves.
      const id = await newEngagement('Model Origin Co');
      await upsertValuationTag(ctx.pool, id, { slug: 'saas', source: 'ai', status: 'suggested' }, null);

      expect((await addTag(id, { slug: 'saas' })).statusCode).toBe(200);
      const row = (await findValuationTag(ctx.pool, id, 'saas'))!;
      expect(row.source).toBe('ai');
      expect(row.status).toBe('accepted');
      expect(row.decided_by).toBe(ops.id);
    });

    it('does not revert an accepted tag either', async () => {
      const id = await newEngagement('Accepted Rerun Co');
      await upsertValuationTag(ctx.pool, id, { slug: 'saas', source: 'ai', status: 'suggested' }, null);
      await upsertValuationTag(ctx.pool, id, { slug: 'saas', source: 'ai', status: 'accepted' }, ops.id);
      const rerun = await upsertValuationTag(
        ctx.pool,
        id,
        { slug: 'saas', source: 'ai', status: 'suggested' },
        null,
      );
      expect(rerun.status).toBe('accepted');
    });

    it('lets a human move a tag the model is still suggesting', async () => {
      const id = await newEngagement('Human Moves Co');
      await upsertValuationTag(ctx.pool, id, { slug: 'saas', source: 'ai', status: 'suggested' }, null);
      const decided = await upsertValuationTag(
        ctx.pool,
        id,
        { slug: 'saas', source: 'manual', status: 'accepted' },
        ops.id,
      );
      expect(decided.status).toBe('accepted');
      expect(decided.decided_by).toBe(ops.id);
    });

    it('clears the decision when a human upsert names no actor', async () => {
      const id = await newEngagement('No Actor Co');
      await upsertValuationTag(ctx.pool, id, { slug: 'saas', source: 'manual', status: 'accepted' }, ops.id);
      const anon = await upsertValuationTag(
        ctx.pool,
        id,
        { slug: 'saas', source: 'manual', status: 'accepted' },
        null,
      );
      expect(anon.decided_by).toBeNull();
      expect(anon.decided_at).toBeNull();
    });

    it('scopes every read to one engagement', async () => {
      const a = await newEngagement('Scope A');
      const b = await newEngagement('Scope B');
      await upsertValuationTag(ctx.pool, a, { slug: 'saas', source: 'manual', status: 'accepted' }, ops.id);
      expect(await listValuationTags(ctx.pool, b)).toEqual([]);
      expect(await findValuationTag(ctx.pool, b, 'saas')).toBeNull();
    });

    it('reports whether a delete removed anything', async () => {
      const id = await newEngagement('Delete Co');
      await upsertValuationTag(ctx.pool, id, { slug: 'saas', source: 'manual', status: 'accepted' }, ops.id);
      expect(await deleteValuationTag(ctx.pool, id, 'saas')).toBe(true);
      expect(await deleteValuationTag(ctx.pool, id, 'saas')).toBe(false);
      expect(await findValuationTag(ctx.pool, id, 'saas')).toBeNull();
    });

    it("drops an engagement's tags with the engagement", async () => {
      // `ON DELETE CASCADE` on the valuation reference. Not a formality: the
      // filter's index is (slug, valuation_id), so an orphaned tag row would
      // keep answering a precedent query with an engagement that is gone.
      // Inserted directly rather than through the API: an engagement created
      // over HTTP carries `valuation_events`, which are append-only by trigger
      // and so pin their engagement in place for good.
      const id = newUlid();
      await ctx.pool.query(
        `INSERT INTO valuations (id, kind, company_name, user_id) VALUES ($1, '409a', $2, $3)`,
        [id, 'Cascade Co', client.id],
      );
      await upsertValuationTag(ctx.pool, id, { slug: 'saas', source: 'manual', status: 'accepted' }, ops.id);
      await ctx.pool.query('DELETE FROM valuations WHERE id = $1', [id]);
      const { rows } = await ctx.pool.query('SELECT 1 FROM valuation_tags WHERE valuation_id = $1', [id]);
      expect(rows).toHaveLength(0);
    });
  });

  // ── The CRUD routes ────────────────────────────────────────────────────────

  describe('the routes', () => {
    it("lists an engagement's tags with the catalogue beside them", async () => {
      const id = await newEngagement('Route List Co');
      await upsertValuationTags(
        ctx.pool,
        id,
        [
          { slug: 'saas', source: 'manual', status: 'accepted' },
          { slug: 'fintech', source: 'ai', status: 'suggested', confidence: 0.7, evidence: ['deck.pdf'] },
        ],
        ops.id,
      );

      const res = await getTags(id);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.accepted).toEqual(['saas']);
      expect(body.tags.map((t: { slug: string }) => t.slug)).toEqual(['saas', 'fintech']);
      expect(body.tags[1]).toMatchObject({
        slug: 'fintech',
        label: 'Fintech',
        known: true,
        source: 'ai',
        status: 'suggested',
        confidence: 0.7,
        evidence: ['deck.pdf'],
      });
      expect(body.categories).toHaveLength(6);
    });

    it('lets the engagement owner read the tags on their own engagement', async () => {
      const id = await newEngagement('Owner Read Co');
      expect((await getTags(id, client.token)).statusCode).toBe(200);
    });

    it('is a 404 for an engagement the caller cannot read', async () => {
      const id = await newEngagement('Other Client Co');
      const stranger = await seedUser(ctx, { roles: ['valuation_user'] });
      expect((await getTags(id, stranger.token)).statusCode).toBe(404);
    });

    it('is a 404 for an id that is not a ULID', async () => {
      expect((await getTags('not-an-id')).statusCode).toBe(404);
    });

    it('accepts a manual tag immediately', async () => {
      // An analyst adding a tag *is* the decision an AI suggestion waits for;
      // routing their conclusion through a suggestion state would be ceremony
      // with no reviewer at the end of it.
      const id = await newEngagement('Manual Add Co');
      const res = await addTag(id, { slug: 'medtech', rationale: 'FDA pathway in the deck.' });
      expect(res.statusCode).toBe(200);
      expect(res.json().tag).toMatchObject({
        slug: 'medtech',
        source: 'manual',
        status: 'accepted',
        rationale: 'FDA pathway in the deck.',
        known: true,
      });
      expect((await getTags(id)).json().accepted).toEqual(['medtech']);
    });

    it('is operations-only — a client cannot tag their own engagement', async () => {
      // A tag drives the list filter and the precedent query, so a client able
      // to tag their engagement could move it in and out of a firm's internal
      // views. Not a thing the client relationship should decide.
      const id = await newEngagement('Client Write Co');
      const res = await addTag(id, { slug: 'saas' }, client.token);
      expect(res.statusCode).toBe(403);
      expect(res.json().detail).toMatch(/operations/i);
    });

    it('points a caller that guessed a slug at the real list', async () => {
      const id = await newEngagement('Guessed Slug Co');
      const res = await addTag(id, { slug: 'vertical_saas' });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/'vertical_saas' is not a tag in the catalogue/);
      expect(res.json().catalogue).toBe('/api/v1/tag-catalogue');
    });

    it('refuses a body that is not a tag', async () => {
      const id = await newEngagement('Bad Body Co');
      expect((await addTag(id, {})).statusCode).toBe(422);
      expect((await addTag(id, { slug: 'saas', colour: 'blue' })).statusCode).toBe(422);
      expect((await addTag(id, { slug: 'saas', rationale: 'x'.repeat(601) })).statusCode).toBe(422);
    });

    it('demotes the incumbent when an exclusive category gets a second tag', async () => {
      // A company that was `seed` last year and is `series_a` now has not made
      // an error, so the new tag is applied and the old one is recorded as
      // rejected rather than the request being refused.
      const id = await newEngagement('Ladder Co');
      expect((await addTag(id, { slug: 'seed' })).statusCode).toBe(200);
      expect((await addTag(id, { slug: 'series_a' })).statusCode).toBe(200);

      const body = (await getTags(id)).json();
      expect(body.accepted).toEqual(['series_a']);
      const seed = body.tags.find((t: { slug: string }) => t.slug === 'seed');
      expect(seed.status).toBe('rejected'); // history still shows what it was
    });

    it('demotes an incumbent the agent proposed and an analyst accepted', async () => {
      // `source` is write-once, so a tag the model suggested keeps `source =
      // 'ai'` after an analyst accepts it. The demotion used to re-state that
      // value at `upsertValuationTag`, whose conflict clause reads it as "a
      // machine is writing over a human decision" and refuses — so the
      // incumbent stayed accepted and the engagement carried two stages at
      // once, which is the exact state the category lock exists to prevent,
      // reached with no race at all (round 356, methodology M3).
      const id = await newEngagement('AI Ladder Co');
      await upsertValuationTag(
        ctx.pool,
        id,
        { slug: 'seed', source: 'ai', status: 'suggested', confidence: 0.8 },
        ops.id,
      );
      expect((await decide(id, 'seed', 'accepted')).statusCode).toBe(200);
      expect((await getTags(id)).json().accepted).toEqual(['seed']);

      expect((await addTag(id, { slug: 'series_a' })).statusCode).toBe(200);
      const body = (await getTags(id)).json();
      expect(body.accepted).toEqual(['series_a']);
      const seed = body.tags.find((t: { slug: string }) => t.slug === 'seed');
      expect(seed).toMatchObject({ status: 'rejected', source: 'ai' });
    });

    it('lets an analyst reject an AI tag they had already accepted', async () => {
      // The only way an AI-sourced tag leaves the list is `rejected` — DELETE
      // refuses one and says so. The decision door carried the row's own
      // `source` into the upsert, so once the tag was decided every later
      // PATCH was inert and answered 200 over a row it had not moved: a tag
      // stuck accepted with no transition out of it.
      const id = await newEngagement('Second Thoughts Co');
      await upsertValuationTag(
        ctx.pool,
        id,
        { slug: 'marketplace', source: 'ai', status: 'suggested', confidence: 0.6 },
        ops.id,
      );
      expect((await decide(id, 'marketplace', 'accepted')).statusCode).toBe(200);

      const res = await decide(id, 'marketplace', 'rejected');
      expect(res.statusCode).toBe(200);
      expect(res.json().tag).toMatchObject({ slug: 'marketplace', status: 'rejected', source: 'ai' });
      expect((await getTags(id)).json().accepted).toEqual([]);
      // And back again — the decision is a transition, not a one-way door.
      expect((await decide(id, 'marketplace', 'accepted')).json().tag.status).toBe('accepted');
    });

    it('is a 404 when the tag went between the read and the decision', async () => {
      // The decision write cannot insert, so a slug with no row is not quietly
      // created by a PATCH.
      const id = await newEngagement('Vanished Tag Co');
      expect((await decide(id, 'saas', 'accepted')).statusCode).toBe(404);
    });

    it('demotes across the whole exclusive category, not just the previous tag', async () => {
      const id = await newEngagement('Ladder Two Co');
      await upsertValuationTags(
        ctx.pool,
        id,
        [
          { slug: 'seed', source: 'manual', status: 'accepted' },
          { slug: 'series_a', source: 'manual', status: 'accepted' },
        ],
        ops.id,
      );
      await addTag(id, { slug: 'series_b' });
      expect((await getTags(id)).json().accepted).toEqual(['series_b']);
    });

    it('serialises an accept behind the engagement tag lock', async () => {
      // The demotion reads the tag list and the write lands after it. On the
      // pool those were three statements with nothing holding the list still:
      // two accepts of one exclusive category arriving together each read a
      // list the other had not landed in, each found nothing to demote, and
      // both committed — the engagement carrying two stages at once, which is
      // the exact state the demotion exists to prevent and one every reader of
      // `accepted` is written as if it cannot see.
      //
      // Asserted by holding the lock rather than by racing two requests: a
      // `Promise.all` of two injects reproduces the old bug only on the
      // interleavings the driver happens to give, so as a regression test it
      // passes for the wrong reason more often than it fails for the right one.
      // Taking `lockTagCategories` here and watching the accept wait for it
      // pins the guarantee itself, and fails deterministically without it.
      const id = await newEngagement('Race Ladder Co');
      await addTag(id, { slug: 'seed' });

      const holder = await ctx.pool.connect();
      let settled = false;
      try {
        await holder.query('BEGIN');
        await lockTagCategories(holder, id);

        const pending = addTag(id, { slug: 'series_a' }).then((res) => {
          settled = true;
          return res;
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(settled).toBe(false);

        await holder.query('COMMIT');
        expect((await pending).statusCode).toBe(200);
      } finally {
        holder.release();
      }

      const body = (await getTags(id)).json();
      expect(body.accepted).toEqual(['series_a']);
      // The loser is on file as rejected, not missing: the history still shows
      // what the engagement was classified as on the way through.
      expect(body.tags.find((t: { slug: string }) => t.slug === 'seed').status).toBe('rejected');
      expect(await acceptedTagSlugs(ctx.pool, id)).toEqual(['series_a']);
    });

    it('leaves a multi-valued category alone', async () => {
      // A fintech marketplace with warrants is one company, not three.
      const id = await newEngagement('Multi Co');
      await addTag(id, { slug: 'fintech' });
      await addTag(id, { slug: 'marketplace' });
      expect((await getTags(id)).json().accepted.sort()).toEqual(['fintech', 'marketplace']);
    });

    it('does not demote across a different exclusive category', async () => {
      const id = await newEngagement('Two Ladders Co');
      await addTag(id, { slug: 'seed' });
      await addTag(id, { slug: 'pre_revenue' });
      expect((await getTags(id)).json().accepted.sort()).toEqual(['pre_revenue', 'seed']);
    });

    it('accepts an AI suggestion without rewriting who proposed it', async () => {
      // "The model proposed this and an analyst agreed" and "an analyst
      // concluded this" are different facts, and only the second is evidence of
      // independent judgement.
      const id = await newEngagement('Accept Suggestion Co');
      await upsertValuationTag(
        ctx.pool,
        id,
        { slug: 'saas', source: 'ai', status: 'suggested', confidence: 0.88, rationale: 'ARR in the deck.' },
        null,
      );

      const res = await decide(id, 'saas', 'accepted');
      expect(res.statusCode).toBe(200);
      expect(res.json().tag).toMatchObject({
        slug: 'saas',
        source: 'ai',
        status: 'accepted',
        confidence: 0.88,
        rationale: 'ARR in the deck.',
      });
      expect(res.json().tag.decided_at).not.toBeNull();
    });

    it('rejects a suggestion without deleting it', async () => {
      const id = await newEngagement('Reject Suggestion Co');
      await upsertValuationTag(ctx.pool, id, { slug: 'saas', source: 'ai', status: 'suggested' }, null);
      expect((await decide(id, 'saas', 'rejected')).statusCode).toBe(200);

      const body = (await getTags(id)).json();
      expect(body.accepted).toEqual([]);
      expect(body.tags.map((t: { slug: string }) => t.slug)).toEqual(['saas']);
      expect(body.tags[0].status).toBe('rejected');
    });

    it('enforces exclusivity on acceptance too', async () => {
      const id = await newEngagement('Accept Ladder Co');
      await addTag(id, { slug: 'seed' });
      await upsertValuationTag(
        ctx.pool,
        id,
        { slug: 'growth_stage', source: 'ai', status: 'suggested', confidence: 0.6 },
        null,
      );
      await decide(id, 'growth_stage', 'accepted');
      expect((await getTags(id)).json().accepted).toEqual(['growth_stage']);
    });

    it('does not enforce exclusivity on a rejection', async () => {
      const id = await newEngagement('Reject Ladder Co');
      await addTag(id, { slug: 'seed' });
      await upsertValuationTag(ctx.pool, id, { slug: 'series_a', source: 'ai', status: 'suggested' }, null);
      await decide(id, 'series_a', 'rejected');
      expect((await getTags(id)).json().accepted).toEqual(['seed']);
    });

    it('is a 404 for a tag that is not on the engagement', async () => {
      const id = await newEngagement('Missing Tag Co');
      expect((await decide(id, 'saas', 'accepted')).statusCode).toBe(404);
      expect((await removeTag(id, 'saas')).statusCode).toBe(404);
    });

    it('refuses a decision that is not accept or reject', async () => {
      const id = await newEngagement('Bad Decision Co');
      await addTag(id, { slug: 'saas' });
      expect((await decide(id, 'saas', 'suggested')).statusCode).toBe(422);
      expect((await decide(id, 'saas', 'maybe')).statusCode).toBe(422);
    });

    it('is operations-only for deciding and deleting', async () => {
      const id = await newEngagement('Client Decide Co');
      await addTag(id, { slug: 'saas' });
      expect((await decide(id, 'saas', 'rejected', client.token)).statusCode).toBe(403);
      expect((await removeTag(id, 'saas', client.token)).statusCode).toBe(403);
    });

    it('deletes a tag a human put there', async () => {
      const id = await newEngagement('Human Delete Co');
      await addTag(id, { slug: 'saas' });
      const res = await removeTag(id, 'saas');
      expect(res.statusCode).toBe(204);
      expect((await getTags(id)).json().tags).toEqual([]);
    });

    it('records one removal however two simultaneous presses interleave', async () => {
      // `findValuationTag` is a statement earlier and on another connection, so
      // whether the second press sees the row is a matter of timing: it either
      // 404s on the read or reaches a DELETE that takes nothing. Both are fine
      // answers — the caller asked for the tag to be gone and it is — and the
      // one thing that must hold under either interleaving is the trail, since
      // `valuation_tag_removed` is what an audit of this table reads to date a
      // classification's withdrawal and two of them describe two removals of a
      // tag that was removed once.
      //
      // Which interleaving a run gets is not this test's to decide, so it
      // asserts what is true of both. `deleteOnceCensus.test.ts` is what holds
      // the rule at the call site, where it can be checked deterministically.
      const id = await newEngagement('Twice Removed Co');
      await addTag(id, { slug: 'saas' });
      const pressed = await Promise.all([removeTag(id, 'saas'), removeTag(id, 'saas')]);
      expect(pressed.map((r) => r.statusCode).sort()).toEqual(
        pressed.some((r) => r.statusCode === 404) ? [204, 404] : [204, 204],
      );
      expect((await getTags(id)).json().tags).toEqual([]);

      const { rows } = await ctx.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM admin_events WHERE subject_id = $1 AND type = 'valuation_tag_removed'`,
        [id],
      );
      expect(Number(rows[0]!.n)).toBe(1);
    });

    it('refuses to delete an AI-sourced tag, and says what to do instead', async () => {
      // The agent's output is evidence of what the model proposed on this
      // engagement. A list an operator can prune to the flattering half is not
      // a classification, it is a conclusion with tags under it.
      const id = await newEngagement('AI Delete Co');
      await upsertValuationTag(ctx.pool, id, { slug: 'saas', source: 'ai', status: 'suggested' }, null);
      const res = await removeTag(id, 'saas');
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/rejected rather than deleted/);
      expect((await getTags(id)).json().tags).toHaveLength(1);
    });

    it('still refuses the delete after an analyst has accepted the AI tag', async () => {
      // Acceptance does not relabel the source, so it does not open the delete.
      const id = await newEngagement('AI Accepted Delete Co');
      await upsertValuationTag(ctx.pool, id, { slug: 'saas', source: 'ai', status: 'suggested' }, null);
      await decide(id, 'saas', 'accepted');
      expect((await removeTag(id, 'saas')).statusCode).toBe(422);
    });

    it('records the write on the admin event stream', async () => {
      const id = await newEngagement('Audited Co');
      await addTag(id, { slug: 'saas' });
      await decide(id, 'saas', 'rejected');
      await upsertValuationTag(
        ctx.pool,
        id,
        { slug: 'fintech', source: 'manual', status: 'accepted' },
        ops.id,
      );
      await removeTag(id, 'fintech');

      const { rows } = await ctx.pool.query<{ type: string }>(
        `SELECT type FROM admin_events WHERE subject_id = $1 ORDER BY occurred_at, type`,
        [id],
      );
      const types = rows.map((r) => r.type);
      expect(types).toContain('valuation_tagged');
      expect(types).toContain('valuation_tag_decided');
      expect(types).toContain('valuation_tag_removed');
    });
  });

  // ── The list filter ────────────────────────────────────────────────────────

  describe('GET /api/v1/valuations?tags=', () => {
    let saasPreRevenue: string;
    let saasOnly: string;
    let suggestedOnly: string;

    const listIds = async (query: string, token = ops.token): Promise<string[]> => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations?${query}&per_page=100`,
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(200);
      return res.json().valuations.map((v: { id: string }) => v.id);
    };

    beforeAll(async () => {
      saasPreRevenue = await newEngagement('Filter Both Co');
      saasOnly = await newEngagement('Filter Saas Co');
      suggestedOnly = await newEngagement('Filter Suggested Co');
      await upsertValuationTags(
        ctx.pool,
        saasPreRevenue,
        [
          { slug: 'saas', source: 'manual', status: 'accepted' },
          { slug: 'pre_revenue', source: 'manual', status: 'accepted' },
        ],
        ops.id,
      );
      await upsertValuationTags(
        ctx.pool,
        saasOnly,
        [
          { slug: 'saas', source: 'manual', status: 'accepted' },
          { slug: 'pre_revenue', source: 'manual', status: 'rejected' },
        ],
        ops.id,
      );
      await upsertValuationTags(
        ctx.pool,
        suggestedOnly,
        [{ slug: 'saas', source: 'ai', status: 'suggested', confidence: 0.9 }],
        null,
      );
    });

    it('conjoins the slugs rather than unioning them', async () => {
      // "Pre-revenue SaaS" is one precedent question; the OR of those two tags
      // is most of the book of work, which is not a filter anyone asked for.
      const both = await listIds('tags=saas,pre_revenue');
      expect(both).toContain(saasPreRevenue);
      expect(both).not.toContain(saasOnly);
    });

    it('matches on the single tag when only one is named', async () => {
      const saas = await listIds('tags=saas');
      expect(saas).toContain(saasPreRevenue);
      expect(saas).toContain(saasOnly);
    });

    it('does not match a merely suggested tag', async () => {
      // A suggestion nobody has reviewed must not silently change which
      // engagements an analyst sees when they filter.
      expect(await listIds('tags=saas')).not.toContain(suggestedOnly);
    });

    it('does not match a rejected tag', async () => {
      expect(await listIds('tags=pre_revenue')).not.toContain(saasOnly);
    });

    it('starts matching once the suggestion is accepted', async () => {
      await decide(suggestedOnly, 'saas', 'accepted');
      expect(await listIds('tags=saas')).toContain(suggestedOnly);
    });

    it('ignores a slug outside the catalogue instead of refusing the request', async () => {
      // A saved view written against a tag later retired keeps working on the
      // tags it still names.
      const res = await listIds('tags=saas,web3_native');
      expect(res).toContain(saasPreRevenue);
      expect(res).toContain(saasOnly);
    });

    it('is unfiltered when nothing in the list is a tag', async () => {
      // Not an empty conjunction that matches nothing — the filter collapses to
      // absent, so the caller gets their whole readable list rather than a
      // silently empty page.
      const filtered = await listIds('tags=web3_native');
      const all = await listIds('');
      expect(filtered.length).toBe(all.length);
      expect(filtered.length).toBeGreaterThan(0);
    });

    it("still applies the caller's own visibility", async () => {
      // The tag filter narrows what a caller may already see; it is not a way
      // to reach another client's engagement.
      const stranger = await seedUser(ctx, { roles: ['valuation_user'] });
      expect(await listIds('tags=saas', stranger.token)).toEqual([]);
    });
  });
});
