import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

function rootWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'n409-pp-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(root, name), body);
  return root;
}

const policyOf = (value: unknown): string => String(value ?? '');

/**
 * `Permissions-Policy` on the HTML origin (round 74).
 *
 * helmet sets every other header on this round's checklist and does not set
 * this one, so the SPA — the single surface where the header actually
 * constrains anything — was serving without it.
 */
describe('permissions policy', () => {
  const root = rootWith({ 'index.html': '<!doctype html>SPA-SHELL' });

  it('denies the sensor, capture and credential families on the SPA document', async () => {
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'GET', url: '/' });
    const policy = policyOf(res.headers['permissions-policy']);

    expect(res.statusCode).toBe(200);
    for (const feature of [
      'geolocation',
      'camera',
      'microphone',
      'usb',
      'serial',
      'payment',
      'display-capture',
      'accelerometer',
      'gyroscope',
      'magnetometer',
      'midi',
      'xr-spatial-tracking',
      'publickey-credentials-get',
    ]) {
      expect(policy).toContain(`${feature}=()`);
    }
    await app.close();
  });

  /**
   * The half of this header that is easy to get wrong, and silently.
   *
   * A document may only delegate a feature it was itself granted, so naming
   * `clipboard-write=()` here would break IntakeLinksPanel's "copy link" and
   * the partner portal's copy-the-minted-secret button — in Chrome, which gates
   * clipboard-write behind this header with a default allowlist of `self`. And
   * naming the media features would take the marketing page's demo embed with
   * them: its `<iframe allow="autoplay; encrypted-media; picture-in-picture">`
   * can only receive what this document holds.
   *
   * Neither failure shows up in a test that merely checks the header exists,
   * which is exactly why it is asserted from the other direction here.
   */
  it('leaves clipboard and the media features at their defaults rather than denying them', async () => {
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'GET', url: '/' });
    const policy = policyOf(res.headers['permissions-policy']);

    for (const feature of [
      'clipboard-write',
      'clipboard-read',
      'autoplay',
      'encrypted-media',
      'picture-in-picture',
      'fullscreen',
    ]) {
      expect(policy).not.toContain(`${feature}=()`);
    }
    await app.close();
  });

  it('sets it on a client-side route, not only on /', async () => {
    // Every SPA route serves the same shell through the catch-all, and the
    // deep link is the URL a user actually lands on.
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({
      method: 'GET',
      url: '/valuations/01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
    expect(res.statusCode).toBe(200);
    expect(policyOf(res.headers['permissions-policy'])).toContain('geolocation=()');
    await app.close();
  });

  it('sets it on a 404, which never reaches a handler', async () => {
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'POST', url: '/not-an-api' });
    expect(res.statusCode).toBe(404);
    expect(policyOf(res.headers['permissions-policy'])).toContain('camera=()');
    await app.close();
  });

  it('sets it on /health and /ready', async () => {
    const app = buildApp({ staticRoot: root });
    for (const url of ['/health', '/ready']) {
      const res = await app.inject({ method: 'GET', url });
      expect(policyOf(res.headers['permissions-policy'])).toContain('geolocation=()');
    }
    await app.close();
  });

  it('is a syntactically well-formed structured-header list', async () => {
    // A malformed Permissions-Policy is dropped wholesale by the browser rather
    // than partially applied, so a typo here is indistinguishable from having
    // never set the header — and would still pass every `toContain` above.
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'GET', url: '/' });
    const policy = policyOf(res.headers['permissions-policy']);

    const entries = policy.split(',').map((s) => s.trim());
    expect(entries.length).toBeGreaterThan(5);
    for (const entry of entries) {
      expect(entry).toMatch(/^[a-z-]+=\((\s*("[^"]*"|\*|self)\s*)*\)$/);
    }
    // No duplicate feature names: a repeat is ignored by the browser and means
    // two lists have drifted apart.
    const names = entries.map((e) => e.split('=')[0]);
    expect(new Set(names).size).toBe(names.length);
    await app.close();
  });
});
