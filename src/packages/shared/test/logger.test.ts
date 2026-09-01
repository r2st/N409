import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pino } from 'pino';
import { REDACT_PATHS, SENSITIVE_FIELDS } from '../src/logger.js';

function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, stream);
  return { logger, lines };
}

/** The one log line, parsed. */
function logged(fn: (logger: ReturnType<typeof captureLogger>['logger']) => void): Record<string, never> {
  const { logger, lines } = captureLogger();
  fn(logger);
  return JSON.parse(lines[0]!);
}

describe('PII redaction (issue #4)', () => {
  it('redacts credentials and PII at top level and nested', () => {
    const out = logged((logger) =>
      logger.info({
        email: 'founder@acme.com',
        password: 'hunter2',
        user: { email: 'x@y.z', first_name: 'Jane', last_name: 'Doe', phone: '+1555' },
        req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1' } },
      }),
    );
    expect(out.email).toBe('[REDACTED]');
    expect(out.password).toBe('[REDACTED]');
    expect(out.user.email).toBe('[REDACTED]');
    expect(out.user.first_name).toBe('[REDACTED]');
    expect(out.user.last_name).toBe('[REDACTED]');
    expect(out.user.phone).toBe('[REDACTED]');
    expect(out.req.headers.authorization).toBe('[REDACTED]');
    expect(out.req.headers.cookie).toBe('[REDACTED]');
  });

  it('redacts cap table payloads', () => {
    const out = logged((logger) => logger.info({ attachment: { cap_table: { holders: ['a'] } } }));
    expect(out.attachment.cap_table).toBe('[REDACTED]');
  });

  it('keeps non-sensitive fields intact', () => {
    const out = logged((logger) => logger.info({ valuation_id: '01ABC', state: 'pending' }));
    expect(out.valuation_id).toBe('01ABC');
    expect(out.state).toBe('pending');
  });

  /**
   * The gap this list was written with. Pino matches a path segment against the
   * exact key, so `token` never covered `access_token` — and every accounting,
   * cap-table and HRIS integration in the valuation service stores its material
   * under exactly those compound names. A single `log.info({ integration })`
   * would have put a live Google/Xero/Carta refresh token into stdout, past a
   * redact list that looked like it covered tokens.
   */
  it('redacts OAuth material, whose field names are compounds of `token`', () => {
    const out = logged((logger) =>
      logger.info({
        integration: {
          access_token: 'ya29.a0AfB_real',
          refresh_token: '1//0eLIVEREFRESH',
          id_token: 'eyJhbGciOi.payload.sig',
        },
      }),
    );
    expect(out.integration.access_token).toBe('[REDACTED]');
    expect(out.integration.refresh_token).toBe('[REDACTED]');
    expect(out.integration.id_token).toBe('[REDACTED]');
  });

  it('redacts provider keys and secrets, which `secret` alone did not match', () => {
    const out = logged((logger) =>
      logger.info({ provider: { api_key: 'sk-live-abc123', client_secret: 'gocspx-xyz' } }),
    );
    expect(out.provider.api_key).toBe('[REDACTED]');
    expect(out.provider.client_secret).toBe('[REDACTED]');
  });

  it('redacts second-factor material — the seed and the one-shot codes alike', () => {
    const out = logged((logger) =>
      logger.info({ mfa: { totp_secret: 'JBSWY3DPEHPK3PXP', backup_codes: ['ABCD-1234'] } }),
    );
    expect(out.mfa.totp_secret).toBe('[REDACTED]');
    expect(out.mfa.backup_codes).toBe('[REDACTED]');
  });

  it('redacts a password on the change-password body, under either of its names', () => {
    const out = logged((logger) =>
      logger.info({ req: { body: { current_password: 'old-one', new_password: 'new-one' } } }),
    );
    expect(out.req.body.current_password).toBe('[REDACTED]');
    expect(out.req.body.new_password).toBe('[REDACTED]');
  });

  /**
   * The depth bound is a real limit, not a formality: pino has no "at any
   * depth" wildcard, so a field five levels down is logged in the clear. Pinned
   * so that the bound is a decision somebody made rather than a surprise.
   */
  it('redacts to four levels deep, and no deeper', () => {
    const out = logged((logger) =>
      logger.info({ a: { b: { c: { password: 'caught' }, password: 'caught' } } }),
    );
    expect(out.a.b.c.password).toBe('[REDACTED]');
    expect(out.a.b.password).toBe('[REDACTED]');

    const deeper = logged((logger) => logger.info({ a: { b: { c: { d: { password: 'missed' } } } } }));
    expect(deeper.a.b.c.d.password).toBe('missed');
  });
});

