import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A route may not put an error it did not author into the client's body.
 *
 * `problems.*` builds the RFC 9457 body a caller reads, and its first argument
 * is free text. Every message a route composes itself is safe by construction
 * — the route knows what it is saying. A message *interpolated from a caught
 * error* is not, because the catch cannot see what it caught:
 *
 *     catch (err) { throw problems.unprocessable(`Sync failed: ${err.message}`) }
 *
 * That line was written for the HRIS client's own failures, which name the
 * provider and a status code and nothing else. What it actually forwarded was
 * whatever reached it, and the sync's insert loop has no catch of its own — so
 * a grant the driver refused answered the analyst with Postgres's wording, its
 * constraint name and its column name. The general shape is worse than that
 * one instance: `pg` puts the offending row's *values* in `err.detail`, an
 * `fetch` failure names the host it could not reach, and none of it is
 * anything the person who clicked "Sync" is owed.
 *
 * The 5xx handler already knows this and scrubs (`scrubError`), but an
 * `ApiProblem` never reaches it — it is the *intended* answer, sent as
 * written. So the rule has to hold at the throw.
 *
 * Seventeen other routes forward a caught error's message and every one of
 * them tests `instanceof` against a class the code owns first, which is the
 * shape this states as a rule: an echoed message must come from an error whose
 * type says its wording is fit to publish. See `IntegrationError` in
 * clients/deadline.ts for the class the HRIS route now checks.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = path.resolve(HERE, '../../src/routes');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.ts$/.test(full) ? [full] : [];
  });
}

/** How far back a statement window may reach for its guard. */
const WINDOW = 400;

export interface ProblemCall {
  /** The first argument, verbatim — the free text the client is sent. */
  message: string;
  /**
   * The statement the call sits in, back to the end of the previous one.
   *
   * The guard is almost never inside the argument. The seventeen routes that
   * legitimately echo a message are all shaped
   * `if (err instanceof XInputError) throw problems.unprocessable(err.message)`
   * — the decision is made by the `if`, one token to the left of anything an
   * argument-only scan can see. A census that read the argument alone would
   * report every one of them, which is a census nobody keeps.
   *
   * The boundary is the previous `;` and not the nearest brace, because half
   * of those guards open a block: `if (err instanceof NoEvidenceError) {` puts
   * a `{` between the guard and the throw, and a brace-bounded window would
   * cut off the only part worth reading. Capped at `WINDOW` characters so a
   * long semicolon-free stretch cannot drag in an unrelated `instanceof`.
   */
  statement: string;
}

/**
 * Every `problems.<kind>(…)` call, with its argument and its statement.
 *
 * Balanced-paren scan rather than `[^)]*`: these arguments carry calls and
 * ternaries of their own, and a lazy regex stops at the first inner `)` —
 * which is exactly where the interesting part of
 * `${err instanceof Error ? err.message : String(err)}` begins.
 */
/**
 * The message a call *effectively* sends, with one-hop local bindings resolved.
 *
 * The scan below reads the argument, and two routes put the interesting part
 * one statement to the left of it:
 *
 *     const message = err instanceof Error ? err.message : String(err);
 *     throw problems.unprocessable(`Sync failed: ${message}`);
 *
 * The argument is `` `Sync failed: ${message}` ``, which names no error and
 * matches nothing — so the census reported success on two instances of the
 * exact line it was written for. That is the failure mode this codebase keeps
 * a register of: a guard that passes by having nothing left to ask. The line
 * in `routes/hris.ts` was fixed when `IntegrationError` was introduced and the
 * two spelled this way were not, for four rounds, with a green test beside
 * them the whole time.
 *
 * One hop, and only for a bare identifier. A census that chased arbitrary
 * expressions would be a small interpreter, and the value here is not depth:
 * it is that the *shortest* evasion — bind it, then interpolate it — no longer
 * works. The binding's own text is appended to the statement as well as the
 * message, so a guard written into the binding (`err instanceof
 * IntegrationError ? err.message : 'constant'`) still excuses the echo, which
 * is where the two fixed routes now put theirs.
 */
