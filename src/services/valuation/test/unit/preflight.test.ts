// The deploy-time config preflight.
//
// The guards it runs already existed; nothing here is testing them again. What
// is being pinned is that they are run against the file the units actually
// read, before anything restarts — the piece whose absence let a
// STRIPE_SECRET_KEY with no STRIPE_WEBHOOK_SECRET sit in production for 324
// commits, taking money that no webhook could fulfil, until an outage found it.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { estateCeiling, parseUnitMemory } from '@n409/shared';
import { modelledRenderCeilingBytes } from '../../src/clients/reportRender.js';
import { KNOWN_UNITS, formatFaults, preflight } from '../../src/preflight.js';

/** A valid production .env, as the smallest thing that passes everything. */
const GOOD_ENV = [
  'DATABASE_URL=postgres://n409:realpassword@10.0.0.5:5432/n409',
  'PUBLIC_BASE_URL=https://app.409.ai',
  'JWT_SECRET=9f2c4a7e1b6d8035fe4a1c9b7d2e6083a5c4b1f7e9d0236a8c5b4f1e7d9a0c36',
  'INTERNAL_SERVICE_TOKEN=b41f7e9d0236a8c5b4f1e7d9a0c369f2',
].join('\n');

/**
 * The memory ceilings round 99 gave every unit, as a suffix the fixtures share.
 *
 * Present in the fixtures because they are present in the real units, and their
 * absence is now a fault: without this every test in this file would be
 * asserting against a pile of memory faults instead of against the thing it is
 * about. `report` gets its own, larger, ceiling — the modelled floor derived
 * from the delegation bound is checked against it.
 */
const LIMITS = 'MemoryAccounting=yes\nMemoryHigh=144M\nMemoryMax=192M\nMemorySwapMax=64M\n';
const REPORT_LIMITS = 'MemoryAccounting=yes\nMemoryHigh=384M\nMemoryMax=512M\nMemorySwapMax=128M\n';

/** Units as `infra/systemd` really has them, trimmed to what the checker reads. */
const UNITS: Record<string, string> = {
  'n409-valuation.service': `[Service]\nEnvironmentFile=/opt/N409/.env\nEnvironment=NODE_ENV=production\nEnvironment=PORT=3001\n${LIMITS}`,
  'n409-report.service': `[Service]\nEnvironmentFile=/opt/N409/.env\nEnvironment=NODE_ENV=production\nEnvironment=PORT=3004\n${REPORT_LIMITS}`,
  'n409-web.service': `[Service]\nEnvironmentFile=/opt/N409/.env\nEnvironment=NODE_ENV=production\nEnvironment=PORT=3000\n${LIMITS}`,
  'n409-ai.service': `[Service]\nEnvironmentFile=/opt/N409/.env\nEnvironment=APP_ENV=production\n${LIMITS}`,
  'n409-engine-wrapper.service': `[Service]\nEnvironmentFile=/opt/N409/.env\nEnvironment=APP_ENV=production\n${LIMITS}`,
};

interface RunOptions {
  env?: string;
  units?: Record<string, string>;
  mode?: number;
  /** Physical RAM of the pretend host. Generous by default; the estate sum has its own tests. */
  hostTotalBytes?: number;
}

function run(options: RunOptions = {}) {
  const units = options.units ?? UNITS;
  const envText = options.env ?? GOOD_ENV;
  return preflight({
    unitDir: '/units',
    resolveEnvFile: () => '/opt/N409/.env',
    readFile: (file) => {
      if (file === '/opt/N409/.env') return envText;
      const name = file.replace('/units/', '');
      const text = units[name];
      if (text === undefined) throw new Error(`ENOENT ${file}`);
      return text;
    },
    statFile: () => options.mode ?? 0o100600,
    // The fixture map *is* the directory. Without this the sweep for units the
    // checker has no guard for would read a `/units` that does not exist, come
    // back empty, and pass every test by never looking at anything.
    readDir: () => Object.keys(units),
    // Never `os.totalmem()`: the estate sum would otherwise be a property of
    // whichever machine ran the suite, so the same fixtures would pass on a
    // laptop and fail in CI. 8GiB is comfortably above every fixture here; the
    // tests that are actually about the host budget pass their own number.
    hostTotalBytes: options.hostTotalBytes ?? 8 * 1024 ** 3,
  });
}

