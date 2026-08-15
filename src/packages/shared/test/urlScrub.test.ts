import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { pino } from 'pino';
import { createLogger, REDACT_PATHS, serializeError, serializeRequest } from '../src/logger.js';
import { SENSITIVE_QUERY_PARAMS, scrubUrl } from '../src/problem.js';

/**
 * Credentials in the query string, and the request log line that wrote them.
 *
 * The redact list covers object properties. A query string is not one — it is a
 * substring of the single string `req.url` — so `token` being on the list did
 * nothing for `?token=…`, while looking exactly like it did.
 */

describe('scrubUrl', () => {
  it('blanks the one-click unsubscribe token, which has no credential shape', () => {
    // `<base64url>.<base64url>` — two segments, so the three-segment JWT rule
    // in scrubSensitive does not match it and never did.
    // The signature half is spelled `test-secret-…` so the repo's own secret
    // scanner reads this fixture as one; the shape that matters to the test is
    // the two base64url segments either side of the dot.
    const token = 'eyJ1IjoiMDFIWFkiLCJzIjoibWFya2V0aW5nIiwiZSI6MTh9.test-secret-signature';
    const out = scrubUrl(`/api/v1/unsubscribe?token=${token}`);
    expect(out).toBe('/api/v1/unsubscribe?token=[REDACTED]');
    expect(out).not.toContain('test-secret-signature');
  });

  it('blanks the OAuth authorization code on the callback routes', () => {
    // Exchangeable for an access token until it is spent. Opaque and
    // provider-chosen, so no value-shape rule can find it.
    const out = scrubUrl('/api/v1/accounting/callback?code=4%2F0AeanS0bQvXm9&realmId=193514');
    expect(out).toContain('code=[REDACTED]');
    expect(out).not.toContain('AeanS0bQvXm9');
    // The non-credential parameter next to it survives, or the line stops being
    // worth writing.
    expect(out).toContain('realmId=193514');
  });

  it('keeps the free-text search parameter, and scrubs an address typed into it', () => {
    // `q` is the most useful parameter to still have when a search 500s. What
    // makes it sensitive is a value shape, which is scrubSensitive's job.
    const out = scrubUrl('/api/v1/valuations?q=ada%40example.com&page=2');
    expect(out).toContain('q=[REDACTED-EMAIL]');
    expect(out).toContain('page=2');
  });

  it('scrubs the path too, not only the query', () => {
    expect(scrubUrl('/api/v1/users/ada%40example.com')).toBe('/api/v1/users/[REDACTED-EMAIL]');
  });

  it('decides per raw pair, so an encoded separator cannot move a later parameter', () => {
    // Decoding the URL whole and then splitting would turn this `%26` into a
    // separator, re-parsing the string into parameters the client never sent.
    // What must not happen is that shifting the boundaries walks the real
    // credential out from under a name on the list.
    const out = scrubUrl('/x?q=harmless%26token%3Dnot-a-real-one&token=THE_LIVE_ONE');
    expect(out).not.toContain('THE_LIVE_ONE');
    expect(out).toContain('token=[REDACTED]');
    // The search text itself is the client's own, and survives as they typed it.
    expect(out).toContain('q=harmless&token=not-a-real-one');
  });

  it('matches a percent-encoded parameter name', () => {
    expect(scrubUrl('/x?to%6Ben=live')).toBe('/x?token=[REDACTED]');
  });

  it('matches the name case-insensitively', () => {
    expect(scrubUrl('/x?Token=live&CODE=live')).toBe('/x?Token=[REDACTED]&CODE=[REDACTED]');
  });

  it('blanks every occurrence of a repeated parameter', () => {
    expect(scrubUrl('/x?token=one&token=two')).toBe('/x?token=[REDACTED]&token=[REDACTED]');
  });

  it('leaves a URL with no query string alone', () => {
    expect(scrubUrl('/api/v1/valuations')).toBe('/api/v1/valuations');
  });

  it('survives a valueless parameter and a malformed escape', () => {
    expect(scrubUrl('/x?flag&token=live')).toBe('/x?flag&token=[REDACTED]');
    // `%zz` is not a valid escape; decodeURIComponent throws on it and the
    // string is kept as the client sent it rather than losing the line.
    expect(scrubUrl('/x?q=%zz&token=live')).toContain('token=[REDACTED]');
  });

  it('covers the OAuth state, whose JWT shape is a coincidence and not a guarantee', () => {
    // It is a JWT today, so scrubSensitive would also catch it. The name is on
    // the list so that coverage does not depend on another module keeping a
    // format it never promised — which is exactly what unsubscribeToken did not.
    expect(scrubUrl('/api/v1/hris/callback?state=not-a-jwt-anymore')).toBe(
      '/api/v1/hris/callback?state=[REDACTED]',
    );
  });

  it('names the parameters that actually appear on this API', () => {
    // A drift guard: these are the ones the routes carry today, and dropping any
    // of them silently reopens the leak.
    for (const name of ['token', 'code', 'state', 'password', 'api_key', 'access_token']) {
      expect(SENSITIVE_QUERY_PARAMS).toContain(name);
    }
    // `q` must stay off the list — see scrubUrl's note.
    expect(SENSITIVE_QUERY_PARAMS).not.toContain('q');
  });
});

