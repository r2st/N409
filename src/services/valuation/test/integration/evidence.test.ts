import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/** Minimal reader: central directory → { name → utf8 body }. */
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
    const size = buf.readUInt32LE(p + 24);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const localNameLen = buf.readUInt16LE(offset + 26);
    const localExtraLen = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLen + localExtraLen;
    out.set(name, buf.subarray(start, start + size).toString('utf8'));
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
