import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { databaseUnavailableReason } from '../src/failure.js';
import { ApiProblem, registerProblemHandler } from '../src/problem.js';

/**
 * What a caller is told when the database, not the request, is the problem
 * (round 175, methodology M5).
 *
 * Every route in the estate reaches Postgres through a pool with four bounds
 * on it — a statement timeout, an idle-in-transaction timeout, a connection
 * timeout and ten clients — and each bound exists so that a bad minute is
 * survivable rather than fatal. What none of them had was an answer: they all
 * raised past the routes into the generic handler and came back `500
 * urn:n409:problem:internal`, whose catalogued advice is "retry with backoff,
 * and send an `Idempotency-Key`, the write may have landed". For a transaction
 * the database itself rolled back, that is both alarming and false.
 *
 * The two halves asserted here are the classification (which failures count)
 * and the answer (what the client gets). The first is the one worth being
 * strict about: a 503 is a promise that the same request later can succeed,
 * and handing that promise to an unrecognised failure sends clients back at a
 * service whose actual problem is a bug.
 */

/** A `pg` error as the driver builds it: SQLSTATE on `code`, plus `severity`. */
function pgError(code: string, message = 'database says no'): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR' });
}

describe('databaseUnavailableReason', () => {
  it('names the SQLSTATEs the database asks you to retry', () => {
    // The four an operator actually meets: the transaction the database picked
    // to lose, a deadlock, our own statement_timeout, and a failover.
    expect(databaseUnavailableReason(pgError('40001'))).toBe('pg.40001');
    expect(databaseUnavailableReason(pgError('40P01'))).toBe('pg.40P01');
    expect(databaseUnavailableReason(pgError('57014'))).toBe('pg.57014');
    expect(databaseUnavailableReason(pgError('57P01'))).toBe('pg.57P01');
    // The whole 08 class is a link problem, member by member.
    expect(databaseUnavailableReason(pgError('08006'))).toBe('pg.08006');
    expect(databaseUnavailableReason(pgError('08P01'))).toBe('pg.08P01');
    // Saturation. Retrying works; retrying hard is how it stays saturated,
    // which is why the answer carries backoff advice rather than a delay.
    expect(databaseUnavailableReason(pgError('53300'))).toBe('pg.53300');
  });

  it('reads the two pool failures Postgres never saw', () => {
    // `pg-pool` builds both with a bare `new Error(message)` — no `code`, no
    // `severity` — so every structured branch in the classifier misses them,
    // and pool exhaustion is the single likeliest way this service fails under
    // load.
    expect(databaseUnavailableReason(new Error('timeout exceeded when trying to connect'))).toBe(
      'pg.pool_exhausted',
    );
    expect(databaseUnavailableReason(new Error('Cannot use a pool after calling end on the pool'))).toBe(
      'pg.pool_closed',
    );
  });

  it('does not claim a failure it merely suspects', () => {
    // A constraint violation is the request being wrong and must keep its own
    // answer; `23505` is transient in no sense.
    expect(databaseUnavailableReason(pgError('23505'))).toBeNull();
    expect(databaseUnavailableReason(pgError('22P02'))).toBeNull();
    // A syscall name is five uppercase characters, exactly like a SQLSTATE.
    // Reading `EPIPE` as a database code would 503 every dropped socket.
    expect(databaseUnavailableReason(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))).toBeNull();
    // Transient by `classifyFailure`, and deliberately not this: the commonest
    // AbortError in a Fastify handler is the client going away.
    expect(databaseUnavailableReason(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBeNull();
    // An upstream's 503 riding on an error object is `upstream`'s business.
    expect(databaseUnavailableReason(Object.assign(new Error('bad gateway'), { status: 503 }))).toBeNull();
    expect(databaseUnavailableReason(new Error('timeout exceeded'))).toBeNull();
    expect(databaseUnavailableReason(null)).toBeNull();
  });

  it('does not mistake an application error that quotes the pool for the pool', () => {
    // Anchored, not substring-matched.
    expect(
      databaseUnavailableReason(new Error('reported: timeout exceeded when trying to connect (see #4)')),
    ).toBeNull();
    // …and only a plain `Error`, so a subclass carrying its own meaning keeps it.
    class Owned extends Error {
      override name = 'Owned';
    }
    expect(databaseUnavailableReason(new Owned('timeout exceeded when trying to connect'))).toBeNull();
  });
});

describe('the handler answers a busy database with 503, not 500', () => {
  async function appAnswering(err: unknown) {
    const app = Fastify({ logger: false });
    registerProblemHandler(app);
    app.get('/x', async () => {
      throw err;
    });
    const res = await app.inject({ method: 'GET', url: '/x' });
    await app.close();
    return res;
  }

  it('reports a deadlock as service unavailable, and says nothing landed', async () => {
    const res = await appAnswering(pgError('40P01', 'deadlock detected'));
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json();
    expect(body.type).toBe('urn:n409:problem:database-unavailable');
    expect(body.title).toBe('Service Unavailable');
    expect(body.detail).toMatch(/Nothing was changed/);
    // The driver's own wording never reaches the client — the message here
    // would be `deadlock detected`, and pg puts the offending values on
    // `err.detail`.
    expect(JSON.stringify(body)).not.toContain('deadlock detected');
  });

  it('answers the same for an exhausted pool', async () => {
    const res = await appAnswering(new Error('timeout exceeded when trying to connect'));
    expect(res.statusCode).toBe(503);
    expect(res.json().type).toBe('urn:n409:problem:database-unavailable');
  });

  it('leaves an ordinary failure as the 500 it was', async () => {
    const res = await appAnswering(pgError('23505', 'duplicate key value violates unique constraint'));
    expect(res.statusCode).toBe(500);
    expect(res.json().type).toBe('urn:n409:problem:internal');
    expect(res.json().detail).toBeUndefined();
  });

  it('does not overrule a route that already answered', async () => {
    // A route catching its own `40001` and saying something better keeps
    // saying it: the mapping runs after the `ApiProblem` branch, not before.
    const res = await appAnswering(
      new ApiProblem({
        status: 409,
        title: 'Conflict',
        type: 'urn:n409:problem:conflict',
        detail: 'Someone else changed this engagement.',
      }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toBe('urn:n409:problem:conflict');
  });

  it('does not overrule a 4xx fastify raised', async () => {
    // A validation failure carries `statusCode` and no SQLSTATE; it must not
    // be swept into the database branch by the new ordering.
    const res = await appAnswering(Object.assign(new Error('body must be object'), { statusCode: 400 }));
    expect(res.statusCode).toBe(400);
    expect(res.json().type).toBe('urn:n409:problem:bad-request');
  });
});
