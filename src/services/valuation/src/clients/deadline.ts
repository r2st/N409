/**
 * Deadlines for outbound calls to third-party integrations.
 *
 * Node's `fetch` has no default timeout. If Xero, Carta, Pulley or an HRIS
 * provider completes the TCP handshake and then goes quiet — a black-holed
 * socket, an overloaded gateway, a connection dropped without a FIN — the
 * promise never settles. Nothing downstream is watching: the Fastify handler
 * stays parked on the await, the analyst's "Import" button spins until their
 * browser gives up, and the handler is still holding its slot long after the
 * person who asked for it has gone.
 *
 * `partnerLogo` (3s) and `internal` (120s) already carry deadlines. These
 * OAuth integrations were the callers that did not, so this is the same rule
 * written once for all of them.
 *
 * The two budgets differ because the work does: a token exchange is a small
 * round-trip against an auth server and should be quick or not at all, while a
 * report or full cap-table pull is a real query on the provider's side and is
 * legitimately slow.
 */

import { describeTransportFailure, markFailure, transportFailureEchoesMessage } from '@n409/shared';
import { findUnstorableText } from '../domain/nulBytes.js';
import { parseRetryAfter } from '../domain/partnerWebhooks.js';

/** Token exchange / connection identification — small, latency-sensitive calls. */
export const OAUTH_TIMEOUT_MS = 10_000;

/** Report, cap-table and roster pulls — the provider does real work for these. */
export const IMPORT_TIMEOUT_MS = 30_000;

/**
 * Runs a third-party request under a deadline, and makes a timeout say so.
 *
 * Without the rewrite the caller sees `AbortSignal`'s stock wording, "The
 * operation was aborted due to timeout", which reaches the analyst as
 * `Import failed: The operation was aborted due to timeout` — true, but it
 * names neither the provider nor the fact that the delay was on their side.
 */
/**
 * An integration failure whose wording is safe to show the person who asked.
 *
 * The route that pulls an HRIS roster ended in
 *
 *     catch (err) { throw problems.unprocessable(`Sync failed: ${err.message}`) }
 *
 * which forwards *whatever was thrown* to the client. That is right for the
 * errors this file raises — "Rippling did not respond within 30s", "Gusto
 * returned a non-JSON response" — each of which names the provider and what it
 * did and carries nothing else. It is wrong for everything else that can be
 * thrown from inside a sync, and the sync's insert loop has no catch of its
 * own: one grant with a date Postgres will not take, and the analyst is shown
 *
 *     Sync failed: date/time field value out of range: "2026-02-31"
 *
 * or, on a unique violation, the name of the index. Driver wording, column
 * names and constraint names are internal detail, and the catch-all could not
 * tell them from the two sentences above because both arrive as `Error`.
 *
 * So "safe to echo" becomes a type rather than a hope. A route forwards the
 * message of an `IntegrationError` and answers everything else with its own
 * constant, having logged the real one.
 *
 * Thrown by `withDeadline` and `readJson`, which is where the provider-
 * attributable failures of every integration client already funnel. The
 * clients' own `throw new Error(…)` sites are converted per client as their
 * routes start forwarding; a plain `Error` is the conservative default,
 * because the cost of the wrong answer is asymmetric — an unhelpful message
 * on one side, disclosure on the other.
 */
export class IntegrationError extends Error {
  /**
   * The status the provider answered with, when one was involved.
   *
   * Carried because throwing it away made every one of these errors
   * unclassifiable. `classifyFailure` reads `status`/`statusCode` off an error
   * — it is how the whole estate tells "the provider is having a bad minute"
   * from "the provider will refuse this forever" — and `providerRefused` built
   * its message by interpolating the status into a string and dropping the
   * number. So a 503 and a 404 arrived at `logFailure` identically
   * unrecognised, both classified `permanent`/`unclassified` by the deliberate
   * default, and a connector logging through the estate's one alerting
   * contract would have paged somebody for every transient blip.
   *
   * `undefined` where no status was involved: a deadline, an unparseable body.
   * Those say what they are by other means (see the `markFailure` below).
   */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'IntegrationError';
    if (status !== undefined) this.status = status;
  }
}

