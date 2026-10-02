import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Counter } from '@n409/shared';
import { problems } from '@n409/shared';
import { FixedWindowRateLimiter } from '../plugins/rateLimit.js';
import { invalidBody } from '../domain/validationProblem.js';

/**
 * Where a crash in the browser is written down.
 *
 * The SPA has had an `ErrorBoundary` at four levels since the F-1 audit, and
 * its docstring says the error "is reported via onError rather than lost". No
 * call site ever passed an `onError`, so every render crash this platform has
 * had went to `console.error` in the user's own devtools — a place nobody on
 * this side has ever looked. There were no `window.onerror` or
 * `unhandledrejection` handlers either, so the same was true of every throw
 * outside a render.
 *
 * That is a whole tier of failure with no signal at all: a bad deploy that
 * blanks one route for every user produces an unchanged access log (the shell
 * and the bundle are both 200s), an unchanged error rate, and an unchanged set
 * of gauges. The first report comes from a client, by email, some hours later.
 *
 * ## What this endpoint is and is not
 *
 * It is a *counter* with a log line attached, not an error-tracking product.
 * `client_errors_total{kind}` is the signal — it is on the scrape endpoint,
 * which is the only channel anything on this box alerts from — and the log line
 * is what an operator reads once the counter has told them to look. Nothing is
 * stored in Postgres: these are unauthenticated reports from a hostile-capable
 * caller, and a table would be an unbounded write the caller controls.
 *
 * ## Why it is public, and what that costs
 *
 * A crash in the sign-in page happens to somebody who has no session, and a
 * crash that only signed-in users can report is a crash report missing exactly
 * the pages most likely to have one. So: unauthenticated, per-IP throttled like
 * the contact form, every field hard-capped in the schema, and answered `204`
 * so it discloses nothing and is worthless as an oracle.
 *
 * Every string is bounded here rather than trusted to the client, because the
 * client is the untrusted party in this exchange — `MAX_STACK` is the only
 * generous one, and a stack is the whole reason the report is worth having.
 * pino writes the line as JSON, so a newline in a message cannot forge a second
 * one.
 */

/** How many reports one address may file before we stop listening. */
const CLIENT_ERROR_LIMIT = 20;
const CLIENT_ERROR_WINDOW_MS = 5 * 60 * 1000;

const MAX_MESSAGE = 500;
const MAX_STACK = 4_000;
const MAX_URL = 500;
/**
 * And the one field on the log line that does not come out of the schema.
 *
 * Every string in the body is bounded here rather than trusted to the client,
 * on the stated ground that the client is the untrusted party in this exchange
 * — and then the line wrote `user-agent` straight through, which the same
 * untrusted party sets and which Node will carry up to its whole header
 * allowance. A real one is under 200 characters; anything past this is not a
 * browser identifying itself, and the first 200 bytes of it still say which
 * one it claims to be.
 */
const MAX_USER_AGENT = 200;

/**
 * Which of the three doors the error came through.
 *
 * A closed enum, because it is a metric label: anything the caller can put in a
 * label is a series they can mint, and `MAX_SERIES_PER_METRIC` is a ceiling
 * shared with every other metric on the endpoint.
 */
export const CLIENT_ERROR_KINDS = ['render', 'uncaught', 'unhandled_rejection'] as const;

const ReportBody = z
  .object({
    kind: z.enum(CLIENT_ERROR_KINDS),
    /** The constructor name — `TypeError`, `ChunkLoadError`. */
    name: z.string().trim().max(100).optional(),
    message: z.string().trim().max(MAX_MESSAGE),
    stack: z.string().max(MAX_STACK).optional(),
    /** React's component stack, on a render crash. */
    component_stack: z.string().max(MAX_STACK).optional(),
    /** Where in the app it happened. Same origin as this service's own callers. */
    url: z.string().trim().max(MAX_URL).optional(),
    /** The bundle the browser was running, so a stale tab is distinguishable. */
    release: z.string().trim().max(100).optional(),
  })
  .strict();

/** The caller's `user-agent`, trimmed to something a log line can hold. */
export function boundedUserAgent(header: string | string[] | undefined): string | null {
  // Node keeps the first `user-agent` and discards repeats, so the array form
  // is not reachable here; it is answered rather than cast away, because the
  // header type says it is possible and a `as string` would be the assumption
  // this file exists to avoid making about a caller's input.
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string' || raw === '') return null;
  return raw.length > MAX_USER_AGENT ? raw.slice(0, MAX_USER_AGENT) : raw;
}

export function registerClientErrorRoutes(
  app: FastifyInstance,
  deps: { limiter?: FixedWindowRateLimiter } = {},
): void {
  const limiter = deps.limiter ?? new FixedWindowRateLimiter(CLIENT_ERROR_LIMIT, CLIENT_ERROR_WINDOW_MS);

  // Registered on the app's own registry when there is one — `buildApp`
  // decorates it before the routes go on. Null in the bare apps some unit tests
  // build, where the log line is the whole of what is being asserted.
  const counter: Counter | null =
    app.metrics?.counter(
      'client_errors_total',
      'Errors reported by the browser SPA, by where they were caught. Nothing else on this box can see a crash that happens after the bundle has been served.',
      ['kind'],
    ) ?? null;

  // The throttle's own count. Without it the signal has a silent ceiling: a
  // route breaking in a render loop files far more than twenty reports, the
  // rest are refused before the body is even parsed, and `client_errors_total`
  // flattens at the limit — which reads as "it stopped getting worse".
  const dropped: Counter | null =
    app.metrics?.counter(
      'client_errors_dropped_total',
      'Crash reports refused by the per-address throttle. Nonzero means client_errors_total is capped and is no longer the whole story.',
    ) ?? null;

  app.post('/api/v1/client-errors', async (req, reply) => {
    const { allowed, resetAt } = limiter.check(req.ip);
    // A refusal rather than a silent 204: a client filing hundreds should be
    // able to tell it is being dropped, and the reporter backs off on it. With
    // the wait, like every other 429 here — the catalogue promises one.
    if (!allowed) {
      dropped?.inc();
      throw problems.tooManyRequests(
        'Too many client error reports from this address',
        Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
      );
    }

    const parsed = ReportBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid client error report', parsed.error);
    const report = parsed.data;

    counter?.inc({ kind: report.kind });
    // `warn`, not `error`: this service is healthy and answered every request
    // it was given. What is broken is the page, and the rate is the thing to
    // watch — `client_errors_total` is what an alert reads.
    req.log.warn(
      {
        event: 'client_error',
        kind: report.kind,
        name: report.name ?? null,
        detail: report.message,
        stack: report.stack ?? null,
        component_stack: report.component_stack ?? null,
        page: report.url ?? null,
        release: report.release ?? null,
        user_agent: boundedUserAgent(req.headers['user-agent']),
      },
      'client error reported',
    );

    return reply.status(204).send();
  });
}
