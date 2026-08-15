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
