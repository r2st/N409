// The deploy-time config preflight.
//
// The guards it runs already existed; nothing here is testing them again. What
// is being pinned is that they are run against the file the units actually
// read, before anything restarts — the piece whose absence let a
// STRIPE_SECRET_KEY with no STRIPE_WEBHOOK_SECRET sit in production for 324
// commits, taking money that no webhook could fulfil, until an outage found it.
import { describe, expect, it } from 'vitest';
import { KNOWN_UNITS, formatFaults, preflight } from '../../src/preflight.js';

/** A valid production .env, as the smallest thing that passes everything. */
const GOOD_ENV = [
  'DATABASE_URL=postgres://n409:realpassword@10.0.0.5:5432/n409',
  'PUBLIC_BASE_URL=https://app.409.ai',
  'JWT_SECRET=9f2c4a7e1b6d8035fe4a1c9b7d2e6083a5c4b1f7e9d0236a8c5b4f1e7d9a0c36',
  'INTERNAL_SERVICE_TOKEN=b41f7e9d0236a8c5b4f1e7d9a0c369f2',
].join('\n');

/** Units as `infra/systemd` really has them, trimmed to what the checker reads. */
const UNITS: Record<string, string> = {
  'n409-valuation.service':
    '[Service]\nEnvironmentFile=/opt/N409/.env\nEnvironment=NODE_ENV=production\nEnvironment=PORT=3001\n',
  'n409-report.service':
    '[Service]\nEnvironmentFile=/opt/N409/.env\nEnvironment=NODE_ENV=production\nEnvironment=PORT=3004\n',
  'n409-web.service':
    '[Service]\nEnvironmentFile=/opt/N409/.env\nEnvironment=NODE_ENV=production\nEnvironment=PORT=3000\n',
  'n409-ai.service': '[Service]\nEnvironmentFile=/opt/N409/.env\nEnvironment=APP_ENV=production\n',
  'n409-engine-wrapper.service':
    '[Service]\nEnvironmentFile=/opt/N409/.env\nEnvironment=APP_ENV=production\n',
};

interface RunOptions {
  env?: string;
  units?: Record<string, string>;
  mode?: number;
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
    const units = { ...UNITS, 'n409-web.service': '[Service]\nEnvironmentFile=-/opt/N409/.env.local\n' };
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
