/**
 * Re-seal everything encrypted at rest under a new key.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * AES-GCM authenticates, so a value written under an old key does not decode to
 * garbage under a new one — it throws. Before `_PREVIOUS` existed that made key
 * rotation indistinguishable from data loss: change DOCUMENTS_ENCRYPTION_KEY
 * and every file uploaded before that moment becomes permanently unreadable,
 * with no warning until somebody clicks download. Which meant, in practice,
 * that the key could not be rotated *after it leaked* — the only time anyone
 * ever wants to.
 *
 * `crypto/envelope.ts` fixed the read half: a retired key named `<NAME>_PREVIOUS`
 * is accepted alongside the current one. This tool is the write half. Without
 * it the retired key can never be retired, because nothing rewrites a stored
 * document — a blob sealed in 2025 is still sealed in 2025's key however many
 * rotations have happened since, and `_PREVIOUS` accumulates or the file dies.
 *
 * ── The runbook ──────────────────────────────────────────────────────────────
 *
 *   1. Generate:            openssl rand -hex 32
 *   2. In /opt/N409/.env, move the current value to <NAME>_PREVIOUS and put the
 *      new one in <NAME>. Restart the units. Reads now try new-then-old, so
 *      nothing is down at any point — this step is safe on its own and can sit
 *      here indefinitely.
 *   3. Run this tool with --apply. It re-seals every value still under the old
 *      key. Safe to re-run; safe to interrupt (each value is written whole).
 *   4. Re-run without --apply. When it reports 0 remaining, delete
 *      <NAME>_PREVIOUS from the env and restart. Until that line is gone, the
 *      leaked key is still one this process accepts.
 *
 * Step 4 is the point of the exercise. Skipping it leaves the rotation halfway
 * done in the one way that looks finished.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *
 *     node tools/rotate-at-rest-keys.mjs              # dry run — counts only
 *     node tools/rotate-at-rest-keys.mjs --apply
 *     node tools/rotate-at-rest-keys.mjs --apply --documents-only
 *
 * Needs the same env the services get: DOCUMENTS_DIR, DATABASE_URL, and the
 * key variables. Run it from the repo root after `npm run build`.
 */
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DIST = new URL('../src/services/valuation/dist', import.meta.url).pathname;
const { documentKey, documentKeyRing, decodeFromStorage, encodeForStorage, isEncrypted } = await import(
  `${DIST}/storage/documentEncryption.js`
);
const { connectionKey, connectionKeyRing, isSealed, openSecret, sealSecret } = await import(
  `${DIST}/crypto/connectionSecrets.js`
);

const apply = process.argv.includes('--apply');
const documentsOnly = process.argv.includes('--documents-only');
const dbOnly = process.argv.includes('--db-only');

/** Columns holding a sealed value, and the table each lives on. */
const SEALED_COLUMNS = [
  ['accounting_connections', ['access_token', 'refresh_token']],
  ['hris_connections', ['access_token', 'refresh_token']],
  ['cap_table_connections', ['access_token', 'refresh_token']],
  ['partner_webhooks', ['secret']],
];

function log(...args) {
  console.log(...args);
}

/**
 * Under the *current* key alone. A value that opens here needs no work; one
 * that throws is either under the retired key or genuinely broken, and the
 * distinction is what makes the dry run's count meaningful.
 */
