import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The certification, on the spine (R388, methodology M3).
 *
 * `valuation_signatures` holds one row per role, so it answers "who is
 * certifying this engagement now" and nothing else. Signing over an existing
 * signature replaces the row; withdrawing one removes it. Neither wrote an
 * event, so a file signed by one reviewer, re-signed by another and published
 * carried no record anywhere that the first certification was ever given — and
 * a withdrawal left nothing at all.
 *
 * Withdrawal is not an exotic path: `assertPublishGate`'s own refusal for a
 * stale second signature tells the operator to "have the second signatory
 * re-sign, or remove their signature on the Signatures panel, before
 * publishing". Every neighbouring step on that path is already on the spine —
 * `qa_review_completed`, `changes_requested`, `board_signoff_recorded`,
 * `report_rendered`.
 */
describe.skipIf(!dbUp)('the signature trail', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let other: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    other = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  async function newValuation(name: string): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(created.statusCode).toBe(201);
    return created.json().valuation.id as string;
  }

  const sign = (id: string, token: string, signerName: string, role = 'main') =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/signatures`,
      headers: authHeader(token),
      payload: { role, signer_name: signerName, signature_text: signerName },
    });

  const unsign = (id: string, role: string, token: string) =>
    ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/valuations/${id}/signatures/${role}`,
      headers: authHeader(token),
    });

  async function events(id: string) {
    const { rows } = await ctx.pool.query<{
      type: string;
      actor_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT type, actor_id, payload FROM valuation_events
        WHERE valuation_id = $1 AND type IN ('signature_recorded', 'signature_removed')
        ORDER BY id`,
      [id],
    );
    return rows;
  }

  it('records who signed, and who they signed over', async () => {
    const id = await newValuation('Signed Twice Ltd');
    expect((await sign(id, ops.token, 'Alice Analyst')).statusCode).toBe(201);
    expect((await sign(id, other.token, 'Bruno Reviewer')).statusCode).toBe(201);

    const rows = await events(id);
    expect(rows.map((r) => r.type)).toEqual(['signature_recorded', 'signature_recorded']);

    // The first signature stands alone: there was nothing to supersede.
    expect(rows[0]).toMatchObject({ actor_id: ops.id });
    expect(rows[0]!.payload).toMatchObject({ role: 'main', signer_name: 'Alice Analyst' });
    expect(rows[0]!.payload.replaced).toBeUndefined();

    // The second names the signatory it wrote over — the fact the single row
    // per role can no longer hold once the upsert has run.
    expect(rows[1]).toMatchObject({ actor_id: other.id });
    expect(rows[1]!.payload).toMatchObject({ role: 'main', signer_name: 'Bruno Reviewer' });
    expect(rows[1]!.payload.replaced).toMatchObject({
      signer_user_id: ops.id,
      signer_name: 'Alice Analyst',
    });
  });

  it('records a withdrawn signature, with whose it was', async () => {
    const id = await newValuation('Second Signatory Withdrew Ltd');
    expect((await sign(id, ops.token, 'Alice Analyst')).statusCode).toBe(201);
    expect((await sign(id, other.token, 'Bruno Reviewer', 'second')).statusCode).toBe(201);
    expect((await unsign(id, 'second', ops.token)).statusCode).toBe(204);

    const rows = await events(id);
    expect(rows.map((r) => r.type)).toEqual([
      'signature_recorded',
      'signature_recorded',
      'signature_removed',
    ]);
    // The actor is whoever pressed remove; the payload is whose attestation it
    // was. On the stale-second-signature path those are two different people.
    expect(rows[2]).toMatchObject({ actor_id: ops.id });
    expect(rows[2]!.payload).toMatchObject({
      role: 'second',
      signer_user_id: other.id,
      signer_name: 'Bruno Reviewer',
    });
    expect(rows[2]!.payload.signed_at).toEqual(expect.any(String));
  });

  it('writes nothing when there was no signature to withdraw', async () => {
    const id = await newValuation('Never Signed Ltd');
    expect((await unsign(id, 'second', ops.token)).statusCode).toBe(404);
    expect(await events(id)).toHaveLength(0);
  });

  /**
   * The trail is what the audit surfaces read, so a type with no descriptor
   * prints as "Event recorded". `EVENT_CATALOG` is the type `recordEvent`
   * takes, which makes that a compile error — this asserts the label reaches
   * the reader.
   */
  it('names both events in the change log rather than filing them as other', async () => {
    const id = await newValuation('Change Log Ltd');
    expect((await sign(id, ops.token, 'Alice Analyst')).statusCode).toBe(201);
    expect((await unsign(id, 'main', ops.token)).statusCode).toBe(204);

    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/events`,
      headers: authHeader(ops.token),
    });
    expect(listed.statusCode).toBe(200);
    const labels = (listed.json().events as { type: string; label: string }[])
      .filter((e) => e.type.startsWith('signature_'))
      .map((e) => e.label);
    expect(labels).toEqual(expect.arrayContaining(['Valuation signed', 'Signature removed']));
  });
});
