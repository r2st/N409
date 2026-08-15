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

/**
 * Subsystems that activate on one variable and work on another (config.ts,
 * `halfConfigured`). Each was written to degrade quietly when unconfigured,
 * which is exactly why half of one is invisible.
 */
describe('loadConfig half-configured subsystems', () => {
  const prod = (extra: Record<string, string>) => () =>
    loadConfig({ ...PROD_BASE, JWT_SECRET: REAL_SECRET, ...extra });

  it('refuses a Stripe API key with no webhook secret', () => {
    // Checkout is gated on the API key alone, and fulfilment happens nowhere
    // but the webhook — so this pairing charges a client and never releases
    // the engagement, with Stripe getting a 503 for three days and giving up.
    expect(prod({ STRIPE_SECRET_KEY: 'sk_live_abc123' })).toThrow(
      /STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not/,
    );
  });

  it('accepts the safe half — a webhook secret with no API key', () => {
    // Checkout is simply unavailable and the invoice fallback takes over; this
    // is also the shape the integration suite boots with.
    expect(prod({ STRIPE_WEBHOOK_SECRET: 'whsec_abc' })).not.toThrow();
  });

  it('accepts both Stripe secrets together', () => {
    expect(prod({ STRIPE_SECRET_KEY: 'sk_live_abc123', STRIPE_WEBHOOK_SECRET: 'whsec_abc' })).not.toThrow();
  });

  it('refuses EMAIL_MODE=smtp with no SMTP_HOST', () => {
    // buildEmailTransports falls back to the log transport, and the outbox
    // records every message as delivered.
    expect(prod({ EMAIL_MODE: 'smtp' })).toThrow(/EMAIL_MODE=smtp but SMTP_HOST is unset/);
  });

  it('leaves the log and off modes alone', () => {
    expect(prod({ EMAIL_MODE: 'log' })).not.toThrow();
    expect(prod({ EMAIL_MODE: 'off' })).not.toThrow();
  });

  it('refuses a partially configured Google sign-in, naming what is missing', () => {
    expect(prod({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret' })).toThrow(
      /Google sign-in is half-configured \(GOOGLE_REDIRECT_URI unset\)/,
    );
    expect(prod({ GOOGLE_CLIENT_ID: 'cid' })).toThrow(/GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI unset/);
  });

  it('accepts Google fully configured, and fully absent', () => {
    expect(
      prod({
        GOOGLE_CLIENT_ID: 'cid',
        GOOGLE_CLIENT_SECRET: 'csecret',
        GOOGLE_REDIRECT_URI: 'https://app.example.com/api/v1/auth/google/callback',
      }),
    ).not.toThrow();
    expect(prod({})).not.toThrow();
  });

  it('names every fault at once rather than one per restart', () => {
    expect(
      prod({ STRIPE_SECRET_KEY: 'sk_live_abc123', EMAIL_MODE: 'smtp', GOOGLE_CLIENT_ID: 'cid' }),
    ).toThrow(/STRIPE_WEBHOOK_SECRET is not.*SMTP_HOST is unset.*Google sign-in is half-configured/s);
  });

  it('does not fire outside production, where half-configured is mid-setup', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'development', JWT_SECRET: REAL_SECRET, STRIPE_SECRET_KEY: 'sk_test_abc' }),
    ).not.toThrow();
    expect(() => loadConfig({ NODE_ENV: 'test', JWT_SECRET: REAL_SECRET, EMAIL_MODE: 'smtp' })).not.toThrow();
  });
});
