import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReport, findReportByValuation, storeRenderedPdf } from '../../src/repos/reports.js';
import { listEvents } from '../../src/events/record.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * The deliverable leaving, recorded.
 *
 * `report_rendered` fires when a version is *produced*, and the published
 * report is served from the stored bytes — so a 409A pulled fifty times over a
 * year by a client, a partner integration and whoever else held the link left
 * exactly one event, dated the day it was made. The only read that ever
 * recorded anything did so by accident: an unpublished engagement renders a
 * stamped copy per download, so the draft path wrote a render event each time
 * while the delivered document — the one auditors and boards actually pull —
 * was the silent one.
 *
 * The evidence bundle has said "the export itself is an auditable act" since it
 * was written. This holds the other two doors to it.
 */

const dbUp = await isDbAvailable();

const CONTENT = {
  title: 'Downloadable Co — 409A',
  sections: [{ key: 'summary', heading: 'Summary', html: '<p>Conclusion.</p>' }],
};

describe.skipIf(!dbUp)('downloading the deliverable', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  /** An engagement with a report whose bytes are already stored — the cached path. */
  const seedDeliverable = async (name: string) => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(created.statusCode).toBe(201);
    const vid = created.json().valuation.id as string;

    const actor = { actorType: 'human' as const, actorId: ops.id, source: 'test' };
    await createReport(ctx.pool, { valuationId: vid, templateVersion: '409a.v1', content: CONTENT, actor });
    const report = (await findReportByValuation(ctx.pool, vid))!;
    await storeRenderedPdf(ctx.pool, {
      report,
      version: report.current_version,
      pdf: Buffer.from('%PDF-1.4 stored deliverable'),
      actor,
    });
    return vid;
  };

  const downloadEvents = async (vid: string) =>
    (await listEvents(ctx.pool, vid, { limit: 200 })).filter((e) => e.type === 'report_downloaded');

  it('records each read of the stored bytes, which nothing did', async () => {
    const vid = await seedDeliverable('Downloadable Co');
    for (let i = 0; i < 2; i += 1) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/report.pdf`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
    }

    const events = await downloadEvents(vid);
    // Two reads, two rows: the point of the event is the *read*, so a second
    // download of an unchanged document is a second fact, not a duplicate.
    expect(events).toHaveLength(2);
    // And attributed to the person who asked. `system` here would put the
    // download in "what the platform did on its own" and take it out of "what
    // people did" — wrong on both of the activity log's actor filters.
    expect(events[0]!.actor_type).toBe('human');
    expect(events[0]!.actor_id).toBe(ops.id);
    expect(events[0]!.source).toBe('report.pdf');
    expect(events[0]!.payload.version).toBe(1);
  });

  it('names the reader, so two people pulling one report are two rows', async () => {
    const vid = await seedDeliverable('Two Readers Co');
    // Two operators rather than an operator and the owner, only because the
    // owner's door opens at `drafted` and the engagement here has not moved.
    // The property under test is the same: the row names the reader.
    const second = await seedUser(ctx, { roles: ['admin'] });
    for (const who of [ops, second]) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/report.pdf`,
        headers: authHeader(who.token),
      });
      expect(res.statusCode).toBe(200);
    }
    const actors = (await downloadEvents(vid)).map((e) => e.actor_id).sort();
    expect(actors).toEqual([ops.id, second.id].sort());
  });
});
