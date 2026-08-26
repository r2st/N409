// The shutdown half of a unit file's contract (round 158).
//
// shared/shutdown.ts bounds the graceful path at 10s and exits either way, and
// the sentence justifying that is "comfortably under systemd's 90s
// TimeoutStopSec". Nothing in this repository set that 90s, no test read it,
// and no unit file mentioned a stop deadline at all — the safety of the whole
// bounded-shutdown design rested on a distro default.
//
// The Python services had the gap from the other side and worse: uvicorn's
// graceful shutdown is unbounded by default, so on SIGTERM it waited for
// in-flight requests forever. The AI pipelines block on an LLM for up to 90s
// and the engine holds a thread for a whole OPM run, so that wait routinely
// outlasted systemd's patience and every shutdown ended in SIGKILL — arrived at
// by way of the graceful path, which is the part that makes it hard to see.
//
// So: two numbers per unit, one rule joining them. The application must give up
// before the supervisor does.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SHUTDOWN_GRACE_MS } from '../src/shutdown.js';
import {
  SYSTEMD_DEFAULT_TIMEOUT_STOP_S,
  parseTimeSpan,
  parseUnitShutdown,
  shutdownFaults,
} from '../src/systemdShutdown.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const UNIT_DIRS = ['infra/systemd', 'infra/backup'].map((d) => path.join(repoRoot, d));

/** Every `.service` install-units.sh installs, read from disk. */
function shippedUnits(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const dir of UNIT_DIRS) {
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith('.service')) continue;
      out.push({ name: entry, text: readFileSync(path.join(dir, entry), 'utf8') });
    }
  }
  return out;
}

describe('parseTimeSpan', () => {
  it('reads a bare number as seconds, which is the form the units use', () => {
    expect(parseTimeSpan('30')).toEqual({ kind: 'seconds', seconds: 30, raw: '30' });
  });

  it('reads systemd time suffixes', () => {
    expect(parseTimeSpan('45s')).toMatchObject({ seconds: 45 });
    expect(parseTimeSpan('2min')).toMatchObject({ seconds: 120 });
    expect(parseTimeSpan('1h')).toMatchObject({ seconds: 3600 });
    expect(parseTimeSpan('500ms')).toMatchObject({ seconds: 0.5 });
  });

  it('reads the compound form systemd accepts', () => {
    // Not exotic: it is the spelling somebody reaches for when raising a limit
    // past a minute. Read as unparseable it would be reported as a *missing*
    // deadline, which sends the reader to the wrong fix.
    expect(parseTimeSpan('1min 30s')).toMatchObject({ seconds: 90 });
  });

  it('treats 0 as infinity, because that is what systemd does with it', () => {
    // The trap this exists for: read as "zero seconds", the single most
    // dangerous value in the file reads as the strictest one.
    expect(parseTimeSpan('0').kind).toBe('infinity');
    expect(parseTimeSpan('infinity').kind).toBe('infinity');
    expect(parseTimeSpan('0.0').kind).toBe('infinity');
  });

  it('refuses a span it cannot read rather than guessing', () => {
    expect(parseTimeSpan('soon').kind).toBe('unparseable');
    expect(parseTimeSpan('').kind).toBe('unparseable');
    expect(parseTimeSpan('30 potatoes').kind).toBe('unparseable');
  });

  it('does not accept a deadline expressed in microseconds', () => {
    // A stop deadline of 30us is a typo. Accepting it would let a unit that
    // SIGKILLs instantly past the guard while looking configured.
    expect(parseTimeSpan('30us').kind).toBe('unparseable');
  });
});

