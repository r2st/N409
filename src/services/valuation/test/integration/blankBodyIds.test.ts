import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

/**
 * A blank id in a request body (round 331, methodology M19).
 *
 * Every one of these fields was `z.string()`, guarded by `if (body.the_id)` and
 * written with `?? null`. `''` is falsy to the guard and defined to the write,
 * so the request skipped the ownership / existence / self-parent checks and
 * then put `''` into a `ulid` column — a 23514 from the domain's CHECK, which
 * nothing maps, so the answer was 500.
 *
 * Each case asserts the 422 *and* that the response names the field, because a
 * blanket 400 would leave the caller guessing which of the ids it sent was the
 * one refused.
 */
describe.skipIf(!dbUp)('a blank id in a body is refused, not stored', () => {
  let ctx: TestApp;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
    ops = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  const seedValuation = (company: string) =>
    createValuation(
      ctx.pool,
      { kind: '409a', companyName: company, userId: owner.id },
      { ...actor, actorId: owner.id },
    );

  async function createOrg(name: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authHeader(owner.token),
      payload: { name, entity_type: 'holding_company' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().organization.id as string;
  }

  it('refuses a blank parent_org_id on create', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authHeader(owner.token),
      payload: { name: 'Blank Parent Co', parent_org_id: '' },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).toContain('parent_org_id');
  });

  it('refuses a blank parent_org_id on patch, and leaves the row alone', async () => {
    const orgId = await createOrg('Patch Co');
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${orgId}`,
      headers: authHeader(owner.token),
      payload: { parent_org_id: '' },
    });
    expect(res.statusCode).toBe(422);
    const { rows } = await ctx.pool.query('SELECT parent_org_id FROM organizations WHERE id = $1', [orgId]);
    expect(rows[0].parent_org_id).toBeNull();
  });

  /** `null` still detaches — the fix refuses blanks, not the documented "no parent". */
  it('still accepts an explicit null parent_org_id', async () => {
    const orgId = await createOrg('Detach Co');
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${orgId}`,
      headers: authHeader(owner.token),
      payload: { parent_org_id: null },
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a blank valuation_id when assigning an entity to an organization', async () => {
    const orgId = await createOrg('Assign Co');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${orgId}/entities`,
      headers: authHeader(owner.token),
      payload: { valuation_id: '' },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).toContain('valuation_id');
  });

  /**
   * The entity route is the one where the blank also bought a *rule*: the
   * "a standalone entity has no parent" refusal sits inside the same truthiness
   * guard, so `''` walked past it as well as past the ownership check.
   */
  it('refuses a blank parent_valuation_id on the entity relationship', async () => {
    const v = await seedValuation('Entity Co');
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${v.id}/entity`,
      headers: authHeader(owner.token),
      payload: { entity_type: 'standalone', parent_valuation_id: '' },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).toContain('parent_valuation_id');
    const { rows } = await ctx.pool.query('SELECT parent_valuation_id FROM valuations WHERE id = $1', [v.id]);
    expect(rows[0].parent_valuation_id).toBeNull();
  });

  it('refuses a blank assignee_id when creating a task', async () => {
    const v = await seedValuation('Task Co');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/tasks`,
      headers: authHeader(ops.token),
      payload: { kind: 'data_review', title: 'Check the cap table', assignee_id: '' },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).toContain('assignee_id');
  });

  it('refuses a blank assignee_id when patching a task, and keeps the assignment', async () => {
    const v = await seedValuation('Task Patch Co');
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/tasks`,
      headers: authHeader(ops.token),
      payload: { kind: 'data_review', title: 'Assigned', assignee_id: ops.id },
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().task.id;

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${taskId}`,
      headers: authHeader(ops.token),
      payload: { assignee_id: '' },
    });
    expect(res.statusCode).toBe(422);
    const { rows } = await ctx.pool.query('SELECT assignee_id FROM review_tasks WHERE id = $1', [taskId]);
    expect(rows[0].assignee_id).toBe(ops.id);
  });

  /*
   * The same three doors on the administration side. `POST /users`,
   * `POST /users/invite` and `PATCH /users/:id` each guard the partner with
   * `if (body.partner_id)` and write `partner_id ?? null`, so a blank one
   * skipped `assertAssignablePartner` and reached `users.partner_id ulid`.
   */
  it('refuses a blank partner_id when an administrator creates an account', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: authHeader(ops.token),
      payload: {
        email: 'blank-partner@example.com',
        password: 'correct-horse-9-battery',
        roles: ['valuation_user'],
        partner_id: '',
      },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).toContain('partner_id');
  });

  it('refuses a blank partner_id on an invitation', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users/invite',
      headers: authHeader(ops.token),
      payload: { email: 'blank-partner-invite@example.com', roles: ['valuation_user'], partner_id: '' },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).toContain('partner_id');
  });

  it('refuses a blank partner_id on an account patch, and leaves the account alone', async () => {
    const victim = await seedUser(ctx, { roles: ['valuation_user'] });
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${victim.id}`,
      headers: authHeader(ops.token),
      payload: { partner_id: '' },
    });
    expect(res.statusCode).toBe(422);
    const { rows } = await ctx.pool.query('SELECT partner_id FROM users WHERE id = $1', [victim.id]);
    expect(rows[0].partner_id).toBeNull();
  });

  /** Unassigning is still `null`, which is what the SPA sends for its blank option. */
  it('still accepts an explicit null assignee_id', async () => {
    const v = await seedValuation('Task Null Co');
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/tasks`,
      headers: authHeader(ops.token),
      payload: { kind: 'data_review', title: 'Unassign me', assignee_id: ops.id },
    });
    const taskId = created.json().task.id;
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${taskId}`,
      headers: authHeader(ops.token),
      payload: { assignee_id: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().task.assignee_id).toBeNull();
  });
});
