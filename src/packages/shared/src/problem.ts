import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { databaseUnavailableReason } from './failure.js';

/**
 * Scrubs secrets/PII that can slip into a free-text error `message` or `stack`
 * (audit B-1 P3). Pino's `redact` paths only cover structured fields, so a
 * thrown `Error("... postgres://user:pw@host ...")` would otherwise reach the
 * logs verbatim. Applied only to the 5xx log line; the client body never
 * includes the message.
 */
export function scrubSensitive(text: string): string {
  if (!text) return text;
  return (
    text
      // credentials embedded in DSNs: keep scheme + host, drop user:password
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s:/@]+@/gi, '$1[REDACTED]@')
      // bearer / authorization tokens
      .replace(/\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1[REDACTED]')
      // JWTs (three base64url segments)
      .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED-JWT]')
      // common API-key shapes (sk-..., AKIA..., long hex/base64 secrets)
      .replace(/\b(?:sk|rk|pk)[-_][A-Za-z0-9]{16,}\b/g, '[REDACTED-KEY]')
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED-KEY]')
      // email addresses
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED-EMAIL]')
      // US SSN
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED-SSN]')
  );
}

/** Returns a log-safe view of an error with message/stack scrubbed. */
export function scrubError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: scrubSensitive(err.message),
      stack: err.stack ? scrubSensitive(err.stack) : undefined,
    };
  }
  return { message: scrubSensitive(String(err)) };
}

/**
 * `decodeURIComponent` that answers the input rather than throwing.
 *
 * Applied to a URL before {@link scrubSensitive} because every scrub pattern
 * matches literal text and a browser sends `ada%40example.com`, not
 * `ada@example.com` — so a percent-encoded address walked straight past the
 * redaction that exists for it. A malformed escape (`%zz`) is a string a client
 * chose and is kept as-is; it is then scrubbed like any other.
 */
function decodedUrl(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/**
 * Query parameters whose value is a credential or an identifier, redacted by
 * *name* rather than by the shape of what they hold.
 *
 * {@link scrubSensitive} matches value shapes — a DSN, a JWT, an `sk-` key, an
 * address — and that is the wrong instrument for a query string, because the
 * credentials this API actually puts in one have no distinguishing shape at
 * all:
 *
 *   * `token` on `/api/v1/unsubscribe` is `<base64url>.<base64url>`
 *     (domain/unsubscribeToken.ts). Two segments, so the three-segment JWT rule
 *     does not match it, and nothing else does either.
 *   * `code` on the four OAuth callbacks — Google SSO, accounting, HRIS and
 *     cap-table sync — is an authorization code, which is an opaque
 *     provider-chosen string that is exchangeable for an access token for the
 *     minute or so before it is spent.
 *
 * `state` is on the list for a different reason. It *is* a JWT today, so the
 * JWT rule already covers it — but only by coincidence of the signing format
 * somebody chose in another module, and `unsubscribeToken` is the standing
 * proof that such a format can change to something shapeless without anyone
 * thinking about this file. Naming it here means the coverage does not depend
 * on that. The cost is real and small: `?state=draft` on the two valuation
 * listing routes is a bounded workflow enum, not a secret, and it now reads
 * `[REDACTED]` in the logs.
 *
 * Deliberately absent: `q`. Free-text search is the single most useful query
 * parameter to have in a log line when a search 500s, and what makes it
 * sensitive is a client typing an address into it — a *value* shape, which is
 * exactly what {@link scrubSensitive} is good at.
 */
export const SENSITIVE_QUERY_PARAMS: readonly string[] = [
  // bearer credentials that travel in a URL because a header cannot reach here:
  // a mailbox provider's one-click POST, an OAuth redirect, a signing link.
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'code',
  'state',
  'signature',
  'sig',
  // provider material
  'secret',
  'client_secret',
  'key',
  'api_key',
  'apikey',
  // session and login
  'auth',
  'authorization',
  'session',
  'sid',
  'password',
  'passwd',
  'pwd',
  // personal identifiers; the address patterns in scrubSensitive catch a
  // well-formed value, and this catches the rest.
  'email',
];

const SENSITIVE_QUERY_PARAM_SET = new Set(SENSITIVE_QUERY_PARAMS);

/**
 * A request URL with credential-bearing query parameters blanked, then scrubbed
 * as free text.
 *
 * Both halves are needed and neither subsumes the other: the parameter list
 * catches a shapeless credential under a known name, and {@link scrubSensitive}
 * catches a shaped secret under a name nobody predicted — including in the
 * path, which is why it runs over the whole string rather than the query alone.
 *
 * Splitting happens on the raw string and decoding happens per component,
 * never the other way round. Decoding the URL whole and *then* splitting means
 * a `%26` inside somebody's search text becomes a separator, the string
 * re-parses into parameters the client never sent, and which name a value sits
 * under is no longer decided by the request — it is decided by the contents of
 * another value. Deciding per raw pair keeps that mapping fixed. The name is
 * decoded for the comparison itself, so `to%6Ben=` is still `token`.
 */
export function scrubUrl(url: string): string {
  const cut = url.indexOf('?');
  const path = scrubSensitive(decodedUrl(cut === -1 ? url : url.slice(0, cut)));
  if (cut === -1) return path;
  const query = url
    .slice(cut + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return scrubSensitive(decodedUrl(pair));
      const name = scrubSensitive(decodedUrl(pair.slice(0, eq)));
      if (SENSITIVE_QUERY_PARAM_SET.has(name.toLowerCase())) return `${name}=[REDACTED]`;
      return `${name}=${scrubSensitive(decodedUrl(pair.slice(eq + 1)))}`;
    })
    .join('&');
  return `${path}?${query}`;
}

