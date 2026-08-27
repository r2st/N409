import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { problemCalls } from './errorBodyDisclosure.test.js';

/**
 * An error a caller cannot act on is a failure the platform did not report.
 *
 * `errorBodyDisclosure` guards the opposite hazard — a message that says *too
 * much*, because it forwarded something a catch could not see. This guards the
 * one that is easier to ship and lasts longer: a message that says nothing. The
 * two are not in tension. "Which field did I get wrong" is answerable from the
 * request the caller themselves sent, and none of it is anybody else's data.
 *
 * R180 audited the estate against three questions — does the message name
 * *what* failed, *why*, and *how to fix it* — and found the answer was
 * systematically no in four places:
 *
 *   * 203 schema rejections answered with a category noun ("Invalid query",
 *     "Invalid request") and put the failing field names in an `errors`
 *     extension. The browser's `ApiError` is `super(problem.detail ?? title)`,
 *     so the extension is not what anybody read; 14 more had no extension at
 *     all, so two words were the entire answer.
 *   * 29 route guards answered 403 with `problems.forbidden()`'s default,
 *     "Not allowed" — no action, no audience, no remedy.
 * The fourth — a malformed id answering the generic 404 — was audited and
 * deliberately left alone; see `keeps the malformed-id 404 deliberately
 * uninformative` at the bottom of this file for why.
 *
 * What this file pins is that none of those come back. It is deliberately a
 * *source* census rather than a set of response assertions: the failure mode is
 * a new route being written in the old shape, and that costs nothing to catch
 * here and needs a fixture and a database to catch anywhere else.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = path.resolve(HERE, '../../src/routes');
const DOMAIN = path.resolve(HERE, '../../src/domain');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.ts$/.test(full) ? [full] : [];
  });
}

const routeSources = sourceFiles(ROUTES).map((file) => ({
  rel: path.relative(path.resolve(HERE, '../..'), file).split(path.sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

/**
 * Messages that name a category and stop.
 *
 * Every one of these was a real `detail` on this API. The list is of whole
 * strings, not substrings: `'Invalid'` as a *prefix* is fine and common — the
 * subject in `Invalid fund — as_of: Expected YYYY-MM-DD` is exactly that word —
 * and what makes a message empty is that the category is *all* there is.
 *
 * `'Not allowed'` and `'Resource not found'` are here as the defaults of
 * `problems.forbidden()` and `problems.notFound()`. They cannot be written by
 * hand and passed either, but the reason they are banned is that they used to
 * arrive by omission, which is what the two `bare …()` cases below cover.
 */
const CONTENTLESS = [
  'Something went wrong',
  'An error occurred',
  'Unexpected error',
  'Error',
  'Failed',
  'Request failed',
  'Bad request',
  'Bad Request',
  'Invalid',
  'Invalid input',
  'Invalid request',
  'Invalid query',
  'Invalid body',
  'Invalid data',
  'Not allowed',
  'Not permitted',
  'Forbidden',
  'Not found',
  'Resource not found',
  'Unauthorized',
  'Conflict',
];

const CONTENTLESS_SET = new Set(CONTENTLESS.map((m) => m.toLowerCase()));

