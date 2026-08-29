/**
 * Is this failure worth trying again, or is trying again just a slower way to
 * fail?
 *
 * Every retry loop in the estate already answers that question, and each one
 * answers it differently. `clients/internal.ts` calls a 4xx permanent and
 * everything else retryable. The email outbox has its own ladder. The AI
 * service's `_post_with_retry` retries transport errors and 5xx. None of them
 * are wrong, but none of them agree, and the disagreements are invisible from
 * any one file — so a failure mode that one layer classifies correctly gets
 * re-classified by the layer above it, and the retry either doesn't happen or
 * happens forever.
 *
 * This is the one table. It is deliberately a *classifier* and not a retry
 * policy: it says what kind of failure this is, and the caller decides what to
 * do about it. That split matters because the two questions genuinely differ on
 * one axis — idempotency. A request we abandoned at our own deadline is a
 * transient *condition* (the upstream is slow, not broken, and will likely be
 * fine in a minute) and simultaneously a request that must not be re-sent,
 * because the upstream accepted it and is still working. `postJson` gets that
 * right today with its `abandoned` flag, and nothing here overrides it: the
 * classifier reports `transient`, the caller keeps its own guard.
 *
 * ## The default is `permanent`
 *
 * An error nothing here recognises is classified permanent, which is the
 * opposite of what a retry-everything loop does and is the whole point. A retry
 * against an unrecognised failure is the failure mode that turns one broken
 * dependency into an outage: the requests pile up, each one holding a
 * connection and a thread, and the thing that was merely returning errors is
 * now also saturated. Retrying is the special case that has to be argued for,
 * entry by entry, which is what the tables below are.
 */

/** What kind of failure this is. */
export type FailureKind = 'transient' | 'permanent';

export interface FailureClass {
  kind: FailureKind;
  /**
   * Stable slug naming the rule that fired — `pg.40001`, `http.503`,
   * `syscall.ECONNREFUSED`, `unclassified`. Logged and alerted on, so it is
   * written to be grepped rather than read as prose.
   */
  reason: string;
  /** Convenience: `kind === 'transient'`. A retry is worth *considering*. */
  retryable: boolean;
}

/**
 * An error that already knows what it is.
 *
 * Set by code that has context this file cannot have — a domain error that
 * knows its own precondition can never come true, say. Honoured ahead of every
 * table below, so a caller is never forced to argue with the classifier.
 */
export const FAILURE_KIND = Symbol.for('n409.failure.kind');

export interface KindedError {
  [FAILURE_KIND]?: FailureKind;
}

/** Tags an error with its classification, overriding every rule below. */
export function markFailure<E extends object>(err: E, kind: FailureKind): E {
  (err as E & KindedError)[FAILURE_KIND] = kind;
  return err;
}

const transient = (reason: string): FailureClass => ({ kind: 'transient', reason, retryable: true });
const permanent = (reason: string): FailureClass => ({ kind: 'permanent', reason, retryable: false });

// ── Syscall / transport ───────────────────────────────────────────────────────

/**
 * Socket-level failures where the condition is about the *link*, not the
 * request, so the same bytes sent a second later may well succeed.
 *
 * `EAI_AGAIN` is here and `ENOTFOUND` is deliberately not. Both come out of the
 * resolver and they mean opposite things: EAI_AGAIN is "the resolver could not
 * answer right now" (a DNS outage, a cold cache, a rate-limited resolver) and
 * ENOTFOUND is "the resolver answered, and there is no such name". The second
 * one is a typo in a config file, and every retry against it is a retry against
 * a hostname that will never exist.
 */
const TRANSIENT_SYSCALLS = new Set([
  'ECONNREFUSED', // nobody listening yet — a restarting upstream, the case retries exist for
  'ECONNRESET', // peer dropped an established socket mid-exchange
  'EPIPE', // wrote to a socket the peer had already closed
  'ETIMEDOUT', // kernel gave up on the connection
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'EAI_AGAIN', // resolver could not answer *right now* — see note above
  'EBUSY',
  'EMFILE', // out of file descriptors: self-inflicted, but it does pass
  'ENFILE',
  'EADDRINUSE', // a port still in TIME_WAIT during a restart
  'UND_ERR_CONNECT_TIMEOUT', // undici's own connect timeout
  'UND_ERR_SOCKET',
]);

