import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Pressing Submit twice on the engagement questionnaire.
 *
 * The portal half of this same questionnaire has stamped `submitted_at` only
 * where it was still null since `submitIntakeLink` was written, and answers the
 * repeat with the standing row — "the request takes a moment, the button does
 * not visibly change, and the client presses it again". The authenticated door
 * had neither half: the UPDATE was unconditional and the `intake_submitted`
 * event was written beside it whatever the UPDATE matched.
 *
 * So a second press re-dated when the client finished and put a second
 * client-visible submission on a spine whose 0001 trigger will not let a row be
 * taken back off. An engagement converted from a portal link already carries
 * one, so the second describes a submission that never happened.
 */
describe.skipIf(!dbUp)('questionnaire submit is once-only', () => {
  let ctx: TestApp;
  let pool: pg.Pool;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const submit = () =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/questionnaire/submit`,
      headers: authHeader(client.token),
    });

  async function submittedEvents(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM valuation_events
        WHERE valuation_id = $1 AND type = 'intake_submitted'`,
      [valuationId],
    );
    return Number(rows[0]!.count);
  }

  beforeAll(async () => {
    ctx = await setupTestApp();
    pool = ctx.pool;
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'Resubmit Inc' },
    });
    valuationId = created.json().valuation.id as string;

    // Every required field, answered in its own type — the same fill
    // `intake.test.ts` uses, so this exercises the submit gate and not the
    // answer rules.
    const schema = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/intake/schema',
        headers: authHeader(client.token),
      })
    ).json().sections as { fields: { key: string; required: boolean; type: string; options?: string[] }[] }[];
    const answers: Record<string, unknown> = {};
    for (const section of schema) {
      for (const field of section.fields) {
        if (!field.required) continue;
        answers[field.key] =
          field.type === 'boolean'
            ? true
            : field.type === 'number'
              ? 5
              : field.type === 'date'
                ? '2020-01-15'
                : field.type === 'select'
                  ? field.options![0]
                  : 'x';
      }
    }
    const saved = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/questionnaire`,
      headers: authHeader(client.token),
      payload: { answers },
    });
    if (saved.statusCode !== 200) throw new Error(`save failed: ${saved.body}`);
  });
  afterAll(async () => ctx?.teardown());

  it('answers the repeat with the original timestamp rather than an error', async () => {
    const first = await submit();
    expect(first.statusCode).toBe(200);
    const firstAt = first.json().submitted_at as string;
    expect(firstAt).toBeTruthy();

    const second = await submit();
    // Not a refusal: the press that mattered worked, and telling the client it
    // failed is the one answer that is both wrong and alarming.
    expect(second.statusCode).toBe(200);
    expect(second.json().submitted_at).toBe(firstAt);
  });

  it('leaves one submission on the client-visible spine', async () => {
    await submit();
    expect(await submittedEvents()).toBe(1);
  });

  it('does not move when the client finished', async () => {
    const { rows } = await pool.query<{ submitted_at: Date }>(
      'SELECT submitted_at FROM intake_questionnaires WHERE valuation_id = $1',
      [valuationId],
    );
    const stored = rows[0]!.submitted_at.toISOString();
    await submit();
    const { rows: after } = await pool.query<{ submitted_at: Date }>(
      'SELECT submitted_at FROM intake_questionnaires WHERE valuation_id = $1',
      [valuationId],
    );
    expect(after[0]!.submitted_at.toISOString()).toBe(stored);
  });
});
