import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { problems, retryPhrase } from '@n409/shared';
import { forbidden } from '../../src/domain/accessProblem.js';
import { invalidSort } from '../../src/domain/sortRefusal.js';
import { MAX_SORT_TERMS, SORTABLE_COLUMNS, parseSortTerms } from '../../src/repos/valuations.js';
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

/**
 * Comments stripped, for the reason the frontend twin already has to special-
 * case `lib/api.ts`: a census whose subject is a *shape* reads its own
 * explanation of that shape as an instance of it. R350 quoted
 * `problems.forbidden()` in a comment saying why the call below it no longer
 * takes the default, and the 403 assertion reported the fix as the bug.
 */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const routeSources = sourceFiles(ROUTES).map((file) => ({
  rel: path.relative(path.resolve(HERE, '../..'), file).split(path.sep).join('/'),
  text: stripComments(readFileSync(file, 'utf8')),
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
   * A remedy has to name a control that does the thing it is named for.
   *
   * `partner-token` is the 403 a *personal* key gets on a partner API route,
   * and its remedy pointed at Settings → API tokens — which is the panel that
   * mints personal keys. An integrator who followed it made a second personal
   * token, sent it, and was refused by this same sentence. Partner keys are
   * minted from `POST /partners/:id/tokens`, which the product draws as the
   * API tokens panel on the partner portal.
   *
   * The negative assertion is the one with teeth: it is the exact prior
   * wording, so this fails again if anybody re-attaches "a partner key" to
   * "Settings".
   */
  it('sends a refused personal key to a screen that can mint a partner one', () => {
    const detail = forbidden('This partner API endpoint', 'partner-token').detail ?? '';
    expect(detail).toMatch(/partner portal/i);
    expect(detail, 'Settings → API tokens mints personal keys, not partner ones').not.toMatch(
      /partner key.{0,40}Settings/i,
    );
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
      // Re-based down in R287. It had risen to 328 — above the ceiling, so the
      // gate was red on main — as R283–R285 built out the measurement surface
      // and gave every fund-holding sub-resource a bare 404 whose parent the
      // caller had already loaded successfully. That is precisely the growth
      // this ratchet is for. Ten of them now name the holding
      // (`noSuchHolding`), which is what brought it back under.
      //
      // Re-based up by one in R312, and this is the direction that needs the
      // argument. R307 gave `/help/articles/:slug` the shape check every other
      // non-`:id` path parameter already had, and refused a slug that cannot
      // name an article with a bare 404 — which is not the growth above but the
      // population the sibling test 'keeps the malformed-id 404 deliberately
      // uninformative' requires to stay wordless: a message describing why the
      // shape was wrong tells a prober how to spell a real one. The gate has
      // been red on main for five rounds over that one call, which is a ratchet
      // measuring nothing.
      320,
    );
  });
});

/**
 * The argument list of every `problems.tooManyRequests(...)` call in a file.
 *
 * Paren-matched rather than regex-bounded because the details are template
 * literals with `${}` in them, and because a 429's second argument is itself
 * usually a nested call computing the wait.
 */
function tooManyRequestsArguments(text: string): string[] {
  const flat = text.replace(/\s+/g, ' ');
  const out: string[] = [];
  const call = /\bproblems\.tooManyRequests\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(flat))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i + 1;
    for (; i < flat.length; i++) {
      const ch = flat[i]!;
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) break;
    }
    out.push(flat.slice(start, i));
  }
  return out;
}

