import { describe, expect, it } from 'vitest';
import {
  optionalCapabilities,
  silentlyDegraded,
  type CapabilityConfig,
} from '../../src/domain/optionalCapabilities.js';

/**
 * The roster of subsystems that are allowed to be off.
 *
 * `halfConfigured` refuses to boot production on a subsystem configured half
 * way. Nothing said anything about one that is off altogether, and off
 * altogether is the deployed state of two of these today. The record of that
 * decision was one `log.info` at boot, weeks ago, on a box nobody watches.
 *
 * What is worth pinning is not the list — a new integration will lengthen it —
 * but the two properties that make it worth reading: `configured` follows every
 * variable rather than the first one, and `silent` means what it says.
 */

const ALL_OFF: CapabilityConfig = {
  CLAMAV_HOST: undefined,
  DOCUMENTS_ENCRYPTION_KEY: undefined,
  EMAIL_MODE: 'log',
  SMTP_HOST: undefined,
  STRIPE_SECRET_KEY: undefined,
  STRIPE_WEBHOOK_SECRET: undefined,
  GOOGLE_CLIENT_ID: undefined,
  GOOGLE_CLIENT_SECRET: undefined,
  GOOGLE_REDIRECT_URI: undefined,
};

const ALL_ON: CapabilityConfig = {
  CLAMAV_HOST: 'clamd.internal',
  DOCUMENTS_ENCRYPTION_KEY: 'a'.repeat(64),
  EMAIL_MODE: 'smtp',
  SMTP_HOST: 'smtp.example.com',
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
  GOOGLE_CLIENT_ID: 'gid',
  GOOGLE_CLIENT_SECRET: 'gsecret',
  GOOGLE_REDIRECT_URI: 'https://n409.example/auth/google/callback',
};

const byKey = (config: CapabilityConfig, key: string) =>
  optionalCapabilities(config).find((c) => c.key === key)!;

describe('the optional-capability roster', () => {
  it('reports every subsystem off when nothing is set', () => {
    expect(optionalCapabilities(ALL_OFF).filter((c) => c.configured)).toEqual([]);
  });

  // The vacuity guard for everything below: a roster that always says "off"
  // would pass every assertion about degradation in this file.
  it('reports every subsystem on when everything is set', () => {
    expect(optionalCapabilities(ALL_ON).filter((c) => !c.configured)).toEqual([]);
  });

  it('needs all of a set, not the first of it', () => {
    // The half-configured cases. Each of these is a subsystem somebody believes
    // they turned on.
    expect(byKey({ ...ALL_ON, STRIPE_WEBHOOK_SECRET: undefined }, 'payments').configured).toBe(false);
    expect(byKey({ ...ALL_ON, GOOGLE_REDIRECT_URI: undefined }, 'google_sso').configured).toBe(false);
    expect(byKey({ ...ALL_ON, SMTP_HOST: undefined }, 'email_delivery').configured).toBe(false);
  });

  it('counts EMAIL_MODE=log as not delivering, however set SMTP_HOST is', () => {
    // A host with the mode left on 'log' is the shape that reads as configured
    // to anything looking at variable names. Nothing is delivered.
    expect(byKey({ ...ALL_ON, EMAIL_MODE: 'log' }, 'email_delivery').configured).toBe(false);
    expect(byKey({ ...ALL_ON, EMAIL_MODE: 'off' }, 'email_delivery').configured).toBe(false);
  });

  it('treats an empty string as unset — an env file with a bare key is not a key', () => {
    expect(byKey({ ...ALL_ON, CLAMAV_HOST: '' }, 'virus_scanning').configured).toBe(false);
  });

  it('separates the subsystems whose absence shows from the ones that do not', () => {
    const quiet = silentlyDegraded(ALL_OFF).map((c) => c.key);
    // Uploads accepted unscanned, blobs written in the clear, and mail recorded
    // as delivered to the log. None of the three tells anybody.
    expect(quiet).toEqual(['virus_scanning', 'document_encryption', 'email_delivery']);
    // Checkout being unavailable is on screen, and the Google button is simply
    // not drawn. Those are decisions a reader can already see.
    expect(quiet).not.toContain('payments');
    expect(quiet).not.toContain('google_sso');
  });

  it('is silent about nothing once everything is configured', () => {
    expect(silentlyDegraded(ALL_ON)).toEqual([]);
  });

  it('says what happens instead, for every entry, on or off', () => {
    // The fallback is the part an operator cannot work out from the key, and it
    // is present whether or not the subsystem is on — somebody reading a
    // configured row is entitled to know what they would be back to.
    for (const c of [...optionalCapabilities(ALL_ON), ...optionalCapabilities(ALL_OFF)]) {
      expect(c.fallback.length).toBeGreaterThan(40);
      expect(c.env.length).toBeGreaterThan(0);
      expect(c.label).not.toBe('');
    }
  });
});
