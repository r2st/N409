import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  ApiProblem,
  problems,
  registerProblemHandler,
  requestErrorContext,
  scrubError,
  scrubSensitive,
} from '../src/problem.js';

describe('scrubSensitive', () => {
  it('masks credentials in a connection string but keeps scheme/host', () => {
    expect(scrubSensitive('connect postgres://n409:s3cr3t@db.internal:5432/n409 failed')).toBe(
      'connect postgres://[REDACTED]@db.internal:5432/n409 failed',
    );
    expect(scrubSensitive('redis://user:pass@cache:6379')).toBe('redis://[REDACTED]@cache:6379');
  });

  it('masks bearer tokens and JWTs', () => {
    expect(scrubSensitive('Authorization: Bearer abcDEF123456789xyz')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
    expect(scrubSensitive(`token ${jwt} rejected`)).toBe('token [REDACTED-JWT] rejected');
  });

  it('masks API keys and emails and SSNs', () => {
    expect(scrubSensitive('key sk-ABCDEF0123456789abcdef used')).toBe('key [REDACTED-KEY] used');
    expect(scrubSensitive('using AKIAIOSFODNN7EXAMPLE now')).toBe('using [REDACTED-KEY] now');
    expect(scrubSensitive('user jane.doe@acme.co not found')).toBe('user [REDACTED-EMAIL] not found');
    expect(scrubSensitive('ssn 123-45-6789 present')).toBe('ssn [REDACTED-SSN] present');
  });

  it('leaves benign text untouched', () => {
    const msg = 'Valuation 42 could not be computed: engine returned 422';
    expect(scrubSensitive(msg)).toBe(msg);
  });

  it('is safe on empty input', () => {
    expect(scrubSensitive('')).toBe('');
  });
});

describe('scrubError', () => {
  it('scrubs message and stack of an Error', () => {
    const err = new Error('failed to reach postgres://u:p@h:5432/db for jane@x.io');
    const scrubbed = scrubError(err);
    expect(scrubbed.name).toBe('Error');
    expect(scrubbed.message).toBe('failed to reach postgres://[REDACTED]@h:5432/db for [REDACTED-EMAIL]');
    expect(String(scrubbed.stack)).not.toContain('jane@x.io');
    expect(String(scrubbed.stack)).not.toContain(':p@');
  });

  it('handles non-Error throwables', () => {
    expect(scrubError('boom sk-ABCDEF0123456789abcdef')).toEqual({ message: 'boom [REDACTED-KEY]' });
  });
});

describe('problems.tooManyRequests', () => {
  it('omits retry_after_seconds when no retry hint is given', () => {
    const err = problems.tooManyRequests('slow down');
    expect(err.retryAfterSeconds).toBeUndefined();
    expect(err.toBody()).not.toHaveProperty('retry_after_seconds');
  });

  it('carries a retry hint through to the problem body', () => {
    const err = problems.tooManyRequests('slow down', 42);
    expect(err.retryAfterSeconds).toBe(42);
    expect(err.toBody()).toMatchObject({ retry_after_seconds: 42 });
  });
});

describe('registerProblemHandler', () => {
  /** Every rate-limited route throws tooManyRequests(detail, seconds) instead
   *  of setting the header itself — this is the one place that plumbing runs,
   *  so every 429 across the platform reports retry-after consistently. */
  it('sets a retry-after header from ApiProblem.retryAfterSeconds', async () => {
    const app = Fastify();
    registerProblemHandler(app);
    app.get('/boom', () => {
      throw problems.tooManyRequests('too fast', 17);
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('17');
    expect(res.json().retry_after_seconds).toBe(17);
    await app.close();
  });

  it('does not set retry-after when the problem carries no retry hint', async () => {
    const app = Fastify();
    registerProblemHandler(app);
    app.get('/boom', () => {
      throw problems.notFound('gone');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['retry-after']).toBeUndefined();
    await app.close();
  });

  /**
   * The gap this closes: an `ApiProblem` was returned without a log line at
   * any status, so every 5xx the estate raises *on purpose* — an unreachable
   * engine turned into a 502 by `toProblem`, a 503 from a provider nobody
   * configured — left the process with nothing but a status code behind it.
   */
  it('logs a 5xx ApiProblem at error, with the problem type and request context', async () => {
    const lines: Array<{ level: string; fields: Record<string, unknown>; msg: string }> = [];
    const app = Fastify({ logger: false });
    app.addHook('onRequest', (req, _reply, done) => {
      for (const level of ['warn', 'error'] as const) {
        (req.log as unknown as Record<string, unknown>)[level] = (
          fields: Record<string, unknown>,
          msg: string,
        ) => {
          lines.push({ level, fields, msg });
        };
      }
      done();
    });
    registerProblemHandler(app);
    app.get('/boom', () => {
      throw new ApiProblem({ status: 502, title: 'Bad Gateway', type: 'urn:n409:problem:upstream' });
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(502);
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('error');
    expect(lines[0].fields.problem_type).toBe('urn:n409:problem:upstream');
    expect(lines[0].fields.status).toBe(502);
    expect(lines[0].fields.method).toBe('GET');
    await app.close();
  });

  /**
   * A 4xx describes the request, not the server. Logging one is logging other
   * people's mistakes at whatever rate they care to make them.
   */
  it('logs nothing for a 4xx ApiProblem', async () => {
    const lines: string[] = [];
    const app = Fastify({ logger: false });
    app.addHook('onRequest', (req, _reply, done) => {
      for (const level of ['warn', 'error'] as const) {
        (req.log as unknown as Record<string, unknown>)[level] = (_f: unknown, msg: string) => {
          lines.push(msg);
        };
      }
      done();
    });
    registerProblemHandler(app);
    app.get('/boom', () => {
      throw problems.notFound('gone');
    });
    expect((await app.inject({ method: 'GET', url: '/boom' })).statusCode).toBe(404);
    expect(lines).toEqual([]);
    await app.close();
  });

  /**
   * Maintenance mode is the one 5xx that is a planned state. It is refused once
   * per mutating request for the length of the window, so it logs at `warn` —
   * a planned window must not read as an incident, and must not be the reason
   * an operator stops reading `error`.
   */
  it('logs an expected 5xx at warn rather than error', async () => {
    const lines: Array<{ level: string; msg: string }> = [];
    const app = Fastify({ logger: false });
    app.addHook('onRequest', (req, _reply, done) => {
      for (const level of ['warn', 'error'] as const) {
        (req.log as unknown as Record<string, unknown>)[level] = (_f: unknown, msg: string) => {
          lines.push({ level, msg });
        };
      }
      done();
    });
    registerProblemHandler(app);
    app.get('/boom', () => {
      throw new ApiProblem({
        status: 503,
        title: 'Service Unavailable',
        detail: 'maintenance',
        expected: true,
      });
    });
    expect((await app.inject({ method: 'GET', url: '/boom' })).statusCode).toBe(503);
    expect(lines).toEqual([{ level: 'warn', msg: 'request refused' }]);
    await app.close();
  });

  it('renders a generic ApiProblem as application/problem+json', async () => {
    const app = Fastify();
    registerProblemHandler(app);
    app.get('/boom', () => {
      throw new ApiProblem({ status: 418, title: "I'm a teapot" });
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(418);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  /**
   * The branch every route reaches by accident rather than on purpose: a raw
   * throw that is not an ApiProblem. What the caller must NOT get back is the
   * message, because an exception string in this codebase quotes connection
   * strings, a client's cap table, or whatever was interpolated into it.
   */
  it('answers an unexpected throw with a generic 500 that quotes nothing', async () => {
    const app = Fastify({ logger: false });
    registerProblemHandler(app);
    app.get('/boom', () => {
      throw new Error('connect postgres://n409:s3cr3t@db.internal:5432/n409 failed');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toEqual({
      type: 'urn:n409:problem:internal',
      title: 'Internal Server Error',
      status: 500,
      instance: '/boom',
    });
    expect(res.body).not.toContain('s3cr3t');
    expect(res.body).not.toContain('db.internal');
    await app.close();
  });

  it('keeps a 4xx thrown by fastify itself, message and all', async () => {
    // A malformed JSON body never reaches a handler — fastify throws with a
    // statusCode of its own, and that status is the useful answer. Its message
    // describes the request, not the server, so it is safe to echo.
    const app = Fastify({ logger: false });
    registerProblemHandler(app);
    app.post('/echo', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().status).toBe(400);
    expect(res.json().title).not.toBe('Internal Server Error');
    expect(res.json().detail).toContain('not valid JSON');
    expect(res.json().instance).toBe('/echo');
    await app.close();
  });
});

/**
 * The failures fastify raises before any handler runs.
 *
 * All of them used to render as `type: "about:blank"` with fastify's English
 * sentence as the `title`. That is the one error shape on this platform a
 * client cannot switch on — and it is the shape returned for precisely the
 * mistakes an integration makes while it is being written, so the first
 * fifty errors a partner ever sees were the untyped ones. Each now carries a
 * stable `urn:n409:problem:*`, the prose moves to `detail` where a message
 * that varies with the fastify version belongs, and `title` is the reason
 * phrase RFC 9457 asks to be constant across occurrences.
 */
describe('problem types for fastify-native failures', () => {
  async function post(payload: string, contentType: string, opts: { bodyLimit?: number } = {}) {
    const app = Fastify({ logger: false, ...opts });
    registerProblemHandler(app);
    app.post('/echo', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': contentType },
      payload,
    });
    await app.close();
    return res;
  }

  it('types an unparseable JSON body distinctly from an empty one', async () => {
    // Both are 400s, and a client should retry neither the same way: one is a
    // serializer bug, the other a request that never carried a body.
    const malformed = await post('{not json', 'application/json');
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().type).toBe('urn:n409:problem:malformed-body');
    expect(malformed.json().title).toBe('Bad Request');

    const empty = await post('', 'application/json');
    expect(empty.statusCode).toBe(400);
    expect(empty.json().type).toBe('urn:n409:problem:empty-body');
    expect(empty.json().type).not.toBe(malformed.json().type);
  });

  it('types a content-type nothing can parse', async () => {
    const res = await post('<x/>', 'application/xml');
    expect(res.statusCode).toBe(415);
    expect(res.json().type).toBe('urn:n409:problem:unsupported-media-type');
    expect(res.json().title).toBe('Unsupported Media Type');
  });

  it('types an over-limit payload, which a client answers by chunking', async () => {
    const res = await post(JSON.stringify({ a: 'x'.repeat(500) }), 'application/json', { bodyLimit: 100 });
    expect(res.statusCode).toBe(413);
    expect(res.json().type).toBe('urn:n409:problem:payload-too-large');
    expect(res.json().title).toBe('Content Too Large');
  });

  it('types a 404 raised by a route that throws one, not just the not-found handler', async () => {
    const app = Fastify({ logger: false });
    registerProblemHandler(app);
    app.get('/gone', async () => {
      throw Object.assign(new Error('no such thing'), { statusCode: 404 });
    });
    const res = await app.inject({ method: 'GET', url: '/gone' });
    expect(res.statusCode).toBe(404);
    expect(res.json().type).toBe('urn:n409:problem:not-found');
    expect(res.json().title).toBe('Not Found');
    await app.close();
  });

  it('gives a 5xx a stable type too, still without a detail', async () => {
    // The type is safe to publish — it says nothing the status does not. The
    // message is not, which is why there is no `detail` on this branch.
    const app = Fastify({ logger: false });
    registerProblemHandler(app);
    app.get('/boom', () => {
      throw new Error('ECONNREFUSED 10.0.0.4:5432');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.json().type).toBe('urn:n409:problem:internal');
    expect(res.json().detail).toBeUndefined();
    expect(res.body).not.toContain('10.0.0.4');
    await app.close();
  });

  it('never answers with about:blank, which is what a client cannot branch on', async () => {
    for (const res of [
      await post('{not json', 'application/json'),
      await post('', 'application/json'),
      await post('<x/>', 'application/xml'),
      await post(JSON.stringify({ a: 'x'.repeat(500) }), 'application/json', { bodyLimit: 100 }),
    ]) {
      expect(res.json().type).toMatch(/^urn:n409:problem:/);
    }
  });

  it('renders an unrouted path as problem+json rather than fastify default', async () => {
    const app = Fastify({ logger: false });
    registerProblemHandler(app);
    const res = await app.inject({ method: 'GET', url: '/nothing/here' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toEqual({
      type: 'urn:n409:problem:not-found',
      title: 'Not Found',
      status: 404,
      instance: '/nothing/here',
    });
    await app.close();
  });
});

/**
 * Every route on the platform throws through one of these, and the front end
 * switches on `status` and `type`. A factory that quietly changed either would
 * be a client-visible break with nothing else asserting the shape.
 */
describe('problem factories', () => {
  const cases: Array<[string, ApiProblem, number, string]> = [
    ['badRequest', problems.badRequest(), 400, 'urn:n409:problem:bad-request'],
    ['unauthorized', problems.unauthorized(), 401, 'urn:n409:problem:unauthorized'],
    ['forbidden', problems.forbidden(), 403, 'urn:n409:problem:forbidden'],
    ['notFound', problems.notFound(), 404, 'urn:n409:problem:not-found'],
    ['conflict', problems.conflict(), 409, 'urn:n409:problem:conflict'],
    ['unprocessable', problems.unprocessable(), 422, 'urn:n409:problem:validation'],
    ['tooManyRequests', problems.tooManyRequests(), 429, 'urn:n409:problem:rate-limited'],
    ['serviceUnavailable', problems.serviceUnavailable(), 503, 'urn:n409:problem:unavailable'],
  ];

  it.each(cases)('%s carries its status and stable type URN', (_name, problem, status, type) => {
    expect(problem.status).toBe(status);
    expect(problem.toBody()).toMatchObject({ status, type });
  });

  it('gives the four unauthenticated shapes a default detail', () => {
    // These are thrown with no argument from the auth plugin and the RBAC
    // guards, so the default is what a client actually reads.
    expect(problems.unauthorized().detail).toBe('Authentication required');
    expect(problems.forbidden().detail).toBe('Not allowed');
    expect(problems.notFound().detail).toBe('Resource not found');
    expect(problems.serviceUnavailable().detail).toBe('Service temporarily unavailable');
  });

  it('omits detail from the body when a factory was given none', () => {
    // `conflict()` and `badRequest()` take an optional detail; an empty
    // `detail: undefined` key in the JSON is noise a client has to handle.
    expect(problems.conflict().toBody()).not.toHaveProperty('detail');
    expect(problems.badRequest('nope').toBody()).toMatchObject({ detail: 'nope' });
  });

  it('merges validation extensions into the body without shadowing the envelope', () => {
    // Every zod failure on the platform rides in `extensions.errors`.
    const body = problems.unprocessable('Invalid valuation', { errors: [{ path: ['kind'] }] }).toBody('/v');
    expect(body).toMatchObject({
      status: 422,
      title: 'Unprocessable Content',
      instance: '/v',
      errors: [{ path: ['kind'] }],
    });
  });
});

/**
 * What a 500 leaves behind for whoever has to explain it.
 *
 * The line carried the error and nothing else. Pino contributes `reqId`, so the
 * rest was in principle recoverable by finding the matching "incoming request"
 * line — which is no help to a log search scoped to `level=error`, an alert
 * built on one, or the single line somebody pastes into an incident channel.
 * And two facts were not recoverable from anywhere: the route *pattern* (the
 * URL has ids substituted in, so grouping 500s by endpoint meant re-deriving
 * it) and who was calling. "Is this one customer or everyone" is the first
 * question asked of a spike in 500s.
 */
describe('5xx log context', () => {
  /** A fastify-shaped logger that records what the error handler writes. */
  function recordingLogger() {
    const lines: { obj: Record<string, unknown>; msg?: string }[] = [];
    const level = (name: string) => (obj: unknown, msg?: string) => {
      if (name === 'error') lines.push({ obj: obj as Record<string, unknown>, msg });
    };
    const logger = {
      level: 'info',
      silent: () => {},
      fatal: level('fatal'),
      error: level('error'),
      warn: level('warn'),
      info: level('info'),
      debug: level('debug'),
      trace: level('trace'),
      child: () => logger,
    };
    return { logger, lines };
  }

  async function capture(build: (app: ReturnType<typeof Fastify>) => void, url = '/valuations/01J0/report') {
    const { logger, lines } = recordingLogger();
    const app = Fastify({ loggerInstance: logger as never });
    registerProblemHandler(app);
    build(app);
    const res = await app.inject({ method: 'GET', url });
    await app.close();
    return { res, line: lines.at(-1) };
  }

  it('names the route pattern, the method and the caller', async () => {
    const { res, line } = await capture((app) => {
      app.addHook('onRequest', (req, _reply, done) => {
        (req as { principal?: unknown }).principal = {
          id: 'usr_1',
          roles: ['valuation_user'],
          partnerId: 'ptn_9',
        };
        done();
      });
      app.get('/valuations/:id/report', () => {
        throw new Error('boom');
      });
    });

    expect(res.statusCode).toBe(500);
    expect(line?.msg).toBe('unhandled error');
    expect(line?.obj).toMatchObject({
      method: 'GET',
      // The pattern, not the substituted URL — this is what groups 500s.
      route: '/valuations/:id/report',
      url: '/valuations/01J0/report',
      actor: { user_id: 'usr_1', roles: ['valuation_user'], partner_id: 'ptn_9' },
    });
  });

  it('says so plainly when nobody was signed in', async () => {
    const { line } = await capture((app) => {
      app.get('/valuations/:id/report', () => {
        throw new Error('boom');
      });
    });
    expect(line?.obj.actor).toBe('anonymous');
  });

  it('distinguishes a partner integration from the human whose token it is', async () => {
    // A partner API call authenticates as its token's creating user, so the
    // principal alone cannot tell the two apart — and they fail differently.
    //
    // The fixture is the *decoration*, verbatim: valuation's auth plugin sets
    // `req.apiToken = { tokenId, partnerId }` and that is the only assignment
    // there is. This test used to build `{ id: 'tok_7' }` instead — the shape
    // of the database row — and passed for years against a reader that looked
    // up `apiToken.id`, which on a real request is undefined. Pino drops an
    // undefined value, so the field simply was not there, and the distinction
    // this test is named for was never once recorded in production. A fixture
    // invented to match the reader tests nothing but the reader.
    const { line } = await capture((app) => {
      app.addHook('onRequest', (req, _reply, done) => {
        (req as { principal?: unknown }).principal = { id: 'usr_1', roles: ['partner_api'], partnerId: 'p1' };
        (req as { apiToken?: unknown }).apiToken = { tokenId: 'tok_7', partnerId: 'p1' };
        done();
      });
      app.get('/valuations/:id/report', () => {
        throw new Error('boom');
      });
    });
    expect(line?.obj.actor).toMatchObject({ api_token_id: 'tok_7' });
  });

  it('reports no token id for a session, so the field means what it says', async () => {
    // The other half. `api_token_id` is only worth having if its absence is
    // information — a human session must not carry the key at all.
    const { line } = await capture((app) => {
      app.addHook('onRequest', (req, _reply, done) => {
        (req as { principal?: unknown }).principal = { id: 'usr_1', roles: ['analyst'], partnerId: null };
        done();
      });
      app.get('/valuations/:id/report', () => {
        throw new Error('boom');
      });
    });
    expect(line?.obj.actor).toEqual({ user_id: 'usr_1', roles: ['analyst'], partner_id: null });
  });

  it('scrubs the query string, which carries whatever a client typed', async () => {
    // Percent-encoded, because that is how a browser sends it — and every
    // scrub pattern matches literal text, so an encoded address walked past
    // the redaction that exists for it until the URL was decoded first.
    const { line } = await capture(
      (app) => {
        app.get('/search', () => {
          throw new Error('boom');
        });
      },
      '/search?q=' + encodeURIComponent('ada@example.com'),
    );
    expect(line?.obj.url).toBe('/search?q=[REDACTED-EMAIL]');
  });

  it('keeps a URL whose escapes are malformed rather than dropping the line', async () => {
    const { line } = await capture((app) => {
      app.get('/search', () => {
        throw new Error('boom');
      });
    }, '/search?q=%zz');
    expect(line?.obj.url).toBe('/search?q=%zz');
  });

  it('adds nothing to the client body', async () => {
    const { res } = await capture((app) => {
      app.addHook('onRequest', (req, _reply, done) => {
        (req as { principal?: unknown }).principal = { id: 'usr_1', roles: ['ops'], partnerId: null };
        done();
      });
      app.get('/valuations/:id/report', () => {
        throw new Error('boom');
      });
    });
    expect(res.json()).toEqual({
      type: 'urn:n409:problem:internal',
      title: 'Internal Server Error',
      status: 500,
      instance: '/valuations/01J0/report',
    });
  });

  it('works on a request that matched no route at all', () => {
    // setNotFoundHandler answers those, but a throw inside a hook can still
    // reach the error handler with no routeOptions.url to report.
    const ctx = requestErrorContext({ method: 'POST', url: '/nope' } as never);
    expect(ctx).toEqual({ method: 'POST', url: '/nope', actor: 'anonymous' });
  });
});