/**
 * R222 — the 429s, which knew the answer and did not give it.
 *
 * Every rate limiter on this platform computes the wait exactly: it knows when
 * the window resets, and each call site already worked the seconds out to hand
 * to `retry-after`. The number then went into a header and into
 * `retry_after_seconds` in the body, and the browser renders neither — the
 * whole reason this file exists is that `ApiError` is
 * `super(problem.detail ?? problem.title)`. Thirteen human-facing details ended
 * in "please try again later" while the real figure sat one field away.
 *
 * The asymmetry is what made it worth a round. `plugins/auth.ts` — the API-key
 * surface, read by machines that also get the header — wrote "retry in 45s"
 * into its prose. The sign-in throttle, the client intake form, the auditor
 * link and the board signing link, all read by people with no access to a
 * header, said "later".
 *
 * `tooManyRequests` now appends the wait itself, so the omission is not a thing
 * a route can do. What is asserted here is that no call site goes back to
 * writing its own — a hand-written wait is both a duplicate of the appended one
 * and the thing that drifts from the header.
 */
describe('a 429 says when to come back', () => {
  const RATE_LIMITED = [
    ...routeSources,
    ...['plugins', 'auth', 'clients'].flatMap((dir) =>
      sourceFiles(path.resolve(HERE, '../../src', dir)).map((file) => ({
        rel: path.relative(path.resolve(HERE, '../..'), file).split(path.sep).join('/'),
        text: readFileSync(file, 'utf8'),
      })),
    ),
  ].filter(({ text }) => text.includes('tooManyRequests('));

  it('finds the call sites it is auditing', () => {
    expect(RATE_LIMITED.length).toBeGreaterThanOrEqual(8);
  });

  /**
   * The vague half, banned as whole clauses rather than as words.
   *
   * "later" and "shortly" are the two ways a message declines to answer the
   * only question a rate limit raises. They are matched with the dash that
   * introduces them so that a detail which happens to contain the word — "this
   * link expires later today" — is not caught.
   */
  it('never tells a person to come back "later"', () => {
    const findings: string[] = [];
    for (const { rel, text } of RATE_LIMITED) {
      // Scoped to the 429's own arguments, not the file. `internal.ts` carries
      // a 503 degraded-service message that ends "retry shortly" a few hundred
      // lines away, and that one is correct: nothing computed a wait for it.
      for (const m of tooManyRequestsArguments(text)) {
        const vague = /(?:try again|retry)\s+(?:later|shortly)/i.exec(m);
        if (vague) findings.push(`${rel} → "${vague[0]}"`);
      }
    }
    expect(findings, '429 details that decline to say when').toEqual([]);
  });

  /**
   * The duplicate half.
   *
   * Three call sites had already solved this for themselves, in three
   * spellings. Now that the helper appends the wait, a hand-written one is a
   * sentence that says the number twice — and the two are computed separately,
   * so they will eventually disagree.
   */
  it('leaves the wait to the helper rather than writing it again', () => {
    const findings: string[] = [];
    for (const { rel, text } of RATE_LIMITED) {
      // `retry in ${n}s` / `Try again in ${n}s.` — an interpolated duration
      // inside the 429's own argument. The circuit breaker's "retry in ~Ns" is
      // a 503 and is out of scope for the same reason as above.
      for (const m of tooManyRequestsArguments(text)) {
        const dup = /(?:try again|retry) in \$\{[^}]*(?:retryAfter|retry_after)[^}]*\}/i.exec(m);
        if (dup) findings.push(`${rel} → "${dup[0]}"`);
      }
    }
    expect(findings, 'call sites hand-writing a wait the helper already appends').toEqual([]);
  });

  /**
   * The phrasing, pinned on the helper.
   *
   * The reader's decision after a rate limit is wait-or-leave, so the coarsening
   * has to keep the sub-minute case exact — that is the only band where the
   * figure changes the decision — and must never round a real wait down to
   * something that invites an immediate retry.
   */
  it('never rounds a wait down', () => {
    for (const seconds of [1, 30, 59, 60, 61, 599, 3599, 3601]) {
      const phrase = retryPhrase(seconds);
      const n = Number(/([\d.]+)/.exec(phrase)![1]);
      const unit = /second/.test(phrase) ? 1 : /minute/.test(phrase) ? 60 : 3600;
      expect(n * unit, `${seconds}s became "${phrase}"`).toBeGreaterThanOrEqual(seconds);
    }
    expect(retryPhrase(1)).toBe('about 1 second');
    expect(retryPhrase(42)).toBe('about 42 seconds');
    expect(retryPhrase(3600)).toBe('about 1 hour');
  });

  /** A 429 with no seconds keeps the detail it was given, unenriched. */
  it('adds nothing when the caller has no wait to give', () => {
    const detail = 'Too many open realtime streams — close a tab and retry';
    expect(problems.tooManyRequests(detail).detail).toBe(detail);
    expect(problems.tooManyRequests(detail, 45).detail).toBe(`${detail} — try again in about 45 seconds.`);
  });
});

