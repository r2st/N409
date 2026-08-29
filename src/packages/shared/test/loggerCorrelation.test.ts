import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { createLogger } from '../src/logger.js';
import {
  bindActor,
  bindRequestId,
  currentActor,
  runWithRequestId,
  runWithSweep,
} from '../src/requestContext.js';

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

describe('the actor on a log line', () => {
  it('is on a line written by something that was never told about the request', () => {
    // The gap. `requestErrorContext` has put an actor on the *unhandled error*
    // line since the B-1 audit, and there are forty-odd `log.warn({ err }, …)`
    // sites reporting failures that never become one. For those, "which
    // customer" had no answer anywhere: the id was on the request and on
    // nothing the request wrote.
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    runWithRequestId('REQ-A1', () => {
      bindActor({ userId: 'USR-1', partnerId: 'PTR-1' });
      log.warn('a webhook would not sign');
    });

    const entry = JSON.parse(lines.at(-1)!);
    expect(entry.requestId).toBe('REQ-A1');
    expect(entry.userId).toBe('USR-1');
    expect(entry.partnerId).toBe('PTR-1');
  });

  it('follows work that outlives the response, like the request id does', async () => {
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    await runWithRequestId('REQ-A2', async () => {
      bindActor({ userId: 'USR-2' });
      await new Promise((r) => setTimeout(r, 5));
      log.warn('a diagnostic write that failed after the 200');
    });

    const entry = JSON.parse(lines.at(-1)!);
    expect(entry.userId).toBe('USR-2');
  });

  it('reaches a line logged through a child logger, which is what req.log is', () => {
    // Every route logs through `req.log`, a child. A mixin that only showed up
    // on `app.log` would miss the sites this exists for.
    const lines: string[] = [];
    const log = loggerWritingTo(lines);
    const requestLogger = log.child({ reqId: 'REQ-A3' });

    runWithRequestId('REQ-A3', () => {
      bindActor({ userId: 'USR-3' });
      requestLogger.warn('upload would not scan');
    });

    expect(JSON.parse(lines.at(-1)!).userId).toBe('USR-3');
  });

  it('is omitted before the request authenticates, not emitted empty', () => {
    // The routing, the 401s and the rate-limit refusals are all written before
    // `authenticate` has resolved anybody. "No userId" has to keep meaning
    // "nobody was authenticated".
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    runWithRequestId('REQ-A4', () => log.info('before the preHandler'));

    const entry = JSON.parse(lines.at(-1)!);
    expect(entry.requestId).toBe('REQ-A4');
    expect(entry).not.toHaveProperty('userId');
    expect(entry).not.toHaveProperty('partnerId');
    expect(entry).not.toHaveProperty('apiTokenId');
  });

  it('omits partnerId and apiTokenId for a session user with neither', () => {
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    runWithRequestId('REQ-A5', () => {
      bindActor({ userId: 'USR-5', partnerId: null, apiTokenId: null });
      log.info('a plain session');
    });

    const entry = JSON.parse(lines.at(-1)!);
    expect(entry.userId).toBe('USR-5');
    expect(entry).not.toHaveProperty('partnerId');
    expect(entry).not.toHaveProperty('apiTokenId');
  });

  it('separates an integration from a human session', () => {
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    runWithRequestId('REQ-A6', () => {
      bindActor({ userId: 'USR-6', partnerId: 'PTR-6', apiTokenId: 'TOK-6' });
      log.warn('partner call failed');
    });

    expect(JSON.parse(lines.at(-1)!).apiTokenId).toBe('TOK-6');
  });

  it('does not leak one request actor into the next', () => {
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    runWithRequestId('REQ-A7', () => {
      bindActor({ userId: 'USR-7' });
      log.info('a');
    });
    runWithRequestId('REQ-A8', () => log.info('b'));
    log.info('none');

    const entries = lines.slice(-3).map((l) => JSON.parse(l));
    expect(entries[0]!.userId).toBe('USR-7');
    expect(entries[1]!).not.toHaveProperty('userId');
    expect(entries[2]!).not.toHaveProperty('userId');
  });

  it('is bound on the store the request already holds, not on a fresh one', () => {
    // The mechanism the whole thing rests on. `bindActor` runs in the
    // `authenticate` preHandler, long after `bindRequestId` put the store in
    // place at `onRequest`, and the consumers that matter most read through the
    // reference taken from that first store. Re-binding would strand them.
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    runWithRequestId('REQ-A9', () => {
      const before = currentActor();
      bindActor({ userId: 'USR-9' });
      expect(before).toBeUndefined();
      expect(currentActor()).toEqual({ userId: 'USR-9' });
      log.info('same store');
    });

    expect(JSON.parse(lines.at(-1)!).requestId).toBe('REQ-A9');
  });

  it('does nothing outside a request rather than inventing a context', () => {
    // A background sweep has no actor. Minting a store here would make
    // `currentRequestId` start answering for lines that had no request.
    expect(() => bindActor({ userId: 'USR-X' })).not.toThrow();
    expect(currentActor()).toBeUndefined();
  });

  it('does not collide with the nested actor block the 5xx line carries', () => {
    // problem.ts logs `actor: { user_id, roles, … }` on an unhandled error.
    // These three keys are flat and camelCase precisely so a mixin key and a
    // log-call key can never be the same key — the `reqId` trap, one field
    // over. Asserted on raw text, because JSON.parse hides a duplicate.
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    runWithRequestId('REQ-A10', () => {
      bindActor({ userId: 'USR-10' });
      log.error({ actor: { user_id: 'USR-10', roles: ['analyst'] } }, 'unhandled error');
    });

    const raw = lines.at(-1)!;
    expect(raw.match(/"actor"/g)).toHaveLength(1);
    expect(raw.match(/"userId"/g)).toHaveLength(1);
    const entry = JSON.parse(raw);
    expect(entry.userId).toBe('USR-10');
    expect(entry.actor.user_id).toBe('USR-10');
  });

  it('carries no field that names the person behind the id', () => {
    // RequestActor is ids only, on purpose: email, first_name and company are
    // all on the redact list, and a mixin is a door into every line in the
    // process. This is the guard on that door.
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    runWithRequestId('REQ-A11', () => {
      bindActor({ userId: 'USR-11', partnerId: 'PTR-11', apiTokenId: 'TOK-11' });
      log.info('a line');
    });

    const entry = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    const values = Object.values(entry).map(String);
    expect(values.some((v) => v.includes('@'))).toBe(false);
    expect(Object.keys(entry).sort()).toEqual(
      ['apiTokenId', 'level', 'msg', 'name', 'partnerId', 'requestId', 'service', 'time', 'userId'].sort(),
    );
  });
});

