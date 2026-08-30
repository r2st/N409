import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * One door to a stored document, in each direction (round 223, M5).
 *
 * The blob directory is the one store in this platform with no transaction, no
 * constraint and no driver between the code and the bytes. Everything that
 * makes a read or a write of it safe is a convention, and both conventions had
 * already been broken once by the time this census was written:
 *
 *   * **Reading.** `decodeFromStorage` authenticates only where a key is
 *     configured; where `DOCUMENTS_ENCRYPTION_KEY` is unset it returns the file
 *     as it found it. `documents.sha256` is the only detector such a deployment
 *     has, and it is `readStoredBlob` that consults it. The download route did;
 *     `encodeDocuments`, which reads the same blobs to send to the model and
 *     whose answer is auto-applied to a valuation's parameters, did not.
 *
 *   * **Writing.** `storage_path` is content-addressed, so a path is shared by
 *     construction — an identical re-upload, and every roll-forward clone,
 *     which copies the path into another engagement's rows. `writeFile` on such
 *     a path truncates a document that belongs to somebody else's row before
 *     it writes, and leaves it truncated if the write does not finish.
 *     `writeBlobAtomically` renames a finished temp file into place instead.
 *
 * Neither is the kind of mistake that shows up in a test of the third reader or
 * the second writer: both failure modes need a second row, a concurrent
 * request, or a full disk. So the guard is a source scan — the same reasoning
 * `hostLocaleCensus` gives for scanning rather than asserting.
 *
 * `src/storage/` is the exception on both lists, because it is where the two
 * doors are implemented.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** This service's `src/`: the file sits at `src/services/valuation/test/unit`. */
const SRC = path.resolve(HERE, '../../src');

const STORAGE = path.join(SRC, 'storage');

/**
 * Files outside `src/storage/` that call `needle` in code rather than naming it
 * in a comment.
 *
 * `opts.onBlobFiles` narrows the population to the files that actually reach
 * the blob directory — the ones naming `documentsDir` or `storage_path`. That
 * matters for `writeFile(`, which is a perfectly ordinary call anywhere else in
 * the service; a census that failed on the first unrelated one would be
 * switched off within a round, and a census nobody trusts guards nothing.
 */
function offenders(needle: string, opts: { onBlobFiles?: boolean } = {}): string[] {
  return sourceFiles(SRC)
    .filter((file) => !file.startsWith(STORAGE + path.sep))
    .filter((file) => {
      const body = readFileSync(file, 'utf8');
      if (opts.onBlobFiles && !/documentsDir|storage_path/.test(body)) return false;
      // Comments name both helpers freely — the point is the call.
      return body
        .split('\n')
        .some(
          (line) =>
            !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//') && line.includes(needle),
        );
    })
    .map((file) => path.relative(SRC, file));
}

describe('reading a stored document blob', () => {
  it('goes through readStoredBlob, which is the only thing that checks sha256', () => {
    expect(offenders('decodeFromStorage(')).toEqual([]);
  });

  it('finds calls in the files it is scanning, so an empty result means something', () => {
    // The scanner's own check: `readStoredBlob(` is called from two route
    // files and named in the comments of more. If this ever came back empty
    // the two assertions above would be passing because nothing was read.
    expect(offenders('readStoredBlob(').sort()).toEqual(['routes/ai.ts', 'routes/documents.ts']);
  });

  it('has a reader that does check it, so the census is not passing on an empty set', () => {
    const body = readFileSync(path.join(STORAGE, 'blobFile.ts'), 'utf8');
    expect(body).toContain('decodeFromStorage(');
    expect(body).toContain('doc.sha256');
  });
});

describe('writing a stored document blob', () => {
  it('goes through writeBlobAtomically, so no live blob is truncated in place', () => {
    expect(offenders('writeFile(', { onBlobFiles: true })).toEqual([]);
  });

  it('has a writer that renames rather than truncates', () => {
    const body = readFileSync(path.join(STORAGE, 'blobFile.ts'), 'utf8');
    expect(body).toContain('rename(tmp, abs)');
  });
});