/**
 * R198 — the layers below the routes.
 *
 * Everything above is a census of `src/routes`, because that is where R180's
 * findings were. R198's were all a layer down: a client (`toProblem` naming an
 * internal service and stopping), a plugin (one 401 detail for four different
 * refusals), a hook (`fetch failed` written into a partner's own delivery log),
 * a renderer (a throw that reached the client as a bodiless 500). None of those
 * files is a route, so none of them was looked at — the census had been reading
 * the place the last round's bugs were rather than the place messages are
 * written.
 *
 * These widen it. They are separate assertions rather than a wider `ROUTES`
 * because the two populations answer to different rules: a route composes a
 * problem, and these mostly *record* a failure into a column somebody reads,
 * which the CONTENTLESS list has nothing to say about.
 */
describe('the layers below the routes', () => {
  /*
   * `repos` joined this list in round 255, and its absence was the same mistake
   * one layer along. Round 198 widened the census off `routes` because messages
   * are written wherever they are written; it reached for the directories that
   * round's bugs had been in, and a repo raises a problem for exactly the same
   * reason a route does — thirteen of them do. Three were bare
   * `problems.notFound()`, on paths where the caller had already loaded the row
   * that then vanished under them, so a stage advance answered "Resource not
   * found" for an engagement whose valuation had been deleted mid-request.
   */
  const SUPPORTING = ['clients', 'plugins', 'hooks', 'pipeline', 'repos'].flatMap((dir) =>
    sourceFiles(path.resolve(HERE, '../../src', dir)).map((file) => ({
      rel: path.relative(path.resolve(HERE, '../..'), file).split(path.sep).join('/'),
      text: readFileSync(file, 'utf8'),
    })),
  );

  it('finds the files it is auditing', () => {
    expect(SUPPORTING.length).toBeGreaterThan(15);
    // Named, because the population is the whole assertion: `repos` was outside
    // it for two rounds and nothing said so.
    expect(SUPPORTING.some(({ rel }) => rel.startsWith('src/repos/'))).toBe(true);
  });

  /**
   * No bare 404 below the routes.
   *
   * The routes carry a *ratchet* rather than a ban, because there the bare 404
   * is usually load-bearing: this API answers the same wordless 404 to a row
   * that does not exist and to one the caller may not see, and telling those
   * apart would be an existence oracle over another tenant's data. None of that
   * holds down here. A repo is reached with the row already loaded and the
   * caller's right to see it already settled, so a 404 raised in one is always
   * "the thing you are holding has gone" — which is a sentence, and a different
   * one from what the caller would otherwise conclude, that they asked wrong.
   */
  it('raises no 404 below the routes without saying what went missing', () => {
    const findings = SUPPORTING.filter(
      ({ rel, text }) =>
        // `registerParamValidation`'s malformed-id 404 is the deliberate
        // exception, argued at length in `plugins/params.ts`.
        rel !== 'src/plugins/params.ts' && /problems\.notFound\(\s*\)/.test(text),
    ).map(({ rel }) => rel);
    expect(findings, 'bare problems.notFound() below the routes').toEqual([]);
  });

  it('sends no message from a client or plugin whose whole content is a category', () => {
    const findings: string[] = [];
    for (const { rel, text } of SUPPORTING) {
      for (const { message } of problemCalls(text)) {
        const literal = literalMessage(message);
        if (literal === null) continue;
        if (CONTENTLESS_SET.has(literal.trim().toLowerCase())) findings.push(`${rel} → "${literal}"`);
      }
    }
    expect(findings).toEqual([]);
  });

  /**
   * The shape the whole round turned out to be.
   *
   * `err.message` on a `fetch` rejection is the string `fetch failed` — for a
   * refused connection, a name that does not resolve, an expired certificate
   * and a reset socket alike, because undici puts the identifying syscall on
   * `cause` one level down. Eight places in this service recorded that message
   * into a column a person later reads: a partner's webhook delivery log, an
   * email's failure line, an HRIS connection's last error, a failed run.
   *
   * `describeTransportFailure` in shared walks the chain and names the
   * condition, falling through to the error's own message when it said
   * something — so adopting it never flattens a message that was already good.
   * What is banned here is the bare idiom on a *recording* path.
   *
   * The exemptions are the two places the reader is an operator holding a
   * terminal, where the raw message is the better artefact and there is no
   * column to put anything in.
   */
  it('records no failure for a person as a bare err.message', () => {
    const BARE = /instanceof Error \? (?:err|e|error)\.message : String\(/;
    const OPERATOR_ONLY = new Set([
      // Boot-time diagnostics, printed to the deploy's console.
      'src/preflight.ts',
      // The migration CLI's own output.
      'src/db/migrate.ts',
    ]);
    const all = sourceFiles(path.resolve(HERE, '../../src')).map((file) => ({
      rel: path.relative(path.resolve(HERE, '../..'), file).split(path.sep).join('/'),
      text: readFileSync(file, 'utf8'),
    }));
    // The census must be able to see its own founding cases, or an idiom that
    // gets reformatted silently empties it.
    expect(all.length).toBeGreaterThan(150);

    const findings = all
      .filter(({ rel, text }) => !OPERATOR_ONLY.has(rel) && BARE.test(text))
      .map(({ rel }) => rel);
    expect(
      findings,
      'failures recorded as `err.message`, which is "fetch failed" for every transport failure',
    ).toEqual([]);
  });

  /**
   * The `toProblem` half, asserted on the table rather than on a response.
   *
   * Three of its four arms named an internal service ("engine", "ai") and
   * stopped, while the fourth — the breaker one — already carried the argument
   * for why that is useless. What keeps the other three honest is that every
   * service has a label written for a reader and two remedies, and that neither
   * remedy is a shrug.
   */
  it('gives every internal service a name a reader knows and a remedy', () => {
    const source = readFileSync(path.resolve(HERE, '../../src/clients/internal.ts'), 'utf8');
    const voices = source.slice(source.indexOf('const SERVICE_VOICE'));
    const labels = [...voices.matchAll(/label:\s*\n?\s*'((?:[^\\']|\\.)*)'/g)].map((m) => m[1]!);
    const remedies = [...voices.matchAll(/Remedy:\s*\n?\s*'((?:[^\\']|\\.)*)'/g)].map((m) => m[1]!);
    // The fallback `voiceOf` returns is counted too, and deliberately: a fifth
    // internal service added later gets that one, and it has to be as usable as
    // the three written by hand. Its label is a template literal, so `label:`
    // is counted rather than the quoted labels.
    const voices_with_a_label = (voices.match(/^\s*label:/gm) ?? []).length;

    expect(labels.length, 'every named service in the table carries a label').toBeGreaterThanOrEqual(3);
    expect(remedies.length, 'a rejected remedy and a broken one per service').toBe(voices_with_a_label * 2);
    for (const label of labels) {
      // The bug being guarded: a label that is the process name and nothing
      // else — "engine", "the ai service" — which is what the three arms said
      // before. "The AI analysis could not be completed" names the work and is
      // allowed to contain the same two letters.
      expect(label, `"${label}" names a component, not the work`).not.toMatch(
        /^(the )?(engine|ai|report)( service| unit)?[.:]?$/i,
      );
      expect(label.split(/\s+/).length, `"${label}" is too terse to name any work`).toBeGreaterThan(3);
    }
    for (const remedy of remedies) {
      expect(remedy.length, `remedy too short to be actionable: "${remedy}"`).toBeGreaterThan(30);
    }
  });

  /**
   * The 401 half.
   *
   * One `detail` answered four different token refusals, three of which have
   * different fixes — and the one this platform causes itself, where the member
   * who minted a firm's key was moved out of the org, read exactly like a typo.
   */
  it('answers each API token refusal with its own sentence', () => {
    const source = readFileSync(path.resolve(HERE, '../../src/repos/apiTokens.ts'), 'utf8');
    const table = source.slice(source.indexOf('API_TOKEN_REFUSAL_DETAIL'));
    const kinds = ['unknown', 'revoked', 'no_owner', 'orphaned', 'partner_retired'];
    for (const kind of kinds) {
      expect(table, `${kind} has no message`).toContain(`${kind}:`);
    }
    const details = [...table.matchAll(/^\s{4}'((?:[^\\']|\\.)*)',$/gm)].map((m) => m[1]!);
    expect(details.length, 'one message per refusal').toBe(kinds.length);
    expect(new Set(details).size, 'two refusals sharing a sentence is the bug').toBe(kinds.length);
  });
});

