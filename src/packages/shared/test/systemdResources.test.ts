// Memory ceilings on systemd units.
//
// What this file is really about is a fact about the box rather than about
// parsing: 204.168.241.124 has 3.8GB, swap already touched, and three unrelated
// products on it. Until round 99 no N409 unit declared a memory limit, so the
// answer to a leak was the kernel's global OOM killer — which chooses by
// resident size, and the largest resident sizes on that host are an unrelated
// product's engine and PostgreSQL. A memory bug in the report renderer would
// have killed the database and left the renderer running.
//
// Round 98 is what made that matter. Delegating PDF rendering to the report
// service removed the bound nobody had designed — pdfkit is synchronous, so
// in-process renders were strictly serial — and made one unit's working set a
// function of load.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MIN_HOST_HEADROOM_BYTES,
  estateCeiling,
  estateCeilingFaults,
  formatBytes,
  memoryLimitFaults,
  parseMemorySize,
  parseUnitMemory,
  type UnitCeiling,
} from '../src/systemdResources.js';

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

describe('parseMemorySize', () => {
  // systemd's K is 1024. Reading it as 1000 would understate every ceiling in
  // the estate by 2.4%, which is small enough to never look wrong and large
  // enough to make the estate sum a number that is not the one on the host.
  it('reads systemd suffixes as powers of 1024', () => {
    expect(parseMemorySize('512M').bytes).toBe(512 * 1024 ** 2);
    expect(parseMemorySize('1G').bytes).toBe(1024 ** 3);
    expect(parseMemorySize('64K').bytes).toBe(65536);
    expect(parseMemorySize('4096').bytes).toBe(4096);
  });

  it('distinguishes infinity, a percentage and a value it cannot read', () => {
    expect(parseMemorySize('infinity').kind).toBe('infinity');
    expect(parseMemorySize('20%').kind).toBe('percent');
    expect(parseMemorySize('lots').kind).toBe('unparseable');
  });

  // A number with a suffix systemd has no meaning for. Reading it as bytes and
  // dropping the suffix would turn `512Mib` — a plausible typo — into 512
  // bytes, which is a ceiling that kills the service on its first allocation.
  it('refuses a number with a suffix systemd does not know', () => {
    expect(parseMemorySize('512Mib').kind).toBe('unparseable');
    expect(parseMemorySize('12XYZ').bytes).toBeNull();
  });
});

describe('parseUnitMemory', () => {
  it('reads the directives out of [Service] only', () => {
    const text = [
      '[Unit]',
      // A limit in the wrong section is a typo that systemd ignores, so reading
      // it as a limit would report a bound that does not exist.
      'MemoryMax=8G',
      '[Service]',
      'Type=oneshot',
      'MemoryAccounting=yes',
      'MemoryHigh=192M',
      'MemoryMax=256M',
      'MemorySwapMax=128M',
      '',
    ].join('\n');
    const parsed = parseUnitMemory(text);
    expect(parsed.type).toBe('oneshot');
    expect(parsed.max?.bytes).toBe(256 * 1024 ** 2);
    expect(parsed.high?.bytes).toBe(192 * 1024 ** 2);
    expect(parsed.swapMax?.bytes).toBe(128 * 1024 ** 2);
  });

  // systemd's rule for a directive a drop-in wants to clear. Reading the empty
  // assignment as "unset" rather than skipping the line is the difference
  // between reporting a missing limit and reporting a limit that is not there.
  it('treats an empty assignment as a reset, not as a value', () => {
    const parsed = parseUnitMemory('[Service]\nMemoryMax=256M\nMemoryMax=\n');
    expect(parsed.max).toBeNull();
  });

  // systemd's reset applies to every directive, not just the one that happened
  // to be tested. A `MemoryAccounting=` cleared by a drop-in and read as `no`
  // would disarm every limit in the unit while reporting a fault about it.
  it('applies the reset rule to each directive it reads', () => {
    const parsed = parseUnitMemory(
      [
        '[Service]',
        'Type=oneshot',
        'Type=',
        'MemoryAccounting=no',
        'MemoryAccounting=',
        'MemoryHigh=192M',
        'MemoryHigh=',
        'MemorySwapMax=64M',
        'MemorySwapMax=',
        '',
      ].join('\n'),
    );
    expect(parsed).toEqual({ type: null, accounting: null, high: null, max: null, swapMax: null });
  });

  it('takes the last assignment when a directive repeats', () => {
    const parsed = parseUnitMemory('[Service]\nMemoryMax=256M\nMemoryMax=512M\n');
    expect(parsed.max?.bytes).toBe(512 * 1024 ** 2);
  });

  // systemd drops a [Service] line with no `=` and logs a warning. Reading it
  // as a directive with an empty value would make it a reset, so a stray word
  // in a unit file would silently clear a ceiling.
  it('ignores a line with no assignment rather than reading it as a reset', () => {
    const parsed = parseUnitMemory('[Service]\nMemoryMax=512M\nMemoryMax\n');
    expect(parsed.max?.bytes).toBe(512 * 1024 ** 2);
  });
});

