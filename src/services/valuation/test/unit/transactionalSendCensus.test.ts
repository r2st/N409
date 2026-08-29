import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * Every transactional send answers `{{support_email}}`.
 *
 * `sendTransactionalEmail` supplies the `always` scope itself, so no call site
 * can leave `{{recipient_name}}` or `{{platform_name}}` as literal braces in a
 * client's inbox whatever it passes. `support_email` is the one of the three it
 * cannot answer alone: the address lives in system settings, and the function
 * can only render it if the caller hands over a store to read it from.
 *
 * Omitted, the variable renders empty — a gap in a sentence rather than braces,
 * which is the deliberate fallback and not a good outcome. This is a source
 * scan rather than a behavioural assertion because the failure is per-call-site
 * and silent: eleven sites reach that function, a twelfth is one route away,
 * and the only symptom is an email that reads "questions? " with nothing after
 * it. Nothing fails, nothing logs, and the operator who wrote the template saw
 * the sample address in the preview.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');

/**
 * The deps argument of each `sendTransactionalEmail…(` call, by brace matching
 * from the first `{` after the open paren.
 *
 * Brace-matched rather than regex-matched: the deps literal and the input
 * literal are siblings inside one call, and a lazy `\{[^}]*\}` stops at the
 * first inner `}` — which on a formatted multi-line call is the deps object's
 * own close, but on the next reformatting need not be. A census that reads the
 * wrong argument passes for the wrong reason.
 */
function depsArguments(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\bsendTransactionalEmail(?:InBackground)?\s*\(/g)) {
    const open = source.indexOf('{', m.index + m[0].length);
    if (open === -1) continue;
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) {
        out.push(source.slice(open, i + 1));
        break;
      }
    }
  }
  return out;
}

describe('transactional send call sites', () => {
  const callers = sourceFiles(SRC)
    .filter((f) => !f.endsWith(path.join('email', 'transactional.ts')))
    .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
    .filter((f) => f.source.includes('sendTransactionalEmail'))
    .map((f) => ({ ...f, deps: depsArguments(f.source) }));

  it('finds the call sites it claims to be scanning', () => {
    // A census over nothing is green. These are the routes that mail a person
    // something they did not ask for at that moment — a reset, an invitation, a
    // receipt — so an empty scan means the matcher broke, not that the sends
    // went away.
    expect(callers.length).toBeGreaterThanOrEqual(8);
    expect(callers.flatMap((c) => c.deps).length).toBeGreaterThanOrEqual(callers.length);
  });

  it('hands every send a settings store to read the support address from', () => {
    const missing = callers.flatMap((c) =>
      c.deps.filter((d) => !/\bsettings\b/.test(d)).map(() => path.relative(SRC, c.file)),
    );
    expect(missing).toEqual([]);
  });
});
