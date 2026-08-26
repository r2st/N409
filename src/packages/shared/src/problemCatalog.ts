/**
 * The error catalog: one entry per `urn:n409:problem:*` type, carrying what the
 * failure means and what the caller is supposed to do about it.
 *
 * The vocabulary itself was already a contract — `problemTypes.test.ts` has
 * refused to let a type be raised without a row in api-design.md §1.1 since the
 * round that found twenty-three of them scattered across ten files. What that
 * row said, though, was only *when* the failure happens. The half an integrator
 * actually needs is the half nobody wrote down: given this `type`, is the
 * request worth sending again, and if so after what. Those are different
 * answers for `rate-limited` (wait for `retry_after_seconds`),
 * `upstream-degraded` (wait, and the write definitely did not happen),
 * `internal` (retry with backoff; the write may have happened) and `validation`
 * (never — fix the body), and a client that treats them alike is either
 * hammering a service that told it to stop or giving up on a blip.
 *
 * So this file is the source and the §1.1 table is a rendering of it. The table
 * is not maintained by hand any more: {@link renderProblemTable} produces it
 * and `problemTypes.test.ts` fails if the document does not match, which makes
 * the document unable to drift in either direction rather than merely checked
 * for completeness. That mattered immediately — the hand-maintained table had
 * `plan-limit` at 409 for as long as it has existed, and the route has always
 * raised it as 402. A client branching on status handled the documented one.
 *
 * It is also served — `GET /api/v1/problems` on the valuation service — so a
 * client can resolve a `type` it does not recognise at runtime instead of
 * falling through to a default branch. That is the reason `type` is repeated
 * inside each entry rather than living only in the map key: the served form is
 * an array, and an entry has to stand alone once it is out of the map.
 *
 * What this file is deliberately *not*: a place to add a type. A type exists
 * because some code raises it, and the census scans the services for that. An
 * entry here with no code behind it fails the same test as a raise with no
 * entry.
 */

/**
 * Whether repeating the identical request can succeed without the caller
 * changing anything.
 *
 * Three answers rather than a boolean, because "retryable" collapses two
 * genuinely different instructions. A 429 and an open circuit breaker say *when*
 * to come back and mean the request was never acted on; a 500 says the server
 * fell over mid-request and the caller does not know whether the write landed,
 * so the retry needs an `Idempotency-Key` rather than just a timer.
 */
export type RetryAdvice =
  /** The same request will fail the same way until it changes. */
  | 'never'
  /**
   * Retry after the delay the response names — `retry_after_seconds` in the
   * body, `Retry-After` in the headers. Nothing was executed, so the retry is
   * safe without an idempotency key.
   */
  | 'after-delay'
  /**
   * Transient server-side failure. Retry with exponential backoff, and send an
   * `Idempotency-Key` on anything with side effects: the first attempt may
   * have committed before it failed.
   */
  | 'with-backoff';

export interface ProblemCatalogEntry {
  /** The `type` URN. The one field of a problem document a client may branch on. */
  type: string;
  /**
   * The status this type arrives with.
   *
   * Text rather than a number because `internal` genuinely spans a class: the
   * handler answers with whatever status the failure carried when it is a 5xx,
   * and 500 when it is not. Every other entry names one code, which is a claim
   * `problemTypes.test.ts` checks against the raise site rather than prose
   * anybody is trusted to keep current.
   */
  status: string;
  /**
   * The constant reason phrase carried in `title`.
   *
   * RFC 9457 asks `title` not to change between occurrences, which makes it a
   * property of the type rather than of the request — so it belongs here, and
   * a type raised with two different titles is a defect this file can name.
   * There was one: `validation` was `Unprocessable Entity` from the route
   * helper and `Unprocessable Content` from the fastify fallback.
   */
  title: string;
  /** When this failure is raised — the sentence a maintainer reads. */
  summary: string;
  /** What the caller should do next — the sentence an integrator reads. */
  resolution: string;
  retry: RetryAdvice;
}

/**
 * Keyed by `type` so a lookup from a received problem document is direct, and
 * ordered by status so the rendered table reads the way somebody scanning for
 * "the code I just got" expects.
 */
