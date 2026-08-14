import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildInfo, readBuildInfo, resetBuildInfoCache, UNKNOWN_BUILD } from '../src/build.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

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

describe('buildInfo', () => {
  afterEach(() => {
    resetBuildInfoCache();
    delete process.env.BUILD_SHA;
  });

  it('reads the environment on the first call', () => {
    resetBuildInfoCache();
    process.env.BUILD_SHA = SHA;
    expect(buildInfo()).toEqual({ sha: SHA, source: 'env' });
  });

  it('answers from memory afterwards, so /health never touches the disk twice', () => {
    // The uptime checker polls /health every few seconds for the life of the
    // process, and every one of those would otherwise be a stat and a read.
    // The running build cannot change without a restart, so one read is all
    // that is ever correct.
    resetBuildInfoCache();
    process.env.BUILD_SHA = SHA;
    const first = buildInfo();
    process.env.BUILD_SHA = 'a'.repeat(40);
    expect(buildInfo()).toBe(first);
  });

  it('re-reads once the cache is dropped, which is what makes it a test seam', () => {
    resetBuildInfoCache();
    process.env.BUILD_SHA = SHA;
    const first = buildInfo();
    resetBuildInfoCache();
    const rotated = 'a'.repeat(40);
    process.env.BUILD_SHA = rotated;
    expect(buildInfo()).not.toBe(first);
    expect(buildInfo().sha).toBe(rotated);
  });
});

describe('the provenance contract, across all five services', () => {
  /*
   * There are three implementations of this resolution order — this module and
   * a `build_info.py` in each of the two FastAPI services — and the point of
   * having three is that one `curl .../health` answers the same question of any
   * unit in the estate. That only holds while they read the same two variable
   * names, and nothing else checks it: each copy has its own test suite, each
   * passes on its own, and a rename on one side is invisible until a deploy
   * verifies four services and shrugs at the fifth.
   *
   * The names also have to be in `.env.example`, which `envExample.test.ts`
   * enforces from the other direction — it scans for reads and demands a line
   * per name. Asserted here too because that test can only see the names the
   * code currently uses: rename BUILD_SHA_FILE in all three copies and swap the
   * `.env.example` line to match, and it stays green while every deployment
   * setting the old name goes quiet. This pins the spelling itself.
   */
  const PROVENANCE_VARS = ['BUILD_SHA', 'BUILD_SHA_FILE'] as const;

  const PY_IMPLEMENTATIONS = ['ai', 'engine-wrapper'].map((service) =>
    path.resolve(repoRoot, 'src/services', service, 'app/build_info.py'),
  );

  it.each(PY_IMPLEMENTATIONS)('%s reads the same two variables', (file) => {
    const text = readFileSync(file, 'utf8');
    const read = [...text.matchAll(/environ\.get\(\s*["']([A-Z][A-Z0-9_]*)["']/g)].map((m) => m[1]);
    expect([...new Set(read)].sort()).toEqual([...PROVENANCE_VARS].sort());
  });

  it('is the order this module implements, and only that order', () => {
    // Reading the TS source rather than trusting the doc comment: the
    // behavioural tests above cover each variable in isolation, so a third one
    // silently added here would not fail any of them.
    const text = readFileSync(path.resolve(repoRoot, 'src/packages/shared/src/build.ts'), 'utf8');
    const read = [...text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1]);
    expect([...new Set(read)].sort()).toEqual([...PROVENANCE_VARS].sort());
  });

  it.each(PROVENANCE_VARS)('%s is documented in .env.example', (name) => {
    const text = readFileSync(path.resolve(repoRoot, '.env.example'), 'utf8');
    expect(new RegExp(`^${name}=`, 'm').test(text)).toBe(true);
  });
});
