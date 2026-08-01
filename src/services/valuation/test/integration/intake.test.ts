import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('feature 7 — client intake questionnaire + reminders', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let otherClient: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    otherClient = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'IntakeCo' },
    });
    valuationId = created.json().valuation.id;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('exposes the questionnaire schema', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/intake/schema',
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sections.length).toBeGreaterThanOrEqual(4);
  });

  it('starts empty with the full document checklist outstanding', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/questionnaire`,
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.answers).toEqual({});
    expect(body.completion.percentComplete).toBe(0);
    expect(body.missing_documents.length).toBeGreaterThan(0);
    expect(body.can_edit).toBe(true);
  });

  it('merge-saves answers section by section', async () => {
    const s1 = await app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/questionnaire`,
      headers: authHeader(client.token),
      payload: {
        answers: {
          legal_name: 'IntakeCo Inc.',
          state_of_incorporation: 'Delaware',
          incorporation_date: '2021-06-01',
          industry: 'SaaS',
          business_description: 'A platform.',
          unknown_field: 'ignored', // filtered out
        },
      },
    });
    expect(s1.statusCode).toBe(200);
    expect(s1.json().answers.unknown_field).toBeUndefined();
    expect(s1.json().completion.sections.find((x: any) => x.key === 'company').complete).toBe(true);

    // A second save preserves the first section's answers (merge, not replace).
    const s2 = await app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/questionnaire`,
      headers: authHeader(client.token),
      payload: { answers: { revenue_status: 'pre_revenue', total_shares_outstanding: 10_000_000 } },
    });
    expect(s2.json().answers.legal_name).toBe('IntakeCo Inc.');
    expect(s2.json().answers.total_shares_outstanding).toBe(10_000_000);
  });

  it('refuses to submit until every required field is answered', async () => {
    const early = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/questionnaire/submit`,
      headers: authHeader(client.token),
    });
    expect(early.statusCode).toBe(422);

    // Fill everything required, then submit succeeds.
    const schema = (
      await app.inject({ method: 'GET', url: '/api/v1/intake/schema', headers: authHeader(client.token) })
    ).json().sections;
    // Type-appropriate answers: 'x' in a date or a select is now refused by
    // the answer rules (see intakeValidation.test.ts), so filling every field
    // with a placeholder string would exercise that gate rather than this one.
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
                  ? field.options[0]
                  : 'x';
      }
    }
    await app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/questionnaire`,
      headers: authHeader(client.token),
      payload: { answers },
    });
    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/questionnaire/submit`,
      headers: authHeader(client.token),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().submitted_at).toBeTruthy();
  });

  it('hides the questionnaire from an unrelated client', async () => {
    for (const [method, url] of [
      ['GET', `/api/v1/valuations/${valuationId}/questionnaire`],
      ['PUT', `/api/v1/valuations/${valuationId}/questionnaire`],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: authHeader(otherClient.token),
        ...(method === 'PUT' ? { payload: { answers: {} } } : {}),
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('sends a document reminder (ops) and records the event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/remind-documents`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reminded).toBe(client.email);
    expect(res.json().missing.length).toBeGreaterThan(0);

    // An outbox row was enqueued for the client.
    const outbox = await pool.query('SELECT * FROM email_outbox WHERE to_email = $1 AND subject LIKE $2', [
      client.email,
      'Documents still needed%',
    ]);
    expect(outbox.rows.length).toBe(1);

    // The reminder is on the audit spine.
    const events = await pool.query(
      "SELECT 1 FROM valuation_events WHERE valuation_id = $1 AND type = 'document_reminder_sent'",
      [valuationId],
    );
    expect(events.rows.length).toBe(1);
  });

  it('blocks reminders from clients', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/remind-documents`,
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(403);
  });
});