function messages(options: RunOptions = {}): string {
  return run(options)
    .faults.map((f) => `${f.scope}: ${f.message}`)
    .join('\n');
}

describe('a correct production environment', () => {
  it('passes', () => {
    const result = run();
    expect(result.faults).toEqual([]);
    expect(result.units).toEqual(KNOWN_UNITS);
  });

  it('covers every unit in infra/systemd', () => {
    expect(KNOWN_UNITS.sort()).toEqual(Object.keys(UNITS).sort());
  });

  it('renders nothing to print when there is nothing wrong', () => {
    expect(formatFaults(run())).toBe('');
  });
});

describe('the faults that were actually in production', () => {
  it('catches a Stripe key with no webhook secret', () => {
    // The one that cost an outage: checkout takes the money, and the webhook —
    // the only thing that marks a payment succeeded — answers 503.
    const text = messages({ env: `${GOOD_ENV}\nSTRIPE_SECRET_KEY=sk_live_abc\n` });
    expect(text).toContain('n409-valuation.service');
    expect(text).toContain('STRIPE_WEBHOOK_SECRET');
  });

  it('accepts the safe half — a webhook secret with no API key', () => {
    // Checkout is simply unavailable, which is what the test suite runs with.
    expect(run({ env: `${GOOD_ENV}\nSTRIPE_WEBHOOK_SECRET=whsec_abc\n` }).faults).toEqual([]);
  });
});

describe('guards that live outside loadConfig', () => {
  it('catches an INTERNAL_SERVICE_TOKEN that would stop four services booting', () => {
    const text = messages({ env: GOOD_ENV.split('\n').slice(0, 3).join('\n') });
    // One missing variable, three units that refuse to start — and the deploy
    // script restarts valuation first, which is the one that does not.
    for (const unit of ['n409-report.service', 'n409-ai.service', 'n409-engine-wrapper.service']) {
      expect(text).toContain(`${unit}: INTERNAL_SERVICE_TOKEN is required`);
    }
    expect(text).not.toContain('n409-valuation.service: INTERNAL_SERVICE_TOKEN');
    // The public BFF registers no internal-auth gate and must not be blamed.
    expect(text).not.toContain('n409-web.service');
  });

  it('names APP_ENV for the Python services and NODE_ENV for the report one', () => {
    const text = messages({ env: GOOD_ENV.split('\n').slice(0, 3).join('\n') });
    expect(text).toContain('n409-ai.service: INTERNAL_SERVICE_TOKEN is required when APP_ENV=production');
    expect(text).toContain(
      'n409-report.service: INTERNAL_SERVICE_TOKEN is required when NODE_ENV=production',
    );
  });
});

describe('loadConfig runs in full, not a restatement of it', () => {
  it('rejects a known example JWT secret', () => {
    const env = GOOD_ENV.replace(/^JWT_SECRET=.*$/m, 'JWT_SECRET=dev-only-secret-change-me-0123456789abcdef');
    expect(messages({ env })).toContain('known example or low-entropy');
  });

  it('rejects an unset PUBLIC_BASE_URL, whose default resolves for nobody', () => {
    const env = GOOD_ENV.split('\n')
      .filter((l) => !l.startsWith('PUBLIC_BASE_URL'))
      .join('\n');
    expect(messages({ env })).toContain('PUBLIC_BASE_URL must be set in production');
  });

  it('rejects EMAIL_MODE=smtp with no SMTP_HOST', () => {
    expect(messages({ env: `${GOOD_ENV}\nEMAIL_MODE=smtp\n` })).toContain('fall back to the log');
  });

  it('rejects a value the schema itself refuses', () => {
    expect(messages({ env: `${GOOD_ENV}\nAUTO_PIPELINE=maybe\n` })).toContain('AUTO_PIPELINE');
  });

  it('reports a fault once even though both precedence readings are checked', () => {
    const faults = run({ env: `${GOOD_ENV}\nSTRIPE_SECRET_KEY=sk_live_abc\n` }).faults.filter(
      (f) => f.scope === 'n409-valuation.service',
    );
    expect(faults).toHaveLength(1);
  });
});

