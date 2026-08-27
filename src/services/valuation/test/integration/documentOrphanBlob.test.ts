import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import {
  authHeader,
  interceptPoolQueries,
  isDbAvailable,
  seedUser,
  setupTestDb,
  type TestDb,
} from './helpers.js';

const dbUp = await isDbAvailable();
const KEY_HEX = randomBytes(32).toString('hex');

/**
 * The blob an upload leaves on disk after failing to record it (round 186,
 * methodology M5).
 *
 * `storeDocument` is two writes to two stores: the bytes go to disk, then the
 * row goes to Postgres. Only the second one can fail on its own — a retired
 * engagement, a foreign key against a valuation deleted while the upload was in
 * flight, a pool with nothing left — and when it did, the request answered with
 * an error and the file stayed where it was, under a path no row named.
 *
 * That is not litter, it is a disclosure hole. `documents.storage_path` is the
 * entire index of what this directory holds, so a file no row points at is
 * invisible to the retention sweep, to the Art. 15 personal-data export, and to
 * the purge. The one operation that reported storing nothing was the one that
 * stored a file nothing could later find or erase — a client's cap table, on
 * our disk, after we told them the upload failed.
 *
 * The rollback has to be narrower than "delete what we wrote", because the path
 * is content-addressed: `<valuationId>/<sha-prefix>__<filename>`, so the same
 * bytes under the same name are the same file. The third case below is the one
 * that keeps the cure from being worse than the disease.
 */
describe.skipIf(!dbUp)('a document upload whose row cannot be written', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let docsDir: string;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;
  const prevKey = process.env.DOCUMENTS_ENCRYPTION_KEY;

  const upload = (content: string, filename = 'cap-table.csv') => {
    const boundary = '----n409orphan';
    const payload =
      `--${boundary}\r\ncontent-disposition: form-data; name="kind"\r\n\r\ncap_table\r\n` +
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `content-type: text/csv\r\n\r\n${content}\r\n--${boundary}--\r\n`;
    return app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/documents`,
      headers: { ...authHeader(ops.token), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
  };

  const blobs = () => {
    const dir = path.join(docsDir, valuationId);
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  };

  beforeAll(async () => {
    process.env.DOCUMENTS_ENCRYPTION_KEY = KEY_HEX;
    db = await setupTestDb();
    docsDir = mkdtempSync(path.join(tmpdir(), 'n409-orphan-'));
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
      payload: { kind: '409a', company_name: 'OrphanCo' },
    });
    valuationId = created.json().valuation.id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
    rmSync(docsDir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.DOCUMENTS_ENCRYPTION_KEY;
    else process.env.DOCUMENTS_ENCRYPTION_KEY = prevKey;
  });

  /** Reject the next `INSERT INTO documents`, and nothing else. */
  const failTheInsert = (message: string) => {
    let fired = false;
    return interceptPoolQueries(db.pool, (sql, phase) => {
      if (phase !== 'before' || fired || !sql.includes('INSERT INTO documents')) return undefined;
      fired = true;
      throw new Error(message);
    });
  };

  it('stores the file when the row lands, so the refusals below are about the failure', async () => {
    const res = await upload('holder,shares\nFounders,8000000');
    expect(res.statusCode).toBe(201);
    expect(blobs()).toHaveLength(1);
  });

  it('leaves nothing on disk when the row does not land', async () => {
    const before = blobs();
    const restore = failTheInsert('insert or update on table "documents" violates foreign key constraint');
    try {
      const res = await upload('holder,shares\nOrphaned,1');
      expect(res.statusCode).toBe(500);
    } finally {
      restore();
    }
    // Exactly the state before the attempt: the earlier document's blob, and
    // nothing else. Asserted as a set rather than a count so a rollback that
    // removed the *wrong* file would fail here too.
    expect(blobs()).toEqual(before);

    // And the store still agrees with the index — no row was written either.
    const { rows } = await db.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM documents WHERE valuation_id = $1',
      [valuationId],
    );
    expect(Number(rows[0]!.n)).toBe(before.length);
  });

  it('does not delete a blob another document is already using', async () => {
    // The case that makes the rollback narrow. Storage paths are
    // content-addressed, so re-uploading identical bytes under the same name
    // resolves to the file the first upload wrote. A rollback phrased as
    // "delete what this request wrote" would, on the second upload failing,
    // delete the *first* upload's document — turning a failed upload into
    // somebody else's data loss, which is strictly worse than the orphan.
    const content = 'holder,shares\nShared,42';
    const first = await upload(content, 'shared.csv');
    expect(first.statusCode).toBe(201);
    const documentId = first.json().document.id as string;
    const before = blobs();

    const restore = failTheInsert('deadlock detected');
    try {
      expect((await upload(content, 'shared.csv')).statusCode).toBe(500);
    } finally {
      restore();
    }

    expect(blobs()).toEqual(before);
    const download = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/documents/${documentId}/download`,
      headers: authHeader(ops.token),
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe(content);
  });
});