/**
 * The request and actor facts a 5xx line needs to be actionable on its own.
 *
 * The line used to carry the error and nothing else. Pino adds `reqId`, so in
 * principle everything else was recoverable by finding the matching "incoming
 * request" line — which works while you have both, and does not while you are
 * reading the one line somebody pasted into an incident channel, or a log
 * search scoped to `level=error`, or an alert built on the same. Two facts were
 * not recoverable at all: which route pattern matched (the URL has the ids
 * substituted in, so grouping 500s by endpoint means re-deriving it), and who
 * was making the request. "Is this one customer or everyone" is the first
 * question asked of a spike in 500s and the logs could not answer it.
 *
 * What is deliberately *not* here: anything identifying a person beyond their
 * id. Roles and partner id say what kind of caller hit this and whose tenant
 * they were in — the shape of the failure — while the email, name and company
 * that would name them are all on the pino redact list for good reason. The URL
 * is decoded and scrubbed on the way in, because query strings on this API
 * carry free-text search (`?q=`) that clients type addresses into.
 */
/**
 * The API-token decoration {@link requestErrorContext} reads off a request.
 *
 * Exported so the service that *sets* it can declare its own context type as an
 * extension of this one, which turns a structural coincidence into something
 * tsc checks. It was a coincidence, and it did not hold: this reader looked up
 * `apiToken.id` while the only assignment in the estate wrote `tokenId`, so the
 * field resolved to undefined on every request that had a token and the key
 * never appeared in a log line. Nothing could catch that — shared cannot import
 * the service, the service never mentioned this reader, and the test that
 * covered it built its own fixture from the database row's spelling.
 */
export interface RequestApiToken {
  tokenId: string;
  /** null for a personal token, which carries its owner's own scope. */
  partnerId: string | null;
}

export function requestErrorContext(req: FastifyRequest): Record<string, unknown> {
  // Structurally typed rather than imported: `principal` and `apiToken` are
  // decorations the valuation service adds, and shared cannot depend on it.
  const r = req as FastifyRequest & {
    principal?: { id?: unknown; roles?: unknown; partnerId?: unknown } | null;
    apiToken?: Partial<RequestApiToken> | null;
    routeOptions?: { url?: unknown };
  };
  const route = typeof r.routeOptions?.url === 'string' ? r.routeOptions.url : undefined;
  const principal = r.principal ?? null;
  const apiToken = r.apiToken ?? null;
  return {
    method: req.method,
    ...(route ? { route } : {}),
    url: scrubUrl(req.url),
    actor: principal
      ? {
          user_id: principal.id,
          roles: principal.roles,
          partner_id: principal.partnerId ?? null,
          // A partner API call authenticates as its token's creating user, so
          // the principal alone cannot tell a human session from an
          // integration — and they fail for different reasons.
          ...(apiToken ? { api_token_id: apiToken.tokenId } : {}),
        }
      : 'anonymous',
  };
}

/**
 * RFC 9457 application/problem+json error (api-design.md §1).
 */
