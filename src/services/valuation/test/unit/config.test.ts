import { describe, expect, it } from 'vitest';
import { KNOWN_EXAMPLE_JWT_SECRETS, loadConfig } from '../../src/config.js';

const REAL_SECRET = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

/** JWT_SECRET production guard (audit B-1 P1). */
describe('loadConfig JWT_SECRET guard', () => {
  it('rejects the known example secret in production', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', JWT_SECRET: KNOWN_EXAMPLE_JWT_SECRETS[0] }),
    ).toThrow(/known example or low-entropy/);
  });

  it('rejects every denylisted secret (case-insensitive) in production', () => {
    for (const known of KNOWN_EXAMPLE_JWT_SECRETS) {
      expect(() =>
        loadConfig({ NODE_ENV: 'production', JWT_SECRET: known.toUpperCase() }),
      ).toThrow(/known example or low-entropy/);
    }
  });

  it('rejects a low-entropy secret in production', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(40) }),
    ).toThrow(/low-entropy/);
  });

  it('accepts a real random secret in production', () => {
    const config = loadConfig({ NODE_ENV: 'production', JWT_SECRET: REAL_SECRET });
    expect(config.JWT_SECRET).toBe(REAL_SECRET);
    expect(config.NODE_ENV).toBe('production');
  });

  it('allows the example secret outside production (dev/test convenience)', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'development', JWT_SECRET: KNOWN_EXAMPLE_JWT_SECRETS[0] }),
    ).not.toThrow();
    expect(() =>
      loadConfig({ NODE_ENV: 'test', JWT_SECRET: KNOWN_EXAMPLE_JWT_SECRETS[0] }),
    ).not.toThrow();
  });

  it('still enforces the 32-char minimum', () => {
    expect(() => loadConfig({ JWT_SECRET: 'short' })).toThrow(/at least 32 chars/);
  });
});
