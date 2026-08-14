import { pino, type Logger } from 'pino';

/**
 * Field names whose value must never reach a log line (NFR: structured
 * logging, PII-redacted).
 *
 * Pino matches a redact path segment by segment against the *exact* key, so
 * `token` does not cover `access_token` — a fact this list was written without.
 * Every OAuth integration in the valuation service carries its material as
 * `access_token`/`refresh_token`, and every one of those would have been logged
 * verbatim by any line that passed the credential row to the logger; so would
 * `api_key` and `client_secret`. `token` and `secret` matched, and looked like
 * they were covering the family.
 *
 * The compound names are therefore enumerated rather than assumed, and
 * `logger.test.ts` scans the services for any `*_token`/`*_secret`/`*_password`
 * property this list has not been told about, so the next integration's
 * credential field fails the suite instead of reaching stdout.
 */
export const SENSITIVE_FIELDS: readonly string[] = [
  // credentials
  'password',
  'password_digest',
  'current_password',
  'new_password',
  // auth material — bearer and OAuth
  'secret',
  'client_secret',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_token',
  'sign_token',
  'api_key',
  'authorization',
  'cookie',
  // second factor: the shared seed and the one-shot codes are both credentials
  'totp_secret',
  'backup_codes',
  // personal identifiers
  'email',
  'phone',
  'first_name',
  'last_name',
  'ssn',
  'tax_id',
  // client company data is sensitive in a valuation context
  'cap_table',
];

/**
 * How deep into a log object a sensitive field is redacted.
 *
 * Four levels covers the shapes this platform actually logs — a bare field, a
 * field on a row (`user.email`), a row inside a wrapper (`req.body.user.email`),
 * and one more for the nested integration payloads. It is a bound rather than a
 * guarantee: pino has no "any depth" wildcard, so anything deeper is not
 * redacted and must not be logged whole.
 */
const REDACT_DEPTH = 4;

/**
 * PII-redaction paths, one per field per depth.
 *
 * Generated rather than hand-listed because the hand-listed version drifted:
 * `email` was redacted three levels down, `phone` only one, for no reason
 * anybody recorded — the shallower fields were simply the ones somebody had
 * been burned by.
 */
export const REDACT_PATHS: string[] = SENSITIVE_FIELDS.flatMap((field) =>
  Array.from({ length: REDACT_DEPTH }, (_, depth) =>
    depth === 0 ? field : `${'*.'.repeat(depth)}${field}`,
  ),
);

export interface LoggerOptions {
  service: string;
  level?: string;
  /** extra redact paths on top of the defaults */
  redact?: string[];
}

export function createLogger(opts: LoggerOptions): Logger {
  return pino({
    name: opts.service,
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    redact: { paths: [...REDACT_PATHS, ...(opts.redact ?? [])], censor: '[REDACTED]' },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    base: { service: opts.service },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
