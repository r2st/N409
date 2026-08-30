import { randomBytes } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';

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
