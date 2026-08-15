import { describe, expect, it } from 'vitest';
import {
  FLAGS,
  flagEnabled,
  flagOverrides,
  flagProblems,
  flagSnapshot,
  parseFlagValue,
  type FlagSpec,
} from '../src/flags.js';

/**
 * The flags are kill switches for machinery that is already running in
 * production, which makes one property more important than all the parsing
 * below: an environment that says nothing must leave every one of them on.
 * A regression there does not fail loudly — it silently disables the breakers,
 * the retry ladders and the backup verification on the next deploy, which is
 * the outage this system exists to shorten rather than cause.
 */

const env = (overrides: Record<string, string | undefined> = {}) => overrides;

describe('defaults', () => {
  it('leaves every declared flag on when nothing is set', () => {
    // The state of a host nobody has touched, and of a freshly provisioned one.
    for (const spec of Object.values(FLAGS)) {
      expect(flagEnabled(spec, env()), `${spec.env} defaults off`).toBe(true);
    }
  });

  it('declares every shipped mechanism as on-by-default', () => {
    // Stated separately from the loop above so that adding a genuinely dark
    // feature (`default: false`) has to be a deliberate edit to this test
    // rather than something that quietly weakens it.
    expect(FLAGS.circuitBreakers.default).toBe(true);
    expect(FLAGS.retryLadders.default).toBe(true);
    expect(FLAGS.backupVerification.default).toBe(true);
  });

  it('reports no problems for an empty environment', () => {
    expect(flagProblems(env())).toEqual([]);
  });

  it('treats a bare `FLAG_X=` as unset rather than as a bad value', () => {
    // This is the shape `.env.example` ships — every optional setting in that
    // file is a bare `NAME=`, flags included. Calling it a fault would fail the
    // deploy preflight on every host provisioned the documented way, which is
    // to say all of them.
    expect(flagProblems(env({ FLAG_CIRCUIT_BREAKERS: '', FLAG_RETRY_LADDERS: '   ' }))).toEqual([]);
    expect(flagEnabled(FLAGS.circuitBreakers, env({ FLAG_CIRCUIT_BREAKERS: '' }))).toBe(true);
  });

  it('reports no overrides for an empty environment', () => {
    expect(flagOverrides(env())).toEqual([]);
  });
});

describe('parseFlagValue', () => {
  it('reads every accepted spelling of on', () => {
    for (const value of ['1', 'true', 'yes', 'on', 'enabled']) {
      expect(parseFlagValue(value), value).toBe(true);
    }
  });

  it('reads every accepted spelling of off', () => {
    for (const value of ['0', 'false', 'no', 'off', 'disabled']) {
      expect(parseFlagValue(value), value).toBe(false);
    }
  });

  it('ignores case and surrounding whitespace', () => {
    // `.env` files and systemd EnvironmentFile both hand through trailing
    // spaces, and an operator typing FALSE is not making a different request.
    expect(parseFlagValue('  FALSE  ')).toBe(false);
    expect(parseFlagValue('On')).toBe(true);
  });

  it('refuses a value it cannot read rather than guessing', () => {
    // `disable` is the one that matters: it is what somebody types when they
    // mean `disabled`, and guessing "not off, therefore on" would report
    // success while leaving the switch exactly where it was.
    for (const value of ['disable', 'nope', 'maybe', '2', 'null', '-1']) {
      expect(parseFlagValue(value), value).toBeNull();
    }
  });

  it('treats unset and empty as unstated', () => {
    expect(parseFlagValue(undefined)).toBeNull();
    expect(parseFlagValue('')).toBeNull();
    expect(parseFlagValue('   ')).toBeNull();
  });
});

