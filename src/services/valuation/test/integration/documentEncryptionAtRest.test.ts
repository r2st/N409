import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import type { FastifyInstance } from 'fastify';

const dbUp = await isDbAvailable();
const KEY_HEX = randomBytes(32).toString('hex');
const PLAINTEXT = 'holder,shares\nFounders,8000000\nSeriesA,2000000';

function multipartUpload(
  app: FastifyInstance,
  url: string,
  token: string,
  opts: { filename: string; kind: string; content: string },
) {
  const boundary = '----n409enc';
  const payload =
    `--${boundary}\r\ncontent-disposition: form-data; name="kind"\r\n\r\n${opts.kind}\r\n` +
    `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${opts.filename}"\r\n` +
    `content-type: text/csv\r\n\r\n${opts.content}\r\n--${boundary}--\r\n`;
  return app.inject({
    method: 'POST',
    url,
    headers: { ...authHeader(token), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

/** Document blobs are encrypted on disk when a key is set (audit B-5 P1). */
describe.skipIf(!dbUp)('document encryption at rest', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let docsDir: string;
  const prevKey = process.env.DOCUMENTS_ENCRYPTION_KEY;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;
  let documentId: string;

  beforeAll(async () => {
    process.env.DOCUMENTS_ENCRYPTION_KEY = KEY_HEX;
    db = await setupTestDb();
    docsDir = mkdtempSync(path.join(tmpdir(), 'n409-enc-'));
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      DOCUMENTS_DIR: docsDir,
      AUTO_PIPELINE: 'off',
    });
    app = buildApp({ config, pool: db.pool });
    await app.ready();
    ops = await seedUser({ app, pool: db.pool, teardown: async () => {} }, { roles: ['reviewer'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'EncCo' },
    });
    valuationId = created.json().valuation.id;
    const up = await multipartUpload(app, `/api/v1/valuations/${valuationId}/documents`, ops.token, {
      filename: 'cap-table.csv',
      kind: 'cap_table',
      content: PLAINTEXT,
    });
    expect(up.statusCode).toBe(201);
    documentId = up.json().document.id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
    rmSync(docsDir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.DOCUMENTS_ENCRYPTION_KEY;
    else process.env.DOCUMENTS_ENCRYPTION_KEY = prevKey;
  });

  it('writes ciphertext to disk — the plaintext never appears in the blob', () => {
    const dir = path.join(docsDir, valuationId);
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    const raw = readFileSync(path.join(dir, files[0]!));
    // AES-GCM magic header, and the sensitive content is not present in the clear.
    expect(raw.subarray(0, 8).toString()).toBe('N409ENC1');
    expect(raw.includes(Buffer.from('Founders,8000000'))).toBe(false);
  });

  it('download transparently decrypts back to the original bytes', async () => {
    const dl = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/documents/${documentId}/download`,
      headers: authHeader(ops.token),
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe(PLAINTEXT);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
  });
});
