import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBuildInfo, UNKNOWN_BUILD } from '../src/build.js';

/**
 * Build provenance. `dist/` is gitignored and built on the server, so without a
 * recorded SHA "which code is live" needs an SSH session — and a skipped build
 * looks exactly like a good one.
 */

const SHA = 'f4d21c4a1b2c3d4e5f60718293a4b5c6d7e8f901';

function tmpFile(contents: string, name = 'BUILD_SHA'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'n409-build-'));
  const file = path.join(dir, name);
  writeFileSync(file, contents);
  return file;
}

describe('readBuildInfo', () => {
  it('prefers BUILD_SHA from the environment', () => {
    expect(readBuildInfo({ BUILD_SHA: SHA })).toEqual({ sha: SHA, source: 'env' });
  });

  it('accepts an abbreviated sha', () => {
    expect(readBuildInfo({ BUILD_SHA: 'f4d21c4' })).toEqual({ sha: 'f4d21c4', source: 'env' });
  });

  it('normalises case so two deploys of one commit compare equal', () => {
    expect(readBuildInfo({ BUILD_SHA: SHA.toUpperCase() }).sha).toBe(SHA);
  });

  it('reads BUILD_SHA_FILE when the env var is absent', () => {
    const file = tmpFile(`${SHA}\n`);
    expect(readBuildInfo({ BUILD_SHA_FILE: file })).toEqual({ sha: SHA, source: 'file' });
  });

  it('tolerates the trailing newline and stray whitespace a shell redirect leaves', () => {
    expect(readBuildInfo({ BUILD_SHA_FILE: tmpFile(`  ${SHA}  \n\n`) }).sha).toBe(SHA);
  });

  it('takes the first field, so `git log --oneline` output still resolves', () => {
    expect(readBuildInfo({ BUILD_SHA_FILE: tmpFile(`${SHA} fix(web): something`) }).sha).toBe(SHA);
  });

  it('falls back to the file when BUILD_SHA is set but malformed', () => {
    const file = tmpFile(SHA);
    // A deploy that exported `BUILD_SHA=$(git rev-parse HEAD)` in a context
    // where git failed would otherwise pin a garbage value.
    expect(readBuildInfo({ BUILD_SHA: 'HEAD', BUILD_SHA_FILE: file })).toEqual({
      sha: SHA,
      source: 'file',
    });
  });

  it('reports unknown rather than throwing when the file is missing', () => {
    expect(
      readBuildInfo({ BUILD_SHA_FILE: '/nonexistent/n409/BUILD_SHA' }, { defaultFile: undefined }),
    ).toEqual(UNKNOWN_BUILD);
  });

  it('reports unknown for a file that is not a sha', () => {
    const file = tmpFile('not a commit\n');
    expect(readBuildInfo({ BUILD_SHA_FILE: file }, { defaultFile: undefined })).toEqual(UNKNOWN_BUILD);
  });

  it('reports unknown when nothing is configured at all', () => {
    expect(readBuildInfo({}, { defaultFile: undefined })).toEqual(UNKNOWN_BUILD);
  });

  it('is bounded: a huge wrong file does not become the sha', () => {
    const file = tmpFile('0'.repeat(500_000));
    expect(readBuildInfo({ BUILD_SHA_FILE: file }, { defaultFile: undefined })).toEqual(UNKNOWN_BUILD);
  });

  it('rejects a directory traversal dressed up as a sha', () => {
    expect(readBuildInfo({ BUILD_SHA: '../../etc/passwd' }, { defaultFile: undefined })).toEqual(
      UNKNOWN_BUILD,
    );
  });
});
