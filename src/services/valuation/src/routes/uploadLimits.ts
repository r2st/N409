/**
 * Non-file limits for the two multipart upload routes (round 74).
 *
 * `fileSize` was the only limit either route set, and `fileSize` is the one
 * limit a request can trivially avoid: it applies to file parts, and a
 * multipart body is not obliged to contain one. A request made entirely of
 * *text* fields was bounded by nothing either route configured.
 *
 * Nor by anything else. Fastify's `bodyLimit` does not reach multipart at all —
 * @fastify/multipart registers its own content-type parser and meters the body
 * itself — so the estate's other body ceiling does not apply here either.
 *
 * What was left was busboy's defaults: 1 MB per field, and @fastify/multipart's
 * 1000-part cap. Multiplied out, that is a request of roughly a gigabyte that
 * both routes accepted, buffered, and only then rejected for having no file in
 * it. Measured on the real registration: 500 fields of 900 KB is a 439 MB body
 * that returned 200 and cost ~920 MB of heap — on a service whose documented
 * document ceiling is 25 MB and whose cap-table ceiling is 10.
 *
 * The numbers below come from what the routes actually read. `documents` takes
 * one file and two short enum-valued fields (`kind`, `category`); `cap-table`
 * takes one file and nothing else. Eight fields of a kilobyte is generous
 * against both and still four orders of magnitude below what was reachable.
 */
export const UPLOAD_FIELD_LIMITS = {
  /** Text fields per request. Both routes read at most two. */
  fields: 8,
  /** Bytes per text field. `kind` and `category` are short enum members. */
  fieldSize: 1024,
  /** Bytes of a field *name* — busboy's own default, pinned so it is not implicit. */
  fieldNameSize: 100,
  /**
   * Total parts (files + fields). Bounds the request even if the ratio of
   * fields to files is not what the two limits above assume.
   */
  parts: 12,
} as const;
