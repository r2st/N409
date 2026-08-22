import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectionKey,
  connectionKeyRing,
  isSealed,
  openConnectionTokens,
  openNullable,
  openSecret,
  sealNullable,
  sealSecret,
} from '../../src/crypto/connectionSecrets.js';

const KEY = randomBytes(32);
const RETIRED = randomBytes(32);

const ENV_NAMES = [
  'CONNECTION_ENCRYPTION_KEY',
  'CONNECTION_ENCRYPTION_KEY_PREVIOUS',
  'MFA_ENCRYPTION_KEY',
  'MFA_ENCRYPTION_KEY_PREVIOUS',
  'DOCUMENTS_ENCRYPTION_KEY',
  'DOCUMENTS_ENCRYPTION_KEY_PREVIOUS',
] as const;

/**
 * At-rest sealing of credentials belonging to somebody else: the OAuth tokens
 * for a client's accounting software, HRIS and cap-table provider, and the HMAC
 * key a partner signs webhook bodies with.
 */
describe('connectionSecrets', () => {
  const saved = new Map(ENV_NAMES.map((n) => [n, process.env[n]]));
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function useKey(name: (typeof ENV_NAMES)[number], key: Buffer): void {
    for (const n of ENV_NAMES) delete process.env[n];
    process.env[name] = key.toString('hex');
  }

  it('round-trips a token and does not leave the plaintext in the stored form', () => {
    const token = 'xoxb-live-accounting-grant-9f2c';
    const stored = sealSecret(token, KEY);
    expect(stored).not.toContain(token);
    expect(isSealed(stored)).toBe(true);
    expect(openSecret(stored, [KEY])).toBe(token);
  });

  it('reads a legacy plaintext value transparently', () => {
    // A connection made before the key existed must keep working; it re-seals
    // the next time the OAuth flow writes it.
    const legacy = 'plaintext-token-from-before';
    expect(isSealed(legacy)).toBe(false);
    expect(openSecret(legacy, [KEY])).toBe(legacy);
  });

  it('stores plaintext when no key is configured, rather than refusing the write', () => {
    // Deliberately unlike encryptSecret(): throwing here would strand a grant
    // the provider has already made. See the module header.
    for (const n of ENV_NAMES) delete process.env[n];
    expect(connectionKey()).toBeNull();
    expect(sealSecret('tok')).toBe('tok');
  });

  it('passes the empty string through instead of sealing it', () => {
    // revokeConnection writes access_token = '' to mean "no credential here".
    // A sealed empty string is a 36-byte blob indistinguishable in SQL from a
    // live one.
    expect(sealSecret('', KEY)).toBe('');
    expect(isSealed('')).toBe(false);
    expect(openSecret('', [KEY])).toBe('');
  });

  it('carries null through both directions', () => {
    expect(sealNullable(null, KEY)).toBeNull();
    expect(openNullable(null, [KEY])).toBeNull();
    const stored = sealNullable('refresh-me', KEY);
    expect(stored).not.toBe('refresh-me');
    expect(openNullable(stored, [KEY])).toBe('refresh-me');
  });

  it('refuses to hand back ciphertext when a sealed value has no key', () => {
    // Posting base64 to Xero as a bearer token fails at the provider, with an
    // error naming neither this process nor the missing variable.
    const stored = sealSecret('tok', KEY);
    expect(() => openSecret(stored, [])).toThrow(/CONNECTION_ENCRYPTION_KEY/);
  });

  it('does not open under an unrelated key', () => {
    const stored = sealSecret('tok', KEY);
    expect(() => openSecret(stored, [randomBytes(32)])).toThrow();
  });

  // ── Key resolution ─────────────────────────────────────────────────────────

  it('falls back through CONNECTION → MFA → DOCUMENTS', () => {
    useKey('DOCUMENTS_ENCRYPTION_KEY', KEY);
    expect(connectionKey()?.equals(KEY)).toBe(true);
    useKey('MFA_ENCRYPTION_KEY', KEY);
    expect(connectionKey()?.equals(KEY)).toBe(true);
    useKey('CONNECTION_ENCRYPTION_KEY', KEY);
    expect(connectionKey()?.equals(KEY)).toBe(true);
  });

  it('prefers CONNECTION_ENCRYPTION_KEY when more than one is set', () => {
    for (const n of ENV_NAMES) delete process.env[n];
    process.env.DOCUMENTS_ENCRYPTION_KEY = RETIRED.toString('hex');
    process.env.CONNECTION_ENCRYPTION_KEY = KEY.toString('hex');
    expect(connectionKey()?.equals(KEY)).toBe(true);
  });

  it('opens a value sealed under the retired key, and seals new ones under the current', () => {
    useKey('CONNECTION_ENCRYPTION_KEY', RETIRED);
    const old = sealSecret('grant-issued-last-year');

    useKey('CONNECTION_ENCRYPTION_KEY', KEY);
    process.env.CONNECTION_ENCRYPTION_KEY_PREVIOUS = RETIRED.toString('hex');

    expect(openSecret(old)).toBe('grant-issued-last-year');
    const fresh = sealSecret('grant-issued-today');
    expect(connectionKeyRing().current?.equals(KEY)).toBe(true);
    // The new value opens under the current key alone — the retired one is a
    // read concession, not something new writes depend on.
    expect(openSecret(fresh, [KEY])).toBe('grant-issued-today');
  });

  it('loses the retired key’s values once _PREVIOUS is dropped', () => {
    // Stated so the rotation runbook's last step is a decision, not a surprise.
    useKey('CONNECTION_ENCRYPTION_KEY', RETIRED);
    const old = sealSecret('grant-issued-last-year');
    useKey('CONNECTION_ENCRYPTION_KEY', KEY);
    expect(() => openSecret(old)).toThrow();
  });

  // ── The row helper the three connection repos share ────────────────────────

  it('opens both token columns of a row and leaves the rest alone', () => {
    const row = {
      id: '01J',
      provider: 'xero',
      access_token: sealSecret('access', KEY),
      refresh_token: sealNullable('refresh', KEY),
    };
    const opened = openConnectionTokens(row, [KEY]);
    expect(opened.access_token).toBe('access');
    expect(opened.refresh_token).toBe('refresh');
    expect(opened.provider).toBe('xero');
    expect(opened.id).toBe('01J');
  });

  it('returns a new object rather than decrypting the row in place', () => {
    // Two reads of the same row must not double-decrypt. The second pass would
    // see no MAGIC, call it legacy plaintext, and happen to be right — which is
    // exactly why it must not be the mechanism.
    const row = { access_token: sealSecret('access', KEY), refresh_token: null };
    const opened = openConnectionTokens(row, [KEY]);
    expect(opened).not.toBe(row);
    expect(row.access_token).not.toBe('access');
    expect(openConnectionTokens(row, [KEY]).access_token).toBe('access');
  });

  it('handles a revoked row, whose access token is the empty string', () => {
    const opened = openConnectionTokens({ access_token: '', refresh_token: null }, [KEY]);
    expect(opened.access_token).toBe('');
    expect(opened.refresh_token).toBeNull();
  });
});