// ── Drift guard ───────────────────────────────────────────────────────────
//
// The list above is only as good as its last update, and the failure is silent:
// a new integration lands with a `webhook_secret` column, nothing in the redact
// list matches it, and the first anybody knows is the value sitting in a log
// aggregator. Same shape as `.env.example` being the deployment contract — the
// invariant is enforced against the source tree rather than trusted to review.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'coverage', '.venv', 'test', 'tests', 'mutants'].includes(entry.name)) {
        continue;
      }
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * `has_password` is a boolean saying whether the user has one
 * (`password_digest IS NOT NULL`), not a password. The subject-access export
 * built the pattern: its "withheld" section lists each credential the account
 * holds *without* holding any of them, so every field there is `has_<the thing
 * it is not>`. A predicate about a secret is the opposite of the secret, and
 * putting one on the redact list would blank the diagnostic — "the account has
 * no password set" is exactly what you want to read in a log about a failed
 * login.
 *
 * Narrow on purpose. `has_` is the only prefix that inverts a name's meaning
 * this way; a field is otherwise assumed to hold what it is named after.
 */
const PRESENCE_PREFIX = /^has_/;

/**
 * Compound credential field names the services actually carry, found in
 * property position only.
 *
 * Property position is the whole point of the two patterns: `trade_secret` is
 * an *asset type* in the intangibles intake (`'trade_secret',` in an options
 * array), not a credential, and a looser scan reports it forever.
 */
function credentialFields(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const suffixes = 'token|secret|password|credentials';
  for (const file of [
    ...sourceFiles(path.join(repoRoot, 'src/services')),
    ...sourceFiles(path.join(repoRoot, 'src/packages')),
  ]) {
    const text = readFileSync(file, 'utf8');
    const rel = path.relative(repoRoot, file);
    const note = (name: string) => {
      if (PRESENCE_PREFIX.test(name)) return;
      const at = found.get(name) ?? [];
      if (!at.includes(rel)) at.push(rel);
      found.set(name, at);
    };
    // Object-literal key or interface member: `access_token: '…'`
    for (const m of text.matchAll(new RegExp(`\\b([a-z][a-z0-9_]*_(?:${suffixes}))\\s*[?]?\\s*:`, 'g'))) {
      note(m[1]!);
    }
    // Property access: `row.refresh_token`
    for (const m of text.matchAll(new RegExp(`\\.([a-z][a-z0-9_]*_(?:${suffixes}))\\b`, 'g'))) {
      note(m[1]!);
    }
  }
  return found;
}

/**
 * `*_email`/`*_phone` fields that are not a natural person's contact details.
 *
 * Declared rather than silently skipped, because each one is a judgement that
 * should be re-read when it changes:
 *
 *  - `marketing_email` is a *boolean* consent flag (`repos/communications.ts`),
 *    not an address. Redacting it blanks a diagnostic and protects nothing —
 *    the `has_password` case exactly.
 *  - `support_email` is the firm's own published support address, rendered on
 *    its login page by the branding routes. It is business contact detail that
 *    the product deliberately shows to anonymous visitors.
 *  - `auto_email` names a feature (the `auto_emails` table), not a recipient.
 *  - `no_email` is a *refusal reason code* — one member of `SSO_REFUSAL_CODES`
 *    (`auth/ssoRefusal.ts`), keyed again in the login page's message map. It is
 *    the name of the case where the provider sent no address at all, so there
 *    is nothing under it to redact; the `has_password` case once more, in the
 *    negative. This one is why the whole check was red: it entered the tree
 *    with the SSO refusal vocabulary and has been failing ever since, which is
 *    the state a tripwire is least useful in — still red, and therefore no
 *    longer read, so a genuinely unredacted `*_email` arriving after it would
 *    have changed nothing about what this suite reported.
 */
