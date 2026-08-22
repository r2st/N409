import { envelope, keyRing, type KeyRing } from './envelope.js';

/**
 * At-rest protection for credentials belonging to somebody else.
 *
 * Four columns across four tables hold bearer material this platform did not
 * mint and cannot re-mint:
 *
 *   accounting_connections.access_token / .refresh_token   — Xero, QuickBooks…
 *   hris_connections.access_token / .refresh_token         — Rippling, Gusto, Deel
 *   cap_table_connections.access_token / .refresh_token    — Carta, Pulley…
 *   partner_webhooks.secret                                — the HMAC signing key
 *
 * All four were stored in the clear. The asymmetry that makes that worth fixing
 * is not theoretical: `SENSITIVE_FIELDS` in shared/logger.ts enumerates
 * `access_token` and `refresh_token` by name, at four nesting depths, with a
 * test that fails when a new integration adds a credential field the list has
 * not been told about — an unusual amount of care taken to keep these strings
 * out of stdout, while every one of them sat in a Postgres column that goes
 * into the nightly dump. A refresh token here is a standing grant to read a
 * client company's general ledger or its payroll roster; it is worth strictly
 * more than the TOTP secret two files over, which has been AES-256-GCM since
 * the MFA feature landed.
 *
 * Same envelope, same rules, different MAGIC — see crypto/envelope.ts. Unlike a
 * TOTP secret these must survive a round trip byte-for-byte, so there is no
 * hashing option: the token is replayed to the provider and the webhook secret
 * is the HMAC key. Encryption is the only treatment available.
 *
 * ── Key ──────────────────────────────────────────────────────────────────────
 *
 * CONNECTION_ENCRYPTION_KEY, falling back to MFA_ENCRYPTION_KEY and then
 * DOCUMENTS_ENCRYPTION_KEY, so the production box needs no new secret to get
 * the benefit — both of the latter are already set there. Each name's
 * `_PREVIOUS` is honoured on read.
 *
 * ── Why unset is not fatal here ──────────────────────────────────────────────
 *
 * `encryptSecret` refuses to write a plaintext TOTP secret in production.
 * Sealing a connection token deliberately does *not*: it degrades to plaintext,
 * exactly as it did before this module existed. The difference is what the
 * failure would cost. A TOTP secret is written during enrolment, which a user
 * can retry; refusing it costs one setup flow. A connection token is written at
 * the end of an OAuth round trip, after the grant has already been made at the
 * provider — throwing there means the provider believes a live connection
 * exists that we did not store, and the user cannot retry without first hunting
 * down and revoking the orphaned grant. Refusing to write is the more damaging
 * of the two answers. Configuration is instead reported through the
 * optional-capabilities roster, where an unset key is visible rather than
 * discovered.
 */
const MAGIC = 'N409SEC1';
const box = envelope(MAGIC);

const KEY_NAMES = ['CONNECTION_ENCRYPTION_KEY', 'MFA_ENCRYPTION_KEY', 'DOCUMENTS_ENCRYPTION_KEY'] as const;

export function connectionKeyRing(env: NodeJS.ProcessEnv = process.env): KeyRing {
  return keyRing(env, KEY_NAMES);
}

/** The key new secrets are written with; null when nothing is configured. */
export function connectionKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  return connectionKeyRing(env).current;
}

/** True when `stored` is a sealed value rather than a legacy plaintext one. */
export function isSealed(stored: string): boolean {
  return box.isSealed(Buffer.from(stored, 'base64'));
}

/**
 * Seal for storage; base64 of the envelope. With no key configured the value is
 * returned unchanged, and reads recognise that by the absent MAGIC.
 *
 * The empty string is passed through rather than sealed. `revokeConnection`
 * writes `access_token = ''` to mean "there is no token here any more", and a
 * sealed empty string would be a 36-byte blob that decodes to nothing —
 * indistinguishable to SQL from a live credential, and the one place somebody
 * eyeballing the table wants the difference to be obvious.
 */
export function sealSecret(plain: string, key: Buffer | null = connectionKey()): string {
  if (!key || plain === '') return plain;
  return box.seal(Buffer.from(plain, 'utf8'), key).toString('base64');
}

/**
 * Plaintext from a stored value. Legacy plaintext passes through, so enabling a
 * key does not strand connections made before it — they re-seal the next time
 * the OAuth flow writes them.
 *
 * A sealed value with no key available throws rather than returning the
 * ciphertext: handing base64 to Xero as a bearer token would fail at the
 * provider with an error naming neither this process nor the missing key.
 */
export function openSecret(stored: string, keys?: readonly Buffer[]): string {
  const blob = Buffer.from(stored, 'base64');
  if (!box.isSealed(blob)) return stored;
  const ring = keys ?? connectionKeyRing().accepted;
  if (ring.length === 0) {
    throw new Error(
      'A stored integration credential is encrypted but no CONNECTION_ENCRYPTION_KEY ' +
        '(or MFA_ENCRYPTION_KEY / DOCUMENTS_ENCRYPTION_KEY) is configured',
    );
  }
  return box.open(blob, ring).toString('utf8');
}

/** `sealSecret` over a nullable column. */
export function sealNullable(plain: string | null, key: Buffer | null = connectionKey()): string | null {
  return plain === null ? null : sealSecret(plain, key);
}

/** `openSecret` over a nullable column. */
export function openNullable(stored: string | null, keys?: readonly Buffer[]): string | null {
  return stored === null ? null : openSecret(stored, keys);
}

/**
 * Row-level helper for the three connection repos, which are identical in this
 * respect and were about to grow three identical copies of it.
 *
 * Returns a new object rather than mutating: `pool.query` rows are handed
 * straight to callers, and a repo that decrypts in place would make a second
 * call on the same row double-decrypt — the second `openSecret` sees no MAGIC,
 * concludes "legacy plaintext", and silently returns the already-plaintext
 * value. That happens to be correct, which is precisely why it should not be
 * relied on.
 */
export function openConnectionTokens<T extends { access_token: string; refresh_token: string | null }>(
  row: T,
  keys?: readonly Buffer[],
): T {
  return {
    ...row,
    access_token: openSecret(row.access_token, keys),
    refresh_token: openNullable(row.refresh_token, keys),
  };
}
