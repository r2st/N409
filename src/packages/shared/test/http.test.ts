import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { problems, registerProblemHandler } from '../src/problem.js';
import { registerHealth } from '../src/health.js';

describe('problem+json error handler (api-design.md §1)', () => {
  it('renders ApiProblem as RFC 9457 body', async () => {
    const app = Fastify();
    registerProblemHandler(app);
    app.get('/boom', async () => {
      throw problems.forbidden('partner scope violation');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json();
    expect(body).toMatchObject({
      type: 'urn:n409:problem:forbidden',
      title: 'Forbidden',
      status: 403,
      detail: 'partner scope violation',
      instance: '/boom',
    });
  });

  it('hides internals on unexpected 500s', async () => {
    const app = Fastify({ logger: false });
    registerProblemHandler(app);
    app.get('/crash', async () => {
      throw new Error('secret database string');
    });
    const res = await app.inject({ method: 'GET', url: '/crash' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret database string');
    expect(res.json().title).toBe('Internal Server Error');
  });

  it('renders 404s as problem+json', async () => {
    const app = Fastify();
    registerProblemHandler(app);
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().type).toBe('urn:n409:problem:not-found');
  });
});

describe('health endpoints (issue #4)', () => {
  it('reports liveness', async () => {
    const app = Fastify();
    registerHealth(app, { service: 'test-svc' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'test-svc' });
  });

  it('fails readiness when a dependency check throws', async () => {
    const app = Fastify();
    registerHealth(app, {
      service: 'test-svc',
      checks: {
        db: async () => {
          throw new Error('connection refused');
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.db).toBe('connection refused');
  });

  it('passes readiness when checks succeed', async () => {
    const app = Fastify();
    registerHealth(app, { service: 'test-svc', checks: { db: async () => {} } });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
  });
});
