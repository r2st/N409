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
        ? `${value.slice(0, MAX_STRING)}… [${value.length - MAX_STRING} more characters]`
        : value;
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
      out[key] = boundedJson((obj as Record<string, unknown>)[key], depth + 1, seen);
    }
    if (keys.length > MAX_ITEMS) out.__truncated__ = `${keys.length - MAX_ITEMS} more keys`;
    return out;
  } finally {
    seen.delete(obj);
  }
}
