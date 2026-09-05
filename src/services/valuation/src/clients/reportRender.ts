import { renderReportPdf as renderLocally, type ReportPdfInput, type RenderOptions } from '@n409/report/pdf';
import type { CircuitTicket, Counter, Histogram, MetricsRegistry } from '@n409/shared';
import {
  ApiProblem,
  CircuitOpenError,
  classifyFailure,
  classifyStatus,
  currentRequestId,
  describeTransportFailure,
  FLAGS,
  flagEnabled,
  requestIdHeaders,
} from '@n409/shared';
import { Semaphore } from '../pipeline/semaphore.js';
import { circuits, internalAuthHeaders } from './internal.js';
import { sliceChars } from '../domain/textSlice.js';
import { readCappedBytes } from './deadline.js';

/**
 * PDF rendering, delegated to the report service when there is one.
 *
 * ## Why this file exists
 *
 * `renderReportPdf` is pdfkit laying out a whole 409A document, and pdfkit is
 * synchronous: the `await` in front of it yields only at the very end, when the
 * output stream is drained. Everything between is one uninterrupted run of JS.
 * Measured rather than assumed (round 97): a 5ms interval timer fires **zero**
 * times across a 103ms local render, and the deployed box logs 436–661ms for a
 * single `GET /api/v1/sample-report/pdf`. For that whole half-second the
 * valuation service serves nobody — not a health probe, not an SSE heartbeat,
 * not the eleven other requests in the queue. It is by a wide margin the most
 * event-loop-hostile thing the platform does, and it sits on the route that
 * produces the deliverable clients pay for.
 *
 * The remedy was already deployed and idle. `n409-report` (port 3004) has run
 * since M2, holds the same renderer, is health-checked by `deploy.sh`, and in
 * its first seven days served 21 requests — every one of them `/health`.
 * `infra/DEPLOYMENT.md` described "valuation ⇄ ai/engine/report", which was not
 * the architecture that ran. This module makes the description true.
 *
 * ## The fallback is the point, not a nicety
 *
 * A 409A report is the deliverable. Making its render depend on a second
 * process would trade a latency problem for an availability one, and that is a
 * bad trade at any speed: today a report renders whenever the API is up, and
 * nothing here is allowed to weaken that. So every failure of the remote path
 * — unset URL, refused connection, open breaker, timeout, 4xx, 5xx, a body
 * that is not a PDF — falls through to the in-process renderer that has always
 * done this work. The worst case of this file is exactly the behaviour of the
 * commit before it.
 *
 * That guarantee cuts the other way too, and is why the counters below exist:
 * a fallback nobody can see is a fallback that becomes permanent. If the report
 * unit is down, or its wire schema drifts and starts rejecting real reports
 * (see `reportRenderPayload` — the HTTP contract has caps the library does
 * not), every render silently goes back to blocking the event loop and the
 * only symptom is the latency this file was written to remove.
 * `report_render_total{mode="local"}` is the thing that says so.
 */

/**
 * How long a delegated render may take before we stop waiting and render here.
 *
 * Generous on purpose. The remote render is the same code doing the same work,
 * so the honest expectation is the local duration plus a loopback round trip
 * and the JSON encoding of the payload — call it under a second for the reports
 * measured so far. The budget is not sized for that; it is sized for the report
 * unit being busy with somebody else's document, because the alternative to
 * waiting is rendering it here, which costs this process more than waiting
 * does. A deadline that fires readily would convert every burst of concurrent
 * renders back into the blocking behaviour under exactly the load that made
 * offloading worth doing — and worse than that, would do the work twice: our
 * giving up does not stop the report unit, which goes on rendering a document
 * nobody is waiting for while this process renders it again. `postJson` calls
 * that case `abandoned` and refuses to retry it for the same reason. The
 * breaker is what stops it repeating: five such failures and the delegation is
 * skipped outright until the unit answers a trial call.
 */
export const REPORT_RENDER_TIMEOUT_MS = 30_000;

/** Where a set of bytes came from. */
export type RenderMode = 'delegated' | 'local';

