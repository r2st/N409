/**
 * A rejection that is thrown away leaves an argument for its own absence.
 *
 * `.catch(() => null)` is the estate's smallest and commonest deliberate
 * swallow, and most of the twenty in this service are right: a `ROLLBACK` in a
 * catch that is re-raising the error that caused it, a temp file removed on the
 * way out, a courtesy `QUIT`. Nothing acts on those failures because there is
 * nothing left to act.
 *
 * The rest are a different thing wearing the same three characters. Each
 * returns the value that *also* means "there is none", so the failure then
 * reads, from every other surface, exactly like the ordinary absence:
 *
 *  - `getSamlConfig(…).catch(() => null)` answered the login screen `saml:
 *    false` — no SSO button for an organisation whose people have no password.
 *  - `findUserById(…).catch(() => null)` left the engagement owner's name out
 *    of the list the redactor is told to strike, in material an operator is
 *    about to treat as anonymized.
 *  - `recordSendFailure(…).catch(() => null)` logged `bounce: null`, the same
 *    value as "the provider did not reject the recipient", while the address
 *    stayed unsuppressed and the ladder kept sending to it.
 *  - six `recordSyncError(…).catch(() => undefined)` discarded the write that
 *    takes a connector out of the due query, so the sweep re-pulled a whole
 *    roster every fifteen minutes behind a card reading healthy.
 *
 * None of those raised, so no error handler saw them; all four answered 2xx, so
 * the access log recorded a success. This census is what makes the choice
 * explicit: a handler that discards a rejection either reports it, or carries a
 * `// swallow:` line saying why there is nothing to report. Derived from the
 * source rather than listed, so the next one is in the population the day it is
 * written.
 *
 * The marker is a comment because that is the estate's idiom for the same
 * question elsewhere — `announcementLossCensus` reads `// announcement-loss:`
 * the same way.
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

/** Comments blanked, line structure and offsets preserved. */
function code(src: string): string {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (let k = i; k < stop; k += 1) if (out[k] !== '\n') out[k] = ' ';
      i = stop;
    } else if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      for (let k = i; k < stop; k += 1) out[k] = ' ';
      i = stop;
    } else i += 1;
  }
  return out.join('');
}

/** The balanced argument text of the `.catch(` starting at `open`. */
function argumentOf(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open);
}

interface Swallow {
  file: string;
  line: number;
  handler: string;
}

/**
 * A handler that cannot report. An inline arrow whose body mentions none of
 * the estate's reporting verbs — a forwarded named handler (`.catch(onError)`)
 * is somebody else's contract and is not this census's business.
 */
function swallows(readMarkers = true): Swallow[] {
  const found: Swallow[] = [];
  for (const file of sourceFiles()) {
    const raw = readFileSync(file, 'utf8');
    const src = code(raw);
    const lines = raw.split('\n');
    for (let i = src.indexOf('.catch('); i >= 0; i = src.indexOf('.catch(', i + 1)) {
      const handler = argumentOf(src, i + '.catch'.length).trim();
      if (!handler.startsWith('(') && !handler.startsWith('async')) continue;
      if (/\blog\b|\blog\?|logFailure|logUnretried|throw |alert:/.test(handler)) continue;
      const line = raw.slice(0, i).split('\n').length;
      // The marker sits on the statement or in the three lines above it.
      const window = lines.slice(Math.max(0, line - 4), line).join('\n');
      if (readMarkers && window.includes('swallow:')) continue;
      found.push({ file: relative(SRC, file), line, handler: handler.replace(/\s+/g, ' ').slice(0, 60) });
    }
  }
  return found;
}

describe('a discarded rejection is a decision, not a default (R267)', () => {
  it('leaves no handler that neither reports the failure nor says why it need not', () => {
    expect(swallows().map((s) => `${s.file}:${s.line} .catch(${s.handler})`)).toEqual([]);
  });

  it('is green because of the markers, not because it reads nothing', () => {
    // Vacuity guard: an assertion that passes because the matcher matches
    // nothing is the one failure a census cannot survive. Every silent catch in
    // this service is annotated, so the green above rests entirely on the
    // marker — read the same population without it and the shape must reappear.
    const withoutMarkers = swallows(false);
    expect(withoutMarkers.length).toBeGreaterThan(10);
    // And in more than one place, so a single annotated file cannot carry it.
    expect(new Set(withoutMarkers.map((s) => s.file)).size).toBeGreaterThan(5);
  });
});