describe('memoryLimitFaults', () => {
  const GOOD = '[Service]\nMemoryAccounting=yes\nMemoryHigh=192M\nMemoryMax=256M\nMemorySwapMax=64M\n';

  it('passes a unit that declares all three', () => {
    expect(memoryLimitFaults(parseUnitMemory(GOOD))).toEqual([]);
  });

  it('names each missing directive', () => {
    const faults = memoryLimitFaults(parseUnitMemory('[Service]\nExecStart=/bin/true\n'));
    expect(faults.join('\n')).toContain('MemoryMax is not set');
    expect(faults.join('\n')).toContain('MemoryHigh is not set');
    expect(faults.join('\n')).toContain('MemorySwapMax is not set');
  });

  // The whole point of requiring MemorySwapMax. In cgroup v2 `memory.max` caps
  // resident pages; anonymous pages evicted to swap are charged to
  // `memory.swap.max`, which defaults to unlimited. A leaking process under a
  // MemoryMax with no swap bound therefore reports as compliant for ever while
  // filling the host's 2GB of swap and thrashing every other tenant.
  it('rejects a MemoryMax with no swap bound as a limit that is not one', () => {
    const faults = memoryLimitFaults(parseUnitMemory('[Service]\nMemoryHigh=192M\nMemoryMax=256M\n'));
    expect(faults.join('\n')).toContain('MemoryMax bounds resident pages only');
  });

  // `MemoryMax=infinity` is what systemd already does. Written out it looks
  // like a decision and is the absence of one, which is worse than nothing
  // because it survives a grep for MemoryMax.
  it('rejects infinity, which is the default spelled out', () => {
    const faults = memoryLimitFaults(
      parseUnitMemory('[Service]\nMemoryHigh=192M\nMemoryMax=infinity\nMemorySwapMax=64M\n'),
    );
    expect(faults.join('\n')).toContain('bounds nothing');
  });

  it('rejects a percentage, because the estate sum has to be a property of the units', () => {
    const faults = memoryLimitFaults(
      parseUnitMemory('[Service]\nMemoryHigh=192M\nMemoryMax=20%\nMemorySwapMax=64M\n'),
    );
    expect(faults.join('\n')).toContain('percentage');
  });

  // A throttle at or above the kill threshold is never reached before the kill,
  // so the unit is back to having one memory behaviour and no warning.
  it('rejects a MemoryHigh that is not below MemoryMax', () => {
    for (const high of ['256M', '512M']) {
      const faults = memoryLimitFaults(
        parseUnitMemory(`[Service]\nMemoryHigh=${high}\nMemoryMax=256M\nMemorySwapMax=64M\n`),
      );
      expect(faults.join('\n')).toContain('never engages');
    }
  });

  it('rejects a value systemd itself would not read', () => {
    const faults = memoryLimitFaults(
      parseUnitMemory('[Service]\nMemoryHigh=192M\nMemoryMax=lots\nMemorySwapMax=64M\n'),
    );
    expect(faults.join('\n')).toContain('not a size systemd will read');
  });

  // The estate writes a quarter of the RAM ceiling. The check is at a half so
  // that a considered exception need not argue with the rule, and refuses the
  // shape with no defence: a swap allowance in the region of the RAM ceiling
  // lets a service run mostly paged out and answer every probe, slowly.
  it('rejects a swap allowance in the region of the RAM ceiling', () => {
    const faults = memoryLimitFaults(
      parseUnitMemory('[Service]\nMemoryHigh=192M\nMemoryMax=256M\nMemorySwapMax=256M\n'),
    );
    expect(faults.join('\n')).toContain('run largely paged out');
  });

  it('allows the quarter the estate actually writes', () => {
    expect(
      memoryLimitFaults(parseUnitMemory('[Service]\nMemoryHigh=384M\nMemoryMax=512M\nMemorySwapMax=128M\n')),
    ).toEqual([]);
  });

  // The one that would make every other check in this file vacuous: the
  // directives stay in the file, read as a decision, and are not enforced.
  it('rejects MemoryAccounting=no, which disarms every limit above it', () => {
    const faults = memoryLimitFaults(parseUnitMemory(`${GOOD}MemoryAccounting=no\n`));
    expect(faults.join('\n')).toContain('switches off the accounting');
  });
});

