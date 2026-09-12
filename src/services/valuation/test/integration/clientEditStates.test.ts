import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT_EDITABLE_STATES } from '../../src/domain/clientEdits.js';
import { VALUATION_STATES } from '../../src/domain/valuation.js';
import { authHeader, forceState, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The owner's edits close where the deliverable starts being written, at
 * both doors (R449).
 *
 * The partner API has refused `PUT /valuations/{id}` from `review` on since
 * it gained the route — once a file is in review an analyst is working from
 * these values, and a company name that changes underneath them appears in a
 * report nobody re-read. The console's `PATCH /valuations/:id` is the same
 * owner, the same three fields, over a session instead of a key, and it
 * never asked: a client could rename the company on a published 409A whose
 * signatures were taken over the old name.
 *
 * Driven over every state in the vocabulary, partitioned by the one set both
 * doors now read, so a state added tomorrow is asked the day it exists. Ops
 * are driven alongside as the control: correcting a label after review is
 * the analyst's ordinary path and stays open.
 */
describe.skipIf(!dbUp)('the owner’s edits and the state of the engagement', () => {
  let ctx: TestApp;
  let owner: { id: string; token: string };
  let ops: { id: string; token: string };

  beforeAll(async () => {
    ctx = await setupTestApp();
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
    ops = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  const create = async (name: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };
  const patch = (token: string, id: string, body: object) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}`,
      headers: authHeader(token),
      payload: body,
    });

  const closed = VALUATION_STATES.filter((s) => !CLIENT_EDITABLE_STATES.has(s));
  const open = VALUATION_STATES.filter((s) => CLIENT_EDITABLE_STATES.has(s));

  it('partitions the whole vocabulary', () => {
    expect(closed.length).toBeGreaterThan(0);
    expect(open.length).toBeGreaterThan(0);
    expect([...closed, ...open].sort()).toEqual([...VALUATION_STATES].sort());
  });

  it.each(closed)('refuses the owner once the file is %s, and says why', async (state) => {
    const id = await create(`Closed ${state} Co`);
    await forceState(ctx, id, state);
    const res = await patch(owner.token, id, { company_name: 'Too Late Inc.' });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain(`'${state}'`);
    expect(res.json().detail).toContain('no longer editable');
    expect(res.json().detail).toMatch(/analyst/i);
    const { rows } = await ctx.pool.query<{ company_name: string }>(
      'SELECT company_name FROM valuations WHERE id = $1',
      [id],
    );
    expect(rows[0]!.company_name).toBe(`Closed ${state} Co`);
  });

  it.each(closed)('lets the analyst correct a label while the file is %s', async (state) => {
    const id = await create(`Analyst ${state} Co`);
    await forceState(ctx, id, state);
    const res = await patch(ops.token, id, { company_name: 'Corrected Inc.' });
    expect(res.statusCode).toBe(200);
    expect(res.json().valuation.company_name).toBe('Corrected Inc.');
  });

  it.each(open)('lets the owner correct a label while the file is %s', async (state) => {
    const id = await create(`Open ${state} Co`);
    await forceState(ctx, id, state);
    const res = await patch(owner.token, id, { company_name: 'Still Mine Inc.' });
    expect(res.statusCode).toBe(200);
    expect(res.json().valuation.company_name).toBe('Still Mine Inc.');
  });

  it('answers the field question before the state question', async () => {
    // A field the owner never had is a 403 whatever the state — the sentence
    // about review would send them to the analyst for a field the analyst
    // would refuse to hand over too.
    const id = await create('Field First Co');
    await forceState(ctx, id, 'published');
    const res = await patch(owner.token, id, { waiting_on_client: true });
    expect(res.statusCode).toBe(403);
  });

  it('answers an empty patch with the row, whatever the state', async () => {
    const id = await create('Empty Patch Co');
    await forceState(ctx, id, 'published');
    expect((await patch(owner.token, id, {})).statusCode).toBe(200);
  });
});
