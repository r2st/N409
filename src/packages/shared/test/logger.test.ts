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

  it('generates a path per field per level, with no duplicates', () => {
    expect(REDACT_PATHS.length).toBe(SENSITIVE_FIELDS.length * 4);
    expect(new Set(REDACT_PATHS).size).toBe(REDACT_PATHS.length);
    expect(REDACT_PATHS).toContain('password');
    expect(REDACT_PATHS).toContain('*.*.*.access_token');
  });
});