export const PROBLEM_CATALOG: Readonly<Record<string, ProblemCatalogEntry>> = {
  'urn:n409:problem:bad-request': {
    type: 'urn:n409:problem:bad-request',
    status: '400',
    title: 'Bad Request',
    summary: 'The request is malformed in a way no other type names.',
    resolution:
      'Read `detail` — it describes the request, not the server. A malformed query parameter is the ' +
      'usual cause; the body half of the same failure is `validation`.',
    retry: 'never',
  },
  'urn:n409:problem:malformed-body': {
    type: 'urn:n409:problem:malformed-body',
    status: '400',
    title: 'Bad Request',
    summary: 'The body is not parseable as its declared content-type.',
    resolution:
      'Fix the serialization before looking at any field. The body never reached a validator, so no ' +
      '`errors` array is present and no field has been examined.',
    retry: 'never',
  },
  'urn:n409:problem:empty-body': {
    type: 'urn:n409:problem:empty-body',
    status: '400',
    title: 'Bad Request',
    summary: 'A JSON content-type was declared with no body.',
    resolution:
      'Send the body, or drop the `content-type` header. The usual cause is an HTTP client that sets ' +
      'the header on every request, including the ones with nothing to send.',
    retry: 'never',
  },
  'urn:n409:problem:unauthorized': {
    type: 'urn:n409:problem:unauthorized',
    status: '401',
    title: 'Unauthorized',
    summary: 'No session or bearer credential, or it has expired.',
    resolution:
      'Re-authenticate and send the request again. An integration should also check the key has not ' +
      'been revoked — a revoked key and a missing one are the same answer here.',
    retry: 'never',
  },
  'urn:n409:problem:plan-limit': {
    type: 'urn:n409:problem:plan-limit',
    status: '402',
    title: 'Plan limit reached',
    summary: "The organisation's plan does not allow another of these.",
    resolution:
      'A commercial limit, not a technical one: retrying never clears it. Upgrade the plan or buy ' +
      'additional valuations. Note the status is 402, not the 409 the rest of the conflict family uses.',
    retry: 'never',
  },
  'urn:n409:problem:forbidden': {
    type: 'urn:n409:problem:forbidden',
    status: '403',
    title: 'Forbidden',
    summary: 'Authenticated, but the principal may not do this.',
    resolution:
      'Do not retry with the same credential — this is a role or scope decision, not a transient one. ' +
      'Ask an administrator for the role, or use a key scoped to the right organisation.',
    retry: 'never',
  },
  'urn:n409:problem:not-found': {
    type: 'urn:n409:problem:not-found',
    status: '404',
    title: 'Not Found',
    summary: "No such resource, or it is outside the caller's scope.",
    resolution:
      'Check the identifier. This is also the answer for a resource that exists but belongs to ' +
      'another organisation — the API will not confirm that it exists — so a 404 is not proof that ' +
      'the id is wrong.',
    retry: 'never',
  },
  'urn:n409:problem:method-not-allowed': {
    type: 'urn:n409:problem:method-not-allowed',
    status: '405',
    title: 'Method Not Allowed',
    summary: 'The path exists; the verb does not.',
    resolution: 'Use the verb the endpoint documents. Most collections take GET and POST only.',
    retry: 'never',
  },
  'urn:n409:problem:not-acceptable': {
    type: 'urn:n409:problem:not-acceptable',
    status: '406',
    title: 'Not Acceptable',
    summary: 'No representation matches the `Accept` header.',
    resolution:
      'Send `Accept: application/json`, or omit the header. The endpoints that answer a file — ' +
      '`report.pdf`, `workbook.xlsx`, the `.csv` exports — are the exception and name their own type.',
    retry: 'never',
  },
  'urn:n409:problem:conflict': {
    type: 'urn:n409:problem:conflict',
    status: '409',
    title: 'Conflict',
    summary: 'State conflict — including an `Idempotency-Key` replayed against a different body.',
    resolution:
      'Re-read the resource and decide from its current state; the request was not applied. A replayed ' +
      'idempotency key is the one case where retrying unchanged cannot help — send the original body, ' +
      'or mint a new key.',
    retry: 'never',
  },
  'urn:n409:problem:payload-too-large': {
    type: 'urn:n409:problem:payload-too-large',
    status: '413',
    title: 'Content Too Large',
    summary: "The body is over the route's limit.",
    resolution:
      'Send less. Upload routes have their own, larger ceiling than the JSON routes, and ' +
      '`GET /api/v1/upload-limits` reports both so a client can check before spending the bandwidth.',
    retry: 'never',
  },
  'urn:n409:problem:unsupported-media-type': {
    type: 'urn:n409:problem:unsupported-media-type',
    status: '415',
    title: 'Unsupported Media Type',
    summary: 'Nothing can parse the declared content-type.',
    resolution:
      'Use `application/json` for JSON bodies and `multipart/form-data` for uploads. A charset ' +
      'parameter is fine; an unrecognised base type is not.',
    retry: 'never',
  },
  'urn:n409:problem:validation': {
    type: 'urn:n409:problem:validation',
    status: '422',
    title: 'Unprocessable Content',
    summary: 'The body or query parsed but failed its validator; `errors` carries the issues.',
    resolution:
      'Read `errors` rather than `detail`: each entry names the failing path and why. The body parsed, ' +
      'so this is a field-level problem and the framing was fine.',
    retry: 'never',
  },
  'urn:n409:problem:rate-limited': {
    type: 'urn:n409:problem:rate-limited',
    status: '429',
    title: 'Too Many Requests',
    summary: 'Limiter exhausted; `retry_after_seconds` and `Retry-After` say when to return.',
    resolution:
      'Wait the stated number of seconds — not a fixed timer of your own — then retry. Nothing was ' +
      'executed. On the partner API the `x-ratelimit-*` headers come back on *successful* responses ' +
      'too, so a client can slow down before it is refused; the `-partner` suffixed trio is a second ' +
      'budget shared across every key in the organisation.',
    retry: 'after-delay',
  },
  'urn:n409:problem:upstream': {
    type: 'urn:n409:problem:upstream',
    status: '502',
    title: 'Bad Gateway',
    summary: 'A service this one depends on failed or timed out.',
    resolution:
      'Retry with backoff. A timeout is indistinguishable from a failure here, so the dependency may ' +
      'still be working on the request — send an `Idempotency-Key` where the endpoint accepts one. A ' +
      '4xx from the dependency is not this: it is reported as `validation`, because it describes the ' +
      'request rather than the outage.',
    retry: 'with-backoff',
  },
  'urn:n409:problem:stripe': {
    type: 'urn:n409:problem:stripe',
    status: '502',
    title: 'Bad Gateway',
    summary: 'Stripe refused the operation; `detail` carries its reason.',
    resolution:
      '`detail` is Stripe’s own message and is safe to show a person. Retry with backoff if it reads ' +
      'like an outage; a declined card or a rejected parameter will be refused again unchanged.',
    retry: 'with-backoff',
  },
  'urn:n409:problem:unavailable': {
    type: 'urn:n409:problem:unavailable',
    status: '503',
    title: 'Service Unavailable',
    summary: 'This service is up but cannot serve the request yet.',
    resolution:
      'Retry with backoff. Raised while a service is still warming up or is draining for shutdown, so ' +
      'it clears on its own — no configuration change makes it go away faster.',
    retry: 'with-backoff',
  },
  'urn:n409:problem:upstream-degraded': {
    type: 'urn:n409:problem:upstream-degraded',
    status: '503',
    title: 'Service Unavailable',
    summary:
      'A dependency failed repeatedly, so its circuit breaker is open and the request was not ' +
      'attempted. Distinct from `upstream`: nothing was dialled, so the caller’s data is unaffected.',
    resolution:
      'Wait for `retry_after_seconds` — the moment the breaker next admits a trial call — and retry ' +
      'once. Retrying sooner is refused without being attempted, so it neither helps you nor helps the ' +
      'dependency recover. No idempotency key is needed: nothing ran.',
    retry: 'after-delay',
  },
  'urn:n409:problem:accounting-unavailable': {
    type: 'urn:n409:problem:accounting-unavailable',
    status: '503',
    title: 'Integration not configured',
    summary: 'The accounting integration is unreachable or unconfigured.',
    resolution:
      'Check the accounting connection in settings — an unconfigured deployment and an unreachable ' +
      'provider answer the same way. Financials can be entered by hand meanwhile: the integration is ' +
      'an import path, not a dependency of the valuation.',
    retry: 'with-backoff',
  },
  'urn:n409:problem:captable-sync-unavailable': {
    type: 'urn:n409:problem:captable-sync-unavailable',
    status: '503',
    title: 'Integration not configured',
    summary: 'The cap-table integration is unreachable or unconfigured.',
    resolution:
      'Check the cap-table connection in settings. The cap table can be imported from a spreadsheet or ' +
      'entered by hand meanwhile.',
    retry: 'with-backoff',
  },
  'urn:n409:problem:hris-unavailable': {
    type: 'urn:n409:problem:hris-unavailable',
    status: '503',
    title: 'Integration not configured',
    summary: 'The HRIS integration is unreachable or unconfigured.',
    resolution: 'Check the HRIS connection in settings. Headcount and grant data can be entered by hand.',
    retry: 'with-backoff',
  },
  'urn:n409:problem:billing-unavailable': {
    type: 'urn:n409:problem:billing-unavailable',
    status: '503',
    title: 'Billing not configured',
    summary: 'Billing is unreachable.',
    resolution:
      'Retry with backoff. Nothing was charged, and valuation work is unaffected — only the billing ' +
      'surfaces refuse.',
    retry: 'with-backoff',
  },
  'urn:n409:problem:payments-unconfigured': {
    type: 'urn:n409:problem:payments-unconfigured',
    status: '503',
    title: 'Service Unavailable',
    summary: 'No payment provider key is set in this deployment.',
    resolution:
      'Neither transient nor the caller’s fault: this deployment has no Stripe key, so retrying cannot ' +
      'help. An operator sets `STRIPE_SECRET_KEY`; until then the payment surfaces are off.',
    retry: 'never',
  },
  'urn:n409:problem:internal': {
    type: 'urn:n409:problem:internal',
    status: '5xx',
    title: 'Internal Server Error',
    summary: 'Unhandled server-side failure. Carries no `detail` by design.',
    resolution:
      'Retry with exponential backoff, and send an `Idempotency-Key` on anything with side effects — ' +
      'the request may have committed before it failed. If it persists, quote the `instance` path and ' +
      'the time: the server-side log line carries the detail this body omits.',
    retry: 'with-backoff',
  },
};

