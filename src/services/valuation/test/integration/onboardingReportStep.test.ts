import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The onboarding checklist's "report" box, against the database rather than
 * against the SQL string.
 *
 * `OnboardingFacts.reports` is documented as "reports that have been rendered
 * at least once", and the fake-pool test beside this one asserted the predicate
 * the query actually carried — `r.current_version > 0` — under a title claiming
 * it counted rendered ones. It counted every report row: `createReport` is the
 * only INSERT into `reports` and it writes version 1, so the column's DEFAULT 0
 * is unreachable and the comparison was true for every row that exists.
 *
 * Which matters because a report row is created by *reading*. `GET /report`
 * instantiates the body from the template on first open, so the box ticked when
 * the analyst opened the tab the checklist was pointing them at — the exact
 * disagreement between a checklist and the screen behind it that this module's
 * own docblock exists to end.
 */
describe.skipIf(!dbUp)('the onboarding report step', () => {
  let ctx: TestApp;
  let ops: { id: string; token: string };
  let client: { id: string; token: string };

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  }, 120_000);
  afterAll(async () => ctx?.teardown());

  const steps = async (): Promise<string[]> => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/onboarding/progress',
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().steps as string[];
  };

  it('does not tick because somebody opened the report tab', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'Checklist, Inc.' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().valuation.id as string;
    expect(await steps()).not.toContain('report');

    // The read that creates the report row from the template.
    const opened = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/report`,
      headers: authHeader(ops.token),
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().report.current_version).toBe(1);
    expect(await steps()).not.toContain('report');

    // Rendering is the step. It is what puts `rendered_at` on a version.
    const rendered = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/report/render`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(rendered.statusCode).toBe(200);
    expect(await steps()).toContain('report');
  });
});