describe('the environment file itself', () => {
  it('reports a parse problem once, not once per unit that reads the file', () => {
    const faults = run({ env: `${GOOD_ENV}\nexport EXTRA=1\n` }).faults.filter((f) => f.scope === '.env');
    expect(faults).toHaveLength(1);
    expect(faults[0]!.message).toContain('line 5');
  });

  it('catches a JWT_SECRET written with export, which systemd would not set', () => {
    // Reads correctly, `source .env` sets it, and the service boots without it
    // — which under the guard is a failed boot rather than a silent bypass, but
    // only after the old process has already been stopped.
    const env = GOOD_ENV.replace(/^JWT_SECRET=/m, 'export JWT_SECRET=');
    const text = messages({ env });
    expect(text).toContain('UNSET');
    expect(text).toContain('n409-valuation.service: Invalid configuration: JWT_SECRET');
  });

  it('catches a world-readable .env', () => {
    expect(messages({ mode: 0o100644 })).toContain('is mode 644');
  });

  it('says nothing about a 0600 .env', () => {
    expect(messages({ mode: 0o100600 })).toBe('');
  });

  it('does not fail when the mode cannot be read', () => {
    const result = preflight({
      unitDir: '/units',
      resolveEnvFile: () => '/opt/N409/.env',
      readFile: (file) => (file === '/opt/N409/.env' ? GOOD_ENV : (UNITS[file.replace('/units/', '')] ?? '')),
      statFile: () => null,
    });
    expect(result.faults).toEqual([]);
  });

  it('fails loudly when the env file is missing rather than validating an empty one', () => {
    const result = preflight({
      unitDir: '/units',
      resolveEnvFile: () => '/nowhere/.env',
      readFile: (file) => {
        if (file.startsWith('/nowhere')) throw new Error('ENOENT');
        return UNITS[file.replace('/units/', '')] ?? '';
      },
      statFile: () => null,
    });
    expect(result.faults.map((f) => f.message).join()).toContain('could not be read');
  });

  it('tolerates an optional env file that is absent', () => {
    // The Environment= lines are kept even though this test is about the
    // EnvironmentFile: a unit stripped down to nothing is a unit that no longer
    // declares NODE_ENV=production, which is a fault of its own now, and the
    // assertion below — "nothing at all is reported against n409-web" — would
    // fail for a reason that has nothing to do with optional env files. Round 99
    // added a second thing a stripped-down unit stops declaring, and `LIMITS` is
    // here for the same reason.
    const units = {
      ...UNITS,
      'n409-web.service': `[Service]\nEnvironmentFile=-/opt/N409/.env.local\nEnvironment=NODE_ENV=production\nEnvironment=PORT=3000\n${LIMITS}`,
    };
    const text = messages({ units });
    expect(text).not.toContain('n409-web.service');
  });
});

describe('the unit and the file disagreeing', () => {
  it('is a fault, without the checker guessing which one wins', () => {
    // NODE_ENV=development in the file against Environment=NODE_ENV=production
    // in the unit is the difference between the production guards being armed
    // and being off, decided by a systemd precedence rule visible in neither
    // file. .env.example ships NODE_ENV=development, so this is one careless
    // copy away.
    const env = `${GOOD_ENV}\nNODE_ENV=development\n`;
    const text = messages({ env });
    expect(text).toContain('Set it in one place');
    expect(text).toContain('"production" by the unit and "development" by its EnvironmentFile');
  });

  it('reports the guard fault the losing reading would produce, too', () => {
    // Under "the unit wins", NODE_ENV=production and the missing token is fatal
    // for three services. Under "the file wins" it is not. Both are reported,
    // because a deployment that is only valid under one reading is not one
    // anybody should have to reason about.
    const env = `${GOOD_ENV.split('\n').slice(0, 3).join('\n')}\nNODE_ENV=development\n`;
    expect(messages({ env })).toContain('INTERNAL_SERVICE_TOKEN is required');
  });

  it('is not a fault when both sides agree', () => {
    expect(messages({ env: `${GOOD_ENV}\nNODE_ENV=production\n` })).toBe('');
  });
});