const PERMANENT_SYSCALLS = new Set([
  'ENOTFOUND', // no such host — configuration, not weather
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED', // expired until somebody renews it; a retry is not that
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_INVALID_URL',
]);

// ── HTTP ──────────────────────────────────────────────────────────────────────

/**
 * Status codes worth trying again.
 *
 * Everything else in 4xx is the caller's request being wrong, and the identical
 * request will be identically wrong next time. 501 and 505 are in 5xx but
 * belong with those: the server is telling you it will never do this.
 */
const TRANSIENT_STATUS = new Set([
  408, // request timeout
  409, // conflict — an optimistic-concurrency loser, retried against fresh state
  423, // locked
  425, // too early
  429, // rate limited — the one every provider actually uses
  500,
  502,
  503,
  504,
  507, // insufficient storage
  509,
  520, // Cloudflare's grab-bag origin errors, seen through any proxy
  521,
  522,
  523,
  524,
  598,
  599,
]);

/**
 * Classify an HTTP status on its own, for callers holding a response rather
 * than an error.
 *
 * A status below 400 is not a failure, and there is no honest classification
 * for one — it is reported `permanent` purely so that a caller who asks anyway
 * does not get told to retry a success.
 */
export function classifyStatus(status: number): FailureClass {
  if (TRANSIENT_STATUS.has(status)) return transient(`http.${status}`);
  // Everything else in 5xx (501, 505, and any bespoke code) is the server
  // saying it will never do this, which puts it with the 4xx.
  return permanent(`http.${status}`);
}

// ── Postgres ──────────────────────────────────────────────────────────────────

/**
 * SQLSTATEs where the same statement, run again, has a real chance of working.
 *
 * The classes matter more than the individual codes. `08` is the whole
 * connection-exception class and every member of it is a link problem. `40001`
 * and `40P01` are the two the database *asks* you to retry — a serialization
 * failure is not an error in the statement, it is the database telling you it
 * picked your transaction to lose. `57P01` is what a Postgres restart or a
 * failover looks like from a client, and `57014` is our own `statement_timeout`
 * firing, which on a merely-busy database passes.
 *
 * `53300` (too_many_connections) is the interesting one: retrying it works, and
 * retrying it *hard* is how a connection-starved database stays starved. It is
 * transient here, and the backoff below is what keeps that honest.
 */
const TRANSIENT_SQLSTATE = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53000', // insufficient_resources
  '53100', // disk_full
  '53200', // out_of_memory
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
  '55006', // object_in_use
  '55P03', // lock_not_available
  '57014', // query_canceled — our statement_timeout
  '57P01', // admin_shutdown — restart/failover
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now — still starting up
  '58030', // io_error
  '58P01', // undefined_file
  'XX000', // internal_error: rare, but seen on replica promotion
]);

/** SQLSTATE classes (first two chars) that are transient in their entirety. */
const TRANSIENT_SQLSTATE_CLASS = new Set([
  '08', // connection_exception — every member
]);

/**
 * The SQLSTATE on a Postgres error, or null when `err` is not one.
 *
 * Both namespaces live on `.code` and they overlap, which is the entire
 * difficulty here: a SQLSTATE is five alphanumerics, and so are the syscall
 * names `EPIPE` and `EBUSY`. Matching on shape alone reads those two as
 * unrecognised SQLSTATEs and classifies them permanent — the exact opposite of
 * what they are, and a silent one, because the wrong answer looks like a
 * confident answer.
 *
 * So the shape is not enough on its own. Either the error carries `severity`
 * (which every error libpq produces has, and nothing else does), or the code
 * starts with a digit, which no errno name does.
 */
function pgCodeOf(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return null;
  const looksLikePgError = typeof (err as { severity?: unknown }).severity === 'string';
  return looksLikePgError || /^[0-9]/.test(code) ? code : null;
}

// ── The classifier ────────────────────────────────────────────────────────────

/** Everything the classifier can be handed, beyond a bare `Error`. */
export interface ClassifyHint {
  /** HTTP status, when the caller has one and the error does not carry it. */
  status?: number | null;
}

/**
 * What kind of failure `err` is.
 *
 * Order is deliberate: an explicit mark beats everything, then the structured
 * identifiers (SQLSTATE, syscall code, HTTP status), and message text is used
 * only where nothing structured exists — `AbortError` and `TimeoutError` reach
 * us as a `name` and nothing else.
 */
