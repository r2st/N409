// Tests for infra/backup/pg-backup.sh (audit P0-1).
//
// The backup script is pure Bash, so we exercise it as a black box: run it with
// a stubbed `pg_dump` and a temp BACKUP_ROOT, drive many deterministic days
// through it (BACKUP_DATE/BACKUP_DOW overrides), and assert the rotation and
// weekly-promotion behaviour that the DR runbook depends on.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const SCRIPT = path.join(repoRoot, 'infra/backup/pg-backup.sh');

let work: string;
let backupRoot: string;
let stubDump: string;
let stubRestore: string;

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'n409-bktest-'));
  backupRoot = path.join(work, 'root');
  // Stub pg_dump: honour --file=… by writing a fake archive there. The archive
  // is `FAKE-DUMP` followed by the number of TOC entries the matching pg_restore
  // stub should report, so a test can ask for a dump of an empty database
  // (STUB_TOC_ENTRIES) or one that is not an archive at all (STUB_CORRUPT)
  // without needing a real database.
  stubDump = path.join(work, 'pg_dump');
  writeFileSync(
    stubDump,
    [
      '#!/usr/bin/env bash',
      'out=""',
      'for a in "$@"; do case "$a" in --file=*) out="${a#--file=}";; esac; done',
      '[ -n "$out" ] || { echo "stub: no --file" >&2; exit 3; }',
      'if [ "${STUB_CORRUPT:-0}" = "1" ]; then',
      '  printf "not-an-archive\\n" > "$out"',
      'else',
      '  printf "FAKE-DUMP\\n%s\\n" "${STUB_TOC_ENTRIES:-12}" > "$out"',
      'fi',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );
  chmodSync(stubDump, 0o755);

  // Stub pg_restore --list, the script's verification step. Mirrors the real
  // binary where it matters: a file that is not an archive is an error rather
  // than an empty listing, and a readable one lists `id; …` TOC lines that the
  // script counts.
  stubRestore = path.join(work, 'pg_restore');
  writeFileSync(
    stubRestore,
    [
      '#!/usr/bin/env bash',
      'file=""',
      'for a in "$@"; do case "$a" in -*) ;; *) file="$a";; esac; done',
      '[ -n "$file" ] || { echo "stub: no file" >&2; exit 3; }',
      'if ! head -n 1 "$file" | grep -q "^FAKE-DUMP$"; then',
      '  echo "pg_restore: error: input file does not appear to be a valid archive (too short?)" >&2',
      '  exit 1',
      'fi',
      'n="$(sed -n 2p "$file")"',
      'echo ";"',
      'echo "; Archive created at 2026-01-01 00:00:00 UTC"',
      'i=1',
      'while [ "$i" -le "$n" ]; do',
      '  echo "$i; 1259 1600$i TABLE public t$i n409"',
      '  i=$((i + 1))',
      'done',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );
  chmodSync(stubRestore, 0o755);
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

function runDay(date: string, dow: number, extra: Record<string, string> = {}): void {
  execFileSync('bash', [SCRIPT], {
    env: {
      ...process.env,
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      BACKUP_ROOT: backupRoot,
      PG_DUMP: stubDump,
      PG_RESTORE: stubRestore,
      KEEP_DAILY: '7',
      KEEP_WEEKLY: '4',
      WEEKLY_DOW: '7',
      BACKUP_DATE: date,
      BACKUP_DOW: String(dow),
      ...extra,
    },
    stdio: 'pipe',
  });
}

const dumps = (dir: string): string[] =>
  readdirSync(path.join(backupRoot, dir))
    .filter((f) => f.endsWith('.dump'))
    .sort();

describe('pg-backup.sh rotation', () => {
  it('caps daily backups at KEEP_DAILY and keeps only the newest', () => {
    // 10 sequential days, none of them the weekly day.
    for (let d = 1; d <= 10; d++) {
      const dd = String(d).padStart(2, '0');
      runDay(`202603${dd}-020000`, 1); // Monday-ish, never promotes
    }
    const daily = dumps('daily');
    expect(daily).toHaveLength(7);
    // Newest 7 are days 04..10; days 01..03 pruned.
    expect(daily[0]).toBe('n409-20260304-020000.dump');
    expect(daily[6]).toBe('n409-20260310-020000.dump');
    expect(daily.some((f) => f.includes('20260301'))).toBe(false);
  });

  it('promotes one dump per week and caps weekly at KEEP_WEEKLY', () => {
    // Fresh root for isolation.
    backupRoot = path.join(work, 'root2');
    mkdirSync(backupRoot, { recursive: true });
    // 6 Sundays in a row -> 6 promotions, weekly must cap at 4 (newest).
    const sundays = ['20260405', '20260412', '20260419', '20260426', '20260503', '20260510'];
    for (const day of sundays) runDay(`${day}-020000`, 7);
    const weekly = dumps('weekly');
    expect(weekly).toHaveLength(4);
    expect(weekly[0]).toBe('n409-20260419-020000.dump'); // oldest survivor
    expect(weekly[3]).toBe('n409-20260510-020000.dump'); // newest
    // The two oldest Sundays were pruned.
    expect(weekly.some((f) => f.includes('20260405') || f.includes('20260412'))).toBe(false);
  });

  it('does not promote to weekly on non-weekly days', () => {
    backupRoot = path.join(work, 'root3');
    mkdirSync(backupRoot, { recursive: true });
    runDay('20260601-020000', 1);
    runDay('20260602-020000', 3);
    expect(dumps('daily')).toHaveLength(2);
    expect(dumps('weekly')).toHaveLength(0);
  });

  it('produces a non-empty custom-format dump file', () => {
    backupRoot = path.join(work, 'root4');
    mkdirSync(backupRoot, { recursive: true });
    runDay('20260701-020000', 2);
    const daily = dumps('daily');
    expect(daily).toEqual(['n409-20260701-020000.dump']);
  });

  // The check that separates "a file exists" from "a file pg_restore can read".
  // A dump killed halfway through by a full disk is non-empty and passes the
  // old `[[ -s ]]` test, and the rotation would then evict a good dump to make
  // room for it.
  it('refuses to rotate in a dump pg_restore cannot read', () => {
    backupRoot = path.join(work, 'root6');
    mkdirSync(backupRoot, { recursive: true });
    expect(() => runDay('20260801-020000', 2, { STUB_CORRUPT: '1' })).toThrow();
    expect(dumps('daily')).toHaveLength(0);
    // And the temp file is gone rather than left for a later run to trip over.
    expect(readdirSync(path.join(backupRoot, 'daily'))).toHaveLength(0);
  });

  // A well-formed archive of the wrong database is the quiet version of the
  // same failure: point DATABASE_URL at an empty scratch DB and every check
  // short of counting the contents passes.
  it('refuses a well-formed dump with too few TOC entries', () => {
    backupRoot = path.join(work, 'root7');
    mkdirSync(backupRoot, { recursive: true });
    expect(() => runDay('20260802-020000', 2, { STUB_TOC_ENTRIES: '3' })).toThrow();
    expect(dumps('daily')).toHaveLength(0);
  });

  it('accepts a dump that meets the floor exactly', () => {
    backupRoot = path.join(work, 'root8');
    mkdirSync(backupRoot, { recursive: true });
    runDay('20260803-020000', 2, { STUB_TOC_ENTRIES: '10', MIN_TOC_ENTRIES: '10' });
    expect(dumps('daily')).toEqual(['n409-20260803-020000.dump']);
  });

  it('records a checksum manifest beside each dump', () => {
    backupRoot = path.join(work, 'root9');
    mkdirSync(backupRoot, { recursive: true });
    runDay('20260804-020000', 2);
    const files = readdirSync(path.join(backupRoot, 'daily')).sort();
    expect(files).toEqual(['n409-20260804-020000.dump', 'n409-20260804-020000.dump.sha256']);
    // The manifest names the dump and carries a real digest of it.
    const manifest = readFileSync(path.join(backupRoot, 'daily', 'n409-20260804-020000.dump.sha256'), 'utf8');
    const digest = createHash('sha256')
      .update(readFileSync(path.join(backupRoot, 'daily', 'n409-20260804-020000.dump')))
      .digest('hex');
    expect(manifest).toContain(digest);
    expect(manifest).toContain('n409-20260804-020000.dump');
  });

  it('carries the checksum into the weekly set', () => {
    backupRoot = path.join(work, 'root10');
    mkdirSync(backupRoot, { recursive: true });
    runDay('20260809-020000', 7);
    const weekly = readdirSync(path.join(backupRoot, 'weekly')).sort();
    expect(weekly).toEqual(['n409-20260809-020000.dump', 'n409-20260809-020000.dump.sha256']);
  });

  // The retention window bounds the directory by design; a manifest class that
  // nothing prunes would be an unbounded one hiding inside it.
  it('prunes the checksum manifest along with its dump', () => {
    backupRoot = path.join(work, 'root11');
    mkdirSync(backupRoot, { recursive: true });
    for (let d = 1; d <= 10; d++) {
      runDay(`202609${String(d).padStart(2, '0')}-020000`, 1);
    }
    const files = readdirSync(path.join(backupRoot, 'daily'));
    expect(files.filter((f) => f.endsWith('.dump'))).toHaveLength(7);
    expect(files.filter((f) => f.endsWith('.sha256'))).toHaveLength(7);
    // No manifest outlives the dump it describes.
    for (const f of files.filter((f) => f.endsWith('.sha256'))) {
      expect(files).toContain(f.replace(/\.sha256$/, ''));
    }
  });

  it('fails loudly when DATABASE_URL cannot be resolved', () => {
    expect(() =>
      execFileSync('bash', [SCRIPT], {
        env: {
          ...process.env,
          DATABASE_URL: '',
          ENV_FILE: path.join(work, 'does-not-exist.env'),
          BACKUP_ROOT: path.join(work, 'root5'),
          PG_DUMP: stubDump,
        },
        stdio: 'pipe',
      }),
    ).toThrow();
  });
});
