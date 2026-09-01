/**
 * The characters Postgres will not take, whatever column they are aimed at.
 *
 * Two of them, found a round apart and refused in the same place because they
 * fail in the same way: a schema passes them, a handler hands them to the
 * driver, and the write comes back as a database error nothing recognises.
 *
 * ## `U+0000`
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
 *
 * ## An unpaired surrogate
 *
 * `U+D800`–`U+DFFF` are not characters; they are the two halves JavaScript
 * splits an astral code point into, and a *lone* half is a string JavaScript
 * will hold and UTF-8 cannot encode. Every layer below has its own answer and
 * none of them is the one the caller wanted:
 *
 *   - a `text` parameter is encoded by the driver with the half replaced by
 *     `U+FFFD`, so `Acme\uD800 Ltd` is *stored* as `Acme\uFFFD Ltd` — a write
 *     answered 200 that silently changed the company name it saved;
 *   - a `jsonb` parameter is refused outright. `JSON.stringify` is required to
 *     emit the half as the literal escape `\ud800` (well-formed stringify,
 *     ES2019), Postgres's JSON parser rejects an unpaired escape, and the
 *     write fails with `22P02 invalid input syntax for type json`.
 *
 * The second is the one that shows. Almost every write on this service records
 * an event, and `recordEvent` puts the payload — which carries the same strings
 * the row does — into a `jsonb` column. So `POST /api/v1/valuations` with a
 * company name a browser can produce by pasting half an emoji, and the company
 * profile editor with the same name, both answered 500: the row inserted, the
 * event refused, the transaction rolled back, and the client told the server
 * broke.
 *
 * Refused for the same reason the NUL is, plus one: here the alternatives are
 * not "store it or refuse it" but "corrupt it or refuse it". `U+FFFD` in a
 * legal name is a worse outcome than being told the name could not be read.
 */

/** How deep a value is walked before it is left alone. Matches boundedJson. */
export const MAX_SCAN_DEPTH = 12;

const NUL = '\u0000';

/**
 * A surrogate code unit with no partner — a high one not followed by a low, or
 * a low one not preceded by a high.
 *
 * Guarded by a cheap "is there a surrogate at all" test because the overwhelming
 * majority of strings have none, and the ones that do are ordinary emoji.
 */