const NON_PERSONAL_CONTACT_FIELDS = new Set([
  'marketing_email',
  'support_email',
  'auto_email',
  'no_email',
]);

/**
 * Compound contact-detail field names the services carry, in property position.
 *
 * Same two patterns and the same reasoning as `credentialFields`. `_name` is
 * deliberately not in the family: on this platform it is overwhelmingly
 * companies, plans and indexes rather than people, so scanning it would report
 * `legal_name` and `index_name` forever — and a tripwire that is always red is
 * one nobody reads. The handful of genuinely personal `*_name` fields are
 * hand-listed in SENSITIVE_FIELDS instead.
 */
function contactFields(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const suffixes = 'email|phone';
  for (const file of [
    ...sourceFiles(path.join(repoRoot, 'src/services')),
    ...sourceFiles(path.join(repoRoot, 'src/packages')),
  ]) {
    const text = readFileSync(file, 'utf8');
    const rel = path.relative(repoRoot, file);
    const note = (name: string) => {
      if (PRESENCE_PREFIX.test(name)) return;
      const at = found.get(name) ?? [];
      if (!at.includes(rel)) at.push(rel);
      found.set(name, at);
    };
    for (const m of text.matchAll(new RegExp(`\\b([a-z][a-z0-9_]*_(?:${suffixes}))\\s*[?]?\\s*:`, 'g'))) {
      note(m[1]!);
    }
    for (const m of text.matchAll(new RegExp(`\\.([a-z][a-z0-9_]*_(?:${suffixes}))\\b`, 'g'))) {
      note(m[1]!);
    }
  }
  return found;
}