export function classifyFailure(err: unknown, hint: ClassifyHint = {}): FailureClass {
  if (err && typeof err === 'object') {
    const marked = (err as KindedError)[FAILURE_KIND];
    if (marked === 'transient') return transient('marked');
    if (marked === 'permanent') return permanent('marked');
  }

  // Postgres, before syscalls: a pg error carries `code` too, and reading its
  // SQLSTATE as a syscall name would classify every one of them `unclassified`.
  const sqlstate = pgCodeOf(err);
  if (sqlstate) {
    if (TRANSIENT_SQLSTATE.has(sqlstate)) return transient(`pg.${sqlstate}`);
    if (TRANSIENT_SQLSTATE_CLASS.has(sqlstate.slice(0, 2))) return transient(`pg.${sqlstate}`);
    return permanent(`pg.${sqlstate}`);
  }

  if (err && typeof err === 'object') {
    const raw = (err as { code?: unknown }).code;
    const code = typeof raw === 'string' ? raw : null;
    if (code) {
      if (TRANSIENT_SYSCALLS.has(code)) return transient(`syscall.${code}`);
      if (PERMANENT_SYSCALLS.has(code)) return permanent(`syscall.${code}`);
    }

    // fetch() wraps the real failure: `TypeError: fetch failed` with the
    // syscall error on `cause`. Without this every network failure in the Node
    // services classifies `unclassified` and stops being retried.
    const cause = (err as { cause?: unknown }).cause;
    if (cause && cause !== err) {
      const inner = classifyFailure(cause, hint);
      if (inner.reason !== 'unclassified') return inner;
    }

    const name = (err as { name?: unknown }).name;
    // Our own deadline, not their failure. Transient as a *condition* — the
    // upstream is slow, and slow passes. Whether the request may be re-sent is
    // a separate question this classifier deliberately does not answer; see the
    // header note and `postJson`'s `abandoned` flag.
    if (name === 'TimeoutError' || name === 'AbortError' || name === 'HeadersTimeoutError') {
      return transient(`abort.${String(name)}`);
    }
  }

  const status = hint.status ?? statusOf(err);
  if (typeof status === 'number' && status >= 400) return classifyStatus(status);

  return permanent('unclassified');
}

