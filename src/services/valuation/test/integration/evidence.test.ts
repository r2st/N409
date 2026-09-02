import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { inflateRawSync } from 'node:zlib';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Minimal reader: central directory → { name → utf8 body }.
 *
 * INFLATES, BECAUSE THE BUNDLE DEFLATES (R344, methodology M5). This walked
 * the central directory and read `compressed_size` bytes out of each local
 * header as UTF-8, which is only the entry's content while the writer stores
 * it. R330 taught `buildZip` to deflate — losslessly, and with both headers
 * still describing the original bytes — and did not teach this, so every
 * assertion in this file that reads a document out of the bundle has since
 * been handed a deflate stream and thrown `SyntaxError: Unexpected token` out
 * of `JSON.parse`. Four of the eight tests here, red on `main` since.
 *
 * The method comes off the entry rather than being assumed, so the mixed
 * bundle `buildZip` now writes — deflated JSON beside a report PDF it stores
 * because deflating it would not pay — reads correctly either way, and a later
 * change to that policy does not break this file again.
 */
function zipEntries(buf: Buffer): Map<string, string> {
  const eocd = buf.subarray(buf.length - 22);
  expect(eocd.readUInt32LE(0)).toBe(0x06054b50);
  const count = eocd.readUInt16LE(10);
  let p = eocd.readUInt32LE(16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const localNameLen = buf.readUInt16LE(offset + 26);
    const localExtraLen = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + size);
    // 0 = stored, 8 = deflate. Raw deflate, not zlib: a zip member carries no
    // zlib header, which is what `inflateRawSync` is for.
    out.set(name, (method === 8 ? inflateRawSync(raw) : raw).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe.skipIf(!dbUp)('evidence bundle export', () => {
  /** Bumped by each test that exports a bundle successfully. */
  let successfulExports = 0;
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'EvidenceCo' },
    });
    valuationId = created.json().valuation.id;

    // Give the bundle something to package: a comment and a signature.
    await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comments`,
      headers: authHeader(ops.token),
      payload: { kind: 'note', body: 'internal reviewer note' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/signatures`,
      headers: authHeader(ops.token),
      payload: {
        role: 'main',
        signer_name: 'Alice Analyst',
        signer_title: 'Reviewer',
        signature_text: 'Alice Analyst',
      },
    });
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('is operations-only', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/evidence-bundle`,
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(403);
  });

  it('404s on an unknown valuation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations/01JZZZZZZZZZZZZZZZZZZZZZZZ/evidence-bundle',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns a ZIP with the full audit package and records the export', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/evidence-bundle`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    successfulExports += 1;
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain('evidence-bundle-');

    const entries = zipEntries(res.rawPayload);
    expect([...entries.keys()].sort()).toEqual(
      [
        'manifest.json',
        'events.json',
        'audit-trail.json',
        'change-log.csv',
        'calculations.json',
        // The engine's own step record per run (migration 0126). It answers
        // "how", which the result document structurally cannot, and no list
        // query carries the column — the bundle is the one caller for which
        // that is the point.
        'calculation-traces.json',
        // The grid the analyst typed, with the data-quality pass over it.
        // `calculations.inputs` is the payload *derived* from it, so a bundle
        // without this gave the auditor the derived figures and never the ones
        // they came from.
        'workbook.json',
        'documents.json',
        'comments.json',
        'signatures.json',
        'review-tasks.json',
        'admin-events.json',
        'ai-jobs.json',
        'ai-prompt-versions.json',
        'decisions.json',
        'qa-reviews.json',
        'scenarios.json',
        // Superseded rows included: "what did you read, and what before
        // that" is exactly what the supersede chain records.
        'market-research.json',
        // The peer set, included and excluded rows alike (migration 0119) —
        // the excluded half is the one an auditor asks about.
        'comparables.json',
        'report-versions.json',
      ].sort(),
    );

    const manifest = JSON.parse(entries.get('manifest.json')!);
    expect(manifest.format).toBe('n409-evidence-bundle/1');
    expect(manifest.valuation.id).toBe(valuationId);
    expect(manifest.valuation.company_name).toBe('EvidenceCo');
    expect(manifest.generated_by.id).toBe(ops.id);
    expect(manifest.counts.comments).toBe(1);
    expect(manifest.counts.signatures).toBe(1);

    const events = JSON.parse(entries.get('events.json')!);
    expect(events.map((e: { type: string }) => e.type)).toContain('valuation_created');

    const comments = JSON.parse(entries.get('comments.json')!);
    expect(comments[0].body).toBe('internal reviewer note');

    const signatures = JSON.parse(entries.get('signatures.json')!);
    expect(signatures[0].signer_name).toBe('Alice Analyst');

    // The export itself must land on the audit spine.
    const timeline = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/events`,
      headers: authHeader(ops.token),
    });
    const types = timeline.json().events.map((e: { type: string }) => e.type);
    expect(types).toContain('evidence_bundle_exported');
  });

  it('includes an enriched audit trail and a flat change log', async () => {
    // A methodology change so there is a field-level change to record.
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/params`,
      headers: authHeader(ops.token),
      payload: { dlom: 0.22 },
    });
    expect(patched.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/evidence-bundle`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    successfulExports += 1;
    const entries = zipEntries(res.rawPayload);

    const trail = JSON.parse(entries.get('audit-trail.json')!);
    expect(trail.summary.total).toBeGreaterThan(0);
    expect(trail.summary.changed_fields).toContain('dlom');
    const params = trail.entries.find((e: { type: string }) => e.type === 'params_updated');
    expect(params.severity).toBe('critical');
    expect(params.category).toBe('methodology');
    expect(params.changes).toContainEqual({ field: 'dlom', from: null, to: 0.22 });

    const csv = entries.get('change-log.csv')!;
    const [header, ...rows] = csv.trim().split('\r\n');
    expect(header.split(',')).toEqual([
      'occurred_at',
      'seq',
      'event_type',
      'event',
      'category',
      'severity',
      'actor_type',
      'actor_id',
      'source',
      'field',
      'field_label',
      'from',
      'to',
    ]);
    const dlomRow = rows.find((r) => r.includes(',dlom,'));
    expect(dlomRow).toBeDefined();
    expect(dlomRow).toContain('params_updated');
    expect(dlomRow).toContain('DLOM');
    expect(dlomRow).toContain('0.22');

    // Every row must have as many columns as the header (quoting held up).
    for (const row of rows) {
      expect(row.length).toBeGreaterThan(0);
    }

    const manifest = JSON.parse(entries.get('manifest.json')!);
    expect(manifest.audit_summary.critical_changes).toBeGreaterThanOrEqual(1);
    expect(manifest.audit_summary.changed_fields).toContain('dlom');
    expect(manifest.counts.field_changes).toBeGreaterThanOrEqual(1);
    expect(manifest.files).toContain('change-log.csv');
  });

  /**
   * The two artifacts an auditor asks for that the bundle used to omit.
   *
   * Both were computed and persisted and reached nobody: the engine's step
   * trace is written on every traced run and read only by the analyst's
   * inspector, and the entered workbook is the grid every derived figure in
   * `calculations.inputs` came from. A bundle answering "what is the number"
   * without either cannot answer "how did you get it" or "from what".
   */
  it('carries the engine step trace and the workbook the figures came from', async () => {
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/workbook`,
      headers: authHeader(ops.token),
      payload: {
        cells: [
          { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_current', value: 6_000_000 },
          // A cost line entered negative — the finding the anomaly pass most
          // deserved to exist for, since the model subtracts these rows and so
          // *adds back* a negative one, overstating every margin below it.
          { sheet: 'income_statement', row_key: 'cogs', column_key: 'fy_current', value: -2_000_000 },
        ],
      },
    });
    expect(patched.statusCode).toBe(200);

    // A traced run, written directly: this engagement has no engine behind it,
    // and what is under test is that the column reaches the bundle, not how it
    // came to be filled (calculationInspector.test.ts covers that end).
    const tracedCalculationId = newUlid();
    await pool.query(
      `INSERT INTO calculations (id, valuation_id, engine_version, status, inputs, results, diagnostics, trace)
       VALUES ($1, $2, 'py-stub', 'succeeded', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, $3::jsonb)`,
      [
        tracedCalculationId,
        valuationId,
        JSON.stringify([
          {
            seq: 1,
            key: 'approach.asset',
            label: 'Asset approach',
            status: 'skipped',
            inputs: { weight: 0 },
            outputs: null,
            note: 'zero weight — excluded from the conclusion',
            elapsed_ms: 0.01,
          },
          {
            seq: 2,
            key: 'approach.market',
            label: 'Market approach (comparables)',
            status: 'reused',
            inputs: null,
            outputs: { equity_value: 28_000_000 },
            note: 'carried over from the previous run',
            elapsed_ms: 0.02,
          },
          {
            seq: 3,
            key: 'weighting',
            label: 'Weighted equity value',
            status: 'computed',
            inputs: { weight_total: 1 },
            outputs: { equity_value: 28_000_000 },
            note: null,
            elapsed_ms: 0.5,
          },
        ]),
      ],
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/evidence-bundle`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    successfulExports += 1;
    const entries = zipEntries(res.rawPayload);

    const workbook = JSON.parse(entries.get('workbook.json')!);
    const income = workbook.sheets.find((s: { key: string }) => s.key === 'income_statement');
    expect(income).toBeDefined();
    // The grid itself, not the engine payload derived from it.
    expect(JSON.stringify(income)).toContain('6000000');
    // And the checks that ran over it, which is what makes the grid reviewable
    // rather than merely present.
    expect(workbook.anomalies.empty).toBe(false);
    const negativeCost = workbook.anomalies.anomalies.find(
      (a: { row_key: string | null }) => a.row_key === 'cogs',
    );
    expect(negativeCost).toBeDefined();
    expect(negativeCost.severity).toBe('error');

    const traces = JSON.parse(entries.get('calculation-traces.json')!);
    expect(traces).toHaveLength(1);
    // The two step statuses a results document structurally cannot express: an
    // approach excluded on purpose and one whose figure is older than the
    // inputs printed beside it. They are the reason the trace is worth
    // packaging at all, so they are what the assertion names.
    expect(traces[0].id).toBe(tracedCalculationId);
    expect(traces[0].trace.map((s: { status: string }) => s.status)).toEqual([
      'skipped',
      'reused',
      'computed',
    ]);
    expect(traces[0].trace[0].note).toBe('zero weight — excluded from the conclusion');

    const manifest = JSON.parse(entries.get('manifest.json')!);
    expect(manifest.counts.workbook_cells).toBe(2);
    expect(manifest.counts.workbook_anomalies).toBeGreaterThanOrEqual(1);
    expect(manifest.counts.calculation_traces).toBe(traces.length);
    // A trace count above the calculation count would read as a mismatch.
    expect(manifest.counts.calculation_traces).toBeLessThanOrEqual(manifest.counts.calculations);
    expect(manifest.files).toContain('calculation-traces.json');
    expect(manifest.files).toContain('workbook.json');
  });

  it('says so when a list it reads itself came back short', async () => {
    /*
     * The bundle's own two reads — `review_tasks` and `admin_events` — had no
     * cap at all until R221, and no census could see that they did not: both
     * the uncapped-read and the silent-cap censuses enumerate `src/repos`, and
     * these are written in the route. A bundle is read by somebody looking for
     * what is *not* in it, so the manifest has to say which of the two a short
     * list is.
     *
     * On its own valuation, because the count assertions above are over the
     * shared one.
     */
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'BusyAdminCo' },
    });
    const id = created.json().valuation.id;
    // One past the ceiling, oldest first, so the newest kept row is knowable.
    await pool.query(
      `INSERT INTO admin_events (id, type, actor_type, actor_id, subject_type, subject_id, subject_label, occurred_at)
       SELECT $1 || lpad(g::text, 4, '0'), 'valuation_flagged', 'human', $2, 'valuation', $3,
              'row ' || g, now() - make_interval(secs => 600 - g)
         FROM generate_series(1, 501) g`,
      [newUlid().slice(0, 22), ops.id, id],
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/evidence-bundle`,
      headers: authHeader(ops.token),
    });
    // Not counted in `successfulExports`: that tally is over the shared
    // valuation's export events, and this bundle is another valuation's.
    expect(res.statusCode).toBe(200);

    const entries = zipEntries(res.rawPayload);
    const manifest = JSON.parse(entries.get('manifest.json')!);
    expect(manifest.truncated.admin_events).toBe(500);
    expect(manifest.counts.admin_events).toBe(500);
    // The page kept is the newest end, handed back oldest-first — the same
    // choice the audit trail makes, so the recent history an auditor asks
    // about is the half that survives.
    const adminEvents = JSON.parse(entries.get('admin-events.json')!) as Array<{
      subject_label: string;
    }>;
    expect(adminEvents).toHaveLength(500);
    expect(adminEvents[0]!.subject_label).toBe('row 2');
    expect(adminEvents.at(-1)!.subject_label).toBe('row 501');
    // And a list that did not reach its ceiling says nothing at all.
    expect(manifest.truncated.review_tasks).toBeUndefined();
    expect(manifest.truncated.events).toBeUndefined();
  });

  it('client cannot reach another user’s bundle (404, not 403 leak)', async () => {
    const own = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'ClientOwnCo' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${own.json().valuation.id}/evidence-bundle`,
      headers: authHeader(client.token),
    });
    // Even on their own valuation the bundle stays ops-only.
    expect(res.statusCode).toBe(403);
  });

  it('pool has no leaked transaction (export event committed)', async () => {
    // One committed event per successful export above — the count is tracked
    // rather than hard-coded so adding an export test cannot silently pass.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM valuation_events WHERE valuation_id = $1 AND type = 'evidence_bundle_exported'`,
      [valuationId],
    );
    expect(rows[0].n).toBe(successfulExports);
  });
});