export function resolveLocals(flat: string, message: string, upto: number): string {
  let resolved = message;
  for (const ref of message.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g)) {
    const name = ref[1]!;
    const binding = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=([^;]*);`, 'g');
    let last: string | null = null;
    for (const m of flat.slice(Math.max(0, upto - WINDOW * 4), upto).matchAll(binding)) last = m[1]!;
    if (last !== null) resolved += ` ${last}`;
  }
  return resolved;
}

export function problemCalls(text: string): ProblemCall[] {
  const flat = text.replace(/\s+/g, ' ');
  const out: ProblemCall[] = [];
  const call = /\bproblems\.[a-zA-Z]+\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(flat))) {
    let depth = 0;
    let quote: string | null = null;
    let i = m.index + m[0].length - 1;
    const start = i + 1;
    for (; i < flat.length; i++) {
      const ch = flat[i]!;
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const boundary = Math.max(flat.lastIndexOf(';', m.index), m.index - WINDOW);
    const raw = flat.slice(start, i);
    const resolved = resolveLocals(flat, raw, m.index);
    out.push({
      message: resolved,
      // The binding rides along in the statement too, so a guard written into
      // it counts as the guard for the echo it produced.
      statement: flat.slice(boundary + 1, i + 1) + (resolved === raw ? '' : ` ${resolved}`),
    });
  }
  return out;
}

/**
 * Names a caught error rather than a domain value.
 *
 * `err`/`error`/`e` are the three spellings the catches in this tree use. The
 * pattern requires a property read or a `String(…)` wrap, so a bare `error`
 * identifier — which in these routes is usually a *field* on a response row,
 * not a thrown thing — is not mistaken for one.
 */
const ECHOES_CAUGHT_ERROR =
  /\b(?:err|error|e)\s*\.\s*(?:message|stack|detail|cause|toString)\b|\bString\(\s*(?:err|error|e)\s*\)|\bdescribeForUser\(/;

/**
 * `err instanceof SomeError` — the guard that makes an echo deliberate.
 *
 * `Error` itself is excluded, and that exclusion is the whole check. Every
 * thrown error passes `err instanceof Error`, so a ternary on it decides how
 * to *stringify* the thing, not whether its wording is fit to publish — and
 * the one line this census exists to catch is
 * `err instanceof Error ? err.message : String(err)`. A guard that accepted it
 * would be a census that reported success on its own founding case, which is
 * the failure mode this codebase keeps a register of.
 */
const NARROWS_BY_TYPE = /\b(?:err|error|e)\s+instanceof\s+(?!Error\b)[A-Z][\w$]*|\bdescribeForUser\(/;

/*
 * `describeForUser` is on both lists on purpose (R277, methodology M19).
 *
 * It publishes a caught error's text, so it is an echo and the scan must see
 * it. And it takes an `InternalServiceError` — which is the narrowing, stated
 * as a parameter type rather than as an `if` — and then puts the value through
 * the one function that decides whether an upstream's words may be repeated at
 * all (`describedBy`, reading `opaque`). So it is a vouched echo wherever it
 * appears, including where a `catch` binds nothing this regex would recognise.
 *
 * The narrowing these sites used to carry, `err instanceof InternalServiceError
 * ? err.message : …`, satisfied the census and was still wrong: the class is
 * the right *class*, and its `message` is `${service}: ${detail}` with the raw
 * upstream body in it whenever `opaque` is set. The guard proved the author
 * had thought about the type. It could not prove they had thought about the
 * string.
 */

interface Finding {
  file: string;
  message: string;
}

function scan(): { findings: Finding[]; calls: number } {
  const findings: Finding[] = [];
  let calls = 0;
  for (const file of sourceFiles(ROUTES)) {
    const text = readFileSync(file, 'utf8');
    const rel = path.relative(path.resolve(HERE, '../..'), file).split(path.sep).join('/');
    for (const { message, statement } of problemCalls(text)) {
      calls++;
      if (!ECHOES_CAUGHT_ERROR.test(message)) continue;
      // An echo guarded by `instanceof` is a decision about a class this
      // codebase owns, which is the whole point — `VolatilityInputError`'s
      // message is written to be read by the analyst.
      if (NARROWS_BY_TYPE.test(statement)) continue;
      findings.push({ file: rel, message: message.slice(0, 120) });
    }
  }
  return { findings, calls };
}

describe('an error body carries no wording the route did not author', () => {
  const { findings, calls } = scan();

  it('is reading the problem bodies the routes actually build', () => {
    // Vacuity guard. Every assertion below passes against a scan that matched
    // nothing, and the scan is a regex over a helper name — rename `problems`
    // and this census goes quiet while still reporting success.
    expect(calls).toBeGreaterThan(200);
  });

  it('reads past an inner call in the argument', () => {
    // The lazy `[^)]*` this replaced stopped at `Error(` and never saw the
    // `err.message` that follows it, which is the half that matters.
    expect(problemCalls('problems.unprocessable(`x: ${f(a)} ${err.message}`)').map((c) => c.message)).toEqual(
      ['`x: ${f(a)} ${err.message}`'],
    );
    expect(problemCalls("problems.notFound('No such thing')").map((c) => c.message)).toEqual([
      "'No such thing'",
    ]);
  });

  it('takes the guard from the statement, where the routes actually write it', () => {
    const [call] = problemCalls(
      'const x = 1; if (err instanceof VolatilityInputError) throw problems.unprocessable(err.message);',
    );
    expect(call!.message).toBe('err.message');
    expect(call!.statement).toContain('instanceof VolatilityInputError');
    // …and does not reach back past the previous statement for one.
    const [bare] = problemCalls('if (err instanceof Owned) noop(); throw problems.conflict(err.message);');
    expect(NARROWS_BY_TYPE.test(bare!.statement)).toBe(false);
    // A guard that opens a block is still in the window — this is the shape
    // `fmvEstimator.ts` uses, and a brace-bounded window lost it.
    const [blocked] = problemCalls(
      'const x = 1; if (err instanceof NoEvidenceError) { throw problems.unprocessable(err.message); }',
    );
    expect(NARROWS_BY_TYPE.test(blocked!.statement)).toBe(true);
  });

  it('would catch the HRIS line this census was written for', () => {
    const message = '`Sync failed: ${err instanceof Error ? err.message : String(err)}`';
    expect(ECHOES_CAUGHT_ERROR.test(message)).toBe(true);
    // And is *not* excused by its `instanceof Error`, which every thrown error
    // satisfies. This is the assertion that keeps the census from passing on
    // the case it was written for.
    expect(NARROWS_BY_TYPE.test(message)).toBe(false);
  });

  it('accepts an echo narrowed to a class the codebase owns', () => {
    const statement = 'if (err instanceof VolatilityInputError) throw problems.unprocessable(err.message);';
    expect(ECHOES_CAUGHT_ERROR.test(statement)).toBe(true);
    expect(NARROWS_BY_TYPE.test(statement)).toBe(true);
  });

  it('follows a message bound one statement earlier', () => {
    // The two-statement spelling, which is what `routes/capTableSync.ts` and
    // `routes/accounting.ts` were written in and what made this census vacuous
    // for both of them. Asserted on the scanner rather than on the tree, so it
    // keeps failing if somebody simplifies `resolveLocals` away.
    const [call] = problemCalls(
      'const message = err instanceof Error ? err.message : String(err); ' +
        'throw problems.unprocessable(`Sync failed: ${message}`);',
    );
    expect(ECHOES_CAUGHT_ERROR.test(call!.message)).toBe(true);
    expect(NARROWS_BY_TYPE.test(call!.statement)).toBe(false);
  });

  it('still excuses a binding that names an owned type', () => {
    // The fixed shape: the guard moved into the binding, and the census has to
    // read it there or the fix looks like the bug.
    const [call] = problemCalls(
      "const detail = err instanceof IntegrationError ? err.message : 'Sync failed'; " +
        'throw problems.unprocessable(`Sync failed: ${detail}`);',
    );
    expect(ECHOES_CAUGHT_ERROR.test(call!.message)).toBe(true);
    expect(NARROWS_BY_TYPE.test(call!.statement)).toBe(true);
  });

  it('does not reach back an unbounded distance for a binding', () => {
    // A local of the same name in a different function, far above, must not be
    // attributed to this call — that would be a census inventing findings.
    const far = `const message = err.message; ${'const filler = 1; '.repeat(200)}`;
    const [call] = problemCalls(`${far}throw problems.notFound(\`gone: \${message}\`);`);
    expect(ECHOES_CAUGHT_ERROR.test(call!.message)).toBe(false);
  });

  it('echoes no caught error that was not narrowed to an owned type', () => {
    expect(
      findings.map((f) => `${f.file}: problems.…(${f.message})`).sort(),
      'a problem body interpolating an error whose wording nothing vouched for',
    ).toEqual([]);
  });
});