/**
 * R366 — the schema rejections that never reached the helpers.
 *
 * R180 moved ~150 validation refusals onto `invalidQuery`/`invalidBody` so the
 * failing field names land in `detail`, and left a census behind. That census
 * is written over the *old idiom* — `problems.*(…, { errors: parsed.error.issues })`
 * — which is a shape a route only has if it already decided to forward the
 * issues. Six routes never had it: they checked `!parsed.success`, threw a
 * category noun, and dropped the `ZodError` on the floor. Nothing matched them
 * because there was nothing left to match.
 *
 * What the callers got:
 *
 *   * `GET /valuations/counts?buckets=weekly` → "Invalid buckets mode", when
 *     zod had already written "buckets: Invalid enum value. Expected 'groups'
 *     | 'named', received 'weekly'".
 *   * `POST /valuations/:id/clone` with `{"roll_forward":"yes"}` → "Invalid
 *     clone request", for one optional boolean.
 *   * `POST /valuations/:id/research/refresh-all` → "Invalid region", with the
 *     region list one field away.
 *   * `POST /debt/rating-spread` with `{"rating":"AAAAA"}` → "Provide a
 *     rating", which is also false: they provided one.
 *
 * So the rule is stated over the fact instead — a `safeParse` this service
 * refuses is answered by the helpers — and the exceptions are named one by
 * one, because each is a decision rather than an oversight and an unnamed
 * exemption is indistinguishable from the bug.
 */
