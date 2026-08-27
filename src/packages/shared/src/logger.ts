// `stdSerializers` is imported by name rather than reached through `pino.`:
// pino's own typings attach only "selected static members" to the callable
// named export, and `stdSerializers` is not among them, so `pino.stdSerializers`
// is a build error even though it resolves at runtime.
import { pino, stdSerializers, type Logger } from 'pino';
import { scrubSensitive, scrubUrl } from './problem.js';
import { currentActor, currentRequestId } from './requestContext.js';

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
  // …and the compound forms, for exactly the reason the OAuth block above
  // exists. `token` never covered `access_token`, and the same segment-by-
  // segment matching means `email` never covered `client_email` — a fact this
  // list was written without, twice. Every row this platform joins to a person
  // names the column after the *role* rather than the field: an audit event
  // carries `actor_email`, a grant carries `grantee_email`, the outbox carries
  // `to_email`, an upload carries `uploaded_by_email`. There are fourteen of
  // them and not one was redacted, so any line that logged such a row whole put
  // an address in the clear.
  //
  // Enumerated rather than matched by suffix because three fields ending in
  // `_email` are not addresses at all, and blanking them would cost diagnostics
  // for nothing: `marketing_email` is a *boolean* consent flag (the
  // `has_password` case — a predicate about a thing is not the thing),
  // `support_email` is the firm's published support address shown on its own
  // login page, and `auto_email` names a feature. `logger.test.ts` scans for
  // any `*_email`/`*_phone` property this list has not been told about and
  // holds those three as declared exceptions, so the next one fails the suite.
  'actor_email',
  'analyst_email',
  'author_email',
  'client_email',
  'created_by_email',
  'customer_email',
  'grantee_email',
  'invited_by_email',
  'member_email',
  'owner_email',
  'recipient_email',
  'reviewer_email',
  'to_email',
  'uploaded_by_email',
  'user_email',
  'to_phone',
  // Personal names under a role-shaped column. Deliberately only the
  // unambiguous ones: `*_name` is dominated on this platform by things that are
  // not people — `brand_name`, `company_name`, `plan_name`, `index_name`,
  // `service_name`, and `legal_name`, which is the *subject company's* legal
  // name and is the single most useful field in a valuation log line. So this
  // is a short hand-picked list rather than a family, and the scan in
  // logger.test.ts deliberately does not police `_name`; a check that reported
  // `index_name` forever is a check somebody deletes.
  'given_name',
  'family_name',
  'grantee_name',
  // Not merely a name: `alwaysTemplateVars` falls back to the *address* when it
  // holds no given name, so this field is an email address for every recipient
  // whose name we never captured — which is most of the ones a send goes to
  // from a form.
  'recipient_name',
  'signer_name',
  'owner_first_name',
  'owner_last_name',
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
  Array.from({ length: REDACT_DEPTH }, (_, depth) => (depth === 0 ? field : `${'*.'.repeat(depth)}${field}`)),
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

/**
 * The correlation id and the actor, on every line rather than on the lines that
 * remembered.
 *
 * Fastify binds `reqId` onto `req.log`, so a handler that logs through the
 * request's own logger is correlated and always was. Everything else in a
 * request is not: `app.log` inside a route, a module-level logger, a hook, and
 * — the case that matters most — work that outlives the response, like the
 * pipeline steps and the diagnostic writes this service deliberately does not
 * await. Those lines are exactly the ones an incident is reconstructed from,
 * and they were the ones with nothing to join on.
 *
 * The id was already available to all of them. `requestContext.ts` binds it to
 * an AsyncLocalStorage at `onRequest` so the internal client can forward it
 * downstream, and an AsyncLocalStorage follows the async work rather than the
 * logger object — so a mixin reading it correlates every line written anywhere
 * under the request, including after it ended.
 *
 * ## Why `requestId` and not `reqId`
 *
 * Pino merges a mixin's keys alongside a child logger's bindings rather than
 * letting one win, so a mixin emitting `reqId` puts **two** `reqId` fields in
 * the same JSON object on every `req.log` line — verified, not assumed. A
 * duplicate key is resolved differently by every parser downstream, and the one
 * that appears second would be the mixin's, so the aggregator's answer for
 * "which request" would depend on its JSON library. A distinct key cannot
 * collide. Inside a request both are present and both hold `req.id`, because
 * the hook binds the mixin's value from it.
 *
 * Outside a request — boot, a cron tick, a background sweep — there is no id
 * and the field is omitted rather than emitted empty, so "no requestId" keeps
 * meaning "not caused by a request" instead of "caused by one we lost".
 */
function requestIdMixin(): Record<string, string> {
  const requestId = currentRequestId();
  const actor = currentActor();
  return {
    ...(requestId ? { requestId } : {}),
    // Flat, and camelCase, for the same collision argument the note above
    // makes about `reqId`. The 5xx line carries a nested `actor` *object*
    // (problem.ts), and a mixin emitting a key a log call also passes is the
    // one shape that puts two of it in the JSON; these three names are used
    // nowhere else. Each is omitted when absent, so a missing `userId` keeps
    // meaning "nobody was authenticated" rather than "we lost who it was".
    ...(actor ? { userId: actor.userId } : {}),
    ...(actor?.partnerId ? { partnerId: actor.partnerId } : {}),
    ...(actor?.apiTokenId ? { apiTokenId: actor.apiTokenId } : {}),
  };
}

export function createLogger(opts: LoggerOptions): Logger {
  return pino({
    name: opts.service,
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    redact: { paths: [...REDACT_PATHS, ...(opts.redact ?? [])], censor: '[REDACTED]' },
    mixin: requestIdMixin,
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
