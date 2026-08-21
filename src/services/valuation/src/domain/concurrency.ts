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

/**
 * What every `version` column in this schema is *for*.
 *
 * Round 93 found `PATCH /valuations/:id/params` still last-write-wins on a row
 * that had carried a version — and had been bumping it on every write — since
 * migration 0158. The column was there, the sibling editor was using it, and
 * the larger of the two forms simply never read the header. Nothing failed,
 * because nothing was looking: a guard is invisible when it is missing, and a
 * half-applied one is invisible twice over.
 *
 * So the roster is asserted against the database rather than maintained by
 * hand. `optimisticLockCensus.test.ts` reads `information_schema` for every
 * column named `version` and requires an entry here for each: a `lock` names
 * the routes that must honour it, and anything else has to say why it is not a
 * lock. Adding a version column without deciding which of the two it is now
 * fails a test instead of waiting for two analysts to notice.
 *
 * The entry is keyed by table because that is what the schema knows. A lock
 * whose counter does not live in a column called `version` — the report editor
 * anchors on `reports.current_version` — is listed too, under `extraLocks`,
 * since the census cannot find those on its own.
 */
export type VersionColumn =
  | {
      kind: 'lock';
      /** The migration that introduced it, for the archaeology. */
      migration: string;
      /**
       * Every route that writes this row through a form a person edits.
       *
       * Each is probed for real: sent a malformed `If-Match` and required to
       * refuse it by name. A route that has quietly stopped parsing the header
       * answers something else, which is precisely the state `PATCH /params`
       * was in for eight migrations.
       */
      guardedRoutes: readonly string[];
    }
  | {
      kind: 'not-a-lock';
      /** What the number means instead, and why no write has to check it. */
      reason: string;
    };

export const VERSION_COLUMNS: Readonly<Record<string, VersionColumn>> = {
  valuations: {
    kind: 'lock',
    migration: '0137',
    guardedRoutes: ['PATCH /api/v1/valuations/:id'],
  },
  valuation_params: {
    kind: 'lock',
    migration: '0158',
    // Two doors onto one row, which is the whole reason the counter is on the
    // row rather than on either form.
    guardedRoutes: ['PATCH /api/v1/valuations/:id/params', 'PATCH /api/v1/valuations/:id/engine-inputs'],
  },
  cap_tables: {
    kind: 'lock',
    migration: '0162',
    guardedRoutes: ['PUT /api/v1/valuations/:id/cap-table'],
  },
  company_profiles: {
    kind: 'lock',
    migration: '0166',
    guardedRoutes: ['PATCH /api/v1/valuations/:id/company-profile'],
  },
  report_versions: {
    kind: 'not-a-lock',
    reason:
      'the append-only history of a report body — `version` is the sequence number of a row that is ' +
      'never updated. The editor’s lost-update guard is on `reports.current_version`; see extraLocks.',
  },
  report_templates: {
    kind: 'not-a-lock',
    reason:
      'the revision number of a published skeleton, half of the (name, version) key. A template is ' +
      'superseded by inserting the next version, not by updating this row in place.',
  },
  ai_prompt_versions: {
    kind: 'not-a-lock',
    reason: 'the history of an edited agent prompt — one row per revision, never updated after insert.',
  },
};

/**
 * Locks whose counter is not a column called `version`, so the schema sweep
 * cannot find them. Listed here so they are probed with the rest.
 */
export const EXTRA_LOCKS: readonly { anchor: string; guardedRoutes: readonly string[] }[] = [
  { anchor: 'reports.current_version', guardedRoutes: ['PUT /api/v1/valuations/:id/report'] },
];