describe('a refused safeParse goes through the helpers', () => {
  /**
   * `if (!x.success)` and the ~140 characters that answer it, whitespace
   * flattened so the answer on the next line is still in the span.
   */
  function refusalAnswers(text: string): string[] {
    const flat = text.replace(/\s+/g, ' ');
    return [...flat.matchAll(/if\s*\(\s*!\s*(\w+)(?:\.data)?\.success\s*\)\s*([^;]{0,140})/g)].map(
      (m) => m[2]!,
    );
  }

  /** Routes whose refusal is deliberately not a problem document naming fields. */
  const EXEMPT: Record<string, string> = {
    // A browser mid-SSO gets a navigation with `?sso_error=`, not a body it
    // will never render. See `refuseSso`.
    'src/routes/auth.ts': 'SSO flow refusals are redirects',
    // The public signing link: a token that does not parse and a token that
    // has been used answer identically, on purpose.
    'src/routes/boardApproval.ts': 'public token routes do not distinguish malformed from spent',
    // "Pass two valuation ids as ?a=…&b=…" already names the format, which is
    // the whole content of the two-issue ZodError behind it.
    'src/routes/compare.ts': 'the hand-written detail states the expected query',
    // An unsubscribe link that does not parse is a 404 page, not an error body.
    'src/routes/unsubscribe.ts': 'returns false to the caller, raises nothing',
    // A malformed `:slug` path parameter, which the sibling assertion above
    // requires to stay wordless for the same reason `registerParamValidation`
    // does.
    'src/routes/valuationTags.ts': 'malformed path parameter, deliberately a bare 404',
  };

  it('finds the call sites it is auditing', () => {
    const total = routeSources.reduce((n, { text }) => n + refusalAnswers(text).length, 0);
    expect(total, 'safeParse refusals across the route table').toBeGreaterThan(150);
  });

  it('names the fields on every schema rejection a route answers', () => {
    const findings: string[] = [];
    for (const { rel, text } of routeSources) {
      if (rel in EXEMPT) continue;
      for (const answer of refusalAnswers(text)) {
        if (/invalidQuery|invalidBody|validationDetail/.test(answer)) continue;
        findings.push(`${rel} → ${answer.trim().slice(0, 70)}`);
      }
    }
    expect(findings, 'schema rejections answered without the failing field names').toEqual([]);
  });

  it('keeps every exemption pointing at a route that still exists', () => {
    // An exemption for a file that has been renamed or has lost its refusal is
    // an exemption for whatever moves in next.
    for (const rel of Object.keys(EXEMPT)) {
      const source = routeSources.find((s) => s.rel === rel);
      expect(source, `${rel} is exempted and no longer exists`).toBeDefined();
      expect(refusalAnswers(source!.text).length, `${rel} no longer refuses a safeParse`).toBeGreaterThan(0);
    }
  });
});

