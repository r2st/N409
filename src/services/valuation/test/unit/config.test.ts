import { describe, expect, it } from 'vitest';
import { KNOWN_EXAMPLE_JWT_SECRETS, loadConfig } from '../../src/config.js';

const REAL_SECRET = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

/** The other two production requirements, so a JWT test fails for its own reason. */
const PROD_BASE = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://n409:hunter2@db.internal:5432/n409',
  PUBLIC_BASE_URL: 'https://app.example.com',
} as const;

/** JWT_SECRET production guard (audit B-1 P1). */
describe('loadConfig JWT_SECRET guard', () => {
  it('rejects the known example secret in production', () => {
    expect(() => loadConfig({ ...PROD_BASE, JWT_SECRET: KNOWN_EXAMPLE_JWT_SECRETS[0] })).toThrow(
      /known example or low-entropy/,
    );
  });

  it('rejects every denylisted secret (case-insensitive) in production', () => {
    for (const known of KNOWN_EXAMPLE_JWT_SECRETS) {
      expect(() => loadConfig({ ...PROD_BASE, JWT_SECRET: known.toUpperCase() })).toThrow(
        /known example or low-entropy/,
      );
    }
  });

  it('rejects a low-entropy secret in production', () => {
    expect(() => loadConfig({ ...PROD_BASE, JWT_SECRET: 'a'.repeat(40) })).toThrow(/low-entropy/);
  });

  it('accepts a real random secret in production', () => {
    const config = loadConfig({ ...PROD_BASE, JWT_SECRET: REAL_SECRET });
    expect(config.JWT_SECRET).toBe(REAL_SECRET);
    expect(config.NODE_ENV).toBe('production');
  });

  it('allows the example secret outside production (dev/test convenience)', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'development', JWT_SECRET: KNOWN_EXAMPLE_JWT_SECRETS[0] }),
    ).not.toThrow();
    expect(() => loadConfig({ NODE_ENV: 'test', JWT_SECRET: KNOWN_EXAMPLE_JWT_SECRETS[0] })).not.toThrow();
  });

  it('still enforces the 32-char minimum', () => {
    expect(() => loadConfig({ JWT_SECRET: 'short' })).toThrow(/at least 32 chars/);
  });
});

/**
 * Variables whose defaults are local-development values (config.ts,
 * REQUIRED_IN_PRODUCTION). They exist so `npm run dev` needs no .env, and that
 * is precisely what makes an unset one in production invisible.
 */
describe('loadConfig production requirements', () => {
  it('refuses to boot in production without PUBLIC_BASE_URL', () => {
    // The damage is silent: every emailed link — password reset, email
    // verification, invitations, intake, board signing — and the URLs Stripe
    // returns a payer to would be minted against http://localhost:3000, on a
    // service reporting itself healthy.
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        JWT_SECRET: REAL_SECRET,
        DATABASE_URL: PROD_BASE.DATABASE_URL,
      }),
    ).toThrow(/PUBLIC_BASE_URL must be set in production/);
  });

  it('refuses to boot in production without DATABASE_URL', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        JWT_SECRET: REAL_SECRET,
        PUBLIC_BASE_URL: PROD_BASE.PUBLIC_BASE_URL,
      }),
    ).toThrow(/DATABASE_URL must be set in production/);
  });

  it('names every unset variable at once rather than one per restart', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: REAL_SECRET })).toThrow(
      /DATABASE_URL, PUBLIC_BASE_URL/,
    );
  });

  it('believes a deployment that deliberately points at localhost', () => {
    // Presence, not shape: a sidecar database or a local reverse proxy is a
    // real deployment, and the guard is about the value nobody chose.
    const config = loadConfig({
      NODE_ENV: 'production',
      JWT_SECRET: REAL_SECRET,
      DATABASE_URL: 'postgres://n409:n409_dev@localhost:5432/n409_dev',
      PUBLIC_BASE_URL: 'http://localhost:3000',
    });
    expect(config.PUBLIC_BASE_URL).toBe('http://localhost:3000');
  });

  it('leaves the development defaults alone outside production', () => {
    const config = loadConfig({ NODE_ENV: 'development', JWT_SECRET: REAL_SECRET });
    expect(config.PUBLIC_BASE_URL).toBe('http://localhost:3000');
  });
});