describe('the redact list keeps up with the code', () => {
  it('covers every compound credential field the services carry', () => {
    const covered = new Set(SENSITIVE_FIELDS);
    const uncovered = [...credentialFields().entries()].filter(([name]) => !covered.has(name));

    expect(
      uncovered.map(([name, files]) => `${name} (in ${files[0]})`),
      'credential-shaped fields with no entry in SENSITIVE_FIELDS',
    ).toEqual([]);
  });

  it('finds the fields it is supposed to be checking', () => {
    // A regex that stopped matching would make the check above pass by scanning
    // nothing at all — the same failure mode the env-example guard has.
    const names = new Set(credentialFields().keys());
    expect(names.has('access_token')).toBe(true);
    expect(names.has('refresh_token')).toBe(true);
    expect(names.has('client_secret')).toBe(true);
    expect(names.has('totp_secret')).toBe(true);
    expect(names.size).toBeGreaterThan(5);
  });

  it('does not mistake an enum value for a credential field', () => {
    // `trade_secret` is an intangible-asset type in the intake definitions.
    // Redacting it would censor the *kind* of asset being valued out of the
    // logs, which is diagnostic data, not a secret.
    expect([...credentialFields().keys()]).not.toContain('trade_secret');
    expect(SENSITIVE_FIELDS).not.toContain('trade_secret');
  });

  it('does not mistake a presence flag for the credential it reports on', () => {
    // `has_password` is `password_digest IS NOT NULL`, selected by the
    // subject-access export (repos/dataExport.ts) to tell the user which
    // credentials are being withheld from their download. It went into the tree
    // with that feature and turned this guard red, which is the worst state for
    // a tripwire to be in: still failing, and therefore no longer read.
    const names = [...credentialFields().keys()];
    expect(names).not.toContain('has_password');
    expect(names).not.toContain('has_totp');
    expect(SENSITIVE_FIELDS).not.toContain('has_password');
    // The thing it reports on is still on the list.
    expect(SENSITIVE_FIELDS).toContain('password_digest');
    expect(SENSITIVE_FIELDS).toContain('totp_secret');
  });

  it('covers every compound contact field the services carry', () => {
    // The same drift, one family over. `email` no more covers `client_email`
    // than `token` covered `access_token`, and this platform names the column
    // after the role in every table that joins to a person — actor_email,
    // grantee_email, to_email, uploaded_by_email. Fourteen of them reached the
    // tree unredacted before this check existed.
    const covered = new Set(SENSITIVE_FIELDS);
    const uncovered = [...contactFields().entries()]
      .filter(([name]) => !covered.has(name))
      .filter(([name]) => !NON_PERSONAL_CONTACT_FIELDS.has(name));

    expect(
      uncovered.map(([name, files]) => `${name} (in ${files[0]})`),
      'contact-shaped fields with no entry in SENSITIVE_FIELDS',
    ).toEqual([]);
  });

  it('finds the contact fields it is supposed to be checking', () => {
    const names = new Set(contactFields().keys());
    expect(names.has('client_email')).toBe(true);
    expect(names.has('to_email')).toBe(true);
    expect(names.size).toBeGreaterThan(5);
  });

  it('holds the non-addresses as declared exceptions, not as oversights', () => {
    // `marketing_email` is the one that matters: it is a boolean consent flag,
    // so redacting it would blank a diagnostic and tell nobody anything —
    // exactly the `has_password` case. Naming the exceptions in a list keeps
    // them reviewable; letting the check ignore the whole family would not.
    for (const name of NON_PERSONAL_CONTACT_FIELDS) {
      expect(SENSITIVE_FIELDS, `${name} should not be redacted`).not.toContain(name);
    }
    expect(NON_PERSONAL_CONTACT_FIELDS.has('marketing_email')).toBe(true);
    // The exceptions must stay *narrow*: each is a specific name, not a family.
    // `no_email` is excused; the role-keyed addresses beside it are not.
    expect(NON_PERSONAL_CONTACT_FIELDS.has('actor_email')).toBe(false);
    expect(NON_PERSONAL_CONTACT_FIELDS.has('to_email')).toBe(false);
  });

  it('excuses no_email because it is a refusal code, not an address', () => {
    // Pinned against the source it comes from: if `no_email` ever stops being a
    // member of the SSO refusal vocabulary, the reason for the exception is
    // gone and this fails rather than quietly widening the census's blind spot.
    // Read from source rather than imported: `packages/shared` is a dependency
    // of the valuation service, not the other way round.
    const vocabulary = readFileSync(
      path.join(repoRoot, 'src/services/valuation/src/auth/ssoRefusal.ts'),
      'utf8',
    );
    expect(vocabulary).toMatch(/SSO_REFUSAL_CODES = \[[\s\S]*'no_email'[\s\S]*\] as const/);
    expect(SENSITIVE_FIELDS).not.toContain('no_email');
    // And it is genuinely what the scanner picks up — not a name nobody writes.
    expect([...contactFields().keys()]).toContain('no_email');
  });

  it('redacts a personal address under a role-shaped key, at depth', () => {
    const out = logged((logger) =>
      logger.info({
        event: { actor_email: 'jane@example.com', client_email: 'ap@client.example.com' },
        outbox: { to_email: 'someone@example.com', to_phone: '+15551234567' },
      }),
    );
    expect(out.event.actor_email).toBe('[REDACTED]');
    expect(out.event.client_email).toBe('[REDACTED]');
    expect(out.outbox.to_email).toBe('[REDACTED]');
    expect(out.outbox.to_phone).toBe('[REDACTED]');
  });

  it('leaves the subject company and the consent flag readable', () => {
    // Over-redaction has a cost, and these are the fields it would be paid in:
    // `legal_name` is the company being valued, which is the most useful thing
    // in a valuation log line.
    const out = logged((logger) =>
      logger.info({
        profile: { legal_name: 'Meridian Robotics, Inc.' },
        prefs: { marketing_email: false },
        brand: { support_email: 'help@meridian.example.com' },
      }),
    );
    expect(out.profile.legal_name).toBe('Meridian Robotics, Inc.');
    expect(out.prefs.marketing_email).toBe(false);
    expect(out.brand.support_email).toBe('help@meridian.example.com');
  });

  it('generates a path per field per level, with no duplicates', () => {
    expect(REDACT_PATHS.length).toBe(SENSITIVE_FIELDS.length * 4);
    expect(new Set(REDACT_PATHS).size).toBe(REDACT_PATHS.length);
    expect(REDACT_PATHS).toContain('password');
    expect(REDACT_PATHS).toContain('*.*.*.access_token');
  });
});