function hasLoneSurrogate(value: string): boolean {
  if (!/[\uD800-\uDFFF]/.test(value)) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Why a string cannot be stored as sent. */
export type UnstorableReason = 'nul' | 'lone_surrogate';

/** Where an unstorable string sits, and what is wrong with it. */
export interface UnstorableText {
  path: string;
  reason: UnstorableReason;
}

function unstorable(value: string): UnstorableReason | null {
  if (value.includes(NUL)) return 'nul';
  return hasLoneSurrogate(value) ? 'lone_surrogate' : null;
}

/**
 * One walk of a request value, per {@link scanRequestValue}.
 *
 * `stack` is the path to the node being looked at, held as segments rather than
 * as a string: THIS HOOK RUNS ON EVERY REQUEST AND THE PATH IS DISCARDED ON
 * ALMOST ALL OF THEM (round 314, methodology M8). Composing `${path}.${key}` on
 * the way down allocated a string per node — for a 5,000-row cap-table body
 * that is ~65,000 strings, most of them long, built to be thrown away. Pushing
 * the segment and joining only where something is found costs nothing until
 * there is something to name.
 */
interface Walk {
  stack: (string | number)[];
  /** Prefix the public entry point was given, for path continuity. */
  prefix: string;
  /** First node deeper than the scan reads, as a path. Null until one is met. */
  deep: string | null;
  /** False when the caller only wants the depth answer — see `findOverDeepValue`. */
  wantUnstorable: boolean;
}

/** `a.b[0].c` from the segment stack. Built only when something has been found. */
function pathOf(walk: Walk): string {
  let out = walk.prefix;
  for (const seg of walk.stack) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${seg}` : seg;
  }
  return out || '(root)';
}

function scan(value: unknown, depth: number, walk: Walk): UnstorableText | null {
  // Ahead of the type tests, and that is the point: what is recorded is the
  // place the scan gave up, whatever sits there. A string at this depth is
  // exactly the value it could not read.
  if (depth > MAX_SCAN_DEPTH) {
    walk.deep ??= pathOf(walk);
    return null;
  }
  if (typeof value === 'string') {
    if (!walk.wantUnstorable) return null;
    const reason = unstorable(value);
    return reason ? { path: pathOf(walk), reason } : null;
  }
  if (value === null || typeof value !== 'object') return null;
  // Buffers and streams are the multipart/webhook bodies, which are bytes on
  // purpose and are not headed for a text column as they stand.
  if (Buffer.isBuffer(value) || value instanceof Date) return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walk.stack.push(i);
      const hit = scan(value[i], depth + 1, walk);
      walk.stack.pop();
      if (hit) return hit;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  // `Object.keys` rather than `Object.entries`: the pair arrays `entries`
  // allocates are two objects per key, on every request, for a list this only
  // iterates.
  for (const key of Object.keys(record)) {
    walk.stack.push(key);
    const keyReason = walk.wantUnstorable ? unstorable(key) : null;
    if (keyReason) {
      const path = `${pathOf(walk)} (key)`;
      walk.stack.pop();
      return { path, reason: keyReason };
    }
    const hit = scan(record[key], depth + 1, walk);
    walk.stack.pop();
    if (hit) return hit;
  }
  return null;
}

/** What one walk of a request value found, in the order a refusal reports it. */
export interface RequestScan {
  /** The first string Postgres will not store as sent, or null. */
  unstorable: UnstorableText | null;
  /** The first value nested past the scan, or null. Only meaningful when
   *  `unstorable` is null — the walk stops at an unstorable hit, and an
   *  unstorable string is the refusal that wins either way. */
  overDeep: string | null;
}

/**
 * Both refusals a request body can earn, from one traversal.
 *
 * ONE WALK, NOT TWO (round 314, methodology M8). The `preValidation` hook asked
 * these as two questions — `findUnstorableText`, then `findOverDeepValue` — over
 * the same value, and the second walk visits exactly the nodes the first one
 * did. On a 5,000-row cap-table import that was 2.7 ms of the 6.6 ms this hook
 * spent before the route saw the request, and the hook runs on every request the
 * service takes.
 *
 * Precedence is unchanged, deliberately: an unstorable string is reported even
 * when something else in the body is also nested too deep. The walk stops at the
 * first unstorable hit, so `overDeep` is complete exactly when it is the answer.
 */
export function scanRequestValue(value: unknown): RequestScan {
  const walk: Walk = { stack: [], prefix: '', deep: null, wantUnstorable: true };
  const unstorable = scan(value, 0, walk);
  return { unstorable, overDeep: unstorable ? null : walk.deep };
}

/**
 * The first string in `value` that Postgres will not store as sent, or null.
 *
 * Keys are searched as well as values: a `z.record(z.string(), z.string())`
 * mapping — the cap-table column mapping is one — lands in a `jsonb` column
 * with its keys intact, and a key is as unstorable as a value.
 *
 * A path is returned rather than a boolean so the refusal can name the field.
 * "Something in your request cannot be stored" is not an answer a caller can
 * act on when the body is a cap table.
 */
export function findUnstorableText(value: unknown, path = '', depth = 0): UnstorableText | null {
  return scan(value, depth, { stack: [], prefix: path, deep: null, wantUnstorable: true });
}

/**
 * The path of the first value nested deeper than {@link findUnstorableText}
 * will walk, or null.
 *
 * The scan stops at `MAX_SCAN_DEPTH` and answers `null` — "nothing unstorable
 * here" — for everything below it. That answer is vacuous rather than true: a
 * NUL at depth 13 is as unstorable as one at depth 1, and it reached the jsonb
 * column that a request body's free-form record ends up in
 * (`POST /valuations/:id/calculate`'s `inputs`, the debt route's `params` and
 * `overrides`, and their siblings), where the driver refused it as `22021` and
 * the route answered 500.
 *
 * The bound itself stays: the scan is recursive, and an unbounded walk over a
 * megabyte of `[[[[…` is a stack overflow, which is the same 500 by another
 * road. So what changes is what the bound *means* — a body the guard cannot
 * finish reading is refused rather than waved through. Nothing legitimate is
 * near it: the deepest request body this API accepts is the engine input
 * document at four levels, and the nested provider payloads that genuinely run
 * deep (a Stripe event, a connector pull) are not request bodies and do not
 * come through this door.
 *
 * The request path asks this through {@link scanRequestValue} instead, which
 * answers it in the walk it was already making.
 */
export function findOverDeepValue(value: unknown, path = '', depth = 0): string | null {
  const walk: Walk = { stack: [], prefix: path, deep: null, wantUnstorable: false };
  scan(value, depth, walk);
  return walk.deep;
}

/** The sentence a caller reads when their body is nested past the scan. */
export function overDeepMessage(path: string): string {
  return (
    `Field ${path} is nested more than ${MAX_SCAN_DEPTH} levels deep, ` +
    'which is deeper than this API accepts'
  );
}

/** What a refusal says about `reason`, as the sentence a caller reads. */
export const UNSTORABLE_REASONS: Record<UnstorableReason, string> = {
  nul: 'a NUL byte, which cannot be stored',
  lone_surrogate: 'an unpaired surrogate — half of a character — which cannot be stored',
};

/** `Field x contains …`, the one sentence both refusals are built from. */
export function unstorableTextMessage(hit: UnstorableText): string {
  return `Field ${hit.path} contains ${UNSTORABLE_REASONS[hit.reason]}`;
}
