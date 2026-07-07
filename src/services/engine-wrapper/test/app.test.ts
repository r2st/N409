import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('engine-wrapper skeleton', () => {
  it('serves generic health', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('serves the /engine/v1/health contract endpoint', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/engine/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', contract: 'engine/v1' });
    expect(res.json().engine_version).toBeDefined();
  });
});
