import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { listTemplates } from '../../src/repos/reportTemplates.js';

const dbUp = await isDbAvailable();

/**
 * ASSERTED AS A DIFFERENCE (R398, methodology M8).
 *
 * A template body is the report skeleton, and `POST /report-templates` accepts
 * a million characters of it. `report_templates` is append-only — every edit
 * mints a new row — so `TEMPLATE_PAGE_LIMIT` versions of one name is a page of
 * 200 full documents, read off the table, assembled by the driver, serialised
 * to JSON and sent to a browser that draws a table of labels, statuses and
 * timestamps.
 *
 * The page reads exactly one body — the draft whose Edit button was pressed,
 * which `GET /report-templates/:id` answers. So the assertion is that growing
 * the bodies does not grow the list: against the pre-fix `SELECT *` the
 * response grows by every one of them.
 */
describe.skipIf(!dbUp)('report templates — the browse list does not carry the bodies', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  const ids: string[] = [];

  const create = async (name: string, body: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/report-templates',
      headers: authHeader(ops.token),
      payload: { name, kind: '409a', body },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().template.id as string;
  };

  const listBytes = async (): Promise<number> => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/report-templates',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    return Buffer.byteLength(res.body);
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    for (let i = 0; i < 3; i += 1) ids.push(await create(`r398_tpl_${i}`, `# Short ${i}\n`));
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('does not grow when the bodies do', async () => {
    const before = await listBytes();
    // 200 kB apiece, an order of magnitude under what the route accepts.
    const long = `# Long\n${'skeleton line\n'.repeat(15_000)}`;
    for (let i = 0; i < 3; i += 1) await create(`r398_tpl_${i}`, long);
    const after = await listBytes();

    // Three more rows, so the response grows by three rows of metadata — and
    // nothing like three bodies. Stated as a ceiling rather than an equality
    // because the rows themselves are real.
    expect(after - before).toBeLessThan(2_000);

    // Not vacuous: the bodies really are on the rows, and the detail route
    // really does hand one over.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/report-templates/${ids[0]!}`,
      headers: authHeader(ops.token),
    });
    expect(detail.statusCode).toBe(200);
    const listed = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/report-templates?name=r398_tpl_0',
      headers: authHeader(ops.token),
    });
    const newest = listed.json().templates[0] as { id: string; label: string };
    const newestBody = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/report-templates/${newest.id}`,
      headers: authHeader(ops.token),
    });
    expect((newestBody.json().template.body as string).length).toBe(long.length);
  });

  it('sends every column the page draws, and not the one it does not', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/report-templates?name=r398_tpl_1',
      headers: authHeader(ops.token),
    });
    const row = res.json().templates[0] as Record<string, unknown>;
    for (const column of ['id', 'name', 'version', 'label', 'kind', 'status', 'notes', 'created_at', 'updated_at'])
      expect(row, column).toHaveProperty(column);
    expect(row).not.toHaveProperty('body');
  });

  it('the repo helper omits it too, so a second caller cannot reintroduce it', async () => {
    const { templates } = await listTemplates(ctx.pool, { name: 'r398_tpl_2' });
    expect(templates.length).toBeGreaterThan(0);
    for (const t of templates) expect(t).not.toHaveProperty('body');
  });
});