/**
 * Why a render happened in-process. One of a closed set, because it is a metric
 * label and an unbounded label is a cardinality incident (see prometheus.ts).
 *
 * `not_configured` and `render_options` are choices; everything else is a
 * failure of the delegated path that the fallback absorbed.
 */
export type LocalReason =
  | 'not_configured'
  | 'render_options'
  | 'circuit_open'
  | 'queue_full'
  | 'unreachable'
  | 'timeout'
  | 'rejected'
  | 'not_a_pdf';

/** Just enough of a Fastify logger for this module; keeps the import weight off. */
export interface RenderLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  /** A render that produced no bytes — see `reportRenderFailed`. */
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface RenderVia {
  /** Passed straight to the local renderer; forces the local path (see below). */
  options?: RenderOptions;
  /** Test seam; defaults to the logger set by `configureReportRenderer`. */
  log?: RenderLogger;
  /** Test seam; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Test seam; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Test seam: the whole-call budget, queue wait included. Defaults to
   * {@link REPORT_RENDER_TIMEOUT_MS}. Present so a suite can assert the budget
   * is *shared* — which takes a render that waits out its deadline for a slot,
   * and nothing else can express that in under thirty seconds.
   */
  timeoutMs?: number;
}

/**
 * The service logger, set at boot.
 *
 * A module-level logger rather than one threaded through the call sites, and
 * the reason is the shape of the call graph rather than convenience: two of the
 * four renders happen inside `renderVersionPdf`/`deliverablePdf`, which are
 * called from three routes across three files and are pinned by a census test
 * (`reportPdfDoorCensus`). Threading a logger would widen four signatures to
 * carry a diagnostic, and the one thing that logger was wanted for — saying
 * *which request* fell back — is already in the async context:
 * `currentRequestId()` is what the id in a Fastify log line comes from, so the
 * line below joins to the request either way.
 */
let serviceLog: RenderLogger | null = null;

/**
 * The service name used for the breaker, the metric label and the log line.
 * Matches the systemd unit and the `/health` `service` field, so an operator
 * greps one word across all three.
 */
const SERVICE = 'report';

/**
 * The wire form of `ReportPdfInput`, as `RenderBody` in the report service
 * expects it.
 *
 * Two fields do not survive `JSON.stringify` unattended and are the whole
 * reason this is a function rather than a spread:
 *
 * - `branding.logo` is a `Buffer`. `JSON.stringify` turns one into
 *   `{"type":"Buffer","data":[137,80,...]}`, which the wire schema rejects —
 *   and if it did not, would be several times the size of the base64 it is
 *   meant to be. The service decodes `logo_base64`; this is the one field whose
 *   name differs between the two sides.
 * - `sections[].schedules` has no wire field at all, because the renderer
 *   ignores it: it is read by this service's `resolveExhibitReferences` before
 *   anything is rendered. Zod would strip it silently, which is fine, but
 *   dropping it here keeps the payload honest about what crosses.
 *
 * `generated_at` needs nothing: a `Date` stringifies to ISO 8601 and the wire
 * schema coerces it back.
 */
export function reportRenderPayload(input: ReportPdfInput): Record<string, unknown> {
  const { branding, sections, ...rest } = input;
  return {
    ...rest,
    sections: sections.map(({ heading, html, charts }) => ({
      heading,
      html,
      ...(charts ? { charts } : {}),
    })),
    ...(branding
      ? {
          branding: {
            partner_name: branding.partner_name,
            ...(branding.brand_color !== undefined ? { brand_color: branding.brand_color } : {}),
            logo_base64: branding.logo ? branding.logo.toString('base64') : null,
          },
        }
      : {}),
  };
}

/**
 * `%PDF-` — the five bytes every PDF starts with.
 *
 * Checked because the failure this guards against does not announce itself. A
 * reverse proxy in front of the report unit that answers 200 with an HTML
 * interstitial, or a future route that returns a JSON envelope, both hand back
 * a `Buffer` of the right type and the wrong content, and the first person to
 * notice is a client whose 409A will not open. Cheap, and it turns a corrupt
 * deliverable into a fallback.
 */
const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');

