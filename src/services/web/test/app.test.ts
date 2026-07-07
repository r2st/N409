import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('web service skeleton', () => {
  it('serves health', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().service).toBe('web');
  });
});
