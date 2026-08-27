import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A surface that reports a failed load must offer a way to run it again.
 *
 * R188's census, over the shape that produced it:
 *
 *     if (error) return <ErrorNote>{error}</ErrorNote>;
 *
 * Fifty-five tabs, panels and pages answered a failed read that way — the
 * whole surface replaced by one red line, with nothing else on it. The reader
 * is then stuck: the request that failed is the one the effect fired on mount,
 * the effect has no reason to run again, and the surface has no control that
 * would make it. A full browser reload is the only way forward, and the note
 * neither says so nor makes it cheap — it costs the reader their scroll
 * position, their filters and every other panel on the page, for a dropped
 * connection or a rolling deploy that is usually over already.
 *
 * The rule below turns on *what the note is made of*, because that is what
 * separates the two kinds of terminal error note in this codebase:
 *
 *   - a note whose child is a state variable — `{error}`, `{bootError}` — is
 *     the text of a request that failed. Something can be retried, so a retry
 *     has to be there;
 *   - a note whose child is a literal — "Review tasks are available to
 *     operations roles only", "That sheet is no longer part of this workbook"
 *     — is a statement about the request itself. Running it again produces the
 *     same sentence, and a Retry button beside it would be a lie about what
 *     the reader can do. Those stay `ErrorNote`, and the census leaves them.
 *
 * There is no allowlist of the first kind. The point of keying on the shape
 * rather than on a list of files is that the next surface written this way
 * fails here before anyone has to notice it in a screenshot.
 *
 * The second half of the census is the wiring: a `LoadError` is only a retry
 * if the token `useRetry` hands out actually reaches a dependency list. A
 * surface that renders the button and never re-runs its load is worse than
 * one with no button, because it looks answered.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

const FILES = walk(SRC).map((file) => ({
  file: path.relative(SRC, file),
  text: readFileSync(file, 'utf8'),
}));

/** The file that defines both primitives is not a call site of either. */
const PRIMITIVES = 'components/ui.tsx';

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

describe('a failed load is never a dead end', () => {
  it('has no surface that returns a bare error note built from state', () => {
    const offenders: string[] = [];
    for (const { file, text } of FILES) {
      if (file === PRIMITIVES) continue;
      // `return <ErrorNote>{x}</ErrorNote>` in any of its spellings: the plain
      // early return, the guarded one, and the `error ? … : <Spinner />`
      // ternary that three of the four remaining ones used.
      const re = /return\s+(?:\w+\s*\?\s*)?\(?\s*<ErrorNote>\{(\w+)\}<\/ErrorNote>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        offenders.push(`${file}:${lineOf(text, m.index)} — <ErrorNote>{${m[1]}}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the literal terminal notes, which have nothing to retry', () => {
    // The other side of the rule. If these ever become `LoadError` the census
    // above has been read as "no terminal notes" rather than "no unretryable
    // failures", and a reader without the role would be invited to try again
    // until they gave up.
    const literals = FILES.filter((f) => f.file !== PRIMITIVES).flatMap(({ file, text }) =>
      [...text.matchAll(/return\s+<ErrorNote>([A-Z][^<{]*)<\/ErrorNote>/g)].map(
        (m) => `${file} — ${m[1]!.trim()}`,
      ),
    );
    expect(literals.sort()).toEqual([
      'pages/TasksPage.tsx — Review tasks are available to operations roles only.',
      'pages/valuation/WorkbookTab.tsx — That sheet is no longer part of this workbook.',
    ]);
  });

  it('wires every retry button to a load that can actually re-run', () => {
    const unwired: string[] = [];
    for (const { file, text } of FILES) {
      if (file === PRIMITIVES) continue;
      const uses = [...text.matchAll(/<LoadError\b/g)];
      if (uses.length === 0) continue;

      // One `useRetry` per `LoadError`: several of these files hold two
      // components with an `error` each, and a single shared token would
      // re-run the wrong one's load.
      const hooks = [...text.matchAll(/const \{ token, retryProps \} = useRetry\(/g)];
      if (hooks.length !== uses.length) {
        unwired.push(`${file} — ${uses.length} LoadError, ${hooks.length} useRetry`);
        continue;
      }

      // …and the token has to reach a dependency list, or nothing re-runs.
      const deps = [...text.matchAll(/\}, \[[^\]]*\btoken\b[^\]]*\]\)/g)];
      if (deps.length !== uses.length) {
        unwired.push(`${file} — ${uses.length} LoadError, ${deps.length} dependency lists take token`);
      }
    }
    expect(unwired).toEqual([]);
  });

  it('resets the failure when the retry is pressed', () => {
    // `useRetry(reset)` without a `reset` re-runs the load behind a note that
    // never comes down: the reader gets no sign anything happened, and a retry
    // that succeeds leaves the surface stuck on the stale error for good.
    const bare: string[] = [];
    for (const { file, text } of FILES) {
      if (file === PRIMITIVES) continue;
      for (const m of text.matchAll(/useRetry\(([^;]*?)\);/g)) {
        if (!/set\w*rror\(null\)/.test(m[1]!)) bare.push(`${file}:${lineOf(text, m.index)}`);
      }
    }
    expect(bare).toEqual([]);
  });
});
