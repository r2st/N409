// The classifier is a table, so it is tested as one: every rule that says
// "retry this" gets a case, and so does every rule that says "do not".
//
// The cases that matter most are the ones where two namespaces collide on the
// same field — `EPIPE` is both a plausible SQLSTATE shape and a syscall name —
// because a misclassification there is silent and confident.
import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  classifyFailure,
  classifyStatus,
  isTransient,
  logFailure,
  logUnretried,
  markFailure,
} from '../src/failure.js';

/** A pg DatabaseError as it actually arrives: SQLSTATE on `code`, plus severity. */
function pgError(code: string, message = 'db said no'): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR', routine: 'exec_simple_query' });
}

/** A Node syscall error: an errno name on `code`, and no `severity`. */
function syscallError(code: string): Error {
  return Object.assign(new Error(`connect ${code} 10.0.0.1:5432`), { code, errno: -61 });
}

describe('classifyFailure — Postgres', () => {
  it('retries the codes the database asks you to retry', () => {
    for (const code of ['40001', '40P01', '57P01', '57014', '53300', '08006', '08001', '08P01']) {
      expect(classifyFailure(pgError(code)), code).toMatchObject({ kind: 'transient', reason: `pg.${code}` });
    }
  });

  it('does not retry a constraint violation or a syntax error', () => {
    for (const code of ['23505', '23503', '42P01', '42601', '22P02']) {
      expect(classifyFailure(pgError(code)), code).toMatchObject({ kind: 'permanent' });
    }
  });

  it('treats the whole 08 connection class as transient, including codes not listed individually', () => {
    // The point of the class rule: a code nobody enumerated still classifies
    // correctly because every member of `08` is a link problem.
    expect(classifyFailure(pgError('08999'))).toMatchObject({ kind: 'transient', reason: 'pg.08999' });
  });
});

describe('classifyFailure — the SQLSTATE/errno collision', () => {
  // EPIPE and EBUSY are five characters of [A-Z], which is the shape of a
  // SQLSTATE. Read as one, they are unrecognised, and an unrecognised SQLSTATE
  // is permanent — so a broken pipe would silently stop being retried.
  it('reads five-letter errno names as syscalls, not as unknown SQLSTATEs', () => {
    for (const code of ['EPIPE', 'EBUSY']) {
      expect(classifyFailure(syscallError(code)), code).toMatchObject({
        kind: 'transient',
        reason: `syscall.${code}`,
      });
    }
  });

  it('still reads a genuine pg error carrying `severity` as a SQLSTATE', () => {
    expect(classifyFailure(pgError('XX000'))).toMatchObject({ kind: 'transient', reason: 'pg.XX000' });
  });

  it('reads a digit-leading five-character code as a SQLSTATE even without severity', () => {
    // A pg error that lost its severity in transit — through a serializer, say —
    // is still recognisable, because no errno name starts with a digit.
    expect(classifyFailure(Object.assign(new Error('x'), { code: '40001' }))).toMatchObject({
      kind: 'transient',
    });
  });
});

describe('classifyFailure — network', () => {
  it('retries the link failures', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'EAI_AGAIN']) {
      expect(classifyFailure(syscallError(code)), code).toMatchObject({ kind: 'transient' });
    }
  });

  it('does not retry ENOTFOUND — a name that does not resolve is a config fault', () => {
    // The distinction from EAI_AGAIN above is the whole reason both are listed.
    expect(classifyFailure(syscallError('ENOTFOUND'))).toMatchObject({
      kind: 'permanent',
      reason: 'syscall.ENOTFOUND',
    });
  });

  it('does not retry an expired certificate', () => {
    expect(classifyFailure(syscallError('CERT_HAS_EXPIRED'))).toMatchObject({ kind: 'permanent' });
  });

  it('unwraps the `cause` that fetch() hides the real failure behind', () => {
    // Without this, every network failure in the Node services classifies
    // `unclassified` — fetch reports `TypeError: fetch failed` and puts the
    // syscall error on `cause`.
    const wrapped = Object.assign(new TypeError('fetch failed'), {
      cause: syscallError('ECONNREFUSED'),
    });
    expect(classifyFailure(wrapped)).toMatchObject({
      kind: 'transient',
      reason: 'syscall.ECONNREFUSED',
    });
  });

  it('does not loop forever on an error that is its own cause', () => {
    const self: Error & { cause?: unknown } = new Error('recursive');
    self.cause = self;
    expect(classifyFailure(self)).toMatchObject({ kind: 'permanent', reason: 'unclassified' });
  });

  it('treats an abort/timeout as a transient condition', () => {
    const timeout = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
    expect(classifyFailure(timeout)).toMatchObject({ kind: 'transient', reason: 'abort.TimeoutError' });
  });
});