/** The first argument of a `problems.*` call, when it is a plain literal. */
function literalMessage(argument: string): string | null {
  const match = /^\s*(['"])((?:[^\\]|\\.)*?)\1\s*(?:,|$)/.exec(argument);
  return match ? match[2]! : null;
}

describe('error messages name what failed, why, and what to do', () => {
  it('finds the call sites it is auditing', () => {
    // A census that silently matches nothing passes every assertion below.
    // R180 is itself the proof that this case is needed: moving the throws
    // behind `invalidQuery`/`invalidBody` blinded two other censuses that had
    // no such guard, and both went green rather than red.
    const calls = routeSources.flatMap(({ text }) => problemCalls(text));
    expect(calls.length).toBeGreaterThan(250);
    expect(routeSources.length).toBeGreaterThan(90);
  });

  it('sends no message whose whole content is a category', () => {
    const findings: string[] = [];
    for (const { rel, text } of routeSources) {
      for (const { message } of problemCalls(text)) {
        const literal = literalMessage(message);
        if (literal === null) continue;
        if (CONTENTLESS_SET.has(literal.trim().toLowerCase())) findings.push(`${rel} → "${literal}"`);
      }
    }
    expect(findings, 'error messages that name a category and stop').toEqual([]);
  });

  it('never takes the default 403, which is the words "Not allowed"', () => {
    // A 403 is the worst status to be bare on. Unlike a 404 it admits the thing
    // exists, and unlike a 422 there is nothing in the request to go and fix —
    // so whose access it needs is the only useful fact it can carry, and the
    // default carries none of it. `domain/accessProblem.ts` supplies an action,
    // a reason and a remedy.
    const bare = routeSources
      .filter(({ text }) => /problems\.forbidden\(\s*\)/.test(text))
      .map(({ rel }) => rel);
    expect(bare, 'routes throwing problems.forbidden() with no detail').toEqual([]);
  });

  it('keeps the malformed-id 404 deliberately uninformative', () => {
    // The one M19 finding this round audited and did *not* act on, recorded
    // here so the next round does not spend the afternoon re-deriving it.
    //
    // "Resource not found" for `GET /valuations/not-a-ulid` reads like a
    // message that has given up, and R180 rewrote 119 in-handler
    // `if (!isUlid(id)) throw problems.notFound()` sites to say "that id is not
    // well-formed" before noticing two things.
    //
    // First, it was dead code. `registerParamValidation` rejects every
    // id-shaped route parameter at `preValidation`, before authentication and
    // before any handler runs, and `ID_PARAM_NAMES` / `NON_ID_PARAM_NAMES`
    // partition every parameter the app registers — so the in-handler checks
    // never fire for a route parameter. 119 improved messages that no caller
    // could ever receive is the exact failure this codebase keeps a register
    // of, and it would have shipped looking like a fix.
    //
    // Second, the bare answer is a decision, not an oversight. The hook's own
    // comment gives the reason: it "keeps the public token-authenticated routes
    // from distinguishing 'malformed' from 'not yours'". Changing that is a
    // disclosure decision about the auditor portal and the signing links, not
    // an error-message one, and it is not this round's to make.
    //
    // So what is asserted is that the guard is still where the reasoning
    // assumes it is. If `registerParamValidation` stops covering ids, the
    // in-handler checks become reachable and the question reopens.
    const params = readFileSync(path.resolve(HERE, '../../src/plugins/params.ts'), 'utf8');
    expect(params).toMatch(/addHook\('preValidation'/);
    expect(params).toMatch(/invalidIdParams\(req\.params/);
    for (const name of ['id', 'valuationId', 'partnerId', 'documentId']) {
      expect(params, `${name} is no longer guarded at the hook`).toContain(`'${name}'`);
    }
  });

  it('puts the failing field names where the browser will render them', () => {
    // The bug this whole round is about: `detail` is what `ApiError`'s message
    // is built from, so a route that composes its own validation body inline
    // puts the fields in `errors`, which nothing renders. Going through the
    // helpers is what makes that structurally impossible.
    const inline: string[] = [];
    for (const { rel, text } of routeSources) {
      const flat = text.replace(/\s+/g, ' ');
      for (const m of flat.matchAll(/problems\.\w+\([^;]{0,200}?errors:\s*\w+(?:\.\w+)*\.error\.issues/g)) {
        inline.push(`${rel} → ${m[0]!.slice(0, 80)}`);
      }
    }
    expect(
      inline,
      'routes composing a validation body inline instead of using invalidQuery/invalidBody',
    ).toEqual([]);
  });

  it('states a remedy on every access category, not just a reason', () => {
    // The "how to fix it" half is the part that cannot be derived from the
    // code, so it is hand-written per category — and the only thing that can
    // keep it honest is requiring it to exist and to be a sentence rather than
    // a shrug.
    const source = readFileSync(path.join(DOMAIN, 'accessProblem.ts'), 'utf8');
    const remedies = [...source.matchAll(/remedy:\s*\n?\s*'((?:[^\\']|\\.)*)'/g)].map((m) => m[1]!);
    const kinds = [...source.matchAll(/^\s*'?([a-z-]+)'?:\s*\{$/gm)].length;
    expect(remedies.length, 'every access kind carries a remedy').toBe(kinds);
    for (const remedy of remedies) {
      expect(remedy.length, `remedy too short to be actionable: "${remedy}"`).toBeGreaterThan(30);
    }
  });

  /**
   * The bare 404s, counted rather than listed.
   *
   * This population is not a to-do list, which is the thing worth writing down:
   * most of it is correct. This API answers the same 404 to a row that does not
   * exist and to one the caller may not see, deliberately, because a message
   * that told those apart would be an existence oracle for another tenant's
   * data — and the ~119 `!isUlid` guards inside handlers are unreachable behind
   * `registerParamValidation` anyway (see above).
   *
   * So the ceiling is a ratchet against *growth*, not a debt to burn down. What
   * it catches is a new route reaching for `problems.notFound()` where nothing
   * is being protected — a 404 on a sub-resource whose parent the caller can
   * already see, say — and it makes that route say so here rather than slip in
   * among the ones that mean it. A ratchet rather than a register of
   * exemptions, because the entries are indistinguishable from each other in
   * source: there is nothing to key an exemption on.
   */
  it('does not grow the population of bare 404s', () => {
    const bare = routeSources.reduce(
      (n, { text }) => n + (text.match(/problems\.notFound\(\s*\)/g) ?? []).length,
      0,
    );
    expect(bare, 'bare problems.notFound() calls — this number may fall, never rise').toBeLessThanOrEqual(
      323,
    );
  });
});
