import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `createLogger` was the untested half of logger.ts: logger.test.ts proves that
 * REDACT_PATHS redacts, under a pino instance it builds itself, but nothing
 * checked that `createLogger` hands those paths to pino at all. That gap is
 * exactly the shape of a silent PII leak — the redaction list stays correct and
 * fully tested while the factory every service actually calls stops applying
 * it, and the suite goes green.
 *
 * pino is mocked because the real one writes to fd 1 through SonicBoom, which
 * neither a process.stdout spy nor vitest's console capture can see. What is
 * worth asserting is the configuration, and this is where it becomes visible.
 */

const pinoCalls: Array<Record<string, unknown>> = [];
const isoTime = () => ',"time":"iso"';

vi.mock('pino', () => {
  const pino = (opts: Record<string, unknown>) => {
    pinoCalls.push(opts);
    return { fake: true };
  };
  pino.stdTimeFunctions = { isoTime };
  return { pino };
});

const { createLogger, REDACT_PATHS } = await import('../src/logger.js');

/** The options `createLogger` handed pino on its most recent call. */
function lastOptions(): {
  name: string;
  level: string;
  redact: { paths: string[]; censor: string };
  formatters: { level: (label: string) => Record<string, unknown> };
  base: Record<string, unknown>;
  timestamp: unknown;
} {
  return pinoCalls.at(-1) as never;
}

describe('createLogger', () => {
  let savedLevel: string | undefined;

  beforeEach(() => {
    savedLevel = process.env.LOG_LEVEL;
    delete process.env.LOG_LEVEL;
    pinoCalls.length = 0;
  });
  afterEach(() => {
    if (savedLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = savedLevel;
  });

  it('applies the full redaction list, censored the same way', () => {
    createLogger({ service: 'valuation' });
    expect(lastOptions().redact.paths).toEqual(REDACT_PATHS);
    expect(lastOptions().redact.censor).toBe('[REDACTED]');
  });

  it('appends caller-supplied paths without dropping the defaults', () => {
    createLogger({ service: 'report', redact: ['engine.api_key', '*.ssn'] });
    const { paths } = lastOptions().redact;
    // Both halves, and the defaults still first — a caller cannot shorten the
    // list by passing one of its own.
    expect(paths).toEqual([...REDACT_PATHS, 'engine.api_key', '*.ssn']);
    expect(paths).toContain('password');
    expect(paths).toContain('cap_table');
  });

  it('names the logger and stamps every line with the service', () => {
    createLogger({ service: 'ai' });
    expect(lastOptions().name).toBe('ai');
    expect(lastOptions().base).toEqual({ service: 'ai' });
  });

  describe('level resolution', () => {
    it('defaults to info', () => {
      createLogger({ service: 'valuation' });
      expect(lastOptions().level).toBe('info');
    });

    it('takes LOG_LEVEL when the caller does not name one', () => {
      process.env.LOG_LEVEL = 'debug';
      createLogger({ service: 'valuation' });
      expect(lastOptions().level).toBe('debug');
    });

    it('lets an explicit level win over the environment', () => {
      process.env.LOG_LEVEL = 'debug';
      createLogger({ service: 'valuation', level: 'warn' });
      expect(lastOptions().level).toBe('warn');
    });
  });

  it('emits the level as a label, not pino’s numeric default', () => {
    createLogger({ service: 'valuation' });
    // Log aggregators filter on `level:"error"`; the raw 50 does not match.
    expect(lastOptions().formatters.level('error')).toEqual({ level: 'error' });
    expect(lastOptions().formatters.level('info')).toEqual({ level: 'info' });
  });

  it('timestamps in ISO 8601 rather than epoch millis', () => {
    createLogger({ service: 'valuation' });
    expect(lastOptions().timestamp).toBe(isoTime);
  });
});