/**
 * The integration failure a retry cannot clear: the stored authorisation is
 * gone, and only a person re-running the OAuth round trip will bring it back.
 *
 * Every one of these connectors keeps a `refresh_token` and a
 * `token_expires_at`, and until this round nothing read either. What that
 * meant is that a connection worked exactly as long as its first access token
 * did — two hours at Gusto, one at QuickBooks — and then answered every
 * scheduled pull with `401`, which the sync recorded as an ordinary transport
 * failure and the card showed as `error` beside a `last_synced_at` that kept
 * getting older. The credential that would have fixed it without anybody
 * noticing was sitting in the next column.
 *
 * With a refresh in the path, the two failures have to be told apart, because
 * they call for opposite handling. A provider that is briefly unwell should be
 * tried again on the next tick. A refresh the provider *refused* —
 * `invalid_grant`, the shape it answers with once the client has revoked the
 * app or the refresh token has itself expired — will be refused identically
 * every fifteen minutes until somebody reconnects, so the useful thing to do
 * with it is stop, say so in words a person can act on, and leave the
 * reconnect button as the next move.
 *
 * It extends `IntegrationError` because the sentence is still provider-
 * attributable and still fit to publish: it names the provider and says the
 * authorisation ended. Routes that already forward an `IntegrationError`'s
 * message therefore forward this one unchanged.
 */
export class ReconnectRequiredError extends IntegrationError {
  constructor(message: string) {
    super(message);
    this.name = 'ReconnectRequiredError';
    // The one thing this type exists to say, said in the vocabulary the
    // classifier reads. Its own name carries it for the two connectors that
    // check `instanceof`; anything else asking `classifyFailure` would have
    // seen the 400 the token endpoint answered with — permanent by the status
    // table, and correct here by accident rather than because this said so.
    markFailure(this, 'permanent');
  }
}

/**
 * The `IntegrationError` for a provider that answered, and refused.
 *
 * Every one of these clients wrote the refusal the same way —
 * `` throw new Error(`${label} ${what} failed (${res.status})`) `` — which is
 * accurate and, for the one status that most deserves better, useless. A 429
 * from Carta or Pulley is not a failure at all: it is the provider naming a
 * time to come back, usually in a `Retry-After` header nobody read. The analyst
 * was told "Carta cap-table fetch failed (429)", which reads like a broken
 * integration and prompts exactly the wrong response — clicking Sync again,
 * immediately, which is how a rate limit becomes a longer rate limit.
 *
 * Only 429 gets its own sentence. Everything else keeps the wording it had,
 * deliberately: it is what the connection's `last_error` column has recorded
 * for the life of these integrations, and half a dozen tests read it.
 *
 * The type is what lets a route echo the sentence at all — see
 * {@link IntegrationError}. These messages name a provider, a status and
 * nothing else, which is the property that made them fit to publish and the
 * property `new Error` could not state.
 */
export function providerRefused(
  label: string,
  what: string,
  res: { status: number; headers: { get(name: string): string | null } },
): IntegrationError {
  if (res.status === 429) {
    const seconds = parseRetryAfter(res.headers.get('retry-after'));
    return new IntegrationError(
      seconds === null
        ? `${label} is rate-limiting us — wait a few minutes and try again.`
        : `${label} is rate-limiting us — try again in about ${Math.max(1, seconds)}s.`,
      res.status,
    );
  }
  return new IntegrationError(`${label} ${what} failed (${res.status})`, res.status);
}

