import { pino, type Logger } from 'pino';

/**
 * PII-redaction paths (NFR: structured logging, PII-redacted).
 * Covers credentials, auth material, and personal/company identifiers that
 * appear in request/response bodies logged at the edges.
 */
export const REDACT_PATHS: string[] = [
  // credentials / auth material
  'password',
  '*.password',
  '*.*.password',
  'password_digest',
  '*.password_digest',
  'secret',
  '*.secret',
  'token',
  '*.token',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  // personal identifiers
  'email',
  '*.email',
  '*.*.email',
  'phone',
  '*.phone',
  'first_name',
  '*.first_name',
  'last_name',
  '*.last_name',
  // client company data is sensitive in a valuation context
  '*.cap_table',
  'cap_table',
];

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
