import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  API_PERMISSIONS_POLICY,
  WEB_PERMISSIONS_POLICY,
  registerPermissionsPolicy,
} from '../src/securityHeaders.js';

/**
 * The hook is registered `onSend` rather than `onRequest` precisely so it lands
 * on the responses no handler produced, so the tests that matter here are the
 * 404 and the error path — a test that only checks a 200 would pass on an
 * `onRequest` hook too, and would not notice the regression this guards.
 */

function parsePolicy(header: string): Map<string, string> {
  return new Map(
    header.split(', ').map((entry) => {
      const eq = entry.indexOf('=');
      return [entry.slice(0, eq), entry.slice(eq + 1)] as const;
    }),
  );
}

describe('permissions policies', () => {
  it('denies the powerful features on both surfaces', () => {
    for (const policy of [API_PERMISSIONS_POLICY, WEB_PERMISSIONS_POLICY]) {
      const parsed = parsePolicy(policy);
      for (const feature of [
        'camera',
        'microphone',
        'geolocation',
        'usb',
        'serial',
        'payment',
        'publickey-credentials-get',
        'display-capture',
      ]) {
        expect(parsed.get(feature)).toBe('()');
      }
    }
  });

  it('leaves the media and clipboard families unnamed on the HTML origin', () => {
    // Naming them would deny them: Chrome gates `clipboard-write` behind this
    // header with a default allowlist of `self`, so listing it here breaks both
    // copy buttons while every test that does not click one stays green.
    const web = parsePolicy(WEB_PERMISSIONS_POLICY);
    for (const feature of [
      'autoplay',
      'clipboard-read',
      'clipboard-write',
      'encrypted-media',
      'fullscreen',
      'picture-in-picture',
    ]) {
      expect(web.has(feature)).toBe(false);
    }
  });

  it('denies the media and clipboard families on the JSON APIs', () => {
    const api = parsePolicy(API_PERMISSIONS_POLICY);
    for (const feature of ['autoplay', 'clipboard-write', 'encrypted-media', 'picture-in-picture']) {
      expect(api.get(feature)).toBe('()');
    }
  });

  it('names every feature exactly once, in sorted order', () => {
    for (const policy of [API_PERMISSIONS_POLICY, WEB_PERMISSIONS_POLICY]) {
      const names = [...parsePolicy(policy).keys()];
      expect(names).toEqual([...names].sort());
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('is a strict superset on the APIs', () => {
    const web = new Set(parsePolicy(WEB_PERMISSIONS_POLICY).keys());
    const api = new Set(parsePolicy(API_PERMISSIONS_POLICY).keys());
    for (const name of web) expect(api.has(name)).toBe(true);
    expect(api.size).toBeGreaterThan(web.size);
  });
});

describe('registerPermissionsPolicy', () => {
  it('sets the header on an ordinary response', async () => {
    const app = Fastify();
    registerPermissionsPolicy(app, API_PERMISSIONS_POLICY);
    app.get('/ok', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['permissions-policy']).toBe(API_PERMISSIONS_POLICY);
    await app.close();
  });

  it('sets it on a response no handler produced', async () => {
    // The 404 and the 500 are the whole reason this is an `onSend` hook.
    const app = Fastify();
    registerPermissionsPolicy(app, WEB_PERMISSIONS_POLICY);
    app.get('/boom', async () => {
      throw new Error('boom');
    });

    const missing = await app.inject({ method: 'GET', url: '/nothing-here' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['permissions-policy']).toBe(WEB_PERMISSIONS_POLICY);

    const failed = await app.inject({ method: 'GET', url: '/boom' });
    expect(failed.statusCode).toBe(500);
    expect(failed.headers['permissions-policy']).toBe(WEB_PERMISSIONS_POLICY);
    await app.close();
  });

  it('never overwrites a policy a route set for itself', async () => {
    const app = Fastify();
    registerPermissionsPolicy(app, API_PERMISSIONS_POLICY);
    app.get('/embed', async (_req, reply) => {
      void reply.header('permissions-policy', 'fullscreen=(self)');
      return { ok: true };
    });

    const res = await app.inject({ method: 'GET', url: '/embed' });
    expect(res.headers['permissions-policy']).toBe('fullscreen=(self)');
    await app.close();
  });
});
