/**
 * A function handed a logger is handed one everywhere it is called.
 *
 * Most of this service logs through `req.log` or `app.log`, which cannot be
 * forgotten. A smaller set takes its logger as a *dependency* — the background
 * sweeps, the email senders, the AI pipeline — because they run under a request
 * on one path and under a timer on another, and each caller knows which logger
 * belongs on the line. That is the right shape, and it has one failure mode
 * nothing else in the estate has: the dependency can simply be left out, every
 * line the callee writes through it disappears, and nothing fails. Not the
 * build, not a test, not the route. The evidence is missing in exactly the way
 * that reads as "this never happened".
 *
 * It had happened. `AiPipelineDeps.log` was optional — annotated "so the many
 * test call sites need not supply one", of which there was one — and
 * `registerQaRoutes` was wired in `app.ts` without it. So on the QA pipeline
 * the run whose failure could not be recorded, the run that came back after the
 * reaper had already settled its job, and (round 233) the lookup that decides
 * whether the engagement owner's name is struck from an external prompt all
 * wrote nothing at all.
 *
 * `AiPipelineDeps.log` is required now, so the compiler holds that one. This
 * holds the rest: every exported function whose deps object declares a `log`,
 * and every call site that builds that object as a literal.
 *
 * Derived, not listed — the population is found by reading the parameter lists,
 * so a sweep added next year is in it the day it is written. Only the *top
 * level* of a deps type counts: `registerDocumentRoutes` takes an
 * `autoPipeline` and a `scan` policy, each of which carries its own logger and
 * is built somewhere else, and requiring a second one beside them would be
 * asking for a field the callee does not read.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '../../src');

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) out.push(p);
    }
  };
  walk(SRC);
  return out.sort();
}

/** Comment-stripped, line structure preserved. */
function code(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/([^:"'`\\])\/\/[^\n]*/g, (m, p1: string) => p1 + blank(m.slice(1)));
}

/** The text between `open` at `from` and its matching close. */
function balanced(src: string, from: number, open: string, close: string): string {
  let depth = 0;
  for (let i = from; i < src.length; i += 1) {
    if (src[i] === open) depth += 1;
    else if (src[i] === close) {
      depth -= 1;
      if (depth === 0) return src.slice(from + 1, i);
    }
  }
  return '';
}

/** Split on separators that are not inside brackets. */
function topLevel(text: string, separators: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if ('({['.includes(ch)) depth += 1;
    if (')}]'.includes(ch)) depth -= 1;
    if (separators.includes(ch) && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const files = sourceFiles().map((path) => ({ path, code: code(readFileSync(path, 'utf8')) }));

/** Every `interface X { … }` body in the service, by name. */
const interfaces = new Map<string, string>();
for (const file of files) {
  for (const m of file.code.matchAll(/interface ([A-Z][A-Za-z0-9_]*)\s*\{/g)) {
    interfaces.set(m[1]!, balanced(file.code, m.index! + m[0].length - 1, '{', '}'));
  }
}

/** Does this parameter type declare a `log` of its own, at its top level? */
function declaresLog(type: string): boolean {
  const t = type.trim();
  let body: string | undefined;
  if (t.startsWith('{')) body = balanced(t, 0, '{', '}');
  else body = interfaces.get(/^([A-Z][A-Za-z0-9_]*)/.exec(t)?.[1] ?? '');
  if (body === undefined) return false;
  return topLevel(body, ';,').some((member) => /^\s*(readonly\s+)?log\??\s*:/.test(member));
}

/** Exported functions taking a logger in a deps object, and which parameter it is. */
const takesLogger = new Map<string, number>();
for (const file of files) {
  for (const m of file.code.matchAll(/export (?:async )?function ([a-zA-Z][A-Za-z0-9_]*)\s*\(/g)) {
    const params = topLevel(balanced(file.code, m.index! + m[0].length - 1, '(', ')'), ',');
    const at = params.findIndex((p) => p.includes(':') && declaresLog(p.slice(p.indexOf(':') + 1)));
    if (at >= 0) takesLogger.set(m[1]!, at);
  }
}

describe('a logger passed as a dependency is passed at every call site', () => {
  it('finds the functions that take one', () => {
    // Vacuity guard: a detector that reads no parameter lists reports no
    // violations, and the two this test was written for are the ones the
    // wiring got wrong.
    expect(takesLogger.size).toBeGreaterThan(15);
    expect([...takesLogger.keys()]).toEqual(expect.arrayContaining(['runAiPipeline', 'registerQaRoutes']));
  });

  it('is passed one wherever the deps object is built', () => {
    const missing: string[] = [];
    for (const file of files) {
      for (const [name, at] of takesLogger) {
        for (const m of file.code.matchAll(new RegExp(`(?<![\\w.])${name}\\s*\\(`, 'g'))) {
          // The declaration itself, not a call of it.
          if (/(function|interface)\s+$/.test(file.code.slice(0, m.index!))) continue;
          const args = topLevel(balanced(file.code, m.index! + m[0].length - 1, '(', ')'), ',');
          const arg = args[at]?.trim();
          // Only a literal is this test's business. An object forwarded from a
          // variable was built by whoever declared it, and the type checker has
          // already held it against the same parameter.
          if (arg === undefined || !arg.startsWith('{')) continue;
          const supplied = topLevel(balanced(arg, 0, '{', '}'), ';,').some((k) => /^\s*log\s*(:|$)/.test(k));
          if (!supplied) {
            const line = file.code.slice(0, m.index!).split('\n').length;
            missing.push(`${relative(SRC, file.path)}:${line} — ${name}(…) builds its deps without a log`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
