/**
 * The one character a `text` column will not take.
 *
 * Postgres stores text as UTF-8 and `U+0000` has no UTF-8 encoding it will
 * accept: any string carrying one is refused by the driver with
 * `22021 invalid byte sequence for encoding "UTF8": 0x00`, whatever the column
 * is and whether the write is a `text`, a `jsonb` or an array element. That is
 * not a constraint violation any repo looks for, so it arrives at the error
 * handler as an unrecognised database error and leaves as a 500.
 *
 * Nothing in the schemas sees it coming. `z.string()` is happy — `U+0000` is a
 * character like any other to zod, and every bound the schemas do carry is
 * about length, charset or shape rather than this one code point. Neither does
 * a raw-bytes scan of the request help: a JSON client writes the character as
 * the six ASCII characters `\u0000`, so the byte only exists after
 * `JSON.parse`. It has to be looked for in the parsed value.
 *
 * The exposure is not theoretical or admin-only. `POST /api/v1/contact` is the
 * unauthenticated marketing contact form, and a `name` with a NUL in it took
 * the request to 500 — a public endpoint turning a client-controlled character
 * into a server error, logged as one, on a form built to be submitted by
 * strangers.
 *
 * Refused rather than stripped. Stripping edits what someone submitted and
 * stores the edit under a 201 that says it was saved as sent; there is no
 * legitimate reason for this character to be in a company name, a comment or a
 * search term, so saying so is the honest answer. The paths that genuinely
 * carry bytes — document uploads — come in as multipart and never through
 * here.
 */

/** How deep a value is walked before it is left alone. Matches boundedJson. */
export const MAX_SCAN_DEPTH = 12;

const NUL = '\u0000';

/**
 * The JSON path of the first NUL-carrying string in `value`, or null.
 *
 * Keys are searched as well as values: a `z.record(z.string(), z.string())`
 * mapping — the cap-table column mapping is one — lands in a `jsonb` column
 * with its keys intact, and a key is as unstorable as a value.
 *
 * A path is returned rather than a boolean so the refusal can name the field.
 * "Something in your request has a NUL in it" is not an answer a caller can
 * act on when the body is a cap table.
 */
export function findNulByte(value: unknown, path = '', depth = 0): string | null {
  if (depth > MAX_SCAN_DEPTH) return null;
  if (typeof value === 'string') return value.includes(NUL) ? path || '(root)' : null;
  if (value === null || typeof value !== 'object') return null;
  // Buffers and streams are the multipart/webhook bodies, which are bytes on
  // purpose and are not headed for a text column as they stand.
  if (Buffer.isBuffer(value) || value instanceof Date) return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findNulByte(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    if (key.includes(NUL)) return `${here} (key)`;
    const hit = findNulByte(child, here, depth + 1);
    if (hit) return hit;
  }
  return null;
}
