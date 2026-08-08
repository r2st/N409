import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The seven corporate buckets 0112 added, end to end: the enum accepts them,
 * an upload lands in one, and the listing can be filtered to it.
 */
describe.skipIf(!dbUp)('document categories', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const upload = async (filename: string, fields: Record<string, string>) => {
    const boundary = '----n409test';
    const parts = Object.entries(fields).map(
      ([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
    );
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: text/plain\r\n\r\nplaceholder contents for ${filename}\r\n`,
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/documents`,
      headers: {
        ...authHeader(admin.token),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.from(`${parts.join('')}--${boundary}--\r\n`),
    });
    return res;
  };

  const list = async (query = '') => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/documents${query}`,
      headers: authHeader(admin.token),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().documents as Array<{ filename: string; kind: string; category: string }>;
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Filed Co' },
    });
    valuationId = created.json().valuation.id;
  });
  afterAll(async () => ctx?.teardown());

  it('accepts a file into each of the seven corporate buckets', async () => {
    // Every one of these is `other` to the extractor and a different answer to
    // "which thing we asked for is this" — the whole point of the second axis.
    for (const category of [
      'corporate_documents',
      'shareholder_agreements',
      'stock_option_plan',
      'board_resolutions',
      'pitch_deck',
      'intellectual_property',
      'prior_valuations',
    ]) {
      const res = await upload(`${category}.txt`, { category });
      expect(res.statusCode, `${category}: ${res.body}`).toBe(201);
      expect(res.json().document.category).toBe(category);
    }
  });

  it('derives the kind from a category stated alone', async () => {
    const docs = await list('?category=stock_option_plan');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.kind).toBe('option_grants');
  });

  it('files a pitch deck in its own bucket rather than the catch-all', async () => {
    const res = await upload('deck.txt', { kind: 'pitch_deck' });
    expect(res.statusCode).toBe(201);
    expect(res.json().document.category).toBe('pitch_deck');
  });

  it('leaves a bare "other" uncategorised rather than guessing between five', async () => {
    const res = await upload('mystery.txt', { kind: 'other' });
    expect(res.json().document.category).toBe('uploads');
  });

  it('refuses a kind that contradicts the stated category', async () => {
    const res = await upload('wrong.txt', { kind: 'cap_table', category: 'pitch_deck' });
    expect(res.statusCode).toBe(422);
  });

  it('filters the listing to one bucket', async () => {
    const all = await list();
    expect(all.length).toBeGreaterThan(8);
    const decks = await list('?category=pitch_deck');
    expect(decks.every((d) => d.category === 'pitch_deck')).toBe(true);
    expect(decks).toHaveLength(2); // the category-stated one and the kind-derived one
  });

  it('rejects a bucket that does not exist', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/documents?category=tax_returns`,
      headers: authHeader(admin.token),
    });
    expect(res.statusCode).toBe(400);
  });

  it('reports all thirteen buckets on the checklist, still blocking only on the cap table', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/documents/categories`,
      headers: authHeader(admin.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      categories: Array<{ key: string; count: number; required: boolean }>;
      missing_required: string[];
    };
    expect(body.categories).toHaveLength(13);
    expect(body.categories.filter((c) => c.required).map((c) => c.key)).toEqual(['captable_documents']);
    expect(body.missing_required).toEqual(['captable_documents']);
    // The finance buckets still come first — a checklist that opened on
    // "board resolutions" would bury the one required bucket.
    expect(body.categories[0]!.key).toBe('captable_documents');
    expect(body.categories.at(-1)!.key).toBe('uploads');
  });
});
