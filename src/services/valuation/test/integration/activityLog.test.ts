import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeader,
  isDbAvailable,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';

/**
 * Activity audit log viewer (P2 #12): admin console actions are evented into
 * admin_events, the global listing merges them with valuation_events, filters
 * combine, and the whole surface is ops-only and immutable.
 */

const dbUp = await isDbAvailable();

interface EventJson {
  id: string;
  scope: 'valuation' | 'admin';
  type: string;
  actor_id: string | null;
  actor_email: string | null;
  subject_type: string;
  subject_id: string | null;
  subject_label: string | null;
  payload: Record<string, unknown>;
}

describe.skipIf(!dbUp)('activity audit log', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const listEvents = async (query = '', token = admin.token) =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/admin/events${query ? `?${query}` : ''}`,
      headers: authHeader(token),
    });

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'Audit Trail Co' },
    });
    valuationId = created.json().valuation.id as string;
  });
  afterAll(async () => ctx?.teardown());

  it('is ops-only', async () => {
    expect((await listEvents('', client.token)).statusCode).toBe(403);
  });

  it('surfaces valuation timeline events in the global feed with subject context', async () => {
    const res = await listEvents(`valuation_id=${valuationId}`);
    expect(res.statusCode).toBe(200);
    const events = res.json().events as EventJson[];
    expect(events.length).toBeGreaterThan(0);
    const created = events.find((e) => e.type === 'valuation_created');
    expect(created).toBeDefined();
    expect(created!.scope).toBe('valuation');
    expect(created!.subject_label).toContain('Audit Trail Co');
    expect(created!.actor_email).toBe(client.email);
  });

  it('returns only that valuation\'s events when filtering by valuation', async () => {
    const res = await listEvents(`valuation_id=${valuationId}`);
    const events = res.json().events as EventJson[];
    expect(events.length).toBeGreaterThan(0);
    // An admin event can never match a valuation filter: admin_events is keyed
    // by subject (user, partner, prompt), never by valuation.
    expect(events.every((e) => e.scope === 'valuation')).toBe(true);
    expect(events.every((e) => e.subject_id === valuationId)).toBe(true);
  });

  it('finds nothing for a valuation that does not exist', async () => {
    const res = await listEvents('valuation_id=01JXXXXXXXXXXXXXXXXXXXXXXX');
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toEqual([]);
    expect(res.json().total).toBe(0);
  });

  it('finds nothing for admin scope combined with a valuation filter', async () => {
    const res = await listEvents(`scope=admin&valuation_id=${valuationId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toEqual([]);
    expect(res.json().total).toBe(0);
  });

  it('events admin console actions: user create/update/deactivate/restore', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: authHeader(admin.token),
      payload: {
        email: 'audited.user@test.example.com',
        password: 'audited-password-1',
        roles: ['valuation_user'],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const userId = createRes.json().user.id as string;

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${userId}`,
      headers: authHeader(admin.token),
      payload: { roles: ['valuation_user', 'reviewer'] },
    });
    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${userId}`,
      headers: authHeader(admin.token),
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/users/${userId}/restore`,
      headers: authHeader(admin.token),
    });

    const res = await listEvents('scope=admin');
    const events = res.json().events as EventJson[];
    const forUser = events.filter((e) => e.subject_id === userId);
    expect(forUser.map((e) => e.type).sort()).toEqual([
      'user_created',
      'user_deactivated',
      'user_restored',
      'user_updated',
    ]);
    for (const e of forUser) {
      expect(e.actor_email).toBe(admin.email);
      expect(e.subject_label).toBe('audited.user@test.example.com');
    }
    const roleChange = forUser.find((e) => e.type === 'user_updated');
    expect(roleChange!.payload.roles).toEqual(['valuation_user', 'reviewer']);
  });

  it('events partner and prompt changes', async () => {
    const partnerRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/partners',
      headers: authHeader(admin.token),
      payload: { name: 'Audit Partner', key: 'audit-partner' },
    });
    expect(partnerRes.statusCode).toBe(201);
    const partnerId = partnerRes.json().partner.id as string;
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/partners/${partnerId}`,
      headers: authHeader(admin.token),
      payload: { name: 'Audit Partner Renamed' },
    });

    const prompts = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/prompts',
      headers: authHeader(admin.token),
    });
    const promptId = prompts.json().prompts[0].id as string;
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/prompts/${promptId}`,
      headers: authHeader(admin.token),
      payload: { system_prompt: 'audited prompt content' },
    });

    const events = (await listEvents('scope=admin')).json().events as EventJson[];
    const types = events.map((e) => e.type);
    expect(types).toContain('partner_created');
    expect(types).toContain('partner_updated');
    expect(types).toContain('prompt_updated');
    expect(events.find((e) => e.type === 'prompt_updated')!.subject_id).toBe(promptId);
  });

  it('combines filters and paginates', async () => {
    const mine = await listEvents(`actor_id=${admin.id}&type=user_created&scope=admin`);
    const events = mine.json().events as EventJson[];
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.type === 'user_created' && e.actor_id === admin.id)).toBe(true);

    const paged = await listEvents('per_page=2&page=1');
    expect(paged.json().events).toHaveLength(2);
    expect(paged.json().total).toBeGreaterThan(2);
    const page2 = await listEvents('per_page=2&page=2');
    const ids1 = (paged.json().events as EventJson[]).map((e) => e.id);
    const ids2 = (page2.json().events as EventJson[]).map((e) => e.id);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });

  it('scope filter separates valuation and admin activity', async () => {
    const valuations = (await listEvents('scope=valuations')).json().events as EventJson[];
    expect(valuations.every((e) => e.scope === 'valuation')).toBe(true);
    const adminOnly = (await listEvents('scope=admin')).json().events as EventJson[];
    expect(adminOnly.every((e) => e.scope === 'admin')).toBe(true);
  });

  it('keeps admin_events append-only at the database level', async () => {
    await expect(
      ctx.pool.query(`UPDATE admin_events SET type = 'tampered'`),
    ).rejects.toThrow(/append-only/);
    await expect(ctx.pool.query('DELETE FROM admin_events')).rejects.toThrow(/append-only/);
  });
});
