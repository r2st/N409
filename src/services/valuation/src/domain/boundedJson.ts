/**
 * A JSON-safe, size-bounded copy of an arbitrary payload.
 *
 * Why bound rather than store whole
 * ---------------------------------
 * `network_items` keeps the request and response of every engine and AI call.
 * An engine compute request carries the whole cap table, every share class and
 * every projection period; a sensitivity response carries a grid. Stored
 * verbatim on every call, the diagnostic log outgrows the data it describes —
 * and the reader of a step view scans the head of a list and the shape of an
 * object, never the four-hundredth projection period.
 *
 * What it must not do is drop a tail silently. A list cut to its first fifty
 * elements with no marker reads as a list that had fifty elements, which is a
 * worse answer than not storing it: it invites someone to conclude the payload
 * we sent was short. Every truncation therefore leaves a `__truncated__` note
 * saying how much went missing.
 *
 * This is the TypeScript counterpart of `engine/trace.py:_plain`, kept
 * deliberately to the same limits and the same marker shape so a reader moving
 * between the engine step view and the network log reads one convention.
 * They are not shared code — the two run in different languages in different
 * processes — so the tests on each side assert the limits independently.
 */

import { sliceChars } from './textSlice.js';

/** How deep an object is walked before it is summarised rather than copied. */
export const MAX_DEPTH = 6;

/** Longest array copied element-by-element; the rest becomes a count. */
export const MAX_ITEMS = 50;

/**
 * Longest string kept whole. Long enough for any identifier, a URL or a
 * sentence of prose; short enough that an extracted document body — which is
 * what actually threatens this table's size — is cut rather than stored twice.
 */
export const MAX_STRING = 2_000;

/**
 * Keys whose value is a copy of client material rather than a description of a
 * call, replaced by their size instead of being stored.
 *
 * `network_items` keeps the request of every engine and AI call, and the AI
 * pipeline request carries `documents[].content_base64` — the *decrypted* bytes
 * of an uploaded cap table, offer letter or board consent, read back out of the
 * blob store by `encodeDocuments`. Bounding a string to 2,000 characters does
 * not make that a description of the call; it makes it the first 1,500 bytes of
 * the document, in plaintext jsonb, in the nightly dump.
 *
 * The asymmetry is what makes it worth fixing rather than shrugging at. The
 * primary copy is envelope-encrypted on disk precisely so that a stolen backup
 * yields no client documents (`storage/documentEncryption.ts`), and this is a
 * second copy of the same bytes with none of that — the identical argument
 * `crypto/connectionSecrets.ts` makes about the OAuth tokens that were
 * enumerated in the log redact list and then stored in the clear. Two lines
 * above the call that writes these rows, `createAiJob` states the rule this
 * breaks: "Persist provenance, not payloads: which docs went in, not their
 * bytes." And `encodeDocuments` keeps the *filename* off its log lines because
 * "this platform's uploads are offer letters and board consents, and their
 * names carry the people in them", while assembling a payload whose bodies were
 * copied verbatim.
 *
 * Nothing reads them. The network log answers which call was made, how long it
 * took and what came back — the document's id, filename and content type say
 * which file went in, and no reader of a diagnostic row has ever wanted its
 * first page.
 *
 * Enumerated by name, and here rather than at the call sites, for the reason
 * every other rule in this codebase is centralised: the next caller inherits it
 * instead of rediscovering it. `text` is the `/ai/anonymize` body — up to
 * 200,000 characters an operator pasted out of a client's spreadsheet, which is
 * the same material by a different route. Both are replaced with a marker
 * naming the size, so the row still says a body was sent and how big it was.
 */
export const CLIENT_BODY_KEYS: ReadonlySet<string> = new Set(['content_base64', 'text']);

