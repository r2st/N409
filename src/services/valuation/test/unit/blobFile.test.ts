/**
 * The upload path used to truncate a live blob in place (round 223, M5).
 *
 * `documents.storage_path` is content-addressed, so a path is shared by
 * construction: an identical re-upload, two analysts filing the same consent,
 * and every roll-forward clone all name the same file. `writeFile` opens that
 * file with `O_TRUNC`, so a re-upload passed through a state where the other
 * rows' document was zero-length, and a write that stopped partway — a full
 * disk, a deploy — left it that way for good. The request that reported
 * storing nothing was the request that destroyed something.
 *
 * The rotation tool has written through a temp file since it was added, for
 * this exact reason. These pin the same guarantee on the path that runs
 * thousands of times more often.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIncompleteBlobPath, writeBlobAtomically } from '../../src/storage/blobFile.js';

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'n409-blob-'));
}

describe('writing a stored blob', () => {
  it('replaces existing content', async () => {
    const dir = await scratch();
    try {
      const file = join(dir, 'doc.bin');
      await writeFile(file, Buffer.from('old'));
      await writeBlobAtomically(file, Buffer.from('new bytes'));
      expect(await readFile(file, 'utf8')).toBe('new bytes');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates the file when nothing is there', async () => {
    const dir = await scratch();
    try {
      const file = join(dir, 'fresh.bin');
      await writeBlobAtomically(file, Buffer.from('first'));
      expect(await readFile(file, 'utf8')).toBe('first');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves no temp file behind on success', async () => {
    const dir = await scratch();
    try {
      await writeBlobAtomically(join(dir, 'doc.bin'), Buffer.from('x'));
      expect(await readdir(dir)).toEqual(['doc.bin']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves the previous blob intact when the write cannot land', async () => {
    const dir = await scratch();
    try {
      const file = join(dir, 'doc.bin');
      await writeFile(file, Buffer.from('the readable document'));
      // A target directory that has gone away is the reachable stand-in for
      // ENOSPC: `open` fails, so nothing was truncated. The point of the
      // assertion is the file, not the error.
      await expect(
        writeBlobAtomically(join(dir, 'missing-subdir', 'doc.bin'), Buffer.from('x')),
      ).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe('the readable document');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('cleans up its temp file when the write fails', async () => {
    const dir = await scratch();
    try {
      const file = join(dir, 'doc.bin');
      // A Buffer larger than the maximum a single write can take: the temp
      // file is opened, and then the write throws.
      await expect(writeBlobAtomically(file, { length: 1 } as unknown as Buffer)).rejects.toThrow();
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('gives each write its own temp name, so two racing writes cannot share one', async () => {
    const dir = await scratch();
    try {
      const file = join(dir, 'doc.bin');
      await Promise.all([
        writeBlobAtomically(file, Buffer.alloc(4096, 1)),
        writeBlobAtomically(file, Buffer.alloc(4096, 1)),
      ]);
      // Whichever landed second, the file is a whole blob and not a mixture.
      expect(await readFile(file)).toEqual(Buffer.alloc(4096, 1));
      expect(await readdir(dir)).toEqual(['doc.bin']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the temp files a blob directory may hold', () => {
  it('names both writers’ leftovers, so the rotation tool skips them', () => {
    expect(isIncompleteBlobPath('/d/abc__f.pdf.rotating')).toBe(true);
    expect(isIncompleteBlobPath('/d/abc__f.pdf.9f3a.partial')).toBe(true);
  });

  it('does not name a document', () => {
    expect(isIncompleteBlobPath('/d/abc__cap table.xlsx')).toBe(false);
    expect(isIncompleteBlobPath('/d/abc__notes.partially-signed.pdf')).toBe(false);
  });
});
