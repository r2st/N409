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
});
