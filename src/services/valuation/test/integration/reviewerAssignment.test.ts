import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * `PATCH /api/v1/valuations/:id` accepted `assigned_reviewer_id` as a bare
 * string and wrote it straight to the column.
 *
 * The column is the `ulid` domain with `valuations_assigned_reviewer_id_fkey`
 * onto `users`, so both ways of getting it wrong ended in the driver rather
 * than the validator:
 *
 *   'not-a-ulid'  →  23514  value for domain ulid violates check constraint
 *   a real ULID   →  23503  insert or update violates foreign key constraint
 *
 * Neither SQLSTATE is mapped, so both surfaced as a bare 500 naming nothing —
 * verified against a live database before this test existed. The second is the
 * one an ordinary admin hits: a reviewer who has since been deleted, or an id
 * from a list that was loaded before they were.
 *
 * `routes/workflow.ts` already got this right for the bulk reassign, and this
 * asserts the single-valuation patch now answers the same way it does.
 */

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('PATCH /valuations/:id assigned_reviewer_id', () => {
  let ctx: TestApp;
  let admin: { id: string; token: string };
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    const owner = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { company_name: 'Reviewer Assignment Co', kind: '409a' },
    });
    valuationId = (created.json() as { valuation: { id: string } }).valuation.id;
  });
  afterAll(() => ctx.teardown());

  const patch = (assigned_reviewer_id: unknown) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}`,
      headers: authHeader(admin.token),
      payload: { assigned_reviewer_id },
    });

  it.each([
    ['a string that is not an id', 'not-a-ulid'],
    ['a lowercase ULID', newUlid().toLowerCase()],
    ['an id padded past 26 characters', `${newUlid()}AAAA`],
    ['the empty string', ''],
  ])('rejects %s with a 422, not a 500', async (_label, value) => {
    const res = await patch(value);
    expect(res.statusCode).toBe(422);
  });

  it('rejects a well-formed id belonging to no user', async () => {
    const res = await patch(newUlid());
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ detail: 'Unknown reviewer' });
  });

  it('names the field, so a form can put the message beside it', async () => {
    const res = await patch(newUlid());
    expect((res.json() as { errors: Array<{ path: string[] }> }).errors[0]?.path).toEqual([
      'assigned_reviewer_id',
    ]);
  });

  it('assigns a reviewer who exists', async () => {
    const reviewer = await seedUser(ctx, { roles: ['reviewer'] });
    const res = await patch(reviewer.id);
    expect(res.statusCode).toBe(200);
    expect(
      (res.json() as { valuation: { assigned_reviewer_id: string } }).valuation.assigned_reviewer_id,
    ).toBe(reviewer.id);
  });

  it('still clears the assignment with null', async () => {
    const reviewer = await seedUser(ctx, { roles: ['reviewer'] });
    expect((await patch(reviewer.id)).statusCode).toBe(200);
    const cleared = await patch(null);
    expect(cleared.statusCode).toBe(200);
    expect(
      (cleared.json() as { valuation: { assigned_reviewer_id: string | null } }).valuation
        .assigned_reviewer_id,
    ).toBeNull();
  });
});