describe('the port each unit binds', () => {
  /** One unit's `Environment=PORT=` line, replaced. */
  function withPort(unit: string, value: string): Record<string, string> {
    return {
      ...UNITS,
      [unit]: UNITS[unit]!.replace(/Environment=PORT=\d+\n/, `Environment=PORT=${value}\n`),
    };
  }

  it('passes on the real unit files', () => {
    expect(messages()).toBe('');
  });

  it.each([
    ['n409-web.service', 3000],
    ['n409-valuation.service', 3001],
    ['n409-report.service', 3004],
  ])('catches an emptied PORT on %s before anything restarts', (unit) => {
    // The failure this exists for: the service starts, logs "listening", and
    // answers on an ephemeral port. Caddy gets connection refused against 3000
    // and `deploy.sh` gets a health probe that never succeeds — neither of which
    // says the word "port". Catching it here costs a failed deploy with the old
    // release still serving.
    const text = messages({ units: withPort(unit, '') });
    expect(text).toContain(unit);
    expect(text).toMatch(/PORT/);
  });

  it.each(['n409-web.service', 'n409-valuation.service', 'n409-report.service'])(
    'catches an out-of-range PORT on %s',
    (unit) => {
      expect(messages({ units: withPort(unit, '70000') })).toContain(unit);
    },
  );

  it('catches a PORT the EnvironmentFile supplies, under either precedence reading', () => {
    // Nothing sets PORT in the shared .env today — the file's own header warns
    // against it — but if something did, only one of the two systemd precedence
    // readings would show it. Both are evaluated, so either is a fault.
    const units = { ...UNITS };
    for (const name of Object.keys(units)) {
      units[name] = units[name]!.replace(/Environment=PORT=\d+\n/, '');
    }
    expect(messages({ units, env: `${GOOD_ENV}\nPORT=0\n` })).toMatch(/PORT/);
  });

  it('leaves the Python units alone — uvicorn takes --port on the ExecStart line', () => {
    // A PORT in the environment is a variable neither Python service reads, so
    // reporting one as a fault would be a false positive on a real deployment.
    const units = {
      ...UNITS,
      'n409-ai.service': `${UNITS['n409-ai.service']!}Environment=PORT=0\n`,
      'n409-engine-wrapper.service': `${UNITS['n409-engine-wrapper.service']!}Environment=PORT=0\n`,
    };
    const text = messages({ units });
    expect(text).not.toContain('n409-ai.service');
    expect(text).not.toContain('n409-engine-wrapper.service');
  });
});

// Feature flags are the one class of setting whose runtime *cannot* complain:
// `flagEnabled` falls back to the default rather than throwing on the request
// path, deliberately, so a misspelled value leaves the switch where it was and
// reports nothing. The deploy is therefore the only place a typo can be caught,
// and these switches get thrown mid-incident — when a silently-ignored one is
// most expensive.
describe('feature flags in the env file', () => {
  const withFlags = (...lines: string[]) => ({ env: [GOOD_ENV, ...lines].join('\n') });

  it('accepts every spelling the reader accepts', () => {
    expect(
      run(withFlags('FLAG_CIRCUIT_BREAKERS=off', 'FLAG_RETRY_LADDERS=0', 'FLAG_BACKUP_VERIFICATION=DISABLED'))
        .faults,
    ).toEqual([]);
  });

  it('accepts an unset flag, which is how every host starts', () => {
    expect(run(withFlags('FLAG_CIRCUIT_BREAKERS=')).faults).toEqual([]);
  });

  it('rejects a value nothing can read', () => {
    const text = messages(withFlags('FLAG_CIRCUIT_BREAKERS=disable'));
    expect(text).toContain('FLAG_CIRCUIT_BREAKERS');
    expect(text).toContain('is not a boolean');
  });

  it('scopes the fault to the env file, not to a unit', () => {
    // The flags are declared centrally and read on both sides of the language
    // split — FLAG_BACKUP_VERIFICATION is consumed by a shell script — so a
    // per-unit scope would be a lie about where the setting lives.
    const result = run(withFlags('FLAG_RETRY_LADDERS=sometimes'));
    expect(result.faults).toHaveLength(1);
    expect(result.faults[0]!.scope).toBe('.env');
  });

  it('reports a bad flag once, not once per unit that reads the file', () => {
    // All five units share /opt/N409/.env; five copies of one fault is noise
    // that hides the other four faults.
    expect(run(withFlags('FLAG_BACKUP_VERIFICATION=nope')).faults).toHaveLength(1);
  });

  it('reports each bad flag separately', () => {
    const result = run(withFlags('FLAG_CIRCUIT_BREAKERS=yep', 'FLAG_RETRY_LADDERS=nah'));
    expect(result.faults).toHaveLength(2);
  });
});