/**
 * The sentence a connector writes into the column an analyst reads.
 *
 * `describeTransportFailure` gives two quite different answers and cannot tell
 * a caller which one it gave. For a recognised network condition, a deadline,
 * or a `fetch failed` that said nothing, it returns a sentence written in
 * `failure.ts` and naming nothing but the condition. For everything else it
 * returns `err.message` — and `last_error` is served to the client verbatim by
 * every `toPublic`, so that branch publishes whatever was thrown.
 *
 * Which was safe while the guarded block was a provider call and nothing else.
 * Round 252 put `accessTokenFor` inside it — the proactive token refresh — and
 * `accessTokenFor` ends in `updateTokens`, a **write to Postgres**. So the
 * catch that says "the client throws `IntegrationError` for everything a
 * provider did, and anything else reaching here is ours" acquired a way for
 * something of ours to arrive with a message: a driver error, which is column
 * names, constraint names and the values Postgres refused. That is exactly the
 * disclosure `errorBodyDisclosure` states the rule for, and exactly what the
 * two sibling catches in these same files — the grant insert loop and the
 * cap-table save — already substitute a written sentence for.
 *
 * So the vouching is explicit. An `IntegrationError` is a message this codebase
 * authored for a caller to read; a transport condition is one `failure.ts`
 * authored. Anything else is ours, gets `ours`, and goes to the log intact —
 * both callers already log `err` in full.
 */
export function describeConnectorFailure(err: unknown, ours: string): string {
  if (err instanceof IntegrationError || !transportFailureEchoesMessage(err)) {
    return describeTransportFailure(err);
  }
  return ours;
}

export async function withDeadline<T>(
  label: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  try {
    return await run(AbortSignal.timeout(timeoutMs));
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // Transient as a *condition*, which is the classifier's own reading of
      // an `AbortError`: the upstream is slow, and slow passes. The name that
      // said so is consumed here — `AbortSignal.timeout`'s error does not
      // survive into the `IntegrationError` this throws — so the fact is
      // carried explicitly rather than lost with it.
      throw markFailure(
        new IntegrationError(`${label} did not respond within ${Math.round(timeoutMs / 1000)}s`),
        'transient',
      );
    }
    throw err;
  }
}

/**
 * The most JSON we will hold from a provider before giving up on the answer.
 *
 * `res.json()` reads to the end of the stream before it parses, so the size of
 * the buffer is the provider's choice, not ours. A misbehaving or hostile
 * endpoint that answers a token exchange with an endless body — or an ingress
 * that streams a multi-gigabyte error page — takes the whole service down with
 * it, and takes the other four services on the same box with it, because the
 * one that dies is the one holding the heap. No status code is involved and
 * nothing in the log says "too big": the process is simply killed.
 *
 * 16 MB is far above every real body these clients read. The largest is a full
 * cap-table pull — a few thousand grants, well under 5 MB of JSON — and a
 * balance sheet or an HRIS roster is smaller still. It is chosen to be
 * comfortably out of the way of legitimate answers rather than to be tight,
 * because the failure this guards is unbounded, not merely large.
 */
export const MAX_INTEGRATION_JSON_BYTES = 16 * 1024 * 1024;

const OVERSIZE_MB = MAX_INTEGRATION_JSON_BYTES / (1024 * 1024);

/**
 * Reads a body to a Buffer, or `null` if it runs past `limitBytes`.
 *
 * The `content-length` check is a courtesy for the honest oversized answer —
 * it costs nothing and refuses before a byte is read. It is not the guard: a
 * chunked response has no length, and a lying one is exactly the case that
 * matters. The stream is the guard, and it stops at the first chunk that
 * crosses the budget, so the peak held is one chunk over the cap rather than
 * whatever the provider felt like sending.
 *
 * Cancelling the reader is what makes that true — without it the socket keeps
 * delivering into a buffer nobody is draining.
 */