describe('serializeRequest', () => {
  it('reproduces every field fastify serializes, not only the url', () => {
    // A serializer on the instance replaces fastify's rather than wrapping it,
    // so anything omitted here is silently gone from every request line.
    const out = serializeRequest({
      method: 'GET',
      url: '/x?token=live',
      host: 'app.example.com',
      ip: '203.0.113.9',
      headers: { 'accept-version': '1.0.0' },
      socket: { remotePort: 44321 },
    });
    expect(out).toEqual({
      method: 'GET',
      url: '/x?token=[REDACTED]',
      version: '1.0.0',
      host: 'app.example.com',
      remoteAddress: '203.0.113.9',
      remotePort: 44321,
    });
  });

  it('tolerates a request with no url, headers or socket', () => {
    const out = serializeRequest({ method: 'GET' });
    expect(out.method).toBe('GET');
    expect(out.url).toBeUndefined();
    expect(out.remotePort).toBeUndefined();
  });
});

describe('serializeError', () => {
  /** A `pg` unique violation, shaped as the driver delivers it. */
  function uniqueViolation() {
    return Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      // Postgres puts the offending row values here. On `users_email_key` that
      // is the address of the person who just tried to sign up.
      detail: 'Key (email)=(jane@example.com) already exists.',
      constraint: 'users_email_key',
      table: 'users',
    });
  }

  it('scrubs the address Postgres puts in `detail`', () => {
    const out = serializeError(uniqueViolation()) as Record<string, unknown>;
    expect(out.detail).toBe('Key (email)=([REDACTED-EMAIL]) already exists.');
    expect(JSON.stringify(out)).not.toContain('jane@example.com');
  });

  it('keeps the fields that make a 23505 diagnosable', () => {
    // The reason scrubError is not simply reused here: it returns only
    // name/message/stack, and which index fired is the whole point of the line.
    const out = serializeError(uniqueViolation()) as Record<string, unknown>;
    expect(out.code).toBe('23505');
    expect(out.constraint).toBe('users_email_key');
    expect(out.table).toBe('users');
  });

  it('scrubs a DSN out of the message and the stack together', () => {
    const err = new Error('connect failed: postgres://n409:s3cr3t@db.internal:5432/n409');
    const out = serializeError(err) as Record<string, string>;
    expect(out.message).toContain('postgres://[REDACTED]@db.internal');
    expect(out.message).not.toContain('s3cr3t');
    expect(out.stack).not.toContain('s3cr3t');
  });

  it('reaches a cause, which pino folds into the message before we see it', () => {
    const err = new Error('upstream call failed');
    err.cause = new Error('connect ECONNREFUSED postgres://u:hunter2@h:5432/db');
    const out = serializeError(err) as Record<string, string>;
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it('leaves a non-string field alone rather than stringifying it', () => {
    const err = Object.assign(new Error('boom'), { statusCode: 503, retriable: true });
    const out = serializeError(err) as Record<string, unknown>;
    expect(out.statusCode).toBe(503);
    expect(out.retriable).toBe(true);
  });
});