export class ApiProblem extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail?: string;
  readonly extensions?: Record<string, unknown>;
  /** Seconds until the caller should retry — set on 429s so the error handler
   *  can emit a `retry-after` header without every rate-limited route
   *  repeating that plumbing. */
  readonly retryAfterSeconds?: number;

  constructor(args: {
    status: number;
    title: string;
    type?: string;
    detail?: string;
    extensions?: Record<string, unknown>;
    retryAfterSeconds?: number;
  }) {
    super(args.detail ?? args.title);
    this.status = args.status;
    this.title = args.title;
    this.type = args.type ?? 'about:blank';
    this.detail = args.detail;
    this.extensions = args.extensions;
    this.retryAfterSeconds = args.retryAfterSeconds;
  }

  toBody(instance?: string): Record<string, unknown> {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      ...(this.detail ? { detail: this.detail } : {}),
      ...(instance ? { instance } : {}),
      ...(this.retryAfterSeconds !== undefined ? { retry_after_seconds: this.retryAfterSeconds } : {}),
      ...this.extensions,
    };
  }
}

export const problems = {
  badRequest: (detail?: string, extensions?: Record<string, unknown>) =>
    new ApiProblem({
      status: 400,
      title: 'Bad Request',
      type: 'urn:n409:problem:bad-request',
      detail,
      extensions,
    }),
  unauthorized: (detail = 'Authentication required') =>
    new ApiProblem({ status: 401, title: 'Unauthorized', type: 'urn:n409:problem:unauthorized', detail }),
  /**
   * `extensions` here for the same reason `badRequest` has them: a 403 that
   * explains itself in prose still needs a token an integration can branch on,
   * and the prose is the part that changes. See `domain/accessProblem.ts` for
   * the `required_access` vocabulary this carries.
   */
  forbidden: (detail = 'Not allowed', extensions?: Record<string, unknown>) =>
    new ApiProblem({ status: 403, title: 'Forbidden', type: 'urn:n409:problem:forbidden', detail, extensions }),
  notFound: (detail = 'Resource not found', extensions?: Record<string, unknown>) =>
    new ApiProblem({ status: 404, title: 'Not Found', type: 'urn:n409:problem:not-found', detail, extensions }),
  conflict: (detail?: string) =>
    new ApiProblem({ status: 409, title: 'Conflict', type: 'urn:n409:problem:conflict', detail }),
  unprocessable: (detail?: string, extensions?: Record<string, unknown>) =>
    new ApiProblem({
      status: 422,
      title: 'Unprocessable Content',
      type: 'urn:n409:problem:validation',
      detail,
      extensions,
    }),
  tooManyRequests: (detail = 'Too many requests — try again later', retryAfterSeconds?: number) =>
    new ApiProblem({
      status: 429,
      title: 'Too Many Requests',
      type: 'urn:n409:problem:rate-limited',
      detail,
      retryAfterSeconds,
    }),
  serviceUnavailable: (detail = 'Service temporarily unavailable') =>
    new ApiProblem({
      status: 503,
      title: 'Service Unavailable',
      type: 'urn:n409:problem:unavailable',
      detail,
    }),
};

/**
 * Stable problem types for the failures fastify raises before a handler runs.
 *
 * These are the errors no route throws on purpose — a body that is not JSON, a
 * content-type nothing can parse, a payload over the limit. They were rendered
 * as `type: "about:blank"` with fastify's English sentence as the `title`,
 * which is the one shape a client cannot branch on: every other failure on this
 * platform carries a `urn:n409:problem:*` type, so an integration that switches
 * on `type` fell through to its default case for exactly the errors it is most
 * likely to hit while being written. Worse, the title moved with the fastify
 * version — "Body cannot be empty when content-type is set to
 * 'application/json'" is prose, not an identifier, and matching on it is the
 * only thing a client could have done.
 *
 * Keyed by `err.code`, which fastify guarantees, rather than by status: 400 is
 * both "unparseable JSON" and "empty body", and a client retrying the second
 * should not retry the first.
 */
const FASTIFY_PROBLEM_TYPES: Readonly<Record<string, string>> = {
  FST_ERR_CTP_INVALID_JSON_BODY: 'urn:n409:problem:malformed-body',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'urn:n409:problem:empty-body',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'urn:n409:problem:unsupported-media-type',
  FST_ERR_CTP_BODY_TOO_LARGE: 'urn:n409:problem:payload-too-large',
  FST_ERR_VALIDATION: 'urn:n409:problem:validation',
};

