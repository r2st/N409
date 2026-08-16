import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { createLogger } from '../src/logger.js';
import { bindRequestId, runWithRequestId } from '../src/requestContext.js';

/**
 * A log line you can join to a request.
 *
 * The id existed at both ends and in the middle: the Python tier binds
 * `x-request-id` to a context var, `requestContext.ts` binds it to an
 * AsyncLocalStorage at `onRequest` so the internal client forwards it, and
 * Fastify binds `reqId` onto `req.log`. What was missing was everything logged
 * through anything *other* than `req.log` — `app.log` inside a route, a
 * module-level logger, a hook, and the work this service deliberately does not
 * await, which outlives the response entirely.
 *
 * That last group is the one that matters. A pipeline step or a diagnostic
 * write that fails after the 200 has gone out is precisely what an incident is
 * reconstructed from, and it had nothing to join on — the request it belonged
 * to had already finished and taken its logger with it.
 *
 * Lines are read back as parsed JSON rather than as text, because the property
 * is that an aggregator can read the field, and a duplicate key is a thing text
 * matching cannot see.
 */
/**
 * A real `createLogger` with its destination swapped for one we can read.
 *
 * The logger under test is built by `createLogger` itself rather than by
 * reassembling its options here. That distinction is the whole point: a
 * hand-built pino with a mixin would pass these tests whether or not the
 * production factory wires one, which is the only thing they exist to check.
 * `streamSym` is pino's own handle on the destination, so swapping it leaves
 * every other part of the configuration — redaction, serializers, the mixin —
 * exactly as production has it.
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

describe('the correlation id on a log line', () => {
  it('is present on a logger that was never told about the request', async () => {
    // The gap this closes: `app.log`, not `req.log`. Nothing here is a child of
    // anything request-shaped, and the id still arrives.
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    runWithRequestId('REQ-1', () => {
      log.info('inside a request');
    });

    const entry = JSON.parse(lines.at(-1)!);
    expect(entry.requestId).toBe('REQ-1');
    expect(entry.msg).toBe('inside a request');
  });

  it('follows work that outlives the response', async () => {
    // The deliberately-unawaited writes. The request has returned; the async
    // context has not gone away, so the line is still joinable.
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    await runWithRequestId('REQ-2', async () => {
      await new Promise((r) => setTimeout(r, 5));
      log.warn('after the response');
    });

    expect(JSON.parse(lines.at(-1)!).requestId).toBe('REQ-2');
  });

  it('is omitted outside a request rather than emitted empty', async () => {
    // A cron tick and a boot line have no request, and "no requestId" has to
    // keep meaning "not caused by one" rather than "caused by one we lost".
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    log.info('a background sweep');

    const entry = JSON.parse(lines.at(-1)!);
    expect(entry).not.toHaveProperty('requestId');
  });

  it('does not leak one request id into the next', async () => {
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    runWithRequestId('REQ-A', () => log.info('a'));
    runWithRequestId('REQ-B', () => log.info('b'));
    log.info('none');

    const entries = lines.slice(-3).map((l) => JSON.parse(l));
    expect(entries[0]!.requestId).toBe('REQ-A');
    expect(entries[1]!.requestId).toBe('REQ-B');
    expect(entries[2]!).not.toHaveProperty('requestId');
  });

  it('does not collide with the reqId Fastify binds', async () => {
    // Pino merges a mixin's keys alongside a child's bindings rather than
    // letting one win, so a mixin emitting `reqId` would put two `reqId` fields
    // in one JSON object and leave "which request" to the parser's
    // duplicate-key rule. Asserted on the raw text, because JSON.parse is
    // exactly the step that hides it.
    const lines: string[] = [];
    const log = loggerWritingTo(lines);
    const requestLogger = log.child({ reqId: 'REQ-3' });

    runWithRequestId('REQ-3', () => requestLogger.info('handler line'));

    const raw = lines.at(-1)!;
    expect(raw.match(/"reqId"/g)).toHaveLength(1);
    expect(raw.match(/"requestId"/g)).toHaveLength(1);
    // Both name the same request, because the hook binds the mixin from req.id.
    const entry = JSON.parse(raw);
    expect(entry.reqId).toBe('REQ-3');
    expect(entry.requestId).toBe('REQ-3');
  });

  it('survives the redaction and serialization the logger already applies', async () => {
    // The mixin is one more thing merged into the object pino redacts. A
    // correlated line that lost its scrubbing would be a bad trade.
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    runWithRequestId('REQ-4', () => log.info({ access_token: 'secret-value' }, 'with a secret'));

    const entry = JSON.parse(lines.at(-1)!);
    expect(entry.requestId).toBe('REQ-4');
    expect(entry.access_token).toBe('[REDACTED]');
  });

  it('is bound by bindRequestId too, which is what the Fastify hook uses', async () => {
    // `runWithRequestId` wraps; the hook cannot wrap, so it calls
    // `enterWith` through `bindRequestId`. Both have to reach the mixin.
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    await runWithRequestId('OUTER', async () => {
      bindRequestId('REQ-5');
      log.info('bound by the hook');
    });

    expect(JSON.parse(lines.at(-1)!).requestId).toBe('REQ-5');
  });
});