describe('classifyStatus', () => {
  it('retries the statuses that mean "not now"', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(classifyStatus(status), String(status)).toMatchObject({ kind: 'transient' });
    }
  });

  it('does not retry a rejection of the request itself', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyStatus(status), String(status)).toMatchObject({ kind: 'permanent' });
    }
  });

  it('does not retry 501/505 despite them being 5xx', () => {
    // "I will never do this" is a permanent answer whichever range it is in.
    expect(classifyStatus(501)).toMatchObject({ kind: 'permanent' });
    expect(classifyStatus(505)).toMatchObject({ kind: 'permanent' });
  });

  it('reads a status carried on the error object', () => {
    expect(classifyFailure(Object.assign(new Error('nope'), { status: 503 }))).toMatchObject({
      kind: 'transient',
    });
    expect(classifyFailure(Object.assign(new Error('nope'), { statusCode: 404 }))).toMatchObject({
      kind: 'permanent',
    });
  });
});

describe('classifyFailure — defaults and overrides', () => {
  it('defaults to permanent, so an unrecognised failure is not retried', () => {
    // The load-bearing default. A retry against an unknown failure is how one
    // broken dependency becomes an outage.
    expect(classifyFailure(new Error('something nobody predicted'))).toMatchObject({
      kind: 'permanent',
      reason: 'unclassified',
    });
    expect(classifyFailure(null)).toMatchObject({ kind: 'permanent' });
    expect(classifyFailure('a string')).toMatchObject({ kind: 'permanent' });
  });

  it('honours an explicit mark ahead of every table', () => {
    // Marked transient despite being a constraint violation, which the pg table
    // would otherwise call permanent.
    expect(classifyFailure(markFailure(pgError('23505'), 'transient'))).toMatchObject({
      kind: 'transient',
      reason: 'marked',
    });
    expect(classifyFailure(markFailure(syscallError('ECONNREFUSED'), 'permanent'))).toMatchObject({
      kind: 'permanent',
    });
  });

  it('isTransient agrees with classifyFailure', () => {
    expect(isTransient(syscallError('ECONNREFUSED'))).toBe(true);
    expect(isTransient(pgError('23505'))).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  it('doubles, with jitter disabled', () => {
    const delays = [0, 1, 2, 3].map((n) => backoffDelayMs(n, { baseMs: 100, jitter: 0 }));
    expect(delays).toEqual([100, 200, 400, 800]);
  });

  it('holds at the ceiling', () => {
    expect(backoffDelayMs(20, { baseMs: 100, maxMs: 5_000, jitter: 0 })).toBe(5_000);
  });

  it('spreads full jitter over [0, exponential]', () => {
    // The whole point: N callers who failed against one outage must not come
    // back at the same instant.
    expect(backoffDelayMs(0, { baseMs: 1_000, jitter: 1, random: () => 0 })).toBe(0);
    expect(backoffDelayMs(0, { baseMs: 1_000, jitter: 1, random: () => 1 })).toBe(1_000);
    expect(backoffDelayMs(0, { baseMs: 1_000, jitter: 1, random: () => 0.5 })).toBe(500);
  });

  it('never returns a negative delay for a negative attempt', () => {
    expect(backoffDelayMs(-5, { baseMs: 100, jitter: 0 })).toBe(100);
  });
});

describe('logFailure', () => {
  function recorder() {
    const warns: Record<string, unknown>[] = [];
    const errors: Record<string, unknown>[] = [];
    return {
      warns,
      errors,
      log: {
        warn: (obj: Record<string, unknown>) => void warns.push(obj),
        error: (obj: Record<string, unknown>) => void errors.push(obj),
      },
    };
  }

  it('warns on a transient failure and does not raise an alert', () => {
    const { log, warns, errors } = recorder();
    logFailure(log, syscallError('ECONNREFUSED'), { where: 'ai' }, 'call failed');
    expect(errors).toHaveLength(0);
    expect(warns[0]).toMatchObject({ where: 'ai', failure_kind: 'transient' });
    expect(warns[0]!.alert).toBeUndefined();
  });

  it('errors on a permanent failure and flags it for alerting', () => {
    // The asymmetry is the contract with whatever scrapes the log: a permanent
    // failure is not going to fix itself and no retry is coming.
    const { log, errors } = recorder();
    logFailure(log, pgError('23505'), { where: 'db' }, 'call failed');
    expect(errors[0]).toMatchObject({ failure_kind: 'permanent', alert: true });
  });

  /**
   * The case `logFailure` gets wrong by construction, and the reason
   * `logUnretried` exists: a transient error on work nothing revisits.
   *
   * `warn` in this codebase promises that a retry is coming. A dropped
   * post-commit announcement has no retry — the row is committed, the webhook
   * was answered 2xx — so the transience of the cause says nothing about the
   * durability of the consequence.
   */
  it('logUnretried errors and alerts even when the error itself is transient', () => {
    const { log, warns, errors } = recorder();
    const failure = logUnretried(
      log,
      syscallError('ECONNREFUSED'),
      { valuationId: 'v1' },
      'notification lost',
    );
    expect(warns).toHaveLength(0);
    expect(errors[0]).toMatchObject({
      valuationId: 'v1',
      failure_kind: 'transient',
      failure_reason: 'syscall.ECONNREFUSED',
      retried: false,
      alert: true,
    });
    // The classification is still returned and still logged: *why* it was lost
    // is the next thing a person needs.
    expect(failure.kind).toBe('transient');
  });
});
