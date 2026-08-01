/**
 * Per-valuation audit trail: GET /valuations/:id/audit-trail enriches the raw
 * event spine with category / severity / field-level changes, and enforces the
 * same visibility split as the rest of the platform — ops see analyst tooling,
 * clients see only the client-visible slice of the event catalog.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

interface AuditEntryBody {
  type: string;
  label: string;
  category: string;
  severity: string;
  visibility: string;
  actor_type: string;
  summary: string;
  changes: Array<{ field: string; from: unknown; to: unknown }>;
  occurred_at: string;
}

describe.skipIf(!dbUp)('valuation audit trail', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let outsider: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const trail = async (
    token: string,
    query = '',
  ): Promise<{
    entries: AuditEntryBody[];
    summary: Record<string, unknown>;
    total: number;
    includes_internal: boolean;
    truncated: boolean;
  }> => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/audit-trail${query}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    outsider = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'AuditTrailCo' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;

    // A methodology change (internal, critical) and a state move (client-visible).
    const params = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/params`,
      headers: authHeader(ops.token),
      payload: { dlom: 0.22, dloc: 0.05 },
    });
    expect(params.statusCode).toBe(200);

    const moved = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}`,
      headers: authHeader(ops.token),
      payload: { state: 'started' },
    });
    expect(moved.statusCode).toBe(200);
  });

  afterAll(async () => ctx?.teardown());

  it('returns enriched entries for ops, newest first', async () => {
    const body = await trail(ops.token);
    expect(body.includes_internal).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(3);

    const times = body.entries.map((e) => Date.parse(e.occurred_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    for (const entry of body.entries) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.category.length).toBeGreaterThan(0);
      expect(['info', 'notice', 'critical']).toContain(entry.severity);
    }
  });

  it('records field-level changes for a methodology patch', async () => {
    const body = await trail(ops.token, '?type=params_updated');
    expect(body.total).toBe(1);
    const entry = body.entries[0]!;
    expect(entry.severity).toBe('critical');
    expect(entry.category).toBe('methodology');
    const dlom = entry.changes.find((c) => c.field === 'dlom');
    expect(dlom).toMatchObject({ from: null, to: 0.22 });
    expect(entry.summary).toContain('DLOM');
  });

  it('records the state transition as a change to the state field', async () => {
    const body = await trail(ops.token, '?type=state_changed');
    expect(body.total).toBe(1);
    expect(body.entries[0]!.changes).toEqual([{ field: 'state', from: 'pending', to: 'started' }]);
  });

  it('hides internal analyst events from the client', async () => {
    const body = await trail(client.token);
    expect(body.includes_internal).toBe(false);
    expect(body.entries.some((e) => e.type === 'params_updated')).toBe(false);
    expect(body.entries.every((e) => e.visibility === 'client')).toBe(true);
    expect(body.entries.some((e) => e.type === 'valuation_created')).toBe(true);
  });

  it('summarises the trail by category and severity', async () => {
    const body = await trail(ops.token);
    const summary = body.summary as {
      total: number;
      by_category: Record<string, number>;
      by_severity: Record<string, number>;
      critical_changes: number;
      changed_fields: string[];
    };
    expect(summary.total).toBe(body.total);
    expect(summary.by_category['methodology']).toBe(1);
    expect(summary.critical_changes).toBeGreaterThanOrEqual(1);
    expect(summary.changed_fields).toContain('dlom');
    expect(summary.changed_fields).toContain('state');
  });

  it('filters by category, severity and changed field', async () => {
    expect((await trail(ops.token, '?category=methodology')).total).toBe(1);
    expect((await trail(ops.token, '?severity=critical')).total).toBeGreaterThanOrEqual(1);
    expect((await trail(ops.token, '?field=dlom')).total).toBe(1);
    expect((await trail(ops.token, '?field=not_a_field')).total).toBe(0);
  });

  it('paginates without losing the total', async () => {
    const all = await trail(ops.token);
    const firstPage = await trail(ops.token, '?per_page=1&page=1');
    const secondPage = await trail(ops.token, '?per_page=1&page=2');
    expect(firstPage.total).toBe(all.total);
    expect(firstPage.entries).toHaveLength(1);
    expect(secondPage.entries[0]!.type).not.toBe(firstPage.entries[0]!.type);
  });

  it('reports that nothing was truncated for a short trail', async () => {
    expect((await trail(ops.token)).truncated).toBe(false);
  });

  it('rejects an unknown category', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/audit-trail?category=nonsense`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s for a principal who cannot read the valuation', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/audit-trail`,
      headers: authHeader(outsider.token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('404s for a malformed id instead of leaking a database error', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/valuations/not-a-ulid/audit-trail',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/audit-trail`,
    });
    expect(res.statusCode).toBe(401);
  });

  describe('CSV change log', () => {
    it('serves a flat change log an auditor can open in Excel', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/audit-trail.csv`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');

      const [header, ...rows] = res.body.trim().split('\r\n');
      expect(header).toContain('field_label');
      const dlom = rows.find((r) => r.includes(',dlom,'));
      expect(dlom).toBeDefined();
      expect(dlom).toContain('DLOM');
    });

    it('excludes internal changes from a client download', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/audit-trail.csv`,
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(',dlom,');
      // The client-visible state change is still there.
      expect(res.body).toContain('state_changed');
    });

    it('404s for a principal who cannot read the valuation', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/audit-trail.csv`,
        headers: authHeader(outsider.token),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('field history', () => {
    it('returns every recorded change to one field', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/audit-trail/field-history?field=dlom`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.field).toBe('dlom');
      expect(body.history).toHaveLength(1);
      expect(body.history[0]).toMatchObject({ from: null, to: 0.22, type: 'params_updated' });
    });

    it('does not expose internal field history to the client', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/audit-trail/field-history?field=dlom`,
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().history).toEqual([]);
    });

    it('requires a field name', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/audit-trail/field-history`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
