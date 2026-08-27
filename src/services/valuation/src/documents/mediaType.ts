/**
 * Normalising the content type a client declares for an upload (round 182).
 *
 * `file.mimetype` is whatever the `Content-Type` header of a multipart *part*
 * said, and both upload paths took it at its word: `contentType: file.mimetype`
 * on the session route, `content_type` on the partner API. It was written to
 * `documents.content_type` — `text NOT NULL` — and read back out on the
 * download route as the response's own `Content-Type` header. Nothing between
 * those two points looked at it.
 *
 * Two things followed from that, and the first is the one that showed.
 *
 * **A NUL byte in a part header is a 500.** The estate's guard against the one
 * character Postgres will not store is a `preValidation` hook over the parsed
 * body (see domain/nulBytes.ts), and that hook says of itself that "the paths
 * that genuinely carry bytes — document uploads — come in as multipart and
 * never through here". True of the *body*, which is a stream when the hook
 * runs. Not true of the part headers, which busboy has already decoded into
 * strings by the time the handler asks for them:
 *
 *   Content-Type: text/plain<NUL>evil   →  500 urn:n409:problem:internal
 *
 * — the driver refusing `22021 invalid byte sequence`, arriving at the error
 * handler as an unrecognised database error. An authenticated client can send
 * it with curl; the filename half of the same trick was already closed, because
 * `safeFilename` strips control characters, and nothing did the same for the
 * type beside it.
 *
 * **And its length was bounded by nothing.** A part header of 20 KB was stored
 * whole and came back as a 20 KB `Content-Type` on the download — larger than
 * the 16 KB header budget Node's own HTTP client will parse, so a response the
 * platform generated about a file it was serving became one some clients cannot
 * read. That is not a size limit anybody had chosen; it is what was left after
 * nobody chose one.
 *
 * The answer to both is that a media type is not free text. RFC 9110 §8.3 says
 * it is `type/subtype` of RFC 9110 tokens, optionally followed by parameters,
 * and anything that is not that is not a content type — it is a string in the
 * field where the content type goes. So it is parsed rather than sanitized: a
 * value that is a media type is kept (lowercased in its type/subtype, which is
 * case-insensitive, with its parameters preserved for the `charset` and
 * `boundary` that carry meaning), and a value that is not is replaced with
 * `application/octet-stream` — the type RFC 9110 §8.3 names for "bytes whose
 * type the sender would not or could not say", which is exactly what a
 * client that sent this has told us.
 *
 * Replaced rather than refused, deliberately, and it is the one place in this
 * round where that is the right way round. The other adversarial inputs of this
 * round are refused because the caller stated something about their own request
 * that was false and can restate it. But the `Content-Type` of a multipart part
 * is chosen by the *browser*, not by the person uploading: a client whose OS has
 * no mapping for `.xlsx` sends the empty string or something odd, and the
 * person clicking Upload cannot correct it and would not know what it meant.
 * Refusing there would turn a browser quirk into an upload nobody can complete,
 * to protect a field the platform only ever echoes back.
 */

/** What is stored when the client's declared type cannot be believed. */
export const DEFAULT_MEDIA_TYPE = 'application/octet-stream';

/**
 * The longest declared type kept intact.
 *
 * Nothing legitimate approaches it — the longest type in IANA's registry is
 * under 90 characters and the parameters that follow one are a charset or a
 * boundary — so this is a ceiling on the pathological case rather than a
 * constraint on the real one. A value over it is not truncated (a truncated
 * media type is a *different, wrong* media type, and half a `multipart/related;
 * boundary=…` is worse than no claim at all) but replaced.
 */
export const MAX_MEDIA_TYPE_LENGTH = 255;

/**
 * RFC 9110 §5.6.2 token: the characters allowed in a type, a subtype, a
 * parameter name, and an unquoted parameter value. Written out rather than
 * spelled as a negated class so that the control characters — the NUL this
 * exists for among them — are excluded by construction rather than by a
 * separate check somebody can forget to keep in step.
 */
const TOKEN = String.raw`[!#$%&'*+.^_\`|~0-9A-Za-z-]+`;

/**
 * `type/subtype` followed by any number of `; name=value` parameters, where a
 * value is a token or a quoted-string.
 *
 * The quoted-string alternative is not decoration: `boundary="a b"` and
 * `name="my report.pdf"` are both ordinary, and a parser that only accepted
 * tokens would throw away the parameters of a perfectly well-formed type. `\\.`
 * inside it is RFC 9110's quoted-pair, which is how a quote reaches the inside
 * of one.
 */
const MEDIA_TYPE = new RegExp(
  `^${TOKEN}/${TOKEN}` + `(?:\\s*;\\s*${TOKEN}\\s*=\\s*(?:${TOKEN}|"(?:[^"\\\\]|\\\\.)*"))*$`,
);

/**
 * The media type to store for a declared one, or {@link DEFAULT_MEDIA_TYPE}.
 *
 * Total, and never throws: every caller is on an upload path where the
 * alternative to an answer is a 500, which is the failure this exists to end.
 */
export function normalizeMediaType(declared: string | null | undefined): string {
  if (typeof declared !== 'string') return DEFAULT_MEDIA_TYPE;
  const trimmed = declared.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_MEDIA_TYPE_LENGTH) return DEFAULT_MEDIA_TYPE;
  if (!MEDIA_TYPE.test(trimmed)) return DEFAULT_MEDIA_TYPE;
  // Type and subtype are case-insensitive (RFC 9110 §8.3.1) and conventionally
  // lowercase; parameter *values* are not, and `boundary=AaBb` is a different
  // boundary from `boundary=aabb`, so only the part before the first `;` is
  // folded.
  const semi = trimmed.indexOf(';');
  if (semi < 0) return trimmed.toLowerCase();
  return trimmed.slice(0, semi).toLowerCase() + trimmed.slice(semi);
}