/**
 * A string this can be certain will insert.
 *
 * Both of this function's promises are about the write: the bounds keep the
 * payload small, and the `null` for a non-finite number keeps a trace of a run
 * that overflowed rather than failing the insert that records it. Two
 * characters break the second one, and `domain/nulBytes.ts` — which refuses
 * both at the request door — is the long-form account of why:
 *
 *   * **An unpaired surrogate.** `JSON.stringify` emits it as the literal
 *     escape `\ud800`, Postgres's JSON parser rejects an unpaired escape, and
 *     the whole `network_items` row is lost.
 *   * **`U+0000`.** `JSON.stringify` emits `\u0000`, and `jsonb` has no
 *     representation for it — the parser refuses that escape too, with
 *     `unsupported Unicode escape sequence`. Same lost row, same silence.
 *
 * The surrogate arrives two ways. `MAX_STRING` used to cut with `String.slice`,
 * which counts UTF-16 units, so an emoji straddling character 2,000 of an
 * upstream body was halved by this function itself; `sliceChars` ends that.
 * What is left is a half-character already in the payload, and here — unlike at
 * the request boundary, where a name is refused rather than edited — replacing
 * it is right: this is a diagnostic copy of something already sent, and
 * `U+FFFD` in a log beats no log.
 *
 * The NUL only ever arrives that second way, and only from the side of the wire
 * the request hook does not cover. `boundedJson` runs over the *response* of
 * every engine and AI call as well as the request: a model that emits
 * `\u0000` inside a JSON string, or a connector pull that carries one through
 * from a client's own spreadsheet, is a payload no schema on this service ever
 * saw. Refusing it is not on the table — the call already happened — so it is
 * replaced, for the same reason and with the same character as the surrogate.
 */
function storable(value: string): string {
  // Fast path: almost nothing carries either character.
  // eslint-disable-next-line no-control-regex
  if (!/[\uD800-\uDFFF\u0000]/.test(value)) return value;
  return value
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
    // eslint-disable-next-line no-control-regex
    .replace(/\u0000/g, '\uFFFD');
}

/** The marker left wherever something was dropped. Never a bare truncation. */
interface Truncated {
  __truncated__: string;
}

function truncated(what: string): Truncated {
  return { __truncated__: what };
}

/**
 * Bounded, detached, JSON-safe. Cycles are cut with a marker rather than
 * throwing: a payload that cannot be serialised is still a payload worth
 * recording the shape of, and this runs on the failure path where the last
 * thing wanted is a second error.
 */
export function boundedJson(value: unknown, depth = 0, seen: Set<object> = new Set()): unknown {
  if (value === null || value === undefined) return null;

  switch (typeof value) {
    case 'boolean':
    case 'number':
      // NaN and ±Infinity are not JSON. A trace of a run that overflowed is
      // precisely the one worth having, so they are recorded as null rather
      // than allowed to fail the insert.
      return typeof value === 'number' && !Number.isFinite(value) ? null : value;
    case 'string':
      return value.length > MAX_STRING
        ? `${storable(sliceChars(value, MAX_STRING))}… [${value.length - MAX_STRING} more characters]`
        : storable(value);
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      // Neither can appear in a payload that was about to be JSON.stringify'd,
      // but this also runs over responses we failed to parse.
      return truncated(typeof value);
    default:
      break;
  }

  if (value instanceof Date) return value.toISOString();

  const obj = value as object;
  if (seen.has(obj)) return truncated('circular reference');

  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return truncated(`${value.length} items`);
    seen.add(obj);
    try {
      const head: unknown[] = value.slice(0, MAX_ITEMS).map((v) => boundedJson(v, depth + 1, seen));
      if (value.length > MAX_ITEMS) head.push(truncated(`${value.length - MAX_ITEMS} more items`));
      return head;
    } finally {
      // Removed on the way out so a value repeated across sibling branches —
      // the same share class referenced twice — is copied both times rather
      // than reported as a cycle. Only a genuine ancestor loop is cut.
      seen.delete(obj);
    }
  }

  const keys = Object.keys(obj as Record<string, unknown>);
  if (depth >= MAX_DEPTH) return truncated(`${keys.length} keys`);
  seen.add(obj);
  try {
    const out: Record<string, unknown> = {};
    for (const key of keys.slice(0, MAX_ITEMS)) {
      const raw = (obj as Record<string, unknown>)[key];
      // A key is as unstorable as a value — `findUnstorableText` searches both
      // for exactly this reason — and an upstream that names a field with half
      // an emoji in it loses the row just as surely as one that puts it in the
      // field. The membership test and the marker keep the *sent* spelling, so
      // `content_base64\u0000` is still recognised as the client body it is;
      // only what lands in the column is repaired.
      const safeKey = storable(key);
      out[safeKey] =
        CLIENT_BODY_KEYS.has(key) && typeof raw === 'string'
          ? truncated(`${safeKey}, ${raw.length} characters`)
          : boundedJson(raw, depth + 1, seen);
    }
    if (keys.length > MAX_ITEMS) out.__truncated__ = `${keys.length - MAX_ITEMS} more keys`;
    return out;
  } finally {
    seen.delete(obj);
  }
}
