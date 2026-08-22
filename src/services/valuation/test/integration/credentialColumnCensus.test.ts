import { describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Every credential-shaped column in the schema, and what is done to it.
 *
 * This exists because the gap it now guards was invisible for a hundred and
 * sixty-six migrations. Three integrations added `access_token` /
 * `refresh_token` pairs, one added an HMAC signing key, and each one looked
 * locally fine — a text column holding a string the provider gave us. Nothing
 * in the repo, the route, or the test suite ever asked the question the four of
 * them answered differently from `users.totp_secret` two files over.
 *
 * So the question is asked of the live schema instead of the source. A source
 * scan for `sealSecret(` would pass by finding the calls that already exist;
 * this fails on a *column* nobody has classified, which is the event worth
 * catching, and it cannot pass vacuously because `information_schema` is not
 * something a refactor can quietly stop matching.
 *
 * Three treatments, and every column must have exactly one:
 *
 *   sealed   — reversible AES-256-GCM (crypto/envelope.ts). For bearer material
 *              that has to be replayed verbatim: an OAuth token posted back to
 *              the provider, an HMAC key, a TOTP seed.
 *   hashed   — one-way. For credentials *we* mint and only ever compare against,
 *              where nothing needs the original back.
 *   plain    — not a credential. Timestamps, public certificates, the visible
 *              half of a key, and the large family of columns whose name ends
 *              in `_key` because it is a lookup key.
 *
 * `hashed` is the better answer wherever it is available, and `sealed` is not a
 * substitute for it: a new column holding something this platform issues should
 * be hashed, not encrypted. `sealed` is the answer only when the plaintext has
 * a consumer.
 */

/** Anything whose name suggests it might hold a credential. Deliberately wide. */
const CANDIDATE_PATTERN =
  '(secret|token|password|passwd|api_key|apikey|credential|private_key|digest|cert)' + '|(^|_)key$';

type Treatment = 'sealed' | 'hashed' | 'plain';

const ROSTER: Record<string, { treatment: Treatment; why: string }> = {
  // ── sealed: somebody else's bearer material, replayed verbatim ────────────
  'accounting_connections.access_token': { treatment: 'sealed', why: 'Xero/QuickBooks/… OAuth grant' },
  'accounting_connections.refresh_token': { treatment: 'sealed', why: 'standing grant on a client ledger' },
  'hris_connections.access_token': { treatment: 'sealed', why: 'Rippling/Gusto/Deel OAuth grant' },
  'hris_connections.refresh_token': { treatment: 'sealed', why: 'standing grant on a payroll roster' },
  'cap_table_connections.access_token': { treatment: 'sealed', why: 'Carta/Pulley/… OAuth grant' },
  'cap_table_connections.refresh_token': { treatment: 'sealed', why: 'standing grant on a cap table' },
  'partner_webhooks.secret': { treatment: 'sealed', why: 'HMAC key; signWebhookBody needs the plaintext' },
  'users.totp_secret': { treatment: 'sealed', why: 'TOTP seed; codes are derived from it every 30s' },

  // ── hashed: ours to mint, never to recover ────────────────────────────────
  'users.password_digest': { treatment: 'hashed', why: 'scrypt' },
  'api_tokens.token_hash': { treatment: 'hashed', why: 'partner API key' },
  'scim_tokens.token_hash': { treatment: 'hashed', why: 'SCIM provisioning bearer' },
  'auditor_access.token_hash': { treatment: 'hashed', why: 'auditor portal link' },
  'client_intake_links.token_hash': { treatment: 'hashed', why: 'client intake link' },
  'mfa_trusted_devices.token_hash': { treatment: 'hashed', why: 'remember-this-device cookie' },
  'board_signoffs.token_sha256': { treatment: 'hashed', why: 'board signature link' },
  'email_verification_tokens.token_sha256': { treatment: 'hashed', why: 'address verification link' },
  'password_reset_tokens.token_sha256': { treatment: 'hashed', why: 'reset link' },
  'user_invitations.token_sha256': { treatment: 'hashed', why: 'invitation link' },

  // ── plain: matched the pattern, holds no secret ───────────────────────────
  'accounting_connections.token_expires_at': { treatment: 'plain', why: 'timestamp' },
  'hris_connections.token_expires_at': { treatment: 'plain', why: 'timestamp' },
  'cap_table_connections.token_expires_at': { treatment: 'plain', why: 'timestamp' },
  'board_signoffs.token_expires_at': { treatment: 'plain', why: 'timestamp' },
  'api_tokens.token_prefix': {
    treatment: 'plain',
    why: 'the visible half of the key — it is shown in the admin list on purpose, so an operator can tell two tokens apart without either being recoverable',
  },
  'saml_config.idp_cert': {
    treatment: 'plain',
    why: "the IdP's *public* signing certificate; it is published in their metadata",
  },
  'partner_api_idempotency.idempotency_key': {
    treatment: 'plain',
    why: 'a client-chosen request id — it authenticates nothing, and the partner sends it in the clear on every retry',
  },
  'partners.key': { treatment: 'plain', why: 'url slug' },
  'roles.key': { treatment: 'plain', why: 'role identifier' },
  'system_settings.key': { treatment: 'plain', why: 'setting name' },
  'communication_templates.key': { treatment: 'plain', why: 'template identifier' },
  'auto_emails.template_key': { treatment: 'plain', why: 'template identifier' },
  'email_outbox.template_key': { treatment: 'plain', why: 'template identifier' },
  'narrative_prompts.section_key': { treatment: 'plain', why: 'report section identifier' },
  'overwrites.field_key': { treatment: 'plain', why: 'which field was overridden' },
  'workbook_cells.row_key': { treatment: 'plain', why: 'spreadsheet coordinate' },
  'workbook_cells.column_key': { treatment: 'plain', why: 'spreadsheet coordinate' },
};

describe.skipIf(!dbUp)('credential column census', () => {
  it('classifies every credential-shaped column in the schema', async () => {
    const db = await setupTestDb();
    try {
      const { rows } = await db.pool.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name ~ $1
          ORDER BY table_name, column_name`,
        [CANDIDATE_PATTERN],
      );
      const found = rows.map((r) => `${r.table_name}.${r.column_name}`);

      // The pattern has to keep matching something, or this whole file is a
      // check that passes by asking nothing — the failure mode a schema-driven
      // census is supposed to be immune to.
      expect(found.length).toBeGreaterThan(20);

      const unclassified = found.filter((c) => !(c in ROSTER));
      expect(
        unclassified,
        'A new column looks like it holds a credential. Decide what happens to it — hash it if this ' +
          'platform mints it, seal it (crypto/connectionSecrets.ts) if something has to replay the ' +
          'plaintext — then add it to ROSTER in this file. If it is not a credential at all, add it as ' +
          "'plain' with the reason.",
      ).toEqual([]);

      // And the other direction: a roster entry for a column that is gone is a
      // claim about protection nobody is providing any more.
      const stale = Object.keys(ROSTER).filter((c) => !found.includes(c));
      expect(stale, 'ROSTER names a column that no longer exists in the schema').toEqual([]);
    } finally {
      await db.teardown();
    }
  }, 120_000);

  it('holds every sealed column to an owner that actually seals it', () => {
    // Not a source scan — a list of the four call sites, each of which the
    // at-rest suite exercises against the raw column. If a fifth sealed column
    // is added, this list and that suite are the two places it has to appear.
    const sealed = Object.entries(ROSTER)
      .filter(([, v]) => v.treatment === 'sealed')
      .map(([c]) => c);
    const covered = [
      // connectionSecretsAtRest.test.ts asserts the plaintext is absent from
      // each of these columns, and present in what the repo returns.
      'accounting_connections.access_token',
      'accounting_connections.refresh_token',
      'hris_connections.access_token',
      'hris_connections.refresh_token',
      'cap_table_connections.access_token',
      'cap_table_connections.refresh_token',
      'partner_webhooks.secret',
      // mfaRepo.test.ts / mfa.test.ts cover this one.
      'users.totp_secret',
    ];
    expect(sealed.sort()).toEqual(covered.sort());
  });
});