function looksLikePdf(bytes: Buffer): boolean {
  return bytes.length > PDF_MAGIC.length && bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

/**
 * How many renders this process will have in flight at the report unit at once,
 * and how many more it will let wait for a slot.
 *
 * The offload took away an accidental bound and this puts a deliberate one
 * back. In-process rendering was self-limiting in a way nobody designed: pdfkit
 * is synchronous, so N simultaneous report downloads rendered strictly one at a
 * time and the process could not even accept new work while one was running.
 * Delegating removes exactly that — which is the point — so N downloads now
 * arrive at port 3004 as N concurrent requests.
 *
 * Measured on the report service rather than guessed: idle RSS 116MB, and each
 * concurrent render adds about 10MB of retained working set while it waits its
 * turn (326MB at 12 concurrent, 407MB at 24). The renders themselves still
 * serialize — one Node thread — so wall time is linear and the extra
 * concurrency buys no throughput at all; it buys only memory. On a host with
 * 3.8GB, 2.4GB in use and swap already touched, and with no `MemoryMax` on any
 * unit in this estate, an unbounded queue there is the OOM candidate.
 *
 * Four in flight, because one renderer means anything above one adds latency
 * rather than throughput — the small number is only to keep the pipe full
 * across the loopback round trip and the JSON encode. Twelve more may wait; at
 * the ~350ms a report takes, a full queue is about five seconds, which is
 * inside every caller's patience and well inside the 30s budget.
 *
 * Past that the request renders here instead. That is the unpleasant end of the
 * trade and it is chosen deliberately: it blocks this event loop for one render
 * — the pre-R98 behaviour, bounded and survivable — where the alternatives are
 * to queue without limit (converting memory into an OOM on the box) or to
 * refuse (failing the download of a document a client has paid for). A
 * deliverable that arrives slowly beats one that does not arrive.
 *
 * `report_render_total{reason="queue_full"}` is what says this is happening,
 * and a non-zero rate is the signal that the renders want their own host rather
 * than a bigger queue.
 */
export const MAX_DELEGATED_IN_FLIGHT = 4;
export const MAX_DELEGATED_QUEUED = 12;

/**
 * The two measurements above, as numbers rather than prose.
 *
 * They exist so that the bound this file chooses and the `MemoryMax` the report
 * unit is given cannot drift apart. Round 99 sized `infra/systemd/
 * n409-report.service` from exactly these constants, and
 * `modelledRenderCeilingBytes()` is recomputed against that unit file by the
 * deploy-time preflight — so raising `MAX_DELEGATED_QUEUED` without raising the
 * unit's ceiling fails the deploy instead of the host.
 *
 * The alternative was a comment in each file naming the other, which is the
 * arrangement that let the deployed units sit four weeks behind the repo.
 */
/**
 * The most rendered PDF we will hold from the report unit.
 *
 * `MAX_DELEGATED_IN_FLIGHT` renders can be reading a body at once, and
 * `RENDER_BYTES_PER_CONCURRENT` is the heap this service already budgets for
 * each of them — so an uncapped read is that admission control multiplied by
 * whatever the far end sends. A 409A deliverable with every exhibit is a few
 * megabytes; this is chosen well above that and below the point where four
 * concurrent reads are the largest thing on the box.
 */
export const MAX_RENDERED_PDF_BYTES = 32 * 1024 * 1024;

/**
 * The most rejection body we will hold before calling it unreadable.
 *
 * A problem document is a sentence and, for the 422, a zod issue list over the
 * wire schema — kilobytes. This is not sized for that but for what else can
 * answer on that port: an ingress error page, a wrong service, a body with no
 * end. The 500-character cut below is what reaches the log; this is what
 * reaches memory.
 */
export const MAX_RENDER_DETAIL_BYTES = 1024 * 1024;

export const RENDER_IDLE_BYTES = 116 * 1024 * 1024;
export const RENDER_BYTES_PER_CONCURRENT = 10 * 1024 * 1024;

/**
 * What the report service can be holding when this client has it as busy as it
 * is willing to make it: every slot full and every queue place taken.
 *
 * A floor for the unit's `MemoryMax`, not a target for it — nothing here
 * accounts for GC lag or heap fragmentation, so a ceiling equal to this number
 * would be a ceiling the service reaches on a normal busy afternoon.
 */
export function modelledRenderCeilingBytes(): number {
  return RENDER_IDLE_BYTES + (MAX_DELEGATED_IN_FLIGHT + MAX_DELEGATED_QUEUED) * RENDER_BYTES_PER_CONCURRENT;
}

const renderSlots = new Semaphore(MAX_DELEGATED_IN_FLIGHT);

/** Live snapshot of the delegation queue — surfaced as gauges, asserted in tests. */
export function delegationConcurrency(): { active: number; pending: number } {
  return { active: renderSlots.activeCount, pending: renderSlots.pendingCount };
}

// ── Metrics ───────────────────────────────────────────────────────────────────

let renderCounter: Counter | null = null;
let renderDuration: Histogram | null = null;

/**
 * Registers this module's instruments against the service registry.
 *
 * Module-level rather than threaded through the four call sites, for the same
 * reason `networkSink` is in `internal.ts`: the alternative is passing a
 * registry into every route that happens to produce a PDF. Unset — which is
 * every unit test — the counters are inert and rendering is unaffected.
 */
export function registerReportRenderMetrics(registry: MetricsRegistry): void {
  renderCounter = registry.counter(
    'report_render_total',
    'PDF renders, by where they happened. mode="local" for a reason other than not_configured means the offload is failing and this process is paying for it.',
    ['mode', 'reason'],
  );
  renderDuration = registry.histogram(
    'report_render_duration_seconds',
    'Wall time to produce a report PDF, including a fallback after a failed delegation.',
    ['mode'],
  );
  // The two numbers the `queue_full` counter cannot give: how close the queue
  // runs to its ceiling in normal operation, rather than how often it hit it.
  registry.gauge(
    'report_render_delegations_active',
    'Renders currently in flight at the report service',
    () => renderSlots.activeCount,
  );
  registry.gauge(
    'report_render_delegations_queued',
    'Renders waiting for a delegation slot',
    () => renderSlots.pendingCount,
  );
}

/** Test seam: drops the instruments so one suite's counts cannot leak into another. */
export function resetReportRenderMetrics(): void {
  renderCounter = null;
  renderDuration = null;
}

function record(mode: RenderMode, reason: string, startedAt: number): void {
  renderCounter?.inc({ mode, reason });
  renderDuration?.observe((Date.now() - startedAt) / 1000, { mode });
}

// ── The renderer ──────────────────────────────────────────────────────────────

/**
 * The report service's base URL, or null when rendering stays in-process.
 *
 * Set once at boot from `config.REPORT_URL` (`app.ts`), module-level for the
 * same reason `networkSink` in `internal.ts` is: the alternative is threading a
 * config object through every route that happens to produce a PDF. Unset —
 * which is every unit test that does not build the app — means the local
 * renderer, with no socket opened and nothing to stub.
 *
 * The default lives in `config.ts` and is loopback, so a deploy turns this on
 * with no edit to `/opt/N409/.env` and no systemd unit to reinstall. Config
 * that exists only on the box is this platform's recurring bug (see
 * `infra/DEPLOYMENT.md`), and a performance fix that silently stays off in
 * production because somebody had to remember a manual step is that bug with a
 * benchmark attached. `REPORT_URL=` (empty) is the operator's off switch.
 */
let baseUrl: string | null = null;

/** Points this module at a report service, or at nothing. Idempotent. */
export function configureReportRenderer(
  url: string | null | undefined,
  log: RenderLogger | null = null,
): void {
  const trimmed = url?.trim();
  baseUrl = trimmed ? trimmed.replace(/\/+$/, '') : null;
  serviceLog = log;
}

/** The configured base URL, for `/health`-adjacent diagnostics and tests. */
export function reportServiceUrl(): string | null {
  return baseUrl;
}

/**
 * The answer when the bytes could not be produced at all.
 *
 * Every failure this module *handles* ends in a PDF: an unreachable report
 * unit, an open breaker, a full queue and a 422 on the wire all fall back to
 * rendering here, which is why none of them is an error. The one that does not
 * is the render itself throwing — pdfkit refusing a font it cannot read, a
 * table whose column widths do not resolve, an embedded image that will not
 * decode — and that had no handler anywhere on the path. It left this function
 * untouched, walked past every `catch` in the four routes that call it, and
 * arrived at `registerProblemHandler` as `500 urn:n409:problem:internal`, whose
 * body carries no `detail` by design. Somebody pressed Download and got
 * nothing, twice: no file and no sentence.
 *
 * So: a 502 that says the render is what failed, that the report itself is
 * intact, and that re-trying is worth one attempt before it is worth a support
 * ticket. `urn:n409:problem:upstream` rather than a new type because that is
 * already the catalogued "a step we depend on did not produce its output", and
 * an operator reading it needs the log line — which still carries the original
 * error, stack and all — not a second URN.
 *
 * The underlying message is deliberately *not* forwarded. It is a pdfkit
 * internal ("Unknown font format", a font path) written for whoever is holding
 * the stack, and this body goes to a client; the same split `describedBy` makes
 * in `clients/internal.ts`.
 */
function reportRenderFailed(err: unknown, reason: LocalReason, log: RenderLogger | null): ApiProblem {
  // The cause goes to the log, which is where it belongs, and not onto the
  // problem: `registerProblemHandler` builds a body from the declared fields,
  // so a `cause` there would be invisible in the response and duplicated here.
  log?.error(
    {
      service: SERVICE,
      reason,
      detail: describe(err),
      err,
      request_id: currentRequestId() ?? null,
      // Nothing retries a render and no sweep comes back for it; the download
      // is simply gone. That is the class `alert: true` is for.
      alert: true,
    },
    'report render failed; no PDF produced',
  );
  return new ApiProblem({
    status: 502,
    title: 'Bad Gateway',
    type: 'urn:n409:problem:upstream',
    detail:
      'The report could not be turned into a PDF. Nothing about the report itself has changed — ' +
      'its content and version are saved. Try the download again, and contact support if it keeps failing.',
  });
}

/**
 * Render a report PDF — on the report service when one is configured and
 * reachable, in this process otherwise.
 *
 * Drop-in for `@n409/report/pdf`'s `renderReportPdf`: same input, same bytes,
 * and it never throws where the library would have succeeded.
 */
export async function renderReportPdf(input: ReportPdfInput, via: RenderVia = {}): Promise<Buffer> {
  const startedAt = Date.now();
  const env = via.env ?? process.env;
  const local = async (reason: LocalReason): Promise<Buffer> => {
    const pdf = await renderLocally(input, via.options).catch((err: unknown) => {
      // Counted before it is thrown. `record` on the success path is what makes
      // the local renderer visible at all, so a renderer that fails every time
      // would otherwise show up as no local renders rather than as a fault.
      record('local', `${reason}:failed`, startedAt);
      throw reportRenderFailed(err, reason, logger(via));
    });
    record('local', reason, startedAt);
    return pdf;
  };

  const url = baseUrl;
  if (!url) return local('not_configured');
  // `RenderOptions` has no wire field — `compress: false` exists so tests can
  // read text out of the bytes, and a caller who asks for it wants the local
  // renderer's exact output. Nothing in the routes passes it; this is here so
  // that if something ever does, it gets what it asked for rather than a
  // compressed stream from a service that never heard the question.
  if (via.options && Object.keys(via.options).length > 0) return local('render_options');

  // Before the breaker, not after: `acquire()` takes a half-open trial slot, and
  // bailing out between that and a recordSuccess/recordFailure would leak it —
  // the breaker would then be one trial short of ever closing again.
  if (renderSlots.pendingCount >= MAX_DELEGATED_QUEUED) {
    logger(via)?.warn(
      {
        service: SERVICE,
        active: renderSlots.activeCount,
        queued: renderSlots.pendingCount,
        request_id: currentRequestId() ?? null,
      },
      'report offload queue full; rendering in-process',
    );
    return local('queue_full');
  }

  const breaker = circuits.get(SERVICE);
  /**
   * Which call this is; see the twin in `clients/internal.ts` (R440, M3).
   *
   * This client is where the straggler is most visible, because the note on
   * the `releaseTrial` arm below already describes one: "the wait this timed
   * out on is the tail of the *previous* stall, held by requests issued before
   * the trip". Those requests settle too, and until they carried a ticket
   * their verdicts were read as the trial call's.
   */
  let ticket: CircuitTicket | undefined;
  try {
    // Same asymmetry as `postJson`: the flag gates the *refusal*, never the
    // bookkeeping, so a breaker switched off still watches and comes back warm.
    if (flagEnabled(FLAGS.circuitBreakers, env)) ticket = breaker.acquire();
  } catch (err) {
    if (!(err instanceof CircuitOpenError)) throw err;
    // Not logged at warn: an open breaker is the steady state of a report unit
    // that is down, and one line per render would be the loudest thing in the
    // log while saying nothing the counter does not. The counter is the signal.
    logger(via)?.debug(
      { service: SERVICE, retry_after_ms: err.retryAfterMs, request_id: currentRequestId() ?? null },
      'report offload skipped',
    );
    return local('circuit_open');
  }

  try {
    const pdf = await renderSlots.run(async () => {
      // One budget for the whole delegated path, queue wait included —
      // `postJson` shares a deadline across its retries for the same reason.
      // Starting the clock after the slot is acquired would make the constant
      // above not the bound it says it is: with four slots stuck on an
      // unresponsive service, a queued render would wait out their deadline and
      // then be given a fresh one of its own.
      const budget = via.timeoutMs ?? REPORT_RENDER_TIMEOUT_MS;
      const remaining = budget - (Date.now() - startedAt);
      // Too little left to be worth dialling; the request would only run into
      // the deadline and report a timeout instead of getting on with the work.
      if (remaining < MIN_ATTEMPT_MS) {
        throw new DelegationError(
          'timeout',
          null,
          'no budget left after waiting for a render slot',
          undefined,
          false,
        );
      }
      return postForPdf(url, input, via, remaining);
    });
    breaker.recordSuccess(ticket);
    record('delegated', 'ok', startedAt);
    return pdf;
  } catch (err) {
    const reason = err instanceof DelegationError ? err.reason : 'unreachable';
    if (err instanceof DelegationError && !err.dialled) {
      /*
       * The probe is handed back, not spent (R424, methodology M3).
       *
       * `acquire()` above takes the half-open trial slot, and this arm is the
       * one path past it that never reaches the report unit: the budget was
       * gone by the time a render slot came free. Recorded as a failure it
       * classified `permanent('unclassified')` — the error carries no cause,
       * no code and no status — which a half-open breaker treats as "the trial
       * answered badly" and re-opens on, restarting the thirty-second cooldown
       * and naming the dependency in `openedBy`, the state gauge and the log.
       *
       * Nothing here is a fact about the report unit. The queue only backs up
       * while renders are being delegated, and the breaker only admits one at
       * a time — so the wait this timed out on is the tail of the *previous*
       * stall, held by requests issued before the trip. The probe that would
       * have found the service healthy is consumed by the outage that is
       * already over, and the next one thirty seconds later can be consumed
       * the same way.
       */
      breaker.releaseTrial(ticket);
    } else {
      breaker.recordFailure(
        err instanceof DelegationError && err.status !== null
          ? classifyStatus(err.status)
          : classifyFailure(err),
        ticket,
      );
    }
    // Warn, not error: nothing is broken from the client's point of view — the
    // bytes are about to be produced here. What is broken is the offload, and
    // the message says which of the two so an operator is not sent looking for
    // a failed download that never happened.
    logger(via)?.warn(
      {
        service: SERVICE,
        reason,
        status: err instanceof DelegationError ? err.status : null,
        detail: describe(err),
        request_id: currentRequestId() ?? null,
      },
      'report offload failed; rendering in-process',
    );
    return local(reason);
  }
}

/**
 * One failed exchange with the report service, carrying the label the metric
 * and the log line both want. Deliberately not `InternalServiceError`: that
 * type's whole contract is that a route turns it into a problem document for
 * the client, and nothing here ever reaches a client — every one of these is
 * absorbed by the fallback.
 */
class DelegationError extends Error {
  constructor(
    readonly reason: LocalReason,
    readonly status: number | null,
    message: string,
    /**
     * The failure this was built from, kept because the breaker reads it.
     *
     * Not decoration. `classifyFailure` decides transient-vs-permanent from
     * `err.code` — and from `err.cause.code`, because `fetch` reports every
     * network failure as a bare `TypeError: fetch failed` with the syscall on
     * the cause. Wrapping without carrying the cause through classifies a
     * refused connection as `unclassified`, which `CircuitBreaker` treats as
     * *permanent* and does not count: the breaker would never open, and a
     * report unit that was down would cost a connection attempt on every render
     * for as long as it stayed down. The one thing the breaker exists to stop.
     */
    cause?: unknown,
    /**
     * Whether the report unit was actually called.
     *
     * False on the one arm that gives up after `acquire()` and before the
     * request — see the note at that arm. A failure that never left this
     * process says nothing about the dependency, and the breaker is told so
     * rather than being handed a verdict it would read as the trial call's.
     */
    readonly dialled: boolean = true,
  ) {
    super(message, { cause });
  }
}

/** Below this there is no point starting the request; it would only time out. */
const MIN_ATTEMPT_MS = 250;

async function postForPdf(
  url: string,
  input: ReportPdfInput,
  via: RenderVia,
  timeoutMs: number,
): Promise<Buffer> {
  const fetchFn = via.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(`${url}/render/v1/pdf`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Same id on both sides of the hop; the report unit adopts it
        // (`requestIdHeader` in its Fastify options) rather than minting one.
        ...internalAuthHeaders(),
        ...requestIdHeaders(),
      },
      body: JSON.stringify(reportRenderPayload(input)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const aborted = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new DelegationError(
      aborted ? 'timeout' : 'unreachable',
      null,
      aborted ? `did not respond within ${Math.round(timeoutMs / 1000)}s` : describe(err),
      err,
    );
  }
  if (!res.ok) {
    // The body of a rejection is the whole diagnostic — a 422 here is the wire
    // schema refusing a real report, which is a contract drift somebody has to
    // read the field list to fix. Bounded, because it goes in a log line.
    //
    // The bound is on the *read*, not only on the slice. `sliceChars(await
    // res.text(), 500)` cuts a string this line has already buffered whole, so
    // the 500 was a statement about the log and never about the heap: a proxy
    // in front of the render unit serving an endless error page was held here
    // in full before a single character was dropped.
    let detail: string;
    try {
      const bytes = await readCappedBytes(res, MAX_RENDER_DETAIL_BYTES);
      // `sliceChars`, not `slice`: a body cut at 500 UTF-16 units can be cut
      // through an astral character, and the orphaned half is a string this
      // message cannot be logged or stored with. See domain/textSlice.ts.
      detail = bytes === null ? '<oversized body>' : sliceChars(bytes.toString('utf8'), 500);
    } catch {
      detail = '<unreadable body>';
    }
    throw new DelegationError('rejected', res.status, `HTTP ${res.status}: ${detail}`);
  }
  let bytes: Buffer;
  try {
    // The deadline covers the body stream too, so a service that answers and
    // then stalls fails here with the same TimeoutError the fetch would raise —
    // which is why this read is inside a boundary rather than after one.
    const read = await readCappedBytes(res, MAX_RENDERED_PDF_BYTES);
    if (read === null) {
      throw new DelegationError(
        'rejected',
        res.status,
        `render exceeded ${MAX_RENDERED_PDF_BYTES / (1024 * 1024)} MB`,
      );
    }
    bytes = read;
  } catch (err) {
    if (err instanceof DelegationError) throw err;
    const aborted = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new DelegationError(aborted ? 'timeout' : 'unreachable', res.status, describe(err), err);
  }
  if (!looksLikePdf(bytes)) {
    throw new DelegationError('not_a_pdf', res.status, `${bytes.length} bytes, not a PDF`);
  }
  return bytes;
}

function logger(via: RenderVia): RenderLogger | null {
  return via.log ?? serviceLog;
}

function describe(err: unknown): string {
  return describeTransportFailure(err);
}