/** An HTTP status carried on the error itself, under any of the usual names. */
function statusOf(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  for (const key of ['status', 'statusCode'] as const) {
    const value = (err as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/** Shorthand for the common question. */
export function isTransient(err: unknown, hint: ClassifyHint = {}): boolean {
  return classifyFailure(err, hint).kind === 'transient';
}

// ── Backoff ───────────────────────────────────────────────────────────────────

export interface BackoffOptions {
  /** Delay before the first retry (ms). Doubles from there. */
  baseMs?: number;
  /** Ceiling on any single delay (ms), before jitter. */
  maxMs?: number;
  /**
   * Jitter as a fraction of the delay, 0–1. Full jitter (1) is the default and
   * is the point of the whole function: without it, N callers who failed
   * against the same outage retry at the same instant, and the recovering
   * dependency is hit by a synchronised wave at every step of the ladder. The
   * literature calls it a thundering herd; from the database's side it is
   * indistinguishable from the original outage.
   */
  jitter?: number;
  /** Injectable randomness, so a test can assert the ladder rather than a range. */
  random?: () => number;
}

/**
 * Delay before retry number `attempt` (0-based: 0 is the delay before the
 * *first* retry), exponential with jitter.
 */
export function backoffDelayMs(attempt: number, opts: BackoffOptions = {}): number {
  const baseMs = opts.baseMs ?? 250;
  const maxMs = opts.maxMs ?? 30_000;
  const jitter = Math.min(1, Math.max(0, opts.jitter ?? 1));
  const random = opts.random ?? Math.random;
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  // Full jitter: uniform over [exponential*(1-jitter), exponential]. At
  // jitter=0 this is the bare exponential, which is what tests want and what
  // production should not have.
  const floor = exponential * (1 - jitter);
  return Math.round(floor + (exponential - floor) * random());
}

// ── Alerting ──────────────────────────────────────────────────────────────────

export interface FailureLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Log a failure at the level its class deserves, with a field an alert rule can
 * match on.
 *
 * The asymmetry is the point. A transient failure is `warn`: it is expected,
 * the retry is going to handle it, and paging somebody for one is how alerting
 * gets muted. A permanent failure is `error` and carries `alert: true` — it is
 * not going to fix itself, no retry is coming, and the only thing that changes
 * it is a person. That field is the contract with whatever scrapes the log;
 * `reason` is what tells them which of the tables above fired.
 */
export function logFailure(
  log: FailureLogger,
  err: unknown,
  context: Record<string, unknown>,
  message: string,
  hint: ClassifyHint = {},
): FailureClass {
  const failure = classifyFailure(err, hint);
  const fields = { ...context, err, failure_kind: failure.kind, failure_reason: failure.reason };
  if (failure.kind === 'transient') {
    log.warn(fields, message);
  } else {
    log.error({ ...fields, alert: true }, message);
  }
  return failure;
}

// ── The database, seen from a request handler ────────────────────────────────

/**
 * The two pool failures that carry no SQLSTATE, because Postgres never saw
 * them.
 *
 * `pg-pool` builds both with `new Error(message)` and nothing else — no `code`,
 * no `severity` — so every structured branch in {@link classifyFailure} misses
 * them and they fall through to `permanent('unclassified')`. Matching on the
 * message is what matching on a message always is: brittle. It is done here
 * anyway, and narrowly, because the alternative is worse. A pool that has run
 * out of connections is the single most likely way this service fails under
 * load, and the answer it gave was a 500 telling the caller the request itself
 * had gone wrong.
 *
 * Anchored rather than substring-matched so an application error that happens
 * to quote one of these sentences is not mistaken for the driver raising it.
 */
const POOL_FAILURES: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // Every client is checked out and `connectionTimeoutMillis` expired waiting.
  { pattern: /^timeout exceeded when trying to connect$/, reason: 'pg.pool_exhausted' },
  // A checkout raced the drain at shutdown. Transient in the only sense that
  // matters to a caller: this instance is going away, another one will answer.
  { pattern: /^Cannot use a pool after calling end on the pool$/, reason: 'pg.pool_closed' },
];

/**
 * Why the database could not answer, or null if this failure is not the
 * database being unable to answer.
 *
 * Deliberately narrower than `isTransient`. Everything this returns non-null
 * for becomes a 503 at the HTTP boundary (see `registerProblemHandler`), and a
 * 503 is a claim: *the request was not served because the server could not
 * serve it, and the same request later can be*. A SQLSTATE the database asks
 * you to retry is exactly that claim. An `AbortError` is not — the commonest
 * one in a Fastify handler is the *client* going away — and a 5xx carried on
 * some upstream's error object is `upstream`'s business, not this one's. Both
 * of those are transient by `classifyFailure` and neither may reach this.
 *
 * So this reads the two structured facts that can only mean the database:
 * a SQLSTATE in the transient tables above, and the pool's own two messages.
 * Everything else keeps the 500 it had, which is the conservative direction —
 * an unrecognised failure claiming to be a retryable database blip would send
 * clients back at a service whose actual problem is a bug.
 */
export function databaseUnavailableReason(err: unknown): string | null {
  const sqlstate = pgCodeOf(err);
  if (sqlstate) {
    if (TRANSIENT_SQLSTATE.has(sqlstate)) return `pg.${sqlstate}`;
    if (TRANSIENT_SQLSTATE_CLASS.has(sqlstate.slice(0, 2))) return `pg.${sqlstate}`;
    return null;
  }
  if (err instanceof Error && err.name === 'Error') {
    for (const { pattern, reason } of POOL_FAILURES) {
      if (pattern.test(err.message)) return reason;
    }
  }
  return null;
}

// ── Describing a transport failure to a person ────────────────────────────────

/**
 * `fetch` reports every transport failure as the same four characters.
 *
 * Node's `fetch` rejects with `TypeError: fetch failed` for a refused
 * connection, a name that does not resolve, an expired certificate and a reset
 * socket alike; the fact that distinguishes them is a syscall `code` one level
 * down, on `cause`. `classifyFailure` already walks that chain — it has to, or
 * every network failure in the estate would classify `unclassified` and stop
 * being retried — but it walks it to answer *whether to retry*, and throws the
 * identity away on the way out.
 *
 * So every place that records `err.message` for somebody to read records the
 * string `fetch failed`. That is not a small population and the readers are not
 * operators with a log next to them: it is the `error` column of a partner's
 * own webhook delivery log, the failure line on an email in the delivery trail,
 * the message on a failed HRIS sync. A partner whose endpoint is behind an
 * expired certificate, or whose DNS record was deleted, is told "fetch failed"
 * and has nowhere to go with it — while the answer was one property away the
 * whole time.
 *
 * This turns that chain into a sentence naming the condition. It is the
 * *transport* half only, and deliberately so: an upstream that answered is
 * describing itself and its own words are better than anything here (see
 * `stripeProblem`, `toProblem`). This speaks only for the exchanges where
 * nobody answered at all.
 */
const TRANSPORT_REASONS: ReadonlyMap<string, string> = new Map([
  ['ECONNREFUSED', 'the connection was refused — nothing is listening on that host and port'],
  ['ECONNRESET', 'the connection was reset before a reply arrived'],
  ['EPIPE', 'the connection closed while the request was still being sent'],
  ['ETIMEDOUT', 'the connection timed out'],
  ['EHOSTUNREACH', 'the host is unreachable from this network'],
  ['ENETUNREACH', 'the network is unreachable'],
  ['ENETDOWN', 'the network is unreachable'],
  ['ENETRESET', 'the connection was reset by the network'],
  ['ENOTFOUND', 'the host name does not resolve — check the address for a typo or a deleted DNS record'],
  ['EAI_AGAIN', 'the host name could not be resolved just now (DNS is not answering)'],
  ['UND_ERR_CONNECT_TIMEOUT', 'the connection timed out'],
  ['UND_ERR_SOCKET', 'the connection closed unexpectedly'],
  ['CERT_HAS_EXPIRED', 'the TLS certificate has expired — renew it and the deliveries resume'],
  [
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'the TLS certificate is self-signed, so it cannot be verified — use a certificate from a public authority',
  ],
  [
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'the TLS certificate chain is incomplete — the server must send its intermediate certificates',
  ],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'the TLS certificate is for a different host name than the one requested'],
  ['EPROTO', 'the TLS handshake failed'],
  ['ERR_INVALID_URL', 'the address is not a valid URL'],
]);

/** Deadlines, which arrive as a `name` and carry no code at all. */
const ABORT_NAMES: ReadonlyMap<string, string> = new Map([
  ['TimeoutError', 'it did not respond in time'],
  ['HeadersTimeoutError', 'it did not send response headers in time'],
  ['AbortError', 'the request was cancelled before a reply arrived'],
]);

/**
 * The message `fetch` uses for everything, and the two `undici` phrasings of
 * the same. Matched exactly rather than by substring: a message that *contains*
 * these words but says more is saying something, and should be kept.
 */
const OPAQUE_TRANSPORT_MESSAGES: ReadonlySet<string> = new Set([
  'fetch failed',
  'terminated',
  'other side closed',
  'socket hang up',
]);

/** The first syscall-ish `code` in an error's `cause` chain, if any. */
function transportCode(err: unknown, depth = 0): string | null {
  if (depth > 5 || !err || typeof err !== 'object') return null;
  const raw = (err as { code?: unknown }).code;
  if (typeof raw === 'string' && TRANSPORT_REASONS.has(raw)) return raw;
  const name = (err as { name?: unknown }).name;
  if (typeof name === 'string' && ABORT_NAMES.has(name)) return name;
  const cause = (err as { cause?: unknown }).cause;
  return cause && cause !== err ? transportCode(cause, depth + 1) : null;
}

/**
 * A sentence naming why an exchange failed, for a record a person will read.
 *
 * Returns the identified condition when there is one, the error's own message
 * when that message says something, and a plain statement of the fact when it
 * does not. Never throws and never returns an empty string, because every
 * caller is on a failure path already and a second failure there is a row that
 * records nothing at all.
 *
 * Not a replacement for a log: `err` itself should still go to the logger,
 * where the stack and the original message are worth having. This is what goes
 * in the column somebody opens a support ticket about.
 */
export function describeTransportFailure(err: unknown): string {
  const code = transportCode(err);
  if (code) return TRANSPORT_REASONS.get(code) ?? ABORT_NAMES.get(code)!;
  const message = err instanceof Error ? err.message : String(err ?? '');
  const trimmed = message.trim();
  if (trimmed === '' || OPAQUE_TRANSPORT_MESSAGES.has(trimmed.toLowerCase())) {
    return 'the request could not be completed and the connection reported no reason';
  }
  return trimmed;
}