/**
 * The background tier's half of the same problem.
 *
 * `requestId` is correctly absent from a sweep tick — nothing asked for it —
 * and until R206 nothing else was present either. Twelve sweeps share the
 * valuation process and its logger, so their interior lines interleaved with no
 * field to tell them apart, and three of the tick bodies are also reachable
 * from an ops route, so "schedule or person" had no answer on the line itself.
 */
describe('the sweep on a log line', () => {
  it('names the tick on a line written deep inside it', async () => {
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    await runWithSweep({ name: 'email-retry', runId: 'RUN-1' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      log.warn({ emailId: 'EML-1' }, 'email retry failed');
    });

    const entry = JSON.parse(lines.at(-1)!);
    expect(entry.sweep).toBe('email-retry');
    expect(entry.sweepRun).toBe('RUN-1');
    expect(entry.emailId).toBe('EML-1');
  });

  it('is omitted outside a tick, so the absence still means something', () => {
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    log.info('a boot line');

    const entry = JSON.parse(lines.at(-1)!);
    expect(entry).not.toHaveProperty('sweep');
    expect(entry).not.toHaveProperty('sweepRun');
  });

  it('ends with the tick rather than leaking onto the next one', async () => {
    // `runWithSweep` uses `run` rather than `enterWith` for exactly this: the
    // scheduler's async context goes on to do other things.
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    await runWithSweep({ name: 'retention', runId: 'RUN-2' }, async () => {});
    log.info('after the tick');

    expect(JSON.parse(lines.at(-1)!)).not.toHaveProperty('sweep');
  });

  it('keeps the request id when a route triggered the run', async () => {
    // The ops-triggered path: both facts are true and the join wants each.
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    await runWithRequestId('REQ-S1', async () => {
      bindActor({ userId: 'USR-S1' });
      await runWithSweep({ name: 'auto-email', runId: 'RUN-3' }, async () => {
        log.info('queued');
      });
    });

    const entry = JSON.parse(lines.at(-1)!);
    expect(entry.requestId).toBe('REQ-S1');
    expect(entry.userId).toBe('USR-S1');
    expect(entry.sweep).toBe('auto-email');
  });

  it('does not duplicate the key a log call passes itself', () => {
    // `sweepFailed` stamps `{ sweep }` on the failure line. Pino's default
    // mixin merge is `Object.assign(mixin, obj)`, so the call wins and there is
    // one key — asserted on the raw text, which is the only place a duplicate
    // is visible.
    const lines: string[] = [];
    const log = loggerWritingTo(lines);

    runWithSweep({ name: 'housekeeping', runId: 'RUN-4' }, () => {
      log.error({ sweep: 'housekeeping' }, 'housekeeping sweep failed');
    });

    const raw = lines.at(-1)!;
    expect(raw.match(/"sweep"/g)).toHaveLength(1);
    expect(JSON.parse(raw).sweep).toBe('housekeeping');
  });
});
