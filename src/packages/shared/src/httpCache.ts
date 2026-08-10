import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Conditional GET (ETag / If-None-Match) for read-heavy JSON endpoints.
 *
 * `TtlCache` already stops repeated reads from reaching Postgres, but every
 * one of those hits still serialized the full payload and pushed it down the
 * wire. The help-article list is fetched by the HelpWidget on *every page
 * mount*, for every user, against content that changes a few times a day; the
 * blog index is fetched by anonymous traffic and crawlers. Those responses were
 * re-sent in full every time even though the bytes were identical, and the
 * browser had no way to say "I already have this" because nothing ever gave it
 * a validator.
 *
 * So: hash the body, send it as an ETag, and answer a matching `If-None-Match`
 * with a bodyless 304. The server still does the work of producing the payload
 * — this saves bandwidth and client-side parsing, not database time, which is
 * what the TTL cache above it is for. The two compose: the cache decides
 * whether we query, the ETag decides whether we transmit.
 *
 * Deliberately *not* applied to per-user mutable data (notifications, the
 * valuation list). A 304 there would be correct only as long as the ETag is
 * recomputed from live data on every request, which is exactly the cost the
 * caching was meant to avoid — and getting it wrong shows a user a stale
 * unread badge, which is worse than sending the bytes.
 */

/**
 * A strong ETag over the JSON encoding of `payload`.
 *
 * `JSON.stringify` is used rather than a structural hash because it is exactly
 * what the framework will serialize, so two payloads share an ETag if and only
 * if the client would receive identical bytes. Key order is therefore
 * significant — that is a property, not a bug: a payload whose key order
 * changed *did* change on the wire.
 */
export function etagFor(payload: unknown): string {
  const json = JSON.stringify(payload) ?? 'null';
  return `"${createHash('sha256').update(json).digest('base64url').slice(0, 27)}"`;
}

/**
 * Does `If-None-Match` match this ETag?
 *
 * Per RFC 9110 the header is a comma-separated list, and `*` matches any
 * existing representation. Weak-comparison is used (the `W/` prefix is
 * stripped before comparing), which is the correct function for
 * `If-None-Match` — a client that received `W/"x"` must still get a 304 when
 * the server now holds `"x"`.
 */
export function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const normalize = (t: string) => t.trim().replace(/^W\//, '');
  const target = normalize(etag);
  return header
    .split(',')
    .map(normalize)
    .some((candidate) => candidate === '*' || candidate === target);
}

export interface ConditionalOptions {
  /**
   * `Cache-Control` for the response. Defaults to `private, no-cache`, which
   * means "you may store this, but revalidate before reusing it" — the header
   * that makes a client actually send `If-None-Match` rather than either
   * re-downloading blindly or serving a stale copy without asking.
   */
  cacheControl?: string;
}

/**
 * Attaches validators to a JSON response and short-circuits to 304 when the
 * client already has it.
 *
 * Returns the payload to send, or `undefined` when a 304 has been dispatched —
 * so a route reads `return conditionalJson(req, reply, body) ?? reply;`... in
 * practice callers just `return`, because Fastify treats an already-sent reply
 * correctly and `undefined` is never serialized.
 */
export function conditionalJson<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  payload: T,
  opts: ConditionalOptions = {},
): T | undefined {
  const etag = etagFor(payload);
  void reply.header('etag', etag);
  void reply.header('cache-control', opts.cacheControl ?? 'private, no-cache');

  if (matchesIfNoneMatch(req.headers['if-none-match'], etag)) {
    // 304 carries no body. Fastify would happily serialize one; sending it
    // would be a protocol violation and some proxies cache the result.
    void reply.code(304).send();
    return undefined;
  }
  return payload;
}
