import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { ApiProblem, problems, registerProblemHandler, scrubError, scrubSensitive } from '../src/problem.js';

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
      type: 'about:blank',
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
    expect(res.json().instance).toBe('/echo');
    await app.close();
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
      title: 'Unprocessable Entity',
      instance: '/v',
      errors: [{ path: ['kind'] }],
    });
  });
});