describe('flagEnabled', () => {
  it('honours an explicit off', () => {
    expect(flagEnabled(FLAGS.circuitBreakers, env({ FLAG_CIRCUIT_BREAKERS: 'off' }))).toBe(false);
  });

  it('honours an explicit on', () => {
    expect(flagEnabled(FLAGS.retryLadders, env({ FLAG_RETRY_LADDERS: 'true' }))).toBe(true);
  });

  it('falls back to the default on a value it cannot read', () => {
    // The runtime half of the bargain in the module header: never throw on the
    // request path. `flagProblems` is the half that makes the mistake visible.
    expect(flagEnabled(FLAGS.circuitBreakers, env({ FLAG_CIRCUIT_BREAKERS: 'disable' }))).toBe(true);
  });

  it('reads a flag independently of the others', () => {
    const set = env({ FLAG_RETRY_LADDERS: 'off' });
    expect(flagEnabled(FLAGS.retryLadders, set)).toBe(false);
    expect(flagEnabled(FLAGS.circuitBreakers, set)).toBe(true);
    expect(flagEnabled(FLAGS.backupVerification, set)).toBe(true);
  });

  it('honours a default of false for a flag declared dark', () => {
    // Nothing in the registry is dark today; this pins that the mechanism
    // supports one, so introducing a genuinely new feature does not require
    // rewriting the reader.
    const dark: FlagSpec = { name: 'dark', env: 'FLAG_DARK', default: false, description: 'x' };
    expect(flagEnabled(dark, env())).toBe(false);
    expect(flagEnabled(dark, env({ FLAG_DARK: 'on' }))).toBe(true);
  });
});

describe('flagProblems', () => {
  it('names the variable, the bad value and the accepted ones', () => {
    const problems = flagProblems(env({ FLAG_CIRCUIT_BREAKERS: 'disable' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('FLAG_CIRCUIT_BREAKERS');
    expect(problems[0]).toContain('disable');
    expect(problems[0]).toContain('false');
  });

  it('says what unset would have meant, since that is the fix on offer', () => {
    expect(flagProblems(env({ FLAG_BACKUP_VERIFICATION: '??' }))[0]).toContain('unset means true');
  });

  it('reports each bad flag once and says nothing about the good ones', () => {
    const problems = flagProblems(
      env({ FLAG_CIRCUIT_BREAKERS: 'yep', FLAG_RETRY_LADDERS: 'off', FLAG_BACKUP_VERIFICATION: 'nah' }),
    );
    expect(problems).toHaveLength(2);
    expect(problems.some((p) => p.includes('FLAG_RETRY_LADDERS'))).toBe(false);
  });

  it('passes an environment carrying every flag set correctly', () => {
    expect(
      flagProblems(
        env({ FLAG_CIRCUIT_BREAKERS: 'off', FLAG_RETRY_LADDERS: '0', FLAG_BACKUP_VERIFICATION: 'no' }),
      ),
    ).toEqual([]);
  });
});

describe('flagSnapshot', () => {
  it('reports every declared flag, keyed by its slug', () => {
    const snapshot = flagSnapshot(env({ FLAG_RETRY_LADDERS: 'off' }));
    expect(snapshot).toEqual({
      circuit_breakers: true,
      retry_ladders: false,
      backup_verification: true,
    });
  });

  it('covers the whole registry, so a new flag cannot be invisible at boot', () => {
    expect(Object.keys(flagSnapshot(env()))).toHaveLength(Object.keys(FLAGS).length);
  });
});

describe('flagOverrides', () => {
  it('lists only the flags departing from their default', () => {
    expect(flagOverrides(env({ FLAG_RETRY_LADDERS: 'off' }))).toEqual(['retry_ladders']);
  });

  it('says nothing when a flag is set to the value it already had', () => {
    // Redundant but correct configuration is not a deviation worth alerting on.
    expect(flagOverrides(env({ FLAG_RETRY_LADDERS: 'on' }))).toEqual([]);
  });
});

describe('the registry itself', () => {
  it('gives every flag a distinct name and variable', () => {
    const specs = Object.values(FLAGS);
    expect(new Set(specs.map((s) => s.name)).size).toBe(specs.length);
    expect(new Set(specs.map((s) => s.env)).size).toBe(specs.length);
  });

  it('prefixes every variable with FLAG_, so the set is greppable on a host', () => {
    for (const spec of Object.values(FLAGS)) {
      expect(spec.env, spec.name).toMatch(/^FLAG_[A-Z0-9_]+$/);
    }
  });

  it('describes what turning each one off actually costs', () => {
    // The description is read by whoever is deciding, mid-incident, whether to
    // throw the switch — so an empty or placeholder one is a real defect.
    for (const spec of Object.values(FLAGS)) {
      expect(spec.description.length, spec.name).toBeGreaterThan(40);
      expect(spec.description, spec.name).toContain('Off:');
    }
  });
});
