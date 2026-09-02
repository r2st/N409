/**
 * What a page tells a reader when its request did not go through (round 222).
 *
 * The server's own messages are audited in the valuation service, and that
 * census stops at the wire. It has to: `detail` is the only field the browser
 * renders — `ApiError` is `super(problem.detail ?? problem.title ?? …)` — so
 * everything the server writes carefully is worth nothing if the page throws it
 * away and substitutes a shrug of its own. Five pages did.
 *
 * All five in the same shape, and all five in the same place:
 *
 *   setError(err instanceof ApiError ? err.message : 'Something went wrong — please try again.');
 *
 * The `else` branch reads like a general-purpose fallback and is not one.
 * `api()` throws `ApiError` whenever the server answered at all — any status,
 * any body, even an empty one — so the only way to land on the other side is
 * for `fetch` itself to reject, and `fetch` rejects when the request never
 * arrived. That is one situation, with one remedy, and "something went wrong"
 * points the reader back at the form instead: on a sign-up or a password reset
 * it is a person retyping a password they typed correctly, on a connection that
 * is still down.
 *
 * `describeRequestFailure` in `lib/api` is where both branches now live. This
 * census is over the pages rather than over that helper, because the failure
 * mode is not the helper being wrong — it is a new page not reaching for it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { describeActionFailure, describeRequestFailure, ApiError, OFFLINE_DETAIL } from '../src/lib/api';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(full) ? [full] : [];
  });
}

const sources = walk(SRC).map((file) => ({
  rel: path.relative(SRC, file).split(path.sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

/**
 * Whole messages that name no situation.
 *
 * Matched as whole quoted strings rather than as substrings: "something went
 * wrong" inside a longer sentence that goes on to say *what* is a different
 * thing from it being the entire answer, and only the second is the bug.
 */
const CONTENTLESS = [
  /^Something went wrong[.\s—-]*(please try again[.]?)?$/i,
  /^An error occurred[.]?$/i,
  /^Unexpected error[.]?$/i,
  /^Request failed[.]?$/i,
  // Case-sensitive, and that is not fussiness. Lowercase `'error'` is a
  // severity level and a variant prop all over this tree — `<Note kind="error">`,
  // `{ level: 'error' }` — and matching it insensitively returned 52 findings,
  // none of which was a message anybody reads. A literal that is displayed
  // starts as a sentence does.
  /^Failed[.]?$/,
  /^Error[.]?$/,
  /*
   * R357. These reached `describeActionFailure` as the *operation* half, which
   * is the half that names what the reader was doing — and they named a verb
   * with no object, on wrappers shared by four operations each. "Could not
   * save." was also the answer to two removals, where nothing was being saved
   * and the sentence sent the reader back to a form rather than to the row
   * still sitting there.
   *
   * They pass the length and whole-sentence rules below, which is why they
   * belong here: an operation can be a grammatical sentence and still not be
   * an operation.
   */
  /^Action failed[.]?$/i,
  /^Could not save[.]?$/i,
];

/**
 * The argument span of every call that puts a message in front of a reader.
 *
 * Paren-matched so a ternary, a template literal or a nested call inside the
 * argument is still inside the span.
 */
function messageCallArguments(source: string): string[] {
  // Comments stripped first. `lib/api.ts` documents the idiom this round
  // removed by quoting it in full, and a census that reads its own explanation
  // as a finding reports the fix as the bug.
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out: string[] = [];
  const call = /\b(?:setError|setActionError|setConvertError|setMessage|new Error)\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(text))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i + 1;
    for (; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) break;
    }
    out.push(text.slice(start, i));
  }
  return out;
}