// ── End to end ────────────────────────────────────────────────────────────
//
// The unit tests above would all have passed while the leak was open, because
// the leak was never in the scrubbing — it was that the request line did not go
// through any. These drive a real fastify instance built the way the services
// build theirs.

/**
 * The serializers `createLogger` actually installs on the instance.
 *
 * Read off the instance rather than assumed, because everything below builds
 * its own pino against a capture stream — pino binds its destination at
 * construction, so a test cannot both use the real instance and read what it
 * wrote. That gap is exactly wide enough for the wiring to be deleted from
 * `createLogger` while every scrubbing test stays green and production starts
 * leaking again, so the wiring is asserted directly.
 */
function installedSerializers(): Record<string, unknown> {
  const logger = createLogger({ service: 'test' }) as unknown as Record<symbol, unknown>;
  return (logger[pino.symbols.serializersSym] ?? {}) as Record<string, unknown>;
}

describe('createLogger installs the serializers', () => {
  it('wires the request serializer, which is what scrubs the URL', () => {
    expect(installedSerializers().req).toBe(serializeRequest);
  });

  it('wires the error serializer, which is what scrubs `detail`', () => {
    expect(installedSerializers().err).toBe(serializeError);
  });
});

/**
 * A fastify app wired the way `buildApp` wires the real ones — the shared
 * logger's own redact paths and serializers — but writing to a string.
 *
 * `createLogger` is called for its configuration rather than mocked, so a
 * change there is felt here; only the destination differs, because pino binds
 * its stream at construction.
 */
function appLoggingTo(lines: string[]) {
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const reference = createLogger({ service: 'test' });
  const logger = pino(
    {
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      serializers: { req: serializeRequest, err: serializeError },
      level: reference.level,
    },
    stream,
  );
  return Fastify({ loggerInstance: logger as never });
}

describe('the request log line the services actually write', () => {
  it('does not carry the unsubscribe token', async () => {
    const lines: string[] = [];
    const app = appLoggingTo(lines);
    app.get('/api/v1/unsubscribe', async () => ({ unsubscribed: true }));

    const token = 'eyJ1IjoiMDFIIn0.test-secret-signature';
    const res = await app.inject({ method: 'GET', url: `/api/v1/unsubscribe?token=${token}` });
    expect(res.statusCode).toBe(200);

    const all = lines.join('');
    expect(all).not.toContain('test-secret-signature');
    expect(all).toContain('token=[REDACTED]');
    // The diagnostics that make the line worth keeping are still there.
    expect(all).toContain('/api/v1/unsubscribe');
    expect(all).toContain('remoteAddress');
  });

  it('does not carry the OAuth code, and still reports the response', async () => {
    const lines: string[] = [];
    const app = appLoggingTo(lines);
    app.get('/api/v1/auth/google/callback', async () => ({ ok: true }));

    await app.inject({
      method: 'GET',
      url: '/api/v1/auth/google/callback?code=4%2F0AeanS0bLIVECODE&state=eyJhbGciOiJIUzI1NiJ9.e30.sig',
    });

    const all = lines.join('');
    expect(all).not.toContain('LIVECODE');
    expect(all).toContain('code=[REDACTED]');
    expect(all).toContain('state=[REDACTED]');
    // Overriding `req` must not have taken `res` down with it — fastify merges
    // its own serializers under the instance's, per key.
    expect(all).toContain('"statusCode":200');
  });

  it('does not carry the address a pg unique violation reports', async () => {
    // The shape of all forty-odd route sites: catch, log, answer something
    // other than a 500 — so the scrubbing on the 5xx handler never runs.
    const lines: string[] = [];
    const app = appLoggingTo(lines);
    app.post('/api/v1/users', async (req, reply) => {
      try {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
          detail: 'Key (email)=(jane@example.com) already exists.',
          constraint: 'users_email_key',
        });
      } catch (err) {
        req.log.warn({ err }, 'could not create user');
        return reply.status(409).send({ error: 'taken' });
      }
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/users', payload: {} });
    expect(res.statusCode).toBe(409);

    const all = lines.join('');
    expect(all).not.toContain('jane@example.com');
    expect(all).toContain('[REDACTED-EMAIL]');
    // Still diagnosable: the constraint that fired is what the line is for.
    expect(all).toContain('users_email_key');
    expect(all).toContain('23505');
  });
});