/**
 * A 200 body is a body a client reads, and nothing was checking those.
 *
 * The census above scans `problems.*` calls, which is every route that answers
 * a *failure* with a failure status. It is not every route that reports a
 * failure. Bulk endpoints answer per row — `POST /api/v1/valuations/bulk`
 * returns `{ results: [{ id, ok: false, error }] }` with a 200 — so a row that
 * Postgres refused put the driver's wording, its constraint name and the values
 * it rejected into an ordinary successful response, where no problem-document
 * rule applied and no scan looked.
 *
 * The rule is the same one: text interpolated from a caught error may only be
 * published when something decided the error's type says its wording is fit to
 * publish. Only the shape of the check differs — an object property rather than
 * a call argument.
 *
 * Scoped to the property names that end up in front of a person (`error`,
 * `detail`, `message`, `warning`, `reason`). A repo write that stores a failure
 * against a job row uses the same names, and several do; those are excused by
 * the same `instanceof` guard the routes already carry, which is the honest
 * outcome — a guard is what makes the message publishable, wherever it is
 * going.
 */
export function bodyEchoes(text: string): string[] {
  return scanBodies(text).unguarded;
}

/**
 * Every property that publishes a caught error's text, split by whether
 * something vouched for it.
 *
 * `guarded` is the vacuity guard. The check below passes against a scan that
 * matched nothing at all — a renamed property, a regex that stopped compiling
 * — and the routes are known to contain several *legitimate* echoes, each
 * behind an `instanceof` of a type the codebase owns. Seeing those is what
 * proves the scan reached the tree rather than an empty file list.
 */
