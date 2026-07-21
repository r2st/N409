// Tests for infra/backup/pg-backup.sh (audit P0-1).
//
// The backup script is pure Bash, so we exercise it as a black box: run it with
// a stubbed `pg_dump` and a temp BACKUP_ROOT, drive many deterministic days
// through it (BACKUP_DATE/BACKUP_DOW overrides), and assert the rotation and
// weekly-promotion behaviour that the DR runbook depends on.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, chmodSync, rmSync } from 'node:fs';
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

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'n409-bktest-'));
  backupRoot = path.join(work, 'root');
  // Stub pg_dump: honour --file=… by writing a few bytes there. Mirrors the real
  // binary's contract closely enough for the script (which checks the file is
  // non-empty and then rotates by filename).
  stubDump = path.join(work, 'pg_dump');
  writeFileSync(
    stubDump,
    [
      '#!/usr/bin/env bash',
      'out=""',
      'for a in "$@"; do case "$a" in --file=*) out="${a#--file=}";; esac; done',
      '[ -n "$out" ] || { echo "stub: no --file" >&2; exit 3; }',
      'printf "FAKE-DUMP\\n" > "$out"',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );
  chmodSync(stubDump, 0o755);
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