/**
 * R366 — `?sort=`, the one refusal that could not reach the helpers.
 *
 * `parseSort` is a hand-rolled parse, so there is no `ZodError` to hand
 * `invalidQuery`, and both list endpoints answered its three distinct failures
 * with the two words `Invalid sort`. A caller who wrote `?sort=name:asc` — the
 * column is `company_name` — was told nothing they could act on, and the
 * spelling they needed is a fixed list of eight the server was holding.
 */
describe('a refused sort says which term and what is allowed', () => {
  it('names the column that is not sortable, and the ones that are', () => {
    const refusal = parseSortTerms('name:asc');
    expect(refusal.refusal).toEqual({ reason: 'unknown_column', term: 'name:asc', column: 'name' });
    const detail = invalidSort(refusal.refusal!).detail ?? '';
    expect(detail).toContain('name');
    // The list, not a description of it: the caller is holding a string they
    // composed and needs the spelling.
    for (const column of SORTABLE_COLUMNS) expect(detail).toContain(column);
  });

  it('names the direction it would have accepted', () => {
    const refusal = parseSortTerms('created_at:sideways');
    expect(refusal.refusal?.reason).toBe('bad_direction');
    const detail = invalidSort(refusal.refusal!).detail ?? '';
    expect(detail).toContain('sideways');
    expect(detail).toMatch(/asc/);
    expect(detail).toMatch(/desc/);
  });

  it('says how many terms it will take', () => {
    const refusal = parseSortTerms(
      Array(MAX_SORT_TERMS + 1)
        .fill('created_at:asc')
        .join(','),
    );
    expect(refusal.refusal?.reason).toBe('too_many');
    const detail = invalidSort(refusal.refusal!).detail ?? '';
    expect(detail).toContain(String(MAX_SORT_TERMS));
  });

  it('is a 400, because a query string that does not parse is malformed', () => {
    expect(invalidSort({ reason: 'too_many', count: 99 }).status).toBe(400);
  });

  it('leaves a sort it accepts alone', () => {
    expect(parseSortTerms('company_name:asc,created_at:desc')).toEqual({
      specs: [
        { column: 'company_name', dir: 'asc' },
        { column: 'created_at', dir: 'desc' },
      ],
      refusal: null,
    });
  });
});
