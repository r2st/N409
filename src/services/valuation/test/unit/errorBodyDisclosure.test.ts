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
    out.push({ message: flat.slice(start, i), statement: flat.slice(boundary + 1, i + 1) });
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
  /\b(?:err|error|e)\s*\.\s*(?:message|stack|detail|cause|toString)\b|\bString\(\s*(?:err|error|e)\s*\)/;

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
const NARROWS_BY_TYPE = /\b(?:err|error|e)\s+instanceof\s+(?!Error\b)[A-Z][\w$]*/;

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

  it('echoes no caught error that was not narrowed to an owned type', () => {
    expect(
      findings.map((f) => `${f.file}: problems.…(${f.message})`).sort(),
      'a problem body interpolating an error whose wording nothing vouched for',
    ).toEqual([]);
  });
});