describe('parseUnitShutdown', () => {
  it('reads Type, TimeoutStopSec and ExecStart out of [Service] only', () => {
    const unit = parseUnitShutdown(
      '[Unit]\nTimeoutStopSec=1\n[Service]\nType=simple\nTimeoutStopSec=30\nExecStart=/usr/bin/node dist/index.js\n',
    );
    expect(unit.type).toBe('simple');
    expect(unit.stopTimeout).toMatchObject({ seconds: 30 });
    expect(unit.execStart).toBe('/usr/bin/node dist/index.js');
  });

  it('prefers TimeoutStopSec over TimeoutSec regardless of which came first', () => {
    // TimeoutSec sets start *and* stop; TimeoutStopSec overrides the stop half.
    // File order does not decide it, so neither may the parser.
    const after = parseUnitShutdown('[Service]\nTimeoutSec=90\nTimeoutStopSec=30\n');
    expect(after.stopTimeoutKey).toBe('TimeoutStopSec');
    expect(after.stopTimeout).toMatchObject({ seconds: 30 });

    const before = parseUnitShutdown('[Service]\nTimeoutStopSec=30\nTimeoutSec=90\n');
    expect(before.stopTimeoutKey).toBe('TimeoutStopSec');
    expect(before.stopTimeout).toMatchObject({ seconds: 30 });
  });

  it('accepts TimeoutSec alone as bounding the stop', () => {
    const unit = parseUnitShutdown('[Service]\nTimeoutSec=45\n');
    expect(unit.stopTimeoutKey).toBe('TimeoutSec');
    expect(unit.stopTimeout).toMatchObject({ seconds: 45 });
  });

  it('finds the uvicorn grace flag in either spelling', () => {
    const spaced = parseUnitShutdown(
      '[Service]\nExecStart=/opt/x/.venv/bin/uvicorn app.main:app --timeout-graceful-shutdown 15\n',
    );
    expect(spaced.runsUvicorn).toBe(true);
    expect(spaced.uvicornGraceSeconds).toBe(15);

    const equals = parseUnitShutdown(
      '[Service]\nExecStart=/opt/x/.venv/bin/uvicorn app.main:app --timeout-graceful-shutdown=15\n',
    );
    expect(equals.uvicornGraceSeconds).toBe(15);
  });

  it('notices uvicorn without the flag', () => {
    const unit = parseUnitShutdown(
      '[Service]\nExecStart=/opt/x/.venv/bin/uvicorn app.main:app --port 3002\n',
    );
    expect(unit.runsUvicorn).toBe(true);
    expect(unit.uvicornGraceSeconds).toBeNull();
  });

  it('does not mistake a node ExecStart for uvicorn', () => {
    const unit = parseUnitShutdown('[Service]\nExecStart=/usr/bin/node dist/index.js\n');
    expect(unit.runsUvicorn).toBe(false);
  });

  it('ignores comments', () => {
    const unit = parseUnitShutdown('[Service]\n# TimeoutStopSec=1\nTimeoutStopSec=30\n');
    expect(unit.stopTimeout).toMatchObject({ seconds: 30 });
  });
});

describe('shutdownFaults', () => {
  const NODE_OK = '[Service]\nType=simple\nExecStart=/usr/bin/node dist/index.js\nTimeoutStopSec=30\n';
  const UVICORN_OK =
    '[Service]\nType=simple\n' +
    'ExecStart=/opt/x/.venv/bin/uvicorn app.main:app --timeout-graceful-shutdown 15\n' +
    'TimeoutStopSec=30\n';

  it('passes a unit that satisfies both halves', () => {
    expect(shutdownFaults(parseUnitShutdown(NODE_OK))).toEqual([]);
    expect(shutdownFaults(parseUnitShutdown(UVICORN_OK))).toEqual([]);
  });

  it('reports a long-running unit with no stop deadline', () => {
    const faults = shutdownFaults(
      parseUnitShutdown('[Service]\nType=simple\nExecStart=/usr/bin/node dist/index.js\n'),
    );
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain('TimeoutStopSec');
  });

  it('reports a stop deadline that is disabled rather than absent', () => {
    for (const raw of ['infinity', '0']) {
      const faults = shutdownFaults(parseUnitShutdown(NODE_OK.replace('30', raw)));
      expect(faults.join(' ')).toContain('disables the stop deadline');
    }
  });

  it('reports a stop deadline that does not clear the application grace', () => {
    // The whole ordering rule in one case: at 10s the app and the supervisor
    // give up at the same instant, so systemd may SIGKILL a shutdown that was
    // still working. It has to be strictly above.
    const equal = shutdownFaults(
      parseUnitShutdown(NODE_OK.replace('TimeoutStopSec=30', 'TimeoutStopSec=10')),
    );
    expect(equal.join(' ')).toContain('not above');

    const under = shutdownFaults(parseUnitShutdown(NODE_OK.replace('TimeoutStopSec=30', 'TimeoutStopSec=5')));
    expect(under.join(' ')).toContain('not above');
  });

  it('ties the deadline to the constant the application actually uses', () => {
    // If DEFAULT_SHUTDOWN_GRACE_MS is ever raised, this is what fails first —
    // which is the point of exporting it rather than leaving it a literal.
    const justUnder = Math.floor(DEFAULT_SHUTDOWN_GRACE_MS / 1000);
    const justOver = justUnder + 1;
    expect(
      shutdownFaults(parseUnitShutdown(NODE_OK.replace('TimeoutStopSec=30', `TimeoutStopSec=${justUnder}`))),
    ).not.toEqual([]);
    expect(
      shutdownFaults(parseUnitShutdown(NODE_OK.replace('TimeoutStopSec=30', `TimeoutStopSec=${justOver}`))),
    ).toEqual([]);
  });

  it('reports uvicorn started without a graceful-shutdown bound', () => {
    const faults = shutdownFaults(
      parseUnitShutdown(
        '[Service]\nType=simple\nExecStart=/opt/x/.venv/bin/uvicorn app.main:app\nTimeoutStopSec=30\n',
      ),
    );
    expect(faults.join(' ')).toContain('--timeout-graceful-shutdown');
  });

  it('reports a uvicorn bound that systemd would pre-empt', () => {
    // The failure this catches is the nastiest of the set, because the flag is
    // present and the unit reads as configured: with the grace at or above the
    // stop deadline, systemd always wins the race and every shutdown is a
    // SIGKILL anyway.
    const faults = shutdownFaults(
      parseUnitShutdown(
        UVICORN_OK.replace('--timeout-graceful-shutdown 15', '--timeout-graceful-shutdown 30'),
      ),
    );
    expect(faults.join(' ')).toContain('decorative');
  });

  it('exempts oneshot units, which have no graceful path to bound', () => {
    // The backup job is a pg_dump. A stop deadline on it would cut a backup
    // short rather than protect anything.
    expect(
      shutdownFaults(
        parseUnitShutdown('[Service]\nType=oneshot\nExecStart=/opt/N409/infra/backup/backup.sh\n'),
      ),
    ).toEqual([]);
  });

  it('treats a unit with no Type= as simple, which is systemd’s own rule', () => {
    // Keying the exemption on the declared shape is what stops this needing an
    // exception list. A new service that forgets `Type=` must not thereby
    // exempt itself from the deadline.
    const faults = shutdownFaults(parseUnitShutdown('[Service]\nExecStart=/usr/bin/node dist/index.js\n'));
    expect(faults).not.toEqual([]);
  });

  it('reports both halves at once rather than stopping at the first', () => {
    const faults = shutdownFaults(
      parseUnitShutdown('[Service]\nType=simple\nExecStart=/opt/x/.venv/bin/uvicorn app.main:app\n'),
    );
    expect(faults).toHaveLength(2);
  });
});

