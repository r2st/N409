import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();
const KEY_HEX = randomBytes(32).toString('hex');
const PLAINTEXT = 'holder,shares\nFounders,8000000\nSeriesA,2000000';

/**
 * A stored file that will not read back (round 175, methodology M5).
 *
 * The download route has always handled the file being *gone* — a 404 saying
 * so. The two cases where the bytes are present and unusable had no handling at
 * all, and they are the two that happen without anybody deleting anything:
 *
 *   * the blob is damaged. Storage is AES-GCM, so a write truncated by a full
 *     disk, a flipped bit, or a snapshot taken mid-write fails the
 *     authentication tag;
 *   * the key is wrong. A deployment whose `DOCUMENTS_ENCRYPTION_KEY` was
 *     rotated without `_PREVIOUS` fails *every* encrypted blob at once.
 *
 * Both threw a bare `Error` from outside the route's `try`, so both reached the
 * client as `500 urn:n409:problem:internal` — a body that carries no `detail`
 * by design. The analyst got a Download button that did nothing and said
 * nothing, and the second case, which is a whole-deployment incident, looked
 * exactly like the first.
 *
 * The third assertion is about the deployments that store blobs in the clear,
 * where there is no authentication tag to fail: `documents.sha256` is written
 * at upload and had never been read since, so corrupted bytes came back under
 * the right filename and content type and were served as the document.
 */
describe.skipIf(!dbUp)('a stored document that will not read back', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let docsDir: string;
  const prevKey = process.env.DOCUMENTS_ENCRYPTION_KEY;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;
  let documentId: string;

  const upload = (content: string) => {
    const boundary = '----n409store';
    const payload =
      `--${boundary}\r\ncontent-disposition: form-data; name="kind"\r\n\r\ncap_table\r\n` +
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="cap-table.csv"\r\n` +
      `content-type: text/csv\r\n\r\n${content}\r\n--${boundary}--\r\n`;
    return app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/documents`,
      headers: { ...authHeader(ops.token), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
  };

  const download = () =>
    app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/documents/${documentId}/download`,
      headers: authHeader(ops.token),
    });

  /** The one blob on disk for this engagement. */
  const blobPath = () => {
    const dir = path.join(docsDir, valuationId);
    const [name] = readdirSync(dir);
    return path.join(dir, name!);
  };

  beforeAll(async () => {
    process.env.DOCUMENTS_ENCRYPTION_KEY = KEY_HEX;
    db = await setupTestDb();
    docsDir = mkdtempSync(path.join(tmpdir(), 'n409-store-'));
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
      payload: { kind: '409a', company_name: 'StoreCo' },
    });
    valuationId = created.json().valuation.id;
    const up = await upload(PLAINTEXT);
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

  it('serves the file it stored, so the refusals below are about the damage', async () => {
    const res = await download();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(PLAINTEXT);
  });

  it('says the stored file is damaged rather than answering an empty 500', async () => {
    const good = readFileSync(blobPath());
    // A write that stopped early: the header and IV are there, the GCM tag is
    // not. This is what a full disk or a power loss leaves behind.
    writeFileSync(blobPath(), good.subarray(0, good.length - 6));
    try {
      const res = await download();
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.type).toBe('urn:n409:problem:document-unreadable');
      expect(body.title).toBe('Document Unreadable');
      // The two things a bare `internal` could not say: what is wrong, and
      // that re-uploading is the fix rather than clicking again.
      expect(body.detail).toMatch(/damaged|encryption key/);
      expect(body.detail).toMatch(/Re-upload/i);
      // And nothing about the cipher, the path, or the key.
      expect(JSON.stringify(body)).not.toContain(docsDir);
    } finally {
      writeFileSync(blobPath(), good);
    }
  });

  it('answers the same when a bit is flipped rather than the file cut short', async () => {
    const good = readFileSync(blobPath());
    const tampered = Buffer.from(good);
    tampered[tampered.length - 1] ^= 0xff;
    writeFileSync(blobPath(), tampered);
    try {
      expect((await download()).json().type).toBe('urn:n409:problem:document-unreadable');
    } finally {
      writeFileSync(blobPath(), good);
    }
  });

  it('recovers as soon as the bytes are good again', async () => {
    // The refusal is about the blob, not a latch: a restore, or a re-upload of
    // the same file, has to start working without a restart.
    const res = await download();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(PLAINTEXT);
  });

  it('refuses rather than serving bytes that fail their recorded hash', async () => {
    // The plaintext-storage case, where there is no authentication tag to fail.
    // `documents.sha256` is written at upload and was never read again, so
    // corruption came back as the document, under the right name and type.
    const encrypted = readFileSync(blobPath());
    writeFileSync(blobPath(), Buffer.from('holder,shares\nFounders,1\n'));
    try {
      const res = await download();
      expect(res.statusCode).toBe(500);
      expect(res.json().type).toBe('urn:n409:problem:document-unreadable');
      // The point of the check: the wrong bytes were serveable, and readable.
      expect(res.body).not.toContain('Founders,1');
    } finally {
      writeFileSync(blobPath(), encrypted);
    }
  });

  it('still answers a missing file as missing, not as damaged', async () => {
    // The pre-existing case, unchanged: a 404 is the right answer for a blob
    // that is not there, and merging it into the new one would lose the
    // distinction between "deleted" and "corrupt".
    const good = readFileSync(blobPath());
    const at = blobPath();
    rmSync(at);
    try {
      const res = await download();
      expect(res.statusCode).toBe(404);
      expect(res.json().detail).toMatch(/missing/i);
    } finally {
      writeFileSync(at, good);
    }
  });
});
