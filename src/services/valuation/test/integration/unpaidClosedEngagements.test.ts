import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateValuation } from '../../src/repos/valuations.js';
import { STATE_GROUPS } from '../../src/domain/operations.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * A file the firm has closed does not keep a pay-now button.
 *
 * `listUnpaidValuationsForScope` is the billing page's demand for money, and
 * it filtered closed work by naming two of the three ways a file closes:
 * `cancelled` and `timeout`. `ignored` — where ops put an engagement that
 * never came to anything — sits beside them in `WORKFLOW_TRANSITIONS`,
 * `HALTED_STATES`, `STATE_GROUPS.closed` and the `ignored` named bucket, and
 * was added to the state machine after the list was written.
 *
 * So the list is driven off `STATE_GROUPS.closed` and this is driven off the
 * same constant: a fourth closed state added tomorrow is covered here without
 * anybody remembering to come back.
 */

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('the pay-now list and a closed engagement', () => {
  let ctx: TestApp;
  let client: { id: string; token: string };

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  }, 60_000);
  afterAll(async () => ctx?.teardown());

  const createValuation = async (companyName: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  const setState = async (id: string, state: string) => {
    await ctx.pool.query('UPDATE valuations SET state = $2::valuation_state WHERE id = $1', [id, state]);
    invalidateValuation(id);
  };

  const unpaidIds = async (): Promise<string[]> => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me/billing',
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(200);
    return (res.json().billing.unpaid_valuations as { id: string }[]).map((v) => v.id);
  };

  it('offers an open engagement and none of the closed ones', async () => {
    const open = await createValuation('Open Pay Co');
    const closed: Record<string, string> = {};
    for (const state of STATE_GROUPS.closed) {
      const id = await createValuation(`Closed ${state} Co`);
      await setState(id, state);
      closed[state] = id;
    }

    const listed = await unpaidIds();
    // Not vacuous: the live engagement is unpaid and is offered, so an empty
    // list would not be what makes the assertions below pass.
    expect(listed).toContain(open);
    for (const [state, id] of Object.entries(closed)) {
      expect(listed, `${state} engagement is still being billed for`).not.toContain(id);
    }
  });
});