function opensUnderCurrent(open, value, currentKey) {
  if (currentKey === null) return true;
  try {
    open(value, [currentKey]);
    return true;
  } catch {
    return false;
  }
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

async function rotateDocuments() {
  const dir = process.env.DOCUMENTS_DIR ?? './data/documents';
  const key = documentKey();
  const ring = documentKeyRing();
  if (!key) {
    log(`documents: DOCUMENTS_ENCRYPTION_KEY is unset — nothing is sealed, nothing to rotate`);
    return;
  }
  let total = 0;
  let plaintext = 0;
  let current = 0;
  let rotated = 0;
  const failed = [];

  for await (const file of walk(dir)) {
    // Leftovers from an interrupted run: the rename below is the last step, so
    // a `.rotating` file is a re-seal that never landed and the original is
    // still in place.
    if (file.endsWith('.rotating')) continue;
    total += 1;
    const blob = await readFile(file);
    if (!isEncrypted(blob)) {
      // Uploaded before the key was ever configured. Sealing it now is exactly
      // what this tool is for, so it counts as work rather than as a skip.
      plaintext += 1;
      if (apply) {
        await writeSealed(file, blob);
        rotated += 1;
      }
      continue;
    }
    if (opensUnderCurrent(decodeFromStorage, blob, key)) {
      current += 1;
      continue;
    }
    let plain;
    try {
      plain = decodeFromStorage(blob, ring.accepted);
    } catch {
      // Neither key opens it. Reported, never touched — a file this tool cannot
      // read is a file it must not overwrite.
      failed.push(file);
      continue;
    }
    if (apply) {
      await writeSealed(file, plain);
      rotated += 1;
    }
  }

  // `toWrite` counts every file that needs a write, of which the plaintext ones
  // are a subset — a never-sealed blob is sealed for the first time here rather
  // than being left behind as "not a rotation problem".
  const toWrite = total - current - failed.length;
  log(
    `documents: ${total} file(s) — ${current} already under the current key, ` +
      `${toWrite} to write (${plaintext} of them never sealed), ${failed.length} unreadable` +
      (apply ? `, ${rotated} rewritten` : ' (dry run)'),
  );
  for (const f of failed) log(`  ! unreadable under either key: ${f}`);
}

/**
 * Write-then-rename, so an interrupted run never leaves a half-written blob
 * where a readable one was. The temp file sits beside the target so the rename
 * stays within one filesystem and is therefore atomic.
 */
async function writeSealed(file, plain) {
  const tmp = `${file}.rotating`;
  await writeFile(tmp, encodeForStorage(plain));
  await rename(tmp, file);
}

async function rotateDb() {
  const key = connectionKey();
  if (!key) {
    log('connections: no key configured — nothing is sealed, nothing to rotate');
    return;
  }
  const ring = connectionKeyRing();
  const url = process.env.DATABASE_URL;
  if (!url) {
    log('connections: DATABASE_URL is unset — skipped');
    return;
  }
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: url });
  try {
    for (const [table, columns] of SEALED_COLUMNS) {
      const { rows } = await pool.query(`SELECT id, ${columns.join(', ')} FROM ${table}`);
      let stale = 0;
      const failed = [];
      for (const row of rows) {
        const updates = {};
        for (const column of columns) {
          const value = row[column];
          // '' is a revoked credential and null is no credential; neither is a
          // sealed value and neither should become one.
          if (value === null || value === '') continue;
          if (isSealed(value) && opensUnderCurrent(openSecret, value, key)) continue;
          try {
            updates[column] = sealSecret(isSealed(value) ? openSecret(value, ring.accepted) : value, key);
          } catch {
            failed.push(`${table}.${row.id}.${column}`);
          }
        }
        const names = Object.keys(updates);
        if (names.length === 0) continue;
        stale += 1;
        if (apply) {
          await pool.query(
            `UPDATE ${table} SET ${names.map((n, i) => `${n} = $${i + 2}`).join(', ')} WHERE id = $1`,
            [row.id, ...names.map((n) => updates[n])],
          );
        }
      }
      log(
        `${table}: ${rows.length} row(s), ${stale} to write, ${failed.length} unreadable` +
          (apply ? '' : ' (dry run)'),
      );
      for (const f of failed) log(`  ! unreadable under either key: ${f}`);
    }
  } finally {
    await pool.end();
  }
}

if (!apply) log('DRY RUN — pass --apply to rewrite. Counts below are what would change.\n');
if (!dbOnly) await rotateDocuments();
if (!documentsOnly) await rotateDb();
if (!apply) log('\nNothing was written.');
else log('\nDone. Re-run without --apply; when nothing is left, drop the *_PREVIOUS variables.');