describe('a page that cannot reach the server says so', () => {
  it('finds the files it is auditing', () => {
    // A census that matches nothing passes every assertion under it.
    expect(sources.length).toBeGreaterThan(50);
    expect(sources.some(({ rel }) => rel.startsWith('pages/'))).toBe(true);
  });

  it('sets no error whose whole content is a category', () => {
    /*
     * Every literal inside the *argument span* of a call that displays a
     * message, paren-matched — not the literals sitting directly after the
     * opening paren, and not every literal in the file.
     *
     * Both narrower and both wider were tried, and each was wrong in its own
     * direction. Matching `setError\('…'` was blind to this round's own
     * founding case: all five removed messages lived in the *else branch of a
     * ternary* — `setError(err instanceof ApiError ? err.message : 'Something
     * went wrong…')` — so the literal is nowhere near the paren, and the census
     * passed against the unfixed tree. Matching every literal in the file
     * caught 52 badge labels and severity props: `'error'` as a variant, and
     * `'Error'` as the word on a status chip, neither of which anybody reads as
     * a sentence.
     *
     * The span is what separates them. A word inside `setError(...)` is being
     * shown to somebody however it got there.
     */
    const findings: string[] = [];
    for (const { rel, text } of sources) {
      for (const argument of messageCallArguments(text)) {
        for (const m of argument.matchAll(/'((?:[^\\'\n]|\\.)*)'/g)) {
          const literal = m[1]!;
          if (CONTENTLESS.some((p) => p.test(literal.trim()))) findings.push(`${rel} → "${literal}"`);
        }
      }
    }
    expect(findings, 'page messages that name a category and stop').toEqual([]);
  });

  /**
   * Round 222 looked at the 191 handlers shaped `err instanceof ApiError ?
   * err.message : '…'` and decided the shape was fine, because the `else`
   * branch names the operation. That reasoning was right about the branch it
   * examined and never looked at the other one.
   *
   * `err.message` is `detail ?? title ?? …`. On a body with no `detail` it is
   * the RFC 9457 reason phrase — the one string the spec asks to be identical
   * on every occurrence, and therefore the one guaranteed to say nothing about
   * this request. Two of this API's own handlers emit exactly that body: the
   * unhandled-500 arm of `registerProblemHandler`, and `setNotFoundHandler`.
   * So all 191 sites rendered "Internal Server Error" or "Not Found" on the two
   * failures a reader is least able to interpret, while the carefully-worded
   * operation sentence sat unused in the branch that only fires when `fetch`
   * itself rejects.
   *
   * `describeActionFailure` takes both halves, and round 255 moved every site
   * onto it. The census below is over the new shape rather than over a ban on
   * the old one, because what has to keep being true is that each of these
   * still names its operation.
   */
  it('routes every displayed failure through a helper that can read the body', () => {
    const raw = sources.flatMap(({ rel, text }) =>
      rel === 'lib/api.ts'
        ? [] // where the removed idiom is quoted, in prose, to explain itself
        : [...text.matchAll(/\b(err|e|error)\s+instanceof ApiError \?\s*\1\.message\b/g)].map(() => rel),
    );
    expect(raw, 'pages still reading a problem body’s title back to the reader').toEqual([]);
  });

  it('still names the operation at every one of them', () => {
    const idiom = sources.flatMap(({ text }) => [
      ...text.matchAll(/describeActionFailure\((?:err|e), '((?:[^\\']|\\.)*)'\)/g),
    ]);
    // The population is large and is expected to stay large.
    expect(idiom.length).toBeGreaterThan(150);
    const operations = idiom.map((m) => m[1]!);
    // Too short to have named anything.
    expect(
      operations.filter((o) => o.trim().length < 12),
      'operations too short to name an operation',
    ).toEqual([]);
    /*
     * And a whole sentence, which the old population was not required to be and
     * which now matters: the helper concatenates this with a second sentence
     * about the failure, so a fragment ("upload failed", "Rename failed") runs
     * into the next one. Five sites were fragments, and the four terse ones —
     * "Failed to load funds", "Delete failed" — were also the least useful
     * messages on the tree, which is not a coincidence.
     */
    expect(
      operations.filter((o) => !/[.!?]$/.test(o.trim())),
      'operations that are a fragment rather than a sentence',
    ).toEqual([]);
  });

  /**
   * A note on why the population jumped by sixteen when it was supposed to be a
   * one-for-one rewrite.
   *
   * The round-222 census pinned `err\.message` with the variable spelled out,
   * so `catch (e) { setError(e instanceof ApiError ? e.message : '…') }` was
   * invisible to it. Sixteen sites across the fund, debt-instrument and ASC 718
   * pages were written that way, and they held the worst strings on the tree —
   * "Rename failed", "Delete failed", "Valuation failed" — precisely because
   * nothing had ever looked at them. The assertion above matches any binding.
   */
  it('finds the sites whichever way the caught error is spelled', () => {
    const spellings = sources
      .flatMap(({ text }) => [...text.matchAll(/describeActionFailure\((\w+),/g)])
      .map((m) => m[1]!);
    expect(new Set(spellings)).toEqual(new Set(['err', 'e']));
  });

  /**
   * The half of the population the two assertions above cannot see (R350).
   *
   * Both of them are about handlers that *caught something* — the
   * `err instanceof ApiError ? err.message : '…'` idiom and its replacement.
   * Fourteen write handlers were written `} catch { setError('…') }`, with no
   * binding at all, so there was no `err` for either pattern to match and the
   * census read a clean tree.
   *
   * A bare catch is not a milder version of the shape R255 fixed; it is the
   * complete version of it. `err.message` at least renders the server's
   * `detail` when there is one, and these render it never. Every string they
   * substituted was a retry suggestion for a refusal that will be made again
   * identically: "Could not post — try again." over `refuseIfRetired`'s
   * sentence about a closed engagement, "Could not revoke the token." over a
   * `forbidden()` that says whose access this needs, "Could not disconnect."
   * over whatever the ledger said. That is the `bufferUpload` failure —
   * advice pointing away from the only thing that would help — and the same
   * files were already reaching for the helper on the handler above or below.
   *
   * Scoped to the writes, deliberately. A failed *load* has a defensible
   * constant: the page is visibly missing its content, and the reader's next
   * move is the retry the message suggests either way. A failed write is the
   * case where the server's sentence is the whole answer.
   */
  it('consults the error at every handler that changed something', () => {
    const findings: string[] = [];
    for (const { rel, text } of sources) {
      if (rel === 'lib/api.ts') continue; // where the removed idiom is quoted in prose
      const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const catches = /\bcatch\s*(\(\s*\w+\s*\))?\s*\{/g;
      let m: RegExpExecArray | null;
      while ((m = catches.exec(stripped))) {
        let depth = 0;
        let i = m.index + m[0].length - 1;
        const start = i + 1;
        for (; i < stripped.length; i++) {
          const ch = stripped[i]!;
          if (ch === '{') depth++;
          else if (ch === '}' && --depth === 0) break;
        }
        const body = stripped.slice(start, i);
        if (!/set\w*(?:Error|Note|Message)\s*\(/.test(body)) continue;
        // Already reading the failure, however it does it.
        if (/describeActionFailure|describeRequestFailure|instanceof ApiError|\berr\b/.test(body)) continue;
        // The try block this catch belongs to. A method other than GET, or a
        // `.catch` hung off a download, is what makes this a write.
        const preceding = stripped.slice(Math.max(0, m.index - 2000), m.index);
        const tryAt = preceding.lastIndexOf('try {');
        const guarded = tryAt >= 0 ? preceding.slice(tryAt) : preceding;
        if (!/method:\s*'(?:POST|PATCH|PUT|DELETE)'/.test(guarded)) continue;
        const line = stripped.slice(0, m.index).split('\n').length;
        findings.push(`${rel}:${line}`);
      }
    }
    expect(findings, 'write handlers that discard the server’s refusal unread').toEqual([]);
  });
});

describe('describeRequestFailure', () => {
  it('prefers the server’s own sentence, which is where the remedy is', () => {
    const err = new ApiError(409, {
      status: 409,
      title: 'Conflict',
      detail: 'This questionnaire has already been submitted.',
    });
    expect(describeRequestFailure(err)).toBe('This questionnaire has already been submitted.');
  });

  it('replaces the status-code-shaped message a bodiless error produces', () => {
    // `ApiError` falls back to `Request failed (502)` when the problem body has
    // neither detail nor title — a proxy that never reached the app. That is a
    // status code wearing a sentence, and it is the one case where the page
    // knows more than the message it was handed.
    const err = new ApiError(502, { status: 502 });
    expect(err.message).toBe('Request failed (502)');
    const described = describeRequestFailure(err);
    expect(described).not.toBe(err.message);
    expect(described).toContain('502');
    // A gateway status is the one family where the browser really can say the
    // request never arrived, so this arm keeps saying it.
    expect(described).toMatch(/did not get through/i);
    expect(described).toMatch(/nothing was changed/i);
  });

  it('does not read this API’s 500 reason phrase back to the reader', () => {
    /*
     * The body `registerProblemHandler` actually sends for an unhandled 500:
     * type, title, status, instance — and no `detail`, deliberately, so an
     * internal message cannot leak. `ApiError` falls through `detail` to
     * `title`, so the words a director or an invitee was shown were "Internal
     * Server Error" — the RFC 9457 reason phrase, which the spec asks to be
     * *stable across occurrences* and is therefore the one string in the body
     * guaranteed to say nothing about their request.
     */
    const err = new ApiError(500, {
      type: 'urn:n409:problem:internal',
      title: 'Internal Server Error',
      status: 500,
    });
    expect(err.message).toBe('Internal Server Error');
    const described = describeRequestFailure(err);
    expect(described).not.toContain('Internal Server Error');
    expect(described).toContain('500');
    expect(described).toMatch(/no explanation/i);
  });

  it('does not tell a reader nothing was saved when it cannot know that', () => {
    /*
     * Round 255. One sentence used to serve every detail-less status, and it was
     * written from the gateway case: "the request did not reach the application
     * itself. Nothing was saved; wait a moment and try again."
     *
     * A `urn:n409:problem:internal` 500 is the opposite of that. The app's own
     * error handler sends it, from inside the app, after a route threw — so the
     * request arrived, and where the throw landed relative to the commit is
     * exactly what nobody on the browser side knows. This estate is full of
     * writes that commit and then announce, and an exception in the second half
     * of one of those is a saved row described to the reader as an unsaved one,
     * with an invitation to press the button again underneath it.
     */
    const internal = describeRequestFailure(
      new ApiError(500, { type: 'urn:n409:problem:internal', title: 'Internal Server Error', status: 500 }),
    );
    expect(internal).not.toMatch(/nothing was (saved|changed)/i);
    expect(internal).not.toMatch(/did not reach the application/i);
    // What it says instead: look before you leap.
    expect(internal).toMatch(/reload the page before trying again/i);
    expect(internal).toMatch(/either applied or not/i);
  });

  it('does not blame the reader for an address the server does not have', () => {
    // `setNotFoundHandler` emits `{title: 'Not Found', status: 404}` with no
    // detail, so an unrouted request showed the reader the words "Not Found".
    const err = new ApiError(404, { type: 'urn:n409:problem:not-found', title: 'Not Found', status: 404 });
    expect(err.message).toBe('Not Found');
    const described = describeRequestFailure(err);
    expect(described).not.toBe(err.message);
    expect(described).toContain('404');
    expect(described).toMatch(/fault on our side/i);
    expect(described).toMatch(/out of date/i);
  });

  it('keeps a detail that happens to look like a title', () => {
    // The test is the absence of `detail`, not the wording of what is there.
    const err = new ApiError(503, {
      status: 503,
      title: 'Service Unavailable',
      detail: 'The database is temporarily unable to serve this request. Nothing was changed.',
    });
    expect(describeRequestFailure(err)).toBe(
      'The database is temporarily unable to serve this request. Nothing was changed.',
    );
  });

  it('names the network for anything that is not an ApiError', () => {
    // A rejected `fetch`, which is the only thing that reaches here.
    expect(describeRequestFailure(new TypeError('Failed to fetch'))).toBe(OFFLINE_DETAIL);
    expect(describeRequestFailure('not an Error')).toBe(OFFLINE_DETAIL);
    // Says both halves: what failed, and that nothing was half-done.
    expect(OFFLINE_DETAIL).toMatch(/could not reach the server/i);
    expect(OFFLINE_DETAIL).toMatch(/nothing was submitted/i);
  });
});

describe('describeActionFailure', () => {
  const operation = 'Could not remove the board member.';

  it('yields to the server’s own sentence, which is written for the situation', () => {
    const err = new ApiError(409, {
      status: 409,
      title: 'Conflict',
      detail: 'That member has already signed and cannot be removed.',
    });
    expect(describeActionFailure(err, operation)).toBe(
      'That member has already signed and cannot be removed.',
    );
  });

  it('does not show the reason phrase where 191 handlers used to', () => {
    // The founding case. `err.message` here is the title, and the title is
    // "Internal Server Error".
    const err = new ApiError(500, {
      type: 'urn:n409:problem:internal',
      title: 'Internal Server Error',
      status: 500,
    });
    const described = describeActionFailure(err, operation);
    expect(described).not.toContain('Internal Server Error');
    expect(described).toContain(operation);
    expect(described).toContain('500');
  });

  it('keeps the operation on an unroutable request too', () => {
    const err = new ApiError(404, { type: 'urn:n409:problem:not-found', title: 'Not Found', status: 404 });
    const described = describeActionFailure(err, operation);
    expect(described).not.toContain('Not Found');
    expect(described).toContain(operation);
  });

  it('says both halves when the request never left', () => {
    // What the old `else` branch answered with the operation alone. The reader
    // needed the operation *and* the reason it is worth retrying unchanged.
    const described = describeActionFailure(new TypeError('Failed to fetch'), operation);
    expect(described).toBe(`${operation} ${OFFLINE_DETAIL}`);
  });
});