describe('estateCeiling', () => {
  function unit(name: string, max: string, swap: string, type?: string): UnitCeiling {
    const body = `[Service]\n${type ? `Type=${type}\n` : ''}MemoryMax=${max}\nMemorySwapMax=${swap}\n`;
    return { unit: name, resources: parseUnitMemory(body) };
  }

  // A unit with no ceilings contributes nothing to the sum rather than NaN.
  // The fault for having none is `memoryLimitFaults`' job, and a NaN total
  // here would make the estate check report on every unit's behalf instead.
  it('contributes nothing for a unit that declares no ceiling', () => {
    const bare: UnitCeiling = { unit: 'bare.service', resources: parseUnitMemory('[Service]\n') };
    expect(estateCeiling([bare]).totalBytes).toBe(0);
  });

  it('counts RAM and swap together, because a unit at both is holding both', () => {
    const { totalBytes } = estateCeiling([unit('a.service', '256M', '64M')]);
    expect(totalBytes).toBe(320 * 1024 ** 2);
  });

  // n409-backup.timer fires at 02:00 and n409-backup-verify.timer at 04:00 on
  // Sundays, so at most one oneshot is ever resident. Summing them would
  // reserve memory for a moment that does not exist; ignoring them entirely
  // would miss that they run *while the services are up*.
  it('sums the always-on units and adds only the largest oneshot', () => {
    const ceiling = estateCeiling([
      unit('a.service', '256M', '0'),
      unit('b.service', '192M', '0'),
      unit('backup.service', '256M', '0', 'oneshot'),
      unit('verify.service', '512M', '0', 'oneshot'),
    ]);
    expect(ceiling.alwaysOnBytes).toBe(448 * 1024 ** 2);
    expect(ceiling.largestOneshotBytes).toBe(512 * 1024 ** 2);
    expect(ceiling.totalBytes).toBe(960 * 1024 ** 2);
  });
});

describe('estateCeilingFaults', () => {
  const ceiling = (mb: number) => ({
    alwaysOnBytes: mb * 1024 ** 2,
    largestOneshotBytes: 0,
    totalBytes: mb * 1024 ** 2,
  });

  it('passes when the host keeps its headroom', () => {
    expect(estateCeilingFaults(ceiling(1024), 3 * 1024 ** 3)).toEqual([]);
  });

  // The two things this catches, neither of which is visible from any single
  // unit file: a limit raised past what the box can honour, and the estate
  // moved onto a smaller box than the limits were sized for.
  it('faults when the ceilings would leave the rest of the box less than a gigabyte', () => {
    const faults = estateCeilingFaults(ceiling(3000), 3814 * 1024 ** 2);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain('PostgreSQL, Caddy, the kernel');
    expect(faults[0]).toContain(formatBytes(MIN_HOST_HEADROOM_BYTES));
  });
});

// The version of every test above that can actually catch the day somebody adds
// a unit, or edits one: the files this repo really ships. `install-units.sh`
// installs every `.service` under both directories, so both are swept.
describe('the units this repo ships', () => {
  it('finds the whole install set — seven services across two directories', () => {
    expect(shippedUnits().map((u) => u.name)).toEqual([
      // infra/systemd
      'n409-ai.service',
      'n409-engine-wrapper.service',
      'n409-report.service',
      'n409-valuation.service',
      'n409-web.service',
      // infra/backup — installed by the same script onto the same host, and
      // outside every check in this repo until round 99.
      'n409-backup-verify.service',
      'n409-backup.service',
    ]);
  });

  it('every one of them declares a bounded ceiling', () => {
    for (const { name, text } of shippedUnits()) {
      expect([name, ...memoryLimitFaults(parseUnitMemory(text))]).toEqual([name]);
    }
  });

  // The measurements the unit files were sized from, pinned so that a later
  // edit that halves a ceiling has to argue with a number rather than with a
  // comment. Taken from the running host on 2026-08-23: report 72M resident /
  // 136M peak, valuation 120M/144M, web 57M/78M, ai 61M/62M, engine 49M/50M.
  it('gives each unit a ceiling above its measured peak, and the largest to the report service', () => {
    const max = Object.fromEntries(
      shippedUnits().map((u) => [u.name, parseUnitMemory(u.text).max?.bytes ?? 0]),
    );
    const peaks: Record<string, number> = {
      'n409-report.service': 136,
      'n409-valuation.service': 144,
      'n409-web.service': 78,
      'n409-ai.service': 62,
      'n409-engine-wrapper.service': 50,
    };
    for (const [name, peakMb] of Object.entries(peaks)) {
      expect(max[name]).toBeGreaterThan(peakMb * 1024 ** 2 * 1.5);
    }
    // The report service is the only unit whose working set is a function of
    // load, so it gets the largest ceiling of the five. If that ever stops
    // being true, the reason has to be written down.
    const services = Object.entries(max).filter(([n]) => n in peaks);
    expect(services.every(([n, v]) => n === 'n409-report.service' || v < max['n409-report.service']!)).toBe(
      true,
    );
  });

  // The number an operator would otherwise have to add up by hand, checked
  // against the box the units are installed on. 3.8GB, shared with PostgreSQL,
  // Caddy and two unrelated products.
  it('fits on the 3.8GB host with the headroom the estate rule requires', () => {
    const ceiling = estateCeiling(
      shippedUnits().map(({ name, text }) => ({ unit: name, resources: parseUnitMemory(text) })),
    );
    expect(estateCeilingFaults(ceiling, 3814 * 1024 ** 2)).toEqual([]);
  });
});