/** Every catalogued type, in the order the table renders. */
export const PROBLEM_TYPES: readonly string[] = Object.keys(PROBLEM_CATALOG);

/**
 * The entry for a received `type`, or undefined for one this build does not
 * know.
 *
 * Undefined is a real answer rather than a failure: a client on an older build
 * will meet types added since, and the documented instruction for that case is
 * to fall back to the status class. Throwing here would turn a
 * forward-compatible design into a crash.
 */
export function describeProblem(type: string | undefined): ProblemCatalogEntry | undefined {
  return type ? PROBLEM_CATALOG[type] : undefined;
}

/**
 * Sort key for a `status` cell, so the catalog's own ordering is checkable.
 *
 * `5xx` has no numeric code and sorts last, which is where the catch-all
 * belongs — it is the entry a client reaches when nothing more specific
 * matched.
 */
export function statusOrder(status: string): number {
  const match = /^(\d{3})/.exec(status);
  return match ? Number(match[1]) : 599;
}

/**
 * The §1.1 table of `docs/api-design.md`, rendered from the catalog.
 *
 * The table used to be the source and the code was checked against it, which
 * caught a type with no row but could not catch a row whose prose had stopped
 * being true — and one had. Rendering inverts that: the prose lives next to the
 * `retry` advice it has to agree with, and the document becomes an artifact a
 * test diffs.
 *
 * Pipes are escaped because a cell may contain one; nothing else in markdown
 * table syntax is significant inside a cell.
 */
export function renderProblemTable(): string {
  const cell = (text: string) => text.replace(/\|/g, '\\|');
  const rows = Object.values(PROBLEM_CATALOG).map(
    (entry) => `| \`${entry.type}\` | ${entry.status} | ${cell(entry.summary)} | ${cell(entry.resolution)} |`,
  );
  return ['| `type` | Status | Raised when | What to do |', '|---|---|---|---|', ...rows].join('\n');
}
