import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationChecksum } from '../../src/db/migrate.js';

const DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();

/**
 * The migration runner (src/db/migrate.ts) orders files by a plain filename
 * sort and applies each exactly once, forever. That makes the *names* part of
 * the schema's contract, and nothing enforced them — so this does.
 *
 * Two prefixes are duplicated already: 0047 and 0127. Both pairs create
 * disjoint objects, so the ambiguity has never bitten, but it is a real hazard
 * — a third file at 0047 sorts *between* the existing two by suffix, so a
 * migration written to run after both can silently run before one. They are
 * grandfathered rather than renamed because renaming an applied migration makes
 * every deployed database re-run it under its new name.
 */
describe('migration history', () => {
  const NUMBERED = /^(\d{4})_[a-z0-9_]+\.sql$/;

  it('has migrations to check', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('names every file NNNN_snake_case.sql', () => {
    const bad = files.filter((f) => !NUMBERED.test(f));
    expect(bad).toEqual([]);
  });

  it('gives each migration a unique numeric prefix, apart from two grandfathered pairs', () => {
    // Frozen list. Adding to it is the wrong fix for a collision: pick the next
    // free number instead, since nothing has applied the new file yet.
    const GRANDFATHERED = new Set(['0047', '0127']);

    const byPrefix = new Map<string, string[]>();
    for (const f of files) {
      const prefix = NUMBERED.exec(f)?.[1];
      if (!prefix) continue;
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), f]);
    }

    const collisions = [...byPrefix.entries()]
      .filter(([prefix, names]) => names.length > 1 && !GRANDFATHERED.has(prefix))
      .map(([, names]) => names);
    expect(collisions).toEqual([]);

    // And the grandfathered ones must stay exactly two files each — a third
    // would land in the middle of a pair that already ran.
    for (const prefix of GRANDFATHERED) {
      expect(byPrefix.get(prefix)).toHaveLength(2);
    }
  });

  it('numbers files in the order they sort, with no prefix ever going backwards', () => {
    const prefixes = files.map((f) => Number(NUMBERED.exec(f)?.[1]));
    const ascending = [...prefixes].sort((a, b) => a! - b!);
    // Gaps are fine and deliberate (0003 → 0010 is the M1/M2 milestone break);
    // what must never happen is filename order disagreeing with numeric order,
    // which is how a five-digit or unpadded name would break the runner.
    expect(prefixes).toEqual(ascending);
  });

  it('gives every file a distinct checksum, so no migration is an accidental copy', async () => {
    const seen = new Map<string, string>();
    for (const f of files) {
      const sum = migrationChecksum(await readFile(path.join(DIR, f), 'utf8'));
      const first = seen.get(sum);
      expect(first, `${f} is byte-identical to ${first}`).toBeUndefined();
      seen.set(sum, f);
    }
  });

  it('checksums independently of line endings', () => {
    expect(migrationChecksum('CREATE TABLE t (a int);\nSELECT 1;\n')).toBe(
      migrationChecksum('CREATE TABLE t (a int);\r\nSELECT 1;\r\n'),
    );
  });

  it('checksums differently when a statement changes', () => {
    expect(migrationChecksum('CREATE TABLE t (a int);')).not.toBe(
      migrationChecksum('CREATE TABLE t (a bigint);'),
    );
  });
});
