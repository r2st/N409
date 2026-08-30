import { createHash, randomBytes } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { ApiProblem } from '@n409/shared';
import { decodeFromStorage } from './documentEncryption.js';

/**
 * Putting bytes at a path without destroying what is already there.
 *
 * `documents.storage_path` is content-addressed —
 * `<valuationId>/<sha-prefix>__<filename>` — so a path is not private to the
 * upload that created it. The same bytes under the same name resolve to the
 * same file, and more than one live `documents` row can name it: an identical
 * re-upload, two analysts filing the same board consent, and every
 * roll-forward clone, which copies `storage_path` verbatim into a new
 * engagement's rows rather than copying the file (see `cloneValuation`).
 *
 * `writeFile` is `open(O_TRUNC)` followed by writes. On a path that already
 * holds a blob, that is a window in which the file is short — first empty,
 * then partial — and the two things that can happen in that window are the two
 * this module exists to prevent:
 *
 *   * **A read.** A download of the *other* row's document lands mid-rewrite
 *     and gets a truncated blob. AES-GCM fails its tag, or the sha256 check
 *     fails, and `readStoredBlob` answers `document-unreadable` and logs it
 *     with `alert: true` — a data-loss page for a file that is intact a
 *     millisecond later and intact now.
 *   * **A failure.** The write stops partway — ENOSPC, an EIO, the process
 *     killed by a deploy — and the truncation is permanent. The upload reports
 *     that it stored nothing, which is true of itself and false of the
 *     engagement: a document that was readable before the request is
 *     unreadable after it, and nothing points at the request that did it.
 *
 * The second one is not hypothetical wording. `tools/rotate-at-rest-keys.mjs`
 * is the only other writer of these blobs and it has written through a temp
 * file since it was added, for exactly this reason — "an interrupted run never
 * leaves a half-written blob where a readable one was". The upload path, which
 * runs thousands of times more often, did not.
 *
 * So: write to a temp name beside the target, flush it, and `rename` it into
 * place. `rename(2)` within one directory is atomic, so a reader sees the old
 * blob or the new one and never a prefix of either. The `sync()` is what makes
 * that promise survive a power cut rather than only a crash: without it the
 * rename can reach the disk before the data it renames, and the file that
 * comes back after the reboot is the right length and full of zeroes.
 */

/**
 * The suffix a blob-directory walker must skip. Two of them, because the two
 * writers name their temp files differently and both are litter of the same
 * kind: bytes that never landed.
 *
 * This matters to exactly one caller — the rotation tool walks
 * `DOCUMENTS_DIR` and re-seals every file it finds, and a leftover temp is not
 * a document. Counting one inflates the tool's totals; failing to decrypt a
 * half-written one puts a file on its "unreadable under either key" list,
 * which is the line that is supposed to mean data loss.
 */
const INCOMPLETE_SUFFIXES = ['.rotating', '.partial'] as const;

/** Whether `p` names a temp file left behind by an interrupted blob write. */
export function isIncompleteBlobPath(p: string): boolean {
  return INCOMPLETE_SUFFIXES.some((suffix) => p.endsWith(suffix));
}

/**
 * Write `bytes` to `abs`, atomically with respect to any reader of `abs`.
 *
 * The temp name carries random bytes rather than the pid or a counter: two
 * uploads of the same content to the same engagement race for the same target
 * path by construction, and a shared temp name would have them writing over
 * each other's half-written file — the very thing this is here to stop.
 *
 * A failure anywhere removes the temp file and rethrows the original error;
 * the target is untouched, so the caller's rollback (`storeDocument`'s orphan
 * unlink) still sees the world it expects.
 */
export async function writeBlobAtomically(abs: string, bytes: Buffer): Promise<void> {
  const tmp = `${abs}.${randomBytes(8).toString('hex')}.partial`;
  try {
    // 'wx' — never reuse a temp path that somehow exists; a collision here
    // would be another writer's in-flight file.
    const handle = await open(tmp, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, abs);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * A blob that will not read is a failure of the storage, not of the request.
 *
 * The missing-file case has always been handled — a 404 saying so. The two
 * *unreadable* cases were not, and they are the ones that happen without
 * anybody deleting anything:
 *
 *   * `decodeFromStorage` is AES-GCM, so a truncated write (a full disk, a box
 *     that lost power between `writeFile` and its flush), a flipped bit, or a
 *     restore from a snapshot taken mid-write all fail the authentication tag;
 *   * a deployment whose `DOCUMENTS_ENCRYPTION_KEY` was rotated without
 *     `_PREVIOUS`, or lost, fails every encrypted blob at once.
 *
 * Both threw a bare `Error` from outside the `try` above, so both reached the
 * client as `500 urn:n409:problem:internal` — a body that carries no `detail`
 * by design and left the analyst with a Download button that does nothing and
 * says nothing. The second one is the worse of the two, because it is not one
 * file: it is every file, and the only symptom was a 500.
 *
 * The integrity check is the other half. `documents.sha256` is taken over the
 * plaintext at upload and has never been read since; without it, corruption of
 * an *unencrypted* deployment's blob has no detector at all — the bytes come
 * back changed, under the right filename and content type, and are served as
 * the document. A hash mismatch is the same answer as a decryption failure,
 * because they are the same event seen through two storage configurations.
 *
 * Logged with `alert: true`: a document this platform accepted and can no
 * longer return is a data-loss event, and the file is not coming back on its
 * own. The client is told what happened and told to re-upload, which is the
 * only thing that fixes it.
 *
 * It lives here rather than in the download route because the download route
 * is not the only reader (round 223). `encodeDocuments` reads the same blobs
 * to send to the model and did its own bare `decodeFromStorage`, which is half
 * the check: on an unencrypted deployment `decodeFromStorage` passes the bytes
 * straight through, so there was nothing at all between a damaged file and the
 * analysis. One reader is a route concern; two are a storage concern.
 */
export function readStoredBlob(
  doc: { id: string; sha256: string | null },
  stored: Buffer,
  log?: { error: (obj: Record<string, unknown>, msg: string) => void },
): Buffer {
  let plain: Buffer;
  try {
    // Decrypt in memory (blobs are ≤25 MB) — GCM can't be streamed off disk.
    plain = decodeFromStorage(stored);
  } catch (err) {
    log?.error({ err, documentId: doc.id, alert: true }, 'stored document could not be decrypted');
    throw documentUnreadable();
  }
  // `sha256` is nullable on rows written before the column existed; a document
  // with nothing to compare against is served, not refused.
  if (doc.sha256) {
    const actual = createHash('sha256').update(plain).digest('hex');
    if (actual !== doc.sha256) {
      log?.error(
        { documentId: doc.id, expected: doc.sha256, actual, alert: true },
        'stored document failed its integrity check',
      );
      throw documentUnreadable();
    }
  }
  return plain;
}

const documentUnreadable = () =>
  new ApiProblem({
    status: 500,
    title: 'Document Unreadable',
    type: 'urn:n409:problem:document-unreadable',
    detail:
      'This file is stored but cannot be read back — it is damaged or was written under an encryption ' +
      'key this deployment no longer has. Re-upload it; retrying the download will not help.',
  });
