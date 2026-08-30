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
import { problems } from '@n409/shared';

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

/**
 * @fastify/multipart's code for the one failure that really is the size cap.
 * Matched on the code rather than the class so nothing here has to import the
 * plugin's error constructors, which it does not export.
 */
const FILE_TOO_LARGE = 'FST_REQ_FILE_TOO_LARGE';

/** The MB figure a limit is quoted to a person as. */
const megabytes = (bytes: number): number => bytes / (1024 * 1024);

/**
 * Read an uploaded file into memory, and say which way it failed.
 *
 * `file.toBuffer()` has more than one way to reject, and both upload routes
 * caught all of them with a bare `catch` that answered
 * "File exceeds the N MB limit". Only one of those rejections is about size.
 *
 * The other is the ordinary one: a client whose connection dropped part-way
 * through the upload. `toBuffer` consumes the file stream with a `for await`,
 * so a body that stops mid-part — a closed laptop, a lost tunnel, a proxy
 * timing out — throws from the iterator, and an eight-byte CSV came back as
 * "File exceeds the 25 MB limit". That message is not merely unhelpful, it is
 * false and it is *actionable in the wrong direction*: the reader goes away
 * and splits a spreadsheet that was never too big, and the thing that would
 * have worked — sending it again — is the one thing the message argues
 * against.
 *
 * Both answers say the same two things a failed upload has to say: nothing was
 * stored, and here is what to do differently. They differ on what that is.
 */
export async function bufferUpload(
  file: { toBuffer: () => Promise<Buffer>; file?: { truncated?: boolean } },
  maxBytes: number,
): Promise<Buffer> {
  try {
    return await file.toBuffer();
  } catch (err) {
    // `truncated` as well as the code, because the flag is what busboy sets
    // when it stops feeding the stream and is true whether or not the plugin
    // got as far as constructing its error.
    const code = (err as { code?: unknown } | null | undefined)?.code;
    if (code === FILE_TOO_LARGE || file.file?.truncated === true) {
      // The size that was *not* accepted cannot be reported: the stream was cut
      // at the limit, so the only number known here is the limit itself. What
      // can be given is the way out, and for the files this platform takes it
      // is nearly always the same one — a scanned PDF that was never
      // compressed, or a workbook carrying years of tabs that are not the cap
      // table.
      throw problems.unprocessable(
        `This file is larger than the ${megabytes(maxBytes)} MB limit, so none of it was saved. ` +
          'Split it, or upload the pages or sheets that matter on their own; a scanned document ' +
          'can usually be made much smaller by re-exporting it as a compressed PDF.',
      );
    }
    throw problems.badRequest(
      'The upload ended before the whole file arrived — nothing was saved. ' +
        'This is usually a dropped connection rather than a problem with the file; upload it again.',
    );
  }
}