// ── The census ───────────────────────────────────────────────────────────────
// The three above test the rule. This tests the estate, and it is the half that
// keeps a sixth service honest: it reads the directories install-units.sh
// reads, so a unit added later is covered without anyone remembering to add it
// here.
describe('the shipped units', () => {
  it('finds every unit the installer installs', () => {
    const names = shippedUnits().map((u) => u.name);
    expect(names).toContain('n409-valuation.service');
    expect(names).toContain('n409-ai.service');
    expect(names).toContain('n409-backup.service');
    expect(names.length).toBeGreaterThanOrEqual(7);
  });

  it('satisfies the shutdown contract, every one of them', () => {
    for (const { name, text } of shippedUnits()) {
      // Named in the assertion so a failure says which unit, not just "false".
      expect([name, ...shutdownFaults(parseUnitShutdown(text))]).toEqual([name]);
    }
  });

  it('bounds every long-running unit well inside the systemd default', () => {
    // Not merely "set". deploy.sh waits on the valuation restart, so a stop
    // that takes the full distro default reads as a hung deploy — the symptom
    // the bounded shutdown exists to remove.
    for (const { name, text } of shippedUnits()) {
      const unit = parseUnitShutdown(text);
      if (unit.type !== 'simple') continue;
      expect(unit.stopTimeout?.kind, name).toBe('seconds');
      const seconds = (unit.stopTimeout as { seconds: number }).seconds;
      expect(seconds, name).toBeLessThan(SYSTEMD_DEFAULT_TIMEOUT_STOP_S);
      expect(seconds, name).toBeGreaterThan(DEFAULT_SHUTDOWN_GRACE_MS / 1000);
    }
  });

  it('bounds uvicorn on both Python units', () => {
    // Asserted positively rather than left to the fault check, so that deleting
    // the flag from an ExecStart cannot pass by making `runsUvicorn` false.
    const python = shippedUnits().filter((u) => parseUnitShutdown(u.text).runsUvicorn);
    expect(python.map((u) => u.name).sort()).toEqual(['n409-ai.service', 'n409-engine-wrapper.service']);
    for (const { name, text } of python) {
      expect(parseUnitShutdown(text).uvicornGraceSeconds, name).toBeGreaterThan(0);
    }
  });
});
