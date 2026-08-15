// `stdSerializers` is imported by name rather than reached through `pino.`:
// pino's own typings attach only "selected static members" to the callable
// named export, and `stdSerializers` is not among them, so `pino.stdSerializers`
// is a build error even though it resolves at runtime.
import { pino, stdSerializers, type Logger } from 'pino';
import { scrubSensitive, scrubUrl } from './problem.js';

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

/** The subset of a raw request Fastify's own `req` serializer reads. */
interface SerializableRequest {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  headers?: Record<string, unknown>;
  socket?: { remotePort?: number };
}

/**
 * Fastify's `req` serializer, with the URL scrubbed.
 *
 * `redact` cannot do this job. Its paths address *object properties*, and a
 * credential in a query string is a substring of one — `req.url` is a single
 * string that happens to have `?token=…` at the end of it, so a `token` entry
 * on the redact list looks like it covers this and does not. The routine
 * "incoming request" line Fastify writes for every request therefore carried
 * every credential this API is obliged to accept in a URL: the one-click
 * unsubscribe token, and the authorization `code` on all four OAuth callbacks.
 * Both are live at the moment they are written, and a log aggregator is exactly
 * the sort of place a year-valid token should not be sitting.
 *
 * The 5xx path already scrubbed its URL (`requestErrorContext`) — so the error
 * line was clean and the two ordinary lines either side of it were not, which
 * is the kind of gap that reads as covered right up until someone greps.
 *
 * Every other field is reproduced exactly as Fastify serializes it
 * (`fastify/lib/logger-pino.js`), because a serializer on the instance
 * *replaces* Fastify's rather than wrapping it — dropping `remoteAddress` here
 * would quietly cost every abuse investigation its client IP.
 */
export function serializeRequest(req: SerializableRequest): Record<string, unknown> {
  return {
    method: req.method,
    url: typeof req.url === 'string' ? scrubUrl(req.url) : req.url,
    version: req.headers?.['accept-version'],
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

/**
 * How far into a serialized error the free-text scrub reaches. Errors are
 * shallow — pino flattens the `cause` chain into `message` and `stack` before
 * this sees it — so this is headroom rather than a load-bearing number.
 */
const ERROR_SCRUB_DEPTH = 3;

/** Every string in `value`, scrubbed; everything else passed through. */
function scrubStrings(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrubSensitive(value);
  if (value === null || typeof value !== 'object' || depth >= ERROR_SCRUB_DEPTH) return value;
  if (Array.isArray(value)) return value.map((entry) => scrubStrings(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = scrubStrings(entry, depth + 1);
  return out;
}

/**
 * Pino's error serializer with the free text scrubbed.
 *
 * The 5xx handler already scrubbed the error it logged (`scrubError`, audit
 * B-1 P3) on the reasoning that a secret interpolated into an `Error` string
 * cannot be reached by `redact`. That reasoning does not stop at 5xx: there
 * are forty-odd `log.warn({ err }, …)` sites in the routes, catching and
 * reporting errors that never become a 500, and every one of them went to the
 * default serializer raw.
 *
 * A `pg` error is the case that makes this concrete rather than theoretical.
 * Postgres puts the offending row values in `detail`, so a duplicate signup
 * logs
 *
 *     Key (email)=(jane@example.com) already exists.
 *
 * — an address in the clear, from a field neither `redact` nor `scrubError`
 * looks at: the first addresses properties by name and this is a substring of
 * one, and the second keeps only `name`/`message`/`stack`.
 *
 * So this scrubs *every string* the serializer emits rather than the two
 * text fields anybody thought to name, and passes non-strings through
 * untouched. That last part is the reason `scrubError` is not simply reused
 * here: it drops `code` and `constraint`, and "which unique index fired" is
 * the whole diagnostic value of a 23505.
 */
export function serializeError(err: unknown): unknown {
  return scrubStrings(stdSerializers.err(err as Error), 0);
}

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
    // Fastify merges its own defaults *under* the instance's
    // (`Object.assign({}, opts.serializers, instance[serializersSym])`), so
    // these two win and `res` keeps serializing as it always did.
    serializers: { req: serializeRequest, err: serializeError },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    base: { service: opts.service },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