describe('missing units', () => {
  it('are a fault — a unit this checker cannot see is one it never validated', () => {
    const units = { ...UNITS };
    delete units['n409-ai.service'];
    expect(messages({ units })).toContain('unit file is missing');
  });
});

describe('formatFaults', () => {
  it('counts and indents them', () => {
    const text = formatFaults({
      faults: [
        { scope: 'a.service', message: 'one' },
        { scope: 'b.service', message: 'two' },
      ],
      units: [],
    });
    expect(text).toBe('2 configuration faults:\n  a.service: one\n  b.service: two');
  });

  it('says fault, singular, for one', () => {
    expect(formatFaults({ faults: [{ scope: 'a', message: 'x' }], units: [] })).toContain(
      '1 configuration fault:',
    );
  });
});

// Every guard that matters is conditional on the unit calling itself production,
// so a unit that stops saying so stops being checked — and reports a clean
// preflight while doing it. That is not a hypothetical: the engine-wrapper unit
// installed on the production host had no `Environment=APP_ENV=production` for
// four weeks, because deploy.sh shipped `infra/systemd/` onto the box and never
// copied it into /etc/systemd/system. Preflight read the repo's copy — the
// correct one — and passed, while the file systemd actually booted left
// `internal_token_middleware` willing to serve unauthenticated the moment
// INTERNAL_SERVICE_TOKEN went missing.
describe('the production posture each unit declares', () => {
  /** Drop the marker line from one unit, leaving everything else intact. */
  function withoutMarker(unit: string): Record<string, string> {
    return { ...UNITS, [unit]: UNITS[unit]!.replace(/Environment=(NODE|APP)_ENV=production\n/, '') };
  }

  it('is satisfied by the real unit files', () => {
    expect(messages()).toBe('');
  });

  it.each([
    ['n409-engine-wrapper.service', 'APP_ENV'],
    ['n409-ai.service', 'APP_ENV'],
    ['n409-valuation.service', 'NODE_ENV'],
    ['n409-report.service', 'NODE_ENV'],
    ['n409-web.service', 'NODE_ENV'],
  ])('is a fault when %s stops declaring it', (unit, marker) => {
    const text = messages({ units: withoutMarker(unit) });
    expect(text).toContain(unit);
    expect(text).toContain(`${marker} is unset, not "production"`);
  });

  // The point of the whole check. A missing marker is not caught by the guards
  // themselves — they are the thing being switched off — so with a perfectly
  // good .env in place, dropping the line produces exactly one fault, and
  // without this check it would produce none at all.
  it('is the only thing that catches it — the guards it gates stay silent', () => {
    const result = run({ units: withoutMarker('n409-engine-wrapper.service') });
    const engine = result.faults.filter((f) => f.scope === 'n409-engine-wrapper.service');
    expect(engine).toHaveLength(1);
    expect(engine[0]!.message).toContain('makes this check pass by having nothing left to ask');
  });

  // The live case exactly: the secret *is* configured, so nothing is currently
  // unauthenticated and `requiresInternalToken` has no complaint to make under
  // either reading. The fault is the missing declaration itself, because it is
  // what decides whether the guard fires if the secret ever goes away.
  it('fires even though INTERNAL_SERVICE_TOKEN is set', () => {
    const text = messages({ units: withoutMarker('n409-engine-wrapper.service') });
    expect(GOOD_ENV).toContain('INTERNAL_SERVICE_TOKEN=');
    expect(text).toContain('n409-engine-wrapper.service');
  });

  // `is_production()` in both Python services compares against the literal
  // string, and `loadConfig` does the same. Accepting a near-miss here would
  // report healthy a box on which every production guard is off.
  it.each(['prod', 'produktion', 'production=1', 'true', ''])(
    'does not accept APP_ENV=%j as production',
    (value) => {
      const units = {
        ...UNITS,
        'n409-engine-wrapper.service': `[Service]\nEnvironmentFile=/opt/N409/.env\nEnvironment=APP_ENV=${value}\n`,
      };
      expect(messages({ units })).toContain('n409-engine-wrapper.service');
    },
  );

  // Case is one of the two things that are tolerated, because `is_production()`
  // lowercases before comparing and so does `declaresProduction`.
  it('accepts the casing the services accept', () => {
    const units = {
      ...UNITS,
      'n409-engine-wrapper.service': `[Service]\nEnvironmentFile=/opt/N409/.env\nEnvironment=APP_ENV=PRODUCTION\n${LIMITS}`,
    };
    expect(messages({ units })).toBe('');
  });

  // The other is a trailing space, and it is tolerated because systemd itself
  // does not preserve one: `Environment=` splits on whitespace, so the service
  // boots with "production" whatever the file looks like. Rejecting it here
  // would fail a deploy over a file that is, to the process that reads it,
  // identical to the one this checker demands.
  it('accepts a trailing space, which systemd strips before the service sees it', () => {
    const units = {
      ...UNITS,
      'n409-engine-wrapper.service': `[Service]\nEnvironmentFile=/opt/N409/.env\nEnvironment=APP_ENV=production \n${LIMITS}`,
    };
    expect(messages({ units })).toBe('');
  });

  // A marker the EnvironmentFile supplies is as good as one the unit does —
  // systemd merges both, and the service reads the merge.
  it('accepts a marker that comes from the EnvironmentFile instead', () => {
    const text = messages({
      units: withoutMarker('n409-engine-wrapper.service'),
      env: `${GOOD_ENV}\nAPP_ENV=production`,
    });
    expect(text).toBe('');
  });

  // The guard loop runs each unit under both precedence readings. A fault that
  // holds under both must still be reported once.
  it('reports the missing declaration once, not once per precedence reading', () => {
    const result = run({ units: withoutMarker('n409-ai.service') });
    const posture = result.faults.filter((f) => f.message.includes('not "production"'));
    expect(posture).toHaveLength(1);
  });
});