export async function readCappedBytes(res: Response, limitBytes: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limitBytes) return null;
  if (!res.body) return Buffer.from(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limitBytes) return null;
      chunks.push(value);
    }
  } finally {
    // Releasing the lock is not enough — the body must be discarded, or the
    // connection stays open feeding a buffer that is already over budget.
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

async function readCappedText(res: Response, label: string): Promise<string> {
  const bytes = await readCappedBytes(res, MAX_INTEGRATION_JSON_BYTES);
  if (bytes === null) {
    throw new IntegrationError(`${label} returned a response larger than ${OVERSIZE_MB} MB`);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Reads a provider's JSON body, and makes a non-JSON answer say so.
 *
 * A 2xx is not a promise of JSON. When a provider's gateway or an ingress in
 * front of it serves an HTML error page — or a body arrives truncated — the
 * `res.json()` that every one of these clients does unguarded rejects with the
 * parser's own wording, and the route's catch-all forwards it verbatim:
 * `Sync failed: Unexpected token '<', "<html><hea"... is not valid JSON`.
 * That is the same complaint `withDeadline` exists to fix — the analyst is
 * shown a parser's internals and told nothing about which provider misbehaved
 * — so it gets the same treatment.
 *
 * The cast the call sites use (`as TokenResponse`, `as Record<string, unknown>`)
 * is a compile-time assertion with no runtime force, so `null` and arrays reach
 * property reads that then throw `Cannot read properties of null`. Requiring an
 * object here means a caller's `body.access_token` is a miss, not a crash.
 *
 * Neither of those is about *size*, and `res.json()` has no opinion on it —
 * see {@link MAX_INTEGRATION_JSON_BYTES}. An oversized body is its own
 * refusal, named as such, rather than a dead process.
 */
export async function readJson(res: Response, label: string): Promise<Record<string, unknown>> {
  const text = await readCappedText(res, label);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new IntegrationError(`${label} returned a non-JSON response`);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new IntegrationError(`${label} returned an unexpected response body`);
  }
  return body as Record<string, unknown>;
}

/**
 * The array-bodied variant — Xero's `/connections` answers with a bare list.
 * Returns `[]` rather than throwing: every caller treats the connections list
 * as best-effort org identification, not as a reason to fail the connection.
 *
 * Best-effort covers the oversized body too: the cap still stops the read, and
 * the empty list this returns is the same answer an unparseable one gets.
 */
export async function readJsonArray(res: Response): Promise<unknown[]> {
  try {
    const body: unknown = JSON.parse(await readCappedText(res, 'The provider'));
    return Array.isArray(body) ? body : [];
  } catch {
    return [];
  }
}

/**
 * The longest provider-supplied identity string this platform stores.
 *
 * Every column these land in is `text`, so this is not the database's bound —
 * it is the same 255 the connect forms and the company-profile editor carry,
 * applied to a value nobody typed.
 */
export const MAX_PROVIDER_TEXT = 255;

/**
 * A provider's identity text — a company name, an org handle, an `asOf` — as
 * something this platform will store, or null.
 *
 * `readJson` guarantees an object and nothing about its fields, and the three
 * connector clients then read names out of it with a cast. What they got back
 * went two places, and the second is the one that bites:
 *
 *   - a `text` column (`external_company_name`, `external_org_name`), where a
 *     non-string is whatever the driver makes of it (`[object Object]`) and a
 *     megabyte of one is stored whole; and
 *   - a `jsonb` one — `recordEvent`'s payload for the connect event, and
 *     `last_sync_summary` for the pull — where `U+0000` and a lone surrogate
 *     are not stored wrong, they are *refused*, by the driver, with an error no
 *     repo recognises (`domain/nulBytes.ts` has the two codes and why).
 *
 * A refused jsonb write is not one bad field. `upsertConnection` writes the row
 * and its event in one transaction, so a `tenantName` carrying a NUL rolls the
 * connection back after the OAuth code has been spent — the analyst reconnects,
 * the provider sends the same name, and the connect fails identically forever.
 * `recordSync` is worse still: it runs *after* the pull has been applied and
 * outside every catch in the sync, so the grants or the cap table are written,
 * the connection's `next_sync_at` is never advanced, no error is recorded, and
 * the sweep re-pulls and re-applies the same payload every fifteen minutes
 * against a connection whose page says it is healthy.
 *
 * Null rather than a truncation or a strip, per `extractIdentity` and the HRIS
 * mapper this generalises: half a value presented as whole, or an edited one
 * stored under a success, is the silent corruption this codebase refuses
 * elsewhere. What the absence then *means* is the caller's — a missing company
 * name is cosmetic, a missing external id makes a pull impossible.
 */
export function storableProviderText(value: unknown, max: number = MAX_PROVIDER_TEXT): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return findUnstorableText(trimmed) ? null : trimmed;
}
