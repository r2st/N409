import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The *other* value on an override body.
 *
 * `PUT /valuations/:id/overwrites/:field_key` carries two figures for one cell:
 * `value`, the number or string the analyst is imposing, and `original_value`,
 * the AI/computed figure it replaces. They describe the same cell, they are
 * displayed side by side ever after — the overwrites tab renders "was X" from
 * it, and the audit event this write records puts it in `from` — and only the
 * first of them was ever checked. `original_value` was
 * `z.union([z.number(), z.string(), z.null()])` and nothing after the schema
 * looked at it again.
 *
 * Which let three things through, all of them under a 200:
 *
 *  - a class mismatch. A `numeric` field could be told its original value was
 *    `"n/a"`, a `date` field a number. The pair on screen then disagrees about
 *    what kind of thing the cell holds, and so does the audit trail.
 *  - `1e999`. JSON parses it to Infinity and `JSON.stringify` writes Infinity
 *    to a `jsonb` column as `null`, so the figure the analyst supplied is
 *    stored as "there wasn't one" — the exact round trip `finiteNumberSweep`
 *    exists to prevent, at a site that file's exemption for this route was
 *    covering without describing.
 *  - any length the 1 MB body allows, stored twice: the `overwrites` row and
 *    the event payload are both jsonb.
 *
 * The browser already refused all three (`OverwritesTab.tsx` parses the
 * original by class and requires `Number.isFinite`), which is the client/server
 * parity shape: the rule existed, in the one place a caller can skip.
 */
describe.skipIf(!dbUp)('an override’s original_value is held to the field it describes', () => {
  let ctx: TestApp;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
  });
  afterAll(async () => ctx?.teardown());

  async function newValuation(): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'Acme Robotics, Inc.' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  }

  /** `payload` is sent raw so `1e999` survives as written rather than as a JS number. */
  const put = async (valuationId: string, field: string, payload: string) =>
    ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/overwrites/${field}`,
      headers: { ...authHeader(ops.token), 'content-type': 'application/json' },
      payload,
    });

  it('accepts the original a numeric field really had', async () => {
    const id = await newValuation();
    const res = await put(id, 'dlom', JSON.stringify({ value: 0.21, original_value: 0.18 }));
    expect(res.statusCode).toBe(200);
    expect(res.json().overwrite.original_value).toBe(0.18);
  });

  it('accepts no original at all — that is what null means', async () => {
    const id = await newValuation();
    const res = await put(id, 'dlom', JSON.stringify({ value: 0.21, original_value: null }));
    expect(res.statusCode).toBe(200);
    expect(res.json().overwrite.original_value).toBeNull();
  });

  it('refuses an original of the wrong class for the field', async () => {
    const id = await newValuation();
    const res = await put(id, 'dlom', JSON.stringify({ value: 0.21, original_value: 'n/a' }));
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/original_value/);
    expect(res.json().detail).toMatch(/finite number/);
  });

  /*
   * R303 reverses this. R299 checked the original against the field's policy
   * range along with everything else, by handing both figures on the body to
   * one `validateOverwriteValue` call.
   *
   * The range is a rule about the figure being imposed. `original_value` is the
   * figure being replaced, and out of policy is the commonest reason it is
   * being replaced — a DLOM the pipeline read as 0.99 from a source saying 99%,
   * which is precisely what an analyst imposing 0.28 is correcting. Refusing
   * the write leaves that figure both uncorrected and unrecorded, over the one
   * number in the body nobody is disputing.
   *
   * Class, finiteness and length still refuse, above and below: those say the
   * original is not a figure of this kind. The range says only that the old
   * number was wrong, which is the premise.
   */
  it('accepts an original outside the range, which is why it is being replaced', async () => {
    const id = await newValuation();
    const res = await put(id, 'dlom', JSON.stringify({ value: 0.21, original_value: 42 }));
    expect(res.statusCode).toBe(200);
    expect(res.json().overwrite.original_value).toBe(42);
    // The imposed value is still held to the range on the same request.
    const bad = await put(id, 'dlom', JSON.stringify({ value: 42, original_value: 0.21 }));
    expect(bad.statusCode).toBe(422);
    expect(bad.json().detail).toMatch(/Invalid value/);
  });

  /**
   * The asymmetry that made the above visible. On a second write the UPDATE
   * branch of `upsertOverwrite` does not touch `original_value` — it stays
   * frozen from the first write, which is the contract the overwrites tab
   * renders "was X" from. A range check therefore refused the request over a
   * figure the route was about to discard unread; every other test here starts
   * from a fresh valuation, so all of them are first writes.
   */
  it('does not refuse an update over the original it is about to discard', async () => {
    const id = await newValuation();
    const first = await put(id, 'dlom', JSON.stringify({ value: 0.21, original_value: 0.24 }));
    expect(first.statusCode).toBe(200);

    const second = await put(id, 'dlom', JSON.stringify({ value: 0.28, original_value: 0.99 }));
    expect(second.statusCode).toBe(200);
    expect(second.json().overwrite.value).toBe(0.28);
    expect(second.json().overwrite.original_value).toBe(0.24);
  });

  /**
   * The one that was silent. Before the check this stored `null` under a 200:
   * the request said "the computed figure was very large" and the row said
   * there was no computed figure.
   */
  it('refuses an original of 1e999 rather than storing null', async () => {
    const id = await newValuation();
    const res = await put(id, 'dlom', '{"value":0.21,"original_value":1e999}');
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/finite number/);

    const { rows } = await ctx.pool.query('SELECT 1 FROM overwrites WHERE valuation_id = $1', [id]);
    expect(rows).toHaveLength(0);
  });

  it('refuses an original longer than a character field may hold', async () => {
    const id = await newValuation();
    const res = await put(
      id,
      'company_legal_name',
      JSON.stringify({ value: 'Acme Robotics, Inc.', original_value: 'x'.repeat(2001) }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/original_value/);
    expect(res.json().detail).toMatch(/2000 characters/);
  });

  it('still refuses a bad `value`, and says which of the two it means', async () => {
    const id = await newValuation();
    const res = await put(id, 'dlom', JSON.stringify({ value: 42, original_value: 0.18 }));
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/Invalid value for/);
    expect(res.json().detail).not.toMatch(/original_value/);
  });
});