// Everything else in this file iterates KNOWN_UNITS — the checker's own list.
// A unit file added to `infra/systemd/` and not to that list is installed onto
// the host by infra/install-units.sh, started by systemd, and validated by
// nothing, while the CLI goes on reporting every unit as checked. Same vacuity
// as a unit that forgets to declare production, one level up: a check scoped to
// a hardcoded list narrows to nothing the moment reality grows past it.
describe('units on disk the checker has no guard for', () => {
  it('is a fault, naming what to do about it', () => {
    const units = { ...UNITS, 'n409-newthing.service': '[Service]\nEnvironment=NODE_ENV=production\n' };
    const text = messages({ units });
    expect(text).toContain('n409-newthing.service');
    expect(text).toContain('has no guard in this checker');
  });

  // The real directory, which is the only version of this test that can catch
  // the sixth unit on the day somebody adds it.
  it('does not fire on the units this repo actually ships', () => {
    const dir = path.resolve(fileURLToPath(import.meta.url), '../../../../../../infra/systemd');
    const onDisk = readdirSync(dir).filter((f) => f.endsWith('.service'));
    expect(onDisk.sort()).toEqual([...KNOWN_UNITS].sort());
  });

  // Timers have no environment to validate and no guard to write; the backup
  // pair lives in a different directory for exactly that reason.
  it('ignores anything that is not a .service', () => {
    const units = { ...UNITS, 'n409-backup.timer': '[Timer]\nOnCalendar=daily\n' };
    expect(messages({ units })).toBe('');
  });

  // A unit that is *missing* is already a fault (see above); it must not also
  // be reported as unknown, which would be the same absence counted twice.
  it('does not double-report a unit that is in the list but not on disk', () => {
    const { 'n409-ai.service': _dropped, ...units } = UNITS;
    const result = run({ units });
    const ai = result.faults.filter((f) => f.scope === 'n409-ai.service');
    expect(ai).toHaveLength(1);
    expect(ai[0]!.message).toContain('unit file is missing');
  });
});

