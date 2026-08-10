/**
 * Carrying a row's `version` over HTTP, so a stale editor is turned away rather
 * than silently winning (migration 0137).
 *
 * The version travels as an entity tag: the GET returns `ETag: "7"`, and a
 * client that wants its write checked sends that value straight back as
 * `If-Match`. This is RFC 9110's mechanism for exactly this problem, which
 * means browsers, caches and HTTP clients already know not to mangle it, and a
 * client that has no opinion simply omits the header and gets the old
 * last-write-wins behaviour.
 *
 * Parsing is deliberately generous about the *shape* and strict about the
 * *value*: `"7"`, `W/"7"` and a bare `7` are all read as version 7, because the
 * three are indistinguishable in intent and rejecting the bare form would only
 * punish clients hand-rolling the header. Anything that is not a non-negative
 * integer is an error rather than a silently-ignored header — a typo'd
 * `If-Match` that is quietly dropped is a lost-update bug wearing a seatbelt
 * that was never buckled.
 */

/** The `ETag` value for a row at `version`. */
export function versionEtag(version: number): string {
  return `"${version}"`;
}

export type IfMatch =
  | { kind: 'absent' }
  | { kind: 'any' }
  | { kind: 'version'; version: number }
  | { kind: 'invalid'; raw: string };

/**
 * Reads an `If-Match` header into the version it names.
 *
 * `*` means "any current representation", which for this resource is the same
 * as not asking for a check — it asserts the row exists, and the caller has
 * already loaded it by the time this is read.
 */
export function parseIfMatch(raw: string | string[] | undefined): IfMatch {
  // Fastify hands back an array when the header is repeated. Repeating
  // If-Match is not a list of alternatives worth honouring here; take the
  // first and let a contradictory second be someone else's bug.
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (header === undefined) return { kind: 'absent' };

  const trimmed = header.trim();
  if (trimmed === '') return { kind: 'absent' };
  if (trimmed === '*') return { kind: 'any' };

  // Strip the optional weak-validator prefix, then the quotes. A weak tag is
  // accepted because the version is exact either way: there is no
  // representation of this row that is "semantically equivalent but different
  // bytes" at the same version.
  let value = trimmed.startsWith('W/') ? trimmed.slice(2).trim() : trimmed;
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }

  // `Number` alone would accept '', ' 7 ', '0x7', '7.0' and '1e3'. The version
  // is a small non-negative integer and nothing else.
  if (!/^\d+$/.test(value)) return { kind: 'invalid', raw: header };
  const version = Number(value);
  if (!Number.isSafeInteger(version)) return { kind: 'invalid', raw: header };
  return { kind: 'version', version };
}