export function scanBodies(text: string): { unguarded: string[]; guarded: number } {
  const flat = text.replace(/\s+/g, ' ');
  const found: string[] = [];
  let guarded = 0;
  // `(?<![.\w])` is load-bearing: without it the `message` in
  // `err.message : String(err)` reads as a property name and the *ternary's*
  // colon as its assignment, so three ordinary bindings were reported as
  // published bodies. A census that invents findings is abandoned as fast as
  // one that misses them.
  const property = /(?<![.\w])(?:error|detail|message|warning|reason)\s*:\s*([^,}]{0,200})/g;
  let m: RegExpExecArray | null;
  while ((m = property.exec(flat))) {
    const value = m[1]!;
    if (!ECHOES_CAUGHT_ERROR.test(value)) continue;
    // Same window rule as above: the guard is normally the `if` or the ternary
    // that the property sits inside, which is to the left of it.
    const from = Math.max(0, m.index - WINDOW);
    if (NARROWS_BY_TYPE.test(flat.slice(from, m.index + m[0].length))) {
      guarded++;
      continue;
    }
    found.push(value.trim().slice(0, 120));
  }
  return { unguarded: found, guarded };
}

describe('a response body carries no wording the route did not author either', () => {
  const findings = sourceFiles(ROUTES).flatMap((file) => {
    const rel = path.relative(path.resolve(HERE, '../..'), file).split(path.sep).join('/');
    return bodyEchoes(readFileSync(file, 'utf8')).map((value) => `${rel}: { … ${value} }`);
  });

  it('is reading the routes, not an empty file list', () => {
    const guarded = sourceFiles(ROUTES).reduce(
      (n, file) => n + scanBodies(readFileSync(file, 'utf8')).guarded,
      0,
    );
    // The legitimate ones: a failed AI job, a failed calculation, a specialty
    // run, an unreachable market feed, a per-topic research failure, a bulk
    // transition row, a remediation re-run — each publishing through
    // `describeForUser`, and each proof the scan sees real code.
    expect(guarded).toBeGreaterThan(4);
  });

  it('reads the property spelling the bulk route used', () => {
    // Vacuity guard, and the founding case: this is `routes/workflow.ts` as it
    // stood, verbatim.
    expect(
      bodyEchoes('results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });'),
    ).toEqual(['err instanceof Error ? err.message : String(err)']);
    // …and does not fire on the fixed shape beside it.
    expect(
      bodyEchoes(
        "results.push({ id, ok: false, error: err instanceof ApiProblem ? err.message : 'could not update' });",
      ),
    ).toEqual([]);
  });

  it('finds no unguarded error text in a route response', () => {
    expect(findings.sort(), 'an error message published in an ordinary response body').toEqual([]);
  });
});