/** Fallback type for a status fastify raised that the table does not name. */
const STATUS_PROBLEM_TYPES: Readonly<Record<number, string>> = {
  400: 'urn:n409:problem:bad-request',
  401: 'urn:n409:problem:unauthorized',
  403: 'urn:n409:problem:forbidden',
  404: 'urn:n409:problem:not-found',
  405: 'urn:n409:problem:method-not-allowed',
  406: 'urn:n409:problem:not-acceptable',
  409: 'urn:n409:problem:conflict',
  413: 'urn:n409:problem:payload-too-large',
  415: 'urn:n409:problem:unsupported-media-type',
  422: 'urn:n409:problem:validation',
  429: 'urn:n409:problem:rate-limited',
};

/**
 * The `title` a status gets, which RFC 9457 asks to be stable across
 * occurrences — so it is the reason phrase, and fastify's sentence becomes the
 * `detail`, where a message that varies belongs.
 */
const REASON_PHRASES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  409: 'Conflict',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
};

/**
 * Installs a fastify error handler that renders every error as problem+json
 * and never leaks internals on 5xx.
 */
export function registerProblemHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ApiProblem) {
      if (err.retryAfterSeconds !== undefined) {
        void reply.header('retry-after', String(err.retryAfterSeconds));
      }
      return reply.status(err.status).type('application/problem+json').send(err.toBody(req.url));
    }
    const fastifyErr = err as { statusCode?: number; message?: string; code?: string };
    const status = fastifyErr.statusCode && fastifyErr.statusCode < 500 ? fastifyErr.statusCode : 500;
    /**
     * The database could not answer, which is not the same thing as the request
     * being wrong.
     *
     * Every route in this estate reaches Postgres through a pool with a
     * `statement_timeout`, an `idle_in_transaction_session_timeout` and ten
     * connections. Each of those bounds exists to make a bad minute survivable,
     * and each of them raises when it fires: a deadlock the database picked this
     * transaction to lose (`40P01`), a statement that ran past its ceiling
     * (`57014`), a connection dropped by a failover (`08006`), a checkout that
     * waited out `connectionTimeoutMillis` because every client was busy. All
     * of them are the server being momentarily unable, all of them pass, and
     * all of them arrived here as `500 urn:n409:problem:internal` — a body
     * whose catalogued advice is "retry with backoff, and send an
     * `Idempotency-Key`, the write may have landed". For a rolled-back
     * transaction that is both alarming and wrong.
     *
     * Placed before the 5xx branch and after the `ApiProblem` one, so a route
     * that already caught its own database error and said something better
     * keeps saying it. The log line is unchanged in substance — same scrub,
     * same context — but at `warn` with the SQLSTATE, because a busy database
     * is not an unhandled error and a page for one is a page nobody keeps.
     */
    const dbReason = databaseUnavailableReason(err);
    if (dbReason !== null) {
      req.log.warn(
        { err: scrubError(err), ...requestErrorContext(req), failure_reason: dbReason },
        'database unavailable',
      );
      return reply.status(503).type('application/problem+json').send({
        type: 'urn:n409:problem:database-unavailable',
        title: 'Service Unavailable',
        status: 503,
        detail: 'The database is temporarily unable to serve this request. Nothing was changed.',
        instance: req.url,
      });
    }
    if (status >= 500) {
      // Scrub the free-text message/stack — pino `redact` only masks structured
      // fields, so secrets interpolated into an Error string would leak (B-1 P3).
      req.log.error({ err: scrubError(err), ...requestErrorContext(req) }, 'unhandled error');
      return reply.status(status).type('application/problem+json').send({
        type: 'urn:n409:problem:internal',
        title: 'Internal Server Error',
        status,
        instance: req.url,
      });
    }
    // A 4xx fastify raised describes the *request*, so its message is safe to
    // echo — but as `detail`, so `title` stays the constant a client can read.
    const type =
      (fastifyErr.code ? FASTIFY_PROBLEM_TYPES[fastifyErr.code] : undefined) ??
      STATUS_PROBLEM_TYPES[status] ??
      'about:blank';
    return reply
      .status(status)
      .type('application/problem+json')
      .send({
        type,
        title: REASON_PHRASES[status] ?? 'Request Error',
        status,
        ...(fastifyErr.message ? { detail: fastifyErr.message } : {}),
        instance: req.url,
      });
  });

  app.setNotFoundHandler((req, reply) =>
    reply
      .status(404)
      .type('application/problem+json')
      .send({ type: 'urn:n409:problem:not-found', title: 'Not Found', status: 404, instance: req.url }),
  );
}
