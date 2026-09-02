import { afterEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { createLogger, setAlertLineSink } from '../src/logger.js';
import { logFailure } from '../src/failure.js';
import { MetricsRegistry, registerProcessMetrics } from '../src/prometheus.js';

/**
 * The alerting contract, counted where the alerting happens (R376, M11).
 *
 * `failure.ts` declares one contract: `alert: true` means a permanent failure
 * that no retry is coming for and that a person has to act on. Forty-odd sites
 * across the estate raise it — several of them, `readStoredBlob`'s data-loss
 * lines among them, with no other number anywhere — and nothing consumed it.
 * The journal is retention configuration and `GET /metrics` is what an alert
 * rule reads, so the flag reached whoever was already reading the journal and
 * nobody else.
 *
 * These read the count through the real `createLogger` rather than through a
 * hand-built pino, for the reason `loggerCorrelation.test.ts` gives about its
 * own mixin: a logger assembled here would pass whether or not the production
 * factory wires the hook, which is the only thing worth checking.
 */
function loggerWritingTo(lines: string[]) {
  const logger = createLogger({ service: 'test-svc' });
  (logger as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return logger;
}

/** A sink that just counts, standing in for the registry's counter. */
function counting(): { calls: () => number } {
  let n = 0;
  setAlertLineSink(() => {
    n += 1;
  });
  return { calls: () => n };
}

afterEach(() => setAlertLineSink(null));

describe('lines carrying the alerting contract', () => {
  it('are counted, and lines without it are not', () => {
    const lines: string[] = [];
    const log = loggerWritingTo(lines);
    const sink = counting();

    log.error({ alert: true, documentId: 'DOC-1' }, 'stored document could not be decrypted');
    log.error({ err: new Error('transient') }, 'an error nobody has to act on');
    log.warn('a bare string');

    expect(sink.calls()).toBe(1);
    // The field is still on the line: the counter is the detector and the
    // journal is the diagnosis, so nothing about the line may change.
    expect(JSON.parse(lines[0]!).alert).toBe(true);
    expect(JSON.parse(lines[0]!).documentId).toBe('DOC-1');
    expect(lines).toHaveLength(3);
  });

  it('counts what `logFailure` decides, not what a call site remembered', () => {
    // The contract's own classifier is the population. A permanent failure is
    // stamped and counted; a transient one drops to `warn` because the retry is
    // coming, and it must not fire a rule that means "a person must act".
    const lines: string[] = [];
    const log = loggerWritingTo(lines);
    const sink = counting();

    logFailure(log, new Error('column "x" does not exist'), { sweep: 'housekeeping' }, 'sweep step failed');
    expect(sink.calls()).toBe(1);

    const transient = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    logFailure(log, transient, { sweep: 'housekeeping' }, 'sweep step failed');
    expect(sink.calls()).toBe(1);
  });

  it('counts lines written, not lines attempted', () => {
    // `formatters.log` runs after pino's level filter, so a line the level
    // discards is a line nobody could have read — counting it would fire a
    // rule for something that reached no journal.
    const lines: string[] = [];
    const log = createLogger({ service: 'test-svc', level: 'error' });
    (log as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const sink = counting();

    log.debug({ alert: true }, 'below the level');
    expect(sink.calls()).toBe(0);
    expect(lines).toHaveLength(0);

    log.error({ alert: true }, 'at the level');
    expect(sink.calls()).toBe(1);
  });

  it('survives a sink that throws, because a log line must not be lost to one', () => {
    const lines: string[] = [];
    const log = loggerWritingTo(lines);
    setAlertLineSink(() => {
      throw new Error('the counter is broken');
    });

    log.error({ alert: true }, 'a permanent failure');

    expect(JSON.parse(lines[0]!).msg).toBe('a permanent failure');
  });

  it('reaches /metrics as a counter, from the one call every Node service makes', () => {
    const registry = new MetricsRegistry();
    registerProcessMetrics(registry, 'valuation');
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    // Before anything alerts the series is present and zero. An absent series
    // is indistinguishable from a healthy one, which is the failure mode this
    // whole file is about.
    expect(registry.render()).toContain('log_alert_lines_total 0');
    expect(registry.render()).toContain('# TYPE log_alert_lines_total counter');

    log.error({ alert: true }, 'a document this platform can no longer return');
    log.error({ alert: true }, 'a chargeback was lost');
    log.info({ ok: true }, 'ordinary');

    expect(registry.render()).toContain('log_alert_lines_total 2');
  });
});