// ── Memory ceilings (round 99) ───────────────────────────────────────────────
//
// The estate ran with no `MemoryMax` on any unit until this round, which was
// harmless while every process was small and flat and stopped being harmless
// when round 98 made the report service's working set a function of load. These
// are the tests for the half of that fix that is a check rather than a number:
// the deploy refuses a unit with no ceiling, refuses a set of ceilings the host
// cannot honour, and refuses a report ceiling that has drifted below the
// concurrency the delegation client is willing to create.
describe('memory ceilings', () => {
  /** A unit body with the memory stanza replaced. */
  function withLimits(unit: string, limits: string): Record<string, string> {
    const base = UNITS[unit]!.split('MemoryAccounting')[0]!;
    return { ...UNITS, [unit]: base + limits };
  }

  it('passes the ceilings the fixtures declare', () => {
    expect(messages()).toBe('');
  });

  it('faults a unit with no ceiling at all, naming what it costs', () => {
    const text = messages({ units: withLimits('n409-web.service', '') });
    expect(text).toContain('n409-web.service: MemoryMax is not set');
    expect(text).toContain("kernel's global OOM killer");
  });

  // The sweep iterates the *directory*, not KNOWN_UNITS, so a unit this checker
  // has no environment guard for still has to declare a ceiling. That is the
  // whole reason the two checks have different scopes: the backup pair is
  // installed onto the same host by the same script and shares its RAM.
  it('covers a unit the environment guards have never heard of', () => {
    const units = { ...UNITS, 'n409-backup.service': '[Service]\nType=oneshot\nExecStart=/bin/true\n' };
    const text = messages({ units });
    expect(text).toContain('n409-backup.service: MemoryMax is not set');
  });

  // A `.timer` has no cgroup of its own — it starts a `.service`, and that is
  // where the limit belongs. Demanding one here would be a fault nobody can fix.
  it('does not ask a timer for a memory limit', () => {
    const units = { ...UNITS, 'n409-backup.timer': '[Timer]\nOnCalendar=daily\n' };
    expect(messages({ units })).toBe('');
  });

  // THE DRIFT THIS EXISTS FOR: the report unit's 512M was derived from
  // MAX_DELEGATED_IN_FLIGHT + MAX_DELEGATED_QUEUED and the per-render cost
  // measured in round 98. Raising the queue depth without raising the ceiling
  // is a change that looks local to one TypeScript file and is really a change
  // to how much memory a systemd unit needs — the two would drift silently, and
  // the discovery would be a SIGKILL at full load.
  it('faults a report ceiling below what the delegation bound can fill', () => {
    const limits = 'MemoryAccounting=yes\nMemoryHigh=96M\nMemoryMax=128M\nMemorySwapMax=32M\n';
    const text = messages({ units: withLimits('n409-report.service', limits) });
    expect(text).toContain('is below the 276M this service is designed to be able to hold');
    expect(text).toContain('MAX_DELEGATED_IN_FLIGHT + MAX_DELEGATED_QUEUED');
  });

  // The modelled floor is a floor and not a target: the shipped 512M clears the
  // 276M model with room for GC lag and heap fragmentation, which the model
  // does not attempt to account for.
  it('accepts the ceiling the report unit actually ships with', () => {
    expect(messages()).toBe('');
    expect(modelledRenderCeilingBytes()).toBe(276 * 1024 ** 2);
  });

  // Nothing in a single unit file can see this. Both of the ways it fires —
  // somebody raising a limit past what the box can honour, and the estate being
  // moved onto a smaller box — are silent otherwise, and both end as the
  // host-wide OOM the per-unit limits were added to prevent.
  it('faults ceilings that do not fit the host the deploy is running on', () => {
    const text = messages({ hostTotalBytes: 1024 ** 3 });
    expect(text).toContain('estate:');
    expect(text).toContain('moved onto a smaller one');
  });

  // A unit named by two --install-dir arguments is one unit on the host. Adding
  // its ceiling twice would fail a deploy over memory nothing will ever hold.
  it('counts a unit listed in two install directories once', () => {
    const both = preflight({
      unitDir: '/units',
      installDirs: ['/units', '/units'],
      resolveEnvFile: () => '/opt/N409/.env',
      readFile: (file) => {
        if (file === '/opt/N409/.env') return GOOD_ENV;
        const text = UNITS[file.replace('/units/', '')];
        if (text === undefined) throw new Error(`ENOENT ${file}`);
        return text;
      },
      statFile: () => 0o100600,
      readDir: () => Object.keys(UNITS),
      // Just above the estate's real ceiling: with the double count it is not.
      hostTotalBytes:
        1024 ** 3 +
        estateCeiling(
          Object.entries(UNITS).map(([unit, text]) => ({ unit, resources: parseUnitMemory(text) })),
        ).totalBytes,
    });
    expect(formatFaults(both)).toBe('');
  });
});
